/**
 * Unit tests: POST /api/auth/discover (authDiscoverRoutes)
 *
 * Security properties locked by this suite:
 *  1. No auth required — route is accessible pre-login, no 401 gate.
 *  2. Rate-limited — 429 + Retry-After header when the limiter denies.
 *  3. No-leak — a domain that is claimed-but-IdP-PENDING/disabled is
 *     indistinguishable from an unknown domain: both yield { method: "password" }.
 *     The DB query's `where` clause enforces `verifiedAt: { not: null }` AND
 *     `tenant.identityProvider.status: "ACTIVE"` — both are asserted.
 *  4. Input validation — 400 INVALID_JSON and 400 INVALID_EMAIL.
 *
 * Timing pad: the handler calls padToMinimum() (real setTimeout) on every
 * path.  To avoid flaky wall-clock assertions the suite uses fake timers
 * (vi.useFakeTimers) so no test actually waits 80 ms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockFindFirst, mockCheckRateLimitKV } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockCheckRateLimitKV: vi.fn(),
}));

// Mock createPrisma (dynamic import path used in discoverHandler)
vi.mock("../../../src/db", () => ({
  createPrisma: () => ({
    tenantDomain: {
      findFirst: mockFindFirst,
    },
  }),
}));

// Mock RateLimiter class — default: allowed
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    checkRateLimitKV = mockCheckRateLimitKV;
  },
}));

// SecurityHeaders passthrough — preserves status/body, adds no headers that
// would interfere with response-shape assertions.
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    addSecurityHeaders(r: Response) {
      return r;
    }
    createSecureResponse(body: string, init: ResponseInit) {
      return new Response(body, init);
    }
  },
}));

// ── Import subject AFTER mocks are registered ─────────────────────────────────
import { authDiscoverRoutes } from "../../../src/lib/routes/auth-discover.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ROUTE = authDiscoverRoutes[0];

/**
 * env that satisfies getIdpRedirectConfig reads:
 *   COGNITO_HOSTED_UI_DOMAIN, COGNITO_APP_CLIENT_ID, COGNITO_REDIRECT_URI
 * All other env fields are irrelevant for this route.
 */
const mockEnv = {
  COGNITO_HOSTED_UI_DOMAIN: "auth.example.com",
  COGNITO_APP_CLIENT_ID: "client-abc",
  COGNITO_REDIRECT_URI: "https://app.example.com/callback",
} as any;

function ctx(pathname = "/api/auth/discover") {
  return {
    url: new URL(`https://api.example.com${pathname}`),
    pathname,
    params: {},
    requestContext: undefined,
  } as any;
}

function postRequest(body: unknown) {
  return new Request("https://api.example.com/api/auth/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postRawRequest(rawBody: string) {
  return new Request("https://api.example.com/api/auth/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}

// A realistic tenant row for a federated domain with an explicit cognitoIdpName
const FEDERATED_ROW_WITH_IDP_NAME = {
  tenant: {
    id: "tenant-cjld2cyuq0000t3rmniod1foy",
    slug: "acme",
    identityProvider: {
      cognitoIdpName: "tenant-xyz",
    },
  },
};

// A row where cognitoIdpName is null — falls back to cognitoIdpName(tenant.id)
const FEDERATED_ROW_NO_IDP_NAME = {
  tenant: {
    id: "tenant-cjld2cyuq0000t3rmniod1foy",
    slug: "acme",
    identityProvider: {
      cognitoIdpName: null,
    },
  },
};

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();

  vi.clearAllMocks();

  // Default: rate limit allows the request
  mockCheckRateLimitKV.mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  });

  // Default: no federated domain found
  mockFindFirst.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Helper: run the handler and drain any pending fake timers so the
 * padToMinimum() Promise resolves without real waiting.
 *
 * We interleave real microtasks with timer advancement:
 *  1. Start the handler promise (it begins executing synchronously).
 *  2. Flush pending microtasks (DB mock resolution, zod parsing, etc.).
 *  3. Advance fake timers by MIN_RESPONSE_MS to unblock padToMinimum's setTimeout.
 *  4. Flush again so the handler can complete and resolve its outer promise.
 */
async function invoke(request: Request): Promise<Response> {
  const promise = ROUTE.handler(request, mockEnv, ctx());
  // Flush all microtasks so the handler reaches the setTimeout in padToMinimum.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  // Now advance fake timers past MIN_RESPONSE_MS (80ms) so padToMinimum resolves.
  vi.advanceTimersByTime(100);
  // Flush the resulting microtasks so the handler promise resolves.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return promise;
}

// ── Route registration ────────────────────────────────────────────────────────

describe("route registration", () => {
  it("exports exactly one route at /api/auth/discover via POST", () => {
    expect(authDiscoverRoutes).toHaveLength(1);
    expect(ROUTE.path).toBe("/api/auth/discover");
    expect(ROUTE.method).toBe("POST");
    expect(typeof ROUTE.handler).toBe("function");
    expect(ROUTE.description).toBeTruthy();
  });

  it("attaches at least one middleware (CORS)", () => {
    expect(Array.isArray(ROUTE.middleware)).toBe(true);
    expect(ROUTE.middleware!.length).toBeGreaterThanOrEqual(1);
  });
});

// ── PASSWORD FALLBACK ─────────────────────────────────────────────────────────

describe("password fallback", () => {
  it("returns { method: 'password' } when no federated domain row is found", async () => {
    mockFindFirst.mockResolvedValue(null);

    const res = await invoke(postRequest({ email: "user@example.org" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ method: "password" });
  });

  it("response does not include tenantSlug or idpRedirect on password fallback", async () => {
    mockFindFirst.mockResolvedValue(null);

    const res = await invoke(postRequest({ email: "user@other-domain.org" }));
    const body = await res.json();

    expect(body.tenantSlug).toBeUndefined();
    expect(body.idpRedirect).toBeUndefined();
  });
});

// ── IDP METHOD ────────────────────────────────────────────────────────────────

describe("idp method — federated tenant", () => {
  it("returns { method: 'idp', tenantSlug, idpRedirect } when a live row is found", async () => {
    mockFindFirst.mockResolvedValue(FEDERATED_ROW_WITH_IDP_NAME);

    const res = await invoke(postRequest({ email: "user@acme.example.org" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe("idp");
    expect(body.tenantSlug).toBe("acme");
    expect(typeof body.idpRedirect).toBe("string");
    expect(body.idpRedirect.length).toBeGreaterThan(0);
  });

  it("idpRedirect is a valid Cognito hosted-UI authorize URL", async () => {
    mockFindFirst.mockResolvedValue(FEDERATED_ROW_WITH_IDP_NAME);

    const res = await invoke(postRequest({ email: "user@acme.example.org" }));
    const { idpRedirect } = await res.json();

    const url = new URL(idpRedirect);
    expect(url.hostname).toBe("auth.example.com");
    expect(url.pathname).toBe("/oauth2/authorize");
  });

  it("idpRedirect carries identity_provider=tenant-xyz (from DB row)", async () => {
    mockFindFirst.mockResolvedValue(FEDERATED_ROW_WITH_IDP_NAME);

    const res = await invoke(postRequest({ email: "user@acme.example.org" }));
    const { idpRedirect } = await res.json();

    const url = new URL(idpRedirect);
    expect(url.searchParams.get("identity_provider")).toBe("tenant-xyz");
  });

  it("idpRedirect scope is fixed to 'openid email profile' (no caller-supplied scope)", async () => {
    mockFindFirst.mockResolvedValue(FEDERATED_ROW_WITH_IDP_NAME);

    const res = await invoke(postRequest({ email: "user@acme.example.org" }));
    const { idpRedirect } = await res.json();

    const url = new URL(idpRedirect);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  it("idpRedirect includes client_id and redirect_uri from env", async () => {
    mockFindFirst.mockResolvedValue(FEDERATED_ROW_WITH_IDP_NAME);

    const res = await invoke(postRequest({ email: "user@acme.example.org" }));
    const { idpRedirect } = await res.json();

    const url = new URL(idpRedirect);
    expect(url.searchParams.get("client_id")).toBe("client-abc");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback");
  });

  it("idpRedirect uses response_type=code", async () => {
    mockFindFirst.mockResolvedValue(FEDERATED_ROW_WITH_IDP_NAME);

    const res = await invoke(postRequest({ email: "user@acme.example.org" }));
    const { idpRedirect } = await res.json();

    const url = new URL(idpRedirect);
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

// ── IDP NAME FALLBACK (cognitoIdpName from tenant.id) ────────────────────────

describe("idp name fallback", () => {
  it("derives identity_provider from tenant.id when cognitoIdpName is null", async () => {
    mockFindFirst.mockResolvedValue(FEDERATED_ROW_NO_IDP_NAME);

    const res = await invoke(postRequest({ email: "user@acme.example.org" }));

    expect(res.status).toBe(200);
    const { method, idpRedirect } = await res.json();
    expect(method).toBe("idp");

    const url = new URL(idpRedirect);
    // cognitoIdpName("tenant-cjld2cyuq0000t3rmniod1foy") = "tenant-" + first 25 chars of id
    // id = "tenant-cjld2cyuq0000t3rmniod1foy"
    // first 25 chars = "tenant-cjld2cyuq0000t3rmn"
    // full idp name = "tenant-tenant-cjld2cyuq0000t3rmn"
    const derivedIdpName = `tenant-${FEDERATED_ROW_NO_IDP_NAME.tenant.id.slice(0, 25)}`;
    expect(url.searchParams.get("identity_provider")).toBe(derivedIdpName);
  });
});

// ── NO-LEAK: DB query structure ───────────────────────────────────────────────

describe("no-leak: DB query must gate on verifiedAt AND identityProvider.status=ACTIVE", () => {
  it("queries with verifiedAt: { not: null } to exclude unverified domains", async () => {
    mockFindFirst.mockResolvedValue(null);

    await invoke(postRequest({ email: "user@example.org" }));

    expect(mockFindFirst).toHaveBeenCalledOnce();
    const [callArgs] = mockFindFirst.mock.calls;
    const where = callArgs[0].where;

    // verifiedAt must be { not: null } — not undefined, not absent
    expect(where.verifiedAt).toBeDefined();
    expect(where.verifiedAt).toEqual({ not: null });
  });

  it("queries with tenant.identityProvider.status='ACTIVE' to exclude disabled IdPs", async () => {
    mockFindFirst.mockResolvedValue(null);

    await invoke(postRequest({ email: "user@example.org" }));

    const [callArgs] = mockFindFirst.mock.calls;
    const where = callArgs[0].where;

    // Must filter for ACTIVE IdP status — not absent, not a permissive value
    expect(where.tenant?.identityProvider?.status).toBe("ACTIVE");
  });

  it("(security) claimed domain with disabled IdP → password response (not idp)", async () => {
    // Simulate: the domain IS claimed and the tenant exists, but the IdP is
    // PENDING/INACTIVE so the DB returns no row (where clause excludes it).
    // From the caller's perspective this is indistinguishable from an unknown domain.
    mockFindFirst.mockResolvedValue(null); // disabled IdP → no row

    const res = await invoke(postRequest({ email: "user@claimed-but-disabled.example.org" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe("password"); // no leak
    expect(body.tenantSlug).toBeUndefined();
    expect(body.idpRedirect).toBeUndefined();
  });

  it("(security) password fallback is shape-identical for unknown vs disabled-IdP domains", async () => {
    // Both must return exactly { method: 'password' } — no additional fields.
    mockFindFirst.mockResolvedValue(null);
    const res1 = await invoke(postRequest({ email: "user@never-registered.example.org" }));
    const res2 = await invoke(postRequest({ email: "user@disabled-idp.example.org" }));

    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1).toEqual({ method: "password" });
    expect(body2).toEqual({ method: "password" });
  });

  it("query filters by the derived email domain (not the raw email string)", async () => {
    mockFindFirst.mockResolvedValue(null);

    await invoke(postRequest({ email: "USER@ACME.EXAMPLE.ORG" }));

    const [callArgs] = mockFindFirst.mock.calls;
    const where = callArgs[0].where;

    // deriveEmailDomain lowercases — must be the lowercased domain, never the full email
    expect(where.domain).toBe("acme.example.org");
  });
});

// ── 429 RATE LIMIT ────────────────────────────────────────────────────────────

describe("rate limiting", () => {
  it("returns 429 when the rate limiter denies the request", async () => {
    const resetAt = Date.now() + 45_000;
    mockCheckRateLimitKV.mockResolvedValue({ allowed: false, resetAt, remaining: 0 });

    const res = await invoke(postRequest({ email: "user@example.org" }));

    expect(res.status).toBe(429);
  });

  it("429 response includes a Retry-After header", async () => {
    const resetAt = Date.now() + 45_000;
    mockCheckRateLimitKV.mockResolvedValue({ allowed: false, resetAt, remaining: 0 });

    const res = await invoke(postRequest({ email: "user@example.org" }));

    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    // Must be a non-negative integer string
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(0);
  });

  it("429 body contains RATE_LIMIT_EXCEEDED error code", async () => {
    const resetAt = Date.now() + 30_000;
    mockCheckRateLimitKV.mockResolvedValue({ allowed: false, resetAt, remaining: 0 });

    const res = await invoke(postRequest({ email: "user@example.org" }));
    const body = await res.json();

    expect(body.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("rate-limited request does NOT reach the DB (short-circuits before query)", async () => {
    mockCheckRateLimitKV.mockResolvedValue({
      allowed: false,
      resetAt: Date.now() + 10_000,
      remaining: 0,
    });

    await invoke(postRequest({ email: "user@example.org" }));

    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("allowed request passes through to the DB", async () => {
    mockCheckRateLimitKV.mockResolvedValue({ allowed: true, remaining: 28, resetAt: Date.now() + 60_000 });
    mockFindFirst.mockResolvedValue(null);

    await invoke(postRequest({ email: "user@example.org" }));

    expect(mockFindFirst).toHaveBeenCalledOnce();
  });
});

// ── 400 INPUT VALIDATION ──────────────────────────────────────────────────────

describe("400 invalid JSON", () => {
  it("returns 400 INVALID_JSON when body is malformed JSON", async () => {
    const req = postRawRequest("{not valid json");

    const res = await invoke(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_JSON");
  });

  it("INVALID_JSON response includes message and remediation", async () => {
    const req = postRawRequest("!!!");

    const res = await invoke(req);
    const body = await res.json();

    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
    expect(typeof body.remediation).toBe("string");
    expect(body.remediation.length).toBeGreaterThan(0);
  });
});

describe("400 invalid email", () => {
  it("returns 400 INVALID_EMAIL for a string with no @-domain", async () => {
    const res = await invoke(postRequest({ email: "not-an-email" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_EMAIL");
  });

  it("returns 400 INVALID_EMAIL for an empty email string", async () => {
    const res = await invoke(postRequest({ email: "" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_EMAIL");
  });

  it("returns 400 INVALID_EMAIL when email field is missing", async () => {
    const res = await invoke(postRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_EMAIL");
  });

  it("INVALID_EMAIL response includes field='email'", async () => {
    const res = await invoke(postRequest({ email: "bad" }));
    const body = await res.json();

    expect(body.field).toBe("email");
  });

  it("INVALID_EMAIL response does not reach the DB", async () => {
    await invoke(postRequest({ email: "invalid" }));

    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("invalid email after rate-limit check — still 400 (rate limit did not fire)", async () => {
    // Rate limit allows, but email is invalid — must be 400, not 429
    mockCheckRateLimitKV.mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60_000 });

    const res = await invoke(postRequest({ email: "bad" }));

    expect(res.status).toBe(400);
  });
});

// ── NO-AUTH REQUIRED ─────────────────────────────────────────────────────────

describe("pre-login: no authentication required", () => {
  it("succeeds (200) without any Authorization header", async () => {
    mockFindFirst.mockResolvedValue(null);

    const req = new Request("https://api.example.com/api/auth/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Deliberately NO Authorization header
      body: JSON.stringify({ email: "user@example.org" }),
    });

    const res = await invoke(req);

    expect(res.status).toBe(200);
  });

  it("does not call any session or auth middleware", async () => {
    // The route array only carries corsMiddleware — no session or auth gate.
    // We verify by asserting the response is 200 with a plain request.
    mockFindFirst.mockResolvedValue(null);

    const res = await invoke(postRequest({ email: "user@example.org" }));

    // A session-gated route would return 401; this must be 200.
    expect(res.status).toBe(200);
  });
});
