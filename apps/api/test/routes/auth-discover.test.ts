/**
 * Unit Tests: POST /api/auth/discover
 *
 * Covers:
 *  1. Federated tenant → method=idp + idpRedirect + tenantSlug
 *  2. Unfederated domain → method=password
 *  3. Disabled IdP → method=password (no information leak)
 *  4. Malformed / missing email → 400
 *  5. Rate limiter → 429 with Retry-After
 *  6. Timing-safe: both federated and non-federated paths complete after MIN_RESPONSE_MS
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { authDiscoverRoutes } from "../../src/lib/routes/auth-discover.js";

// ── DB mock ───────────────────────────────────────────────────────────────────
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    tenantDomain: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("../../src/db", () => ({
  createPrisma: () => mockDb,
}));

// ── Rate limiter mock ─────────────────────────────────────────────────────────
const { mockCheckRateLimitKV } = vi.hoisted(() => ({
  mockCheckRateLimitKV: vi.fn(),
}));

vi.mock("../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    checkRateLimitKV = mockCheckRateLimitKV;
  },
}));

// ── SecurityHeaders mock ──────────────────────────────────────────────────────
vi.mock("../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    addSecurityHeaders(res: Response) {
      return res;
    }
  },
}));

// ── Clock mock — lets us verify timing pad behaviour ─────────────────────────
let fakeNow = 1_000_000;
const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

// ── Helpers ───────────────────────────────────────────────────────────────────
const mockEnv = {
  DATABASE_URL: "postgresql://test",
  COGNITO_HOSTED_UI_DOMAIN: "auth.example.com",
  COGNITO_APP_CLIENT_ID: "client-id-123",
  COGNITO_REDIRECT_URI: "https://app.example.com/auth/callback",
  RATE_LIMIT_KV: {
    get: vi.fn(),
    put: vi.fn(),
  },
} as unknown as Env;

function makeRequest(body: unknown): Request {
  return new Request("https://api.example.com/api/auth/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const discoverRoute = authDiscoverRoutes[0]!;

async function callHandler(req: Request): Promise<Response> {
  return discoverRoute.handler(req, mockEnv, {
    pathname: "/api/auth/discover",
    url: "https://api.example.com/api/auth/discover",
    requestContext: {} as any,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("POST /api/auth/discover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeNow = 1_000_000;

    // Default: rate limit allows
    mockCheckRateLimitKV.mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetAt: fakeNow + 60_000,
    });

    // Default: no federated tenant
    mockDb.tenantDomain.findFirst.mockResolvedValue(null);
  });

  describe("federated tenant", () => {
    it("returns method=idp with idpRedirect and tenantSlug", async () => {
      mockDb.tenantDomain.findFirst.mockResolvedValue({
        tenant: {
          id: "clxabc123456789",
          slug: "acme-corp",
          identityProvider: {
            cognitoIdpName: "tenant-clxabc123456",
          },
        },
      });

      const res = await callHandler(makeRequest({ email: "alice@acme-corp.com" }));
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.method).toBe("idp");
      expect(body.tenantSlug).toBe("acme-corp");
      expect(body.idpRedirect).toMatch(
        /^https:\/\/auth\.example\.com\/oauth2\/authorize\?/,
      );
      expect(body.idpRedirect).toContain("identity_provider=tenant-clxabc123456");
      expect(body.idpRedirect).toContain("client_id=client-id-123");
      expect(body.idpRedirect).toContain("response_type=code");
      expect(body.idpRedirect).toContain("scope=openid");
    });

    it("falls back to cognitoIdpName formula when DB row has no cognitoIdpName stored", async () => {
      mockDb.tenantDomain.findFirst.mockResolvedValue({
        tenant: {
          id: "clxabc123456789",
          slug: "acme",
          identityProvider: {
            cognitoIdpName: null,
          },
        },
      });

      const res = await callHandler(makeRequest({ email: "bob@acme.org" }));
      const body = await res.json() as any;
      expect(body.method).toBe("idp");
      expect(body.idpRedirect).toContain("identity_provider=tenant-clxabc123456");
    });

    it("queries with verifiedAt not null and status ACTIVE", async () => {
      mockDb.tenantDomain.findFirst.mockResolvedValue({
        tenant: {
          id: "clx999",
          slug: "org",
          identityProvider: { cognitoIdpName: "tenant-clx999" },
        },
      });

      await callHandler(makeRequest({ email: "user@org.io" }));

      expect(mockDb.tenantDomain.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            domain: "org.io",
            verifiedAt: { not: null },
            tenant: {
              identityProvider: {
                status: "ACTIVE",
              },
            },
          }),
        }),
      );
    });
  });

  describe("non-federated / no matching domain", () => {
    it("returns method=password when no tenant domain record found", async () => {
      mockDb.tenantDomain.findFirst.mockResolvedValue(null);

      const res = await callHandler(makeRequest({ email: "user@unknown.com" }));
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.method).toBe("password");
      expect(body.idpRedirect).toBeUndefined();
    });
  });

  describe("disabled IdP — no information leak", () => {
    it("returns method=password (same as no-IdP case) when IdP status is DISABLED", async () => {
      // DISABLED IdP is excluded by the query (status: "ACTIVE" filter),
      // so findFirst returns null — same result as no domain at all.
      mockDb.tenantDomain.findFirst.mockResolvedValue(null);

      const res = await callHandler(makeRequest({ email: "emp@claimed-but-disabled.com" }));
      const body = await res.json() as any;
      expect(body.method).toBe("password");
    });

    it("the DB query only selects ACTIVE IdPs — DISABLED is never returned", async () => {
      await callHandler(makeRequest({ email: "user@disabled-idp.io" }));

      const callArgs = mockDb.tenantDomain.findFirst.mock.calls[0]?.[0] as any;
      expect(callArgs.where.tenant.identityProvider.status).toBe("ACTIVE");
    });
  });

  describe("malformed input", () => {
    it("returns 400 for missing email field", async () => {
      const res = await callHandler(makeRequest({}));
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toBe("INVALID_EMAIL");
    });

    it("returns 400 for email without @ sign", async () => {
      const res = await callHandler(makeRequest({ email: "notanemail" }));
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toBe("INVALID_EMAIL");
    });

    it("returns 400 for email with no domain part after @", async () => {
      const res = await callHandler(makeRequest({ email: "user@" }));
      expect(res.status).toBe(400);
    });

    it("returns 400 for email with no dot in domain", async () => {
      const res = await callHandler(makeRequest({ email: "user@nodot" }));
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid JSON body", async () => {
      const req = new Request("https://api.example.com/api/auth/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });
      const res = await callHandler(req);
      expect(res.status).toBe(400);
    });

    it("returns 400 for null email", async () => {
      const res = await callHandler(makeRequest({ email: null }));
      expect(res.status).toBe(400);
    });
  });

  describe("rate limiter", () => {
    it("returns 429 with Retry-After when rate limit is exceeded", async () => {
      mockCheckRateLimitKV.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt: fakeNow + 45_000,
      });

      const res = await callHandler(makeRequest({ email: "attacker@evil.com" }));
      expect(res.status).toBe(429);
      const body = await res.json() as any;
      expect(body.error).toBe("RATE_LIMIT_EXCEEDED");
      expect(res.headers.get("Retry-After")).toBeTruthy();
    });

    it("rate limiter is called with per-IP key components", async () => {
      const req = new Request("https://api.example.com/api/auth/discover", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "1.2.3.4",
        },
        body: JSON.stringify({ email: "user@example.com" }),
      });

      await callHandler(req);

      expect(mockCheckRateLimitKV).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "auth-discover",
        30,
        60,
      );
    });

    it("does not call DB when rate limit is exceeded", async () => {
      mockCheckRateLimitKV.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt: fakeNow + 60_000,
      });

      await callHandler(makeRequest({ email: "spammer@example.com" }));
      expect(mockDb.tenantDomain.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("timing-safe behaviour", () => {
    it("federated path calls setTimeout to pad to MIN_RESPONSE_MS", async () => {
      // Start fake clock at 0; DB resolves instantly (fakeNow stays at 0),
      // so elapsed < 80ms → padToMinimum fires a setTimeout with > 0 delay.
      fakeNow = 0;
      let padDelay = 0;
      const realSetTimeout = globalThis.setTimeout;
      vi.stubGlobal("setTimeout", (fn: TimerHandler, delay?: number) => {
        if (typeof delay === "number" && delay > 0) padDelay = delay;
        return realSetTimeout(fn as () => void, 0);
      });

      mockDb.tenantDomain.findFirst.mockResolvedValue({
        tenant: {
          id: "t1",
          slug: "s1",
          identityProvider: { cognitoIdpName: "tenant-t1" },
        },
      });

      await callHandler(makeRequest({ email: "a@federated.com" }));
      expect(padDelay).toBeGreaterThan(0);

      vi.stubGlobal("setTimeout", realSetTimeout);
    });

    it("non-federated path also pads to MIN_RESPONSE_MS", async () => {
      fakeNow = 0;
      let padDelay = 0;
      const realSetTimeout = globalThis.setTimeout;
      vi.stubGlobal("setTimeout", (fn: TimerHandler, delay?: number) => {
        if (typeof delay === "number" && delay > 0) padDelay = delay;
        return realSetTimeout(fn as () => void, 0);
      });

      mockDb.tenantDomain.findFirst.mockResolvedValue(null);
      await callHandler(makeRequest({ email: "b@nonfederated.com" }));
      expect(padDelay).toBeGreaterThan(0);

      vi.stubGlobal("setTimeout", realSetTimeout);
    });

    it("400 path also pads to minimum response time", async () => {
      fakeNow = 0;
      let padDelay = 0;
      const realSetTimeout = globalThis.setTimeout;
      vi.stubGlobal("setTimeout", (fn: TimerHandler, delay?: number) => {
        if (typeof delay === "number" && delay > 0) padDelay = delay;
        return realSetTimeout(fn as () => void, 0);
      });

      await callHandler(makeRequest({ email: "badformat" }));
      expect(padDelay).toBeGreaterThan(0);

      vi.stubGlobal("setTimeout", realSetTimeout);
    });
  });

  describe("route shape", () => {
    it("exports exactly one route at /api/auth/discover POST", () => {
      expect(authDiscoverRoutes).toHaveLength(1);
      expect(authDiscoverRoutes[0]!.path).toBe("/api/auth/discover");
      expect(authDiscoverRoutes[0]!.method).toBe("POST");
    });
  });
});
