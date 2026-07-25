/**
 * Unit tests: routes/agent-authorize.ts (T9b-d).
 *
 * Covers:
 *  - Unauthenticated GET → 302 to /auth/login.
 *  - Missing capability → 403.
 *  - MFA stale → 401 with mfa_required.
 *  - Rate limit: 5 attempts/IP/min → 429 on the 6th.
 *  - Successful approval calls Cognito, seals tokens, writes session row.
 *  - Locked-out device_code → 410.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetSession,
  mockApplyRateLimitKV,
  mockLookupDeviceCodeByUserCode,
  mockLoadByDeviceCode,
  mockApproveDeviceAuth,
  mockIncrementFailedLookup,
  mockRecordAgentSession,
  mockIssueForAgent,
  mockAuditEmit,
  mockFindMember,
  mockFindUser,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockApplyRateLimitKV: vi.fn(),
  mockLookupDeviceCodeByUserCode: vi.fn(),
  mockLoadByDeviceCode: vi.fn(),
  mockApproveDeviceAuth: vi.fn(),
  mockIncrementFailedLookup: vi.fn(),
  mockRecordAgentSession: vi.fn(),
  mockIssueForAgent: vi.fn(),
  mockAuditEmit: vi.fn(),
  mockFindMember: vi.fn(),
  mockFindUser: vi.fn(),
}));

vi.mock("../../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));


vi.mock("../../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    constructor(_env: unknown) {}
    createSecureResponse(body: BodyInit, init: ResponseInit) {
      return new Response(body, init);
    }
  },
}));

vi.mock("../../../../src/lib/oauth/device-authorization", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/lib/oauth/device-authorization.js")>(
    "../../../../src/lib/oauth/device-authorization",
  );
  return {
    ...actual,
    lookupDeviceCodeByUserCode: (...a: unknown[]) => mockLookupDeviceCodeByUserCode(...a),
    loadByDeviceCode: (...a: unknown[]) => mockLoadByDeviceCode(...a),
    approveDeviceAuth: (...a: unknown[]) => mockApproveDeviceAuth(...a),
    incrementFailedLookup: (...a: unknown[]) => mockIncrementFailedLookup(...a),
  };
});

vi.mock("../../../../src/lib/oauth/refresh-detection", () => ({
  recordAgentSession: (...a: unknown[]) => mockRecordAgentSession(...a),
}));

vi.mock("../../../../src/db", () => ({
  createPrisma: () => ({
    tenantMember: { findFirst: (...a: unknown[]) => mockFindMember(...a) },
    user: { findUnique: (...a: unknown[]) => mockFindUser(...a) },
    securityEvent: { create: vi.fn() },
  }),
}));

import {
  agentAuthorizeRoutes,
  _resetAgentAuthorizeDepsForTest,
  _setAgentAuthorizeDepsForTest,
} from "../../../../src/lib/routes/agent-authorize.js";
import type { Env } from "../../../../src/env.js";
import type { Session } from "../../../../src/lib/session-cookie.js";

const ENV = {
  COGNITO_USER_POOL_ID: "us-east-1_pool",
  COGNITO_AGENT_CLIENT_ID: "agent-client",
  AGENT_VERIFICATION_URI_BASE: "https://example.com/agents/authorize",
  RATE_LIMIT_KV: undefined,
} as unknown as Env;

function findRoute(path: string, method: string) {
  return agentAuthorizeRoutes.find(
    (r) => (typeof r.path === "string" ? r.path === path : (r.path as RegExp).test(path)) && r.method === method,
  );
}

function makeRequest(path: string, init: RequestInit & { body?: string } = {}): Request {
  return new Request(`http://localhost${path}`, { method: "POST", ...init });
}

const ADMIN_SESSION: Session & { refreshToken: string } = {
  userId: "u_admin",
  email: "admin@example.com",
  role: "B2B_PARTNER",
  expiresAt: Date.now() + 3_600_000,
  dataRegion: "EU",
  profileContext: "primary",
  mfaVerified: true,
  mfaVerifiedAt: Date.now() - 60_000, // 1 minute ago
  refreshToken: "RT-admin",
};

beforeEach(() => {
  mockGetSession.mockReset();
  mockApplyRateLimitKV.mockReset().mockResolvedValue(null);
  mockLookupDeviceCodeByUserCode.mockReset();
  mockLoadByDeviceCode.mockReset();
  mockApproveDeviceAuth.mockReset();
  mockIncrementFailedLookup.mockReset();
  mockRecordAgentSession.mockReset();
  mockIssueForAgent.mockReset();
  mockAuditEmit.mockReset();
  mockFindMember.mockReset().mockResolvedValue({
    id: "tm_admin",
    tenantId: "t_one",
    userId: "u_admin",
    role: "ADMIN",
    status: "ACTIVE",
    tenant: { id: "t_one", slug: "demo" },
  });
  mockFindUser.mockReset().mockResolvedValue({ subject: "cognito-sub-admin" });

  _resetAgentAuthorizeDepsForTest();
  _setAgentAuthorizeDepsForTest({
    issuer: { issueForAgent: mockIssueForAgent },
    rateLimiter: {
      applyRateLimitKV: mockApplyRateLimitKV,
      // unused fallthroughs
      checkRateLimit: vi.fn(),
      checkRateLimitKV: vi.fn(),
      applyRateLimit: vi.fn(),
    } as unknown as import("../../../../src/lib/rate-limit.js").RateLimiter,
    auditEmitter: {
      emit: mockAuditEmit,
    } as unknown as import("../../../../src/lib/audit-composer.js").TenantAuditEmitter,
  });
});

describe("GET /agents/authorize", () => {
  it("redirects to /auth/login when no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const route = findRoute("/agents/authorize", "GET")!;
    const request = new Request("http://localhost/agents/authorize?user_code=BCDF-GHJK");
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize",
      params: {},
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/auth/login");
  });

  it("returns 400 when user_code is missing", async () => {
    const route = findRoute("/agents/authorize", "GET")!;
    const request = new Request("http://localhost/agents/authorize");
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize",
      params: {},
    });
    expect(response.status).toBe(400);
  });

  it("returns 403 when user lacks ManageAgentSessions", async () => {
    mockGetSession.mockResolvedValue(ADMIN_SESSION);
    mockFindMember.mockResolvedValue({
      id: "tm_member",
      tenantId: "t_one",
      userId: "u_admin",
      role: "MEMBER",
      status: "ACTIVE",
      tenant: { id: "t_one", slug: "demo" },
    });

    const route = findRoute("/agents/authorize", "GET")!;
    const request = new Request("http://localhost/agents/authorize?user_code=BCDF-GHJK");
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize",
      params: {},
    });
    expect(response.status).toBe(403);
  });

  it("renders the approval page for admin with fresh MFA", async () => {
    mockGetSession.mockResolvedValue(ADMIN_SESSION);
    mockLookupDeviceCodeByUserCode.mockResolvedValue("dc-123");
    mockLoadByDeviceCode.mockResolvedValue({
      deviceCode: "dc-123",
      userCodeHash: "h",
      status: "pending",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      createdAt: Math.floor(Date.now() / 1000),
      interval: 5,
      failedLookups: 0,
      agentLabel: "claude-code/1.0",
    });

    const route = findRoute("/agents/authorize", "GET")!;
    const request = new Request("http://localhost/agents/authorize?user_code=BCDF-GHJK");
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize",
      params: {},
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("BCDF-GHJK");
    expect(body).toContain("claude-code/1.0");
    // HIGH-4: caveat banner + Source IP line + agentLabel rendered in
    // a code-style block (visually distinct from trusted UI text).
    expect(body).toContain("not verified by");
    expect(body).toContain("Source IP");
    expect(body).toMatch(/<code class="label-block">/);
  });

  it("renders MFA-required notice when MFA is stale", async () => {
    mockGetSession.mockResolvedValue({
      ...ADMIN_SESSION,
      mfaVerifiedAt: Date.now() - 90 * 60 * 1000, // 1.5h
    });
    mockLookupDeviceCodeByUserCode.mockResolvedValue("dc-123");
    mockLoadByDeviceCode.mockResolvedValue({
      deviceCode: "dc-123",
      userCodeHash: "h",
      status: "pending",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      createdAt: Math.floor(Date.now() / 1000),
      interval: 5,
      failedLookups: 0,
    });

    const route = findRoute("/agents/authorize", "GET")!;
    const request = new Request("http://localhost/agents/authorize?user_code=BCDF-GHJK");
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize",
      params: {},
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("MFA");
    expect(body).toContain("disabled");
  });
});

describe("POST /agents/authorize/approve", () => {
  function makeApprove(): { route: ReturnType<typeof findRoute>; request: Request } {
    const route = findRoute("/agents/authorize/approve", "POST")!;
    const request = makeRequest("/agents/authorize/approve", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "user_code=BCDF-GHJK",
    });
    return { route, request };
  }

  it("returns 429 once rate limit is exceeded (sec finding #3)", async () => {
    // The handler invokes the limiter twice per request (global ceiling
    // then per-IP). Track only the per-endpoint hits so the contract
    // ("5 approve attempts then block") still tracks the same shape.
    const perEndpoint: Record<string, number> = {};
    mockApplyRateLimitKV.mockImplementation(async (_env, _req, endpoint: string) => {
      perEndpoint[endpoint] = (perEndpoint[endpoint] ?? 0) + 1;
      if (endpoint === "/agents/authorize/approve" && perEndpoint[endpoint] > 5) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 });
      }
      return null;
    });
    mockGetSession.mockResolvedValue(ADMIN_SESSION);
    mockLookupDeviceCodeByUserCode.mockResolvedValue(null); // 404 path

    const { route } = makeApprove();
    const responses: Response[] = [];
    for (let i = 0; i < 6; i++) {
      const req = makeRequest("/agents/authorize/approve", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "user_code=BCDF-GHJK",
      });
      responses.push(
        await route.handler(req, ENV, {
          url: new URL(req.url),
          pathname: "/agents/authorize/approve",
          params: {},
        }),
      );
    }
    // The first 5 are not rate-limited (will return 404 for missing user_code).
    // The 6th must be 429.
    for (let i = 0; i < 5; i++) {
      expect(responses[i]!.status).not.toBe(429);
    }
    expect(responses[5]!.status).toBe(429);
  });

  it("CRITICAL-3: global ceiling fires regardless of per-IP bucket", async () => {
    // The global ceiling is queried first; once that bucket is full the
    // per-IP bucket never gets touched. We model that by failing only
    // the `:global` keyspace.
    mockApplyRateLimitKV.mockImplementation(async (_env, _req, endpoint: string) => {
      if (endpoint.endsWith(":global")) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 });
      }
      return null;
    });
    mockGetSession.mockResolvedValue(ADMIN_SESSION);

    const { route, request } = makeApprove();
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize/approve",
      params: {},
    });
    expect(response.status).toBe(429);
  });

  it("HIGH-5: refuses approval when the cognito sub cannot be resolved from the User row", async () => {
    mockFindUser.mockResolvedValue(null);
    mockGetSession.mockResolvedValue(ADMIN_SESSION);
    const { route, request } = makeApprove();
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize/approve",
      params: {},
    });
    // buildAuthContext returns null when subject is missing → 401.
    expect(response.status).toBe(401);
  });

  it("returns 401 mfa_required when MFA is stale", async () => {
    mockGetSession.mockResolvedValue({ ...ADMIN_SESSION, mfaVerifiedAt: Date.now() - 90 * 60 * 1000 });
    const { route, request } = makeApprove();
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize/approve",
      params: {},
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("MFA_REQUIRED");
  });

  it("returns 401 when no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const { route, request } = makeApprove();
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize/approve",
      params: {},
    });
    expect(response.status).toBe(401);
  });

  it("returns 410 device_code_locked when failed lookups exceeded the threshold (sec finding #3)", async () => {
    mockGetSession.mockResolvedValue(ADMIN_SESSION);
    mockLookupDeviceCodeByUserCode.mockResolvedValue("dc-locked");
    mockLoadByDeviceCode.mockResolvedValue({
      deviceCode: "dc-locked",
      userCodeHash: "matching",
      status: "pending",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      createdAt: Math.floor(Date.now() / 1000),
      interval: 5,
      failedLookups: 10,
    });
    // Stub the user_code hash mismatch path so we go through increment.
    const original = await import("../../../../src/lib/oauth/device-authorization.js");
    const realHash = original.hashUserCode;
    const userCodeNormalised = original.normaliseUserCode("BCDF-GHJK");
    const matchingHash = realHash(userCodeNormalised);
    mockLoadByDeviceCode.mockResolvedValue({
      deviceCode: "dc-locked",
      userCodeHash: matchingHash,
      status: "pending",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      createdAt: Math.floor(Date.now() / 1000),
      interval: 5,
      failedLookups: 10,
    });

    const { route, request } = makeApprove();
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize/approve",
      params: {},
    });
    expect(response.status).toBe(410);
  });

  it("approves the session, calls issuer, seals tokens, writes session row", async () => {
    mockGetSession.mockResolvedValue(ADMIN_SESSION);
    mockLookupDeviceCodeByUserCode.mockResolvedValue("dc-good");
    const original = await import("../../../../src/lib/oauth/device-authorization.js");
    const userCodeNormalised = original.normaliseUserCode("BCDF-GHJK");
    const matchingHash = original.hashUserCode(userCodeNormalised);
    mockLoadByDeviceCode.mockResolvedValue({
      deviceCode: "dc-good",
      userCodeHash: matchingHash,
      status: "pending",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      createdAt: Math.floor(Date.now() / 1000),
      interval: 5,
      failedLookups: 0,
      agentLabel: "claude-code/1.0",
    });
    mockIssueForAgent.mockResolvedValue({
      access_token: "AT",
      refresh_token: "RT",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const { route, request } = makeApprove();
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize/approve",
      params: {},
    });
    expect(response.status).toBe(200);
    expect(mockIssueForAgent).toHaveBeenCalledTimes(1);
    expect(mockApproveDeviceAuth).toHaveBeenCalledTimes(1);
    expect(mockRecordAgentSession).toHaveBeenCalledTimes(1);

    // HIGH-5: the issuer + the persisted session row must use the real
    // Cognito sub resolved from the User table — not the trellis user id.
    const issuerCall = mockIssueForAgent.mock.calls[0]![0] as { username: string };
    expect(issuerCall.username).toBe("cognito-sub-admin");
    const recordCall = mockRecordAgentSession.mock.calls[0]![0] as {
      session: { sub: string };
    };
    expect(recordCall.session.sub).toBe("cognito-sub-admin");
  });

  it("returns 404 when user_code does not resolve", async () => {
    mockGetSession.mockResolvedValue(ADMIN_SESSION);
    mockLookupDeviceCodeByUserCode.mockResolvedValue(null);

    const { route, request } = makeApprove();
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize/approve",
      params: {},
    });
    expect(response.status).toBe(404);
  });

  it("increments failed lookups on user_code mismatch", async () => {
    mockGetSession.mockResolvedValue(ADMIN_SESSION);
    mockLookupDeviceCodeByUserCode.mockResolvedValue("dc-mismatch");
    mockLoadByDeviceCode.mockResolvedValue({
      deviceCode: "dc-mismatch",
      userCodeHash: "different-hash",
      status: "pending",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      createdAt: Math.floor(Date.now() / 1000),
      interval: 5,
      failedLookups: 0,
    });
    mockIncrementFailedLookup.mockResolvedValue(1);

    const { route, request } = makeApprove();
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/agents/authorize/approve",
      params: {},
    });
    expect(response.status).toBe(404);
    expect(mockIncrementFailedLookup).toHaveBeenCalledWith("dc-mismatch");
  });
});
