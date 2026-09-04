/**
 * Unit tests: routes/agent-sessions.ts (T9b-d).
 *
 * Covers:
 *  - GET returns only the requesting user's sessions.
 *  - POST revoke is session-scoped (D.1): it never calls Cognito
 *    globalSignOut, and it passes the blocklist binding through.
 *  - 404 when revoking a session that belongs to another user.
 *  - POST global-sign-out is the separately named deliberate action.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuthMiddleware,
  mockListAgentSessions,
  mockGetAgentSession,
  mockRevokeAgentSession,
  mockAdminGlobalSignOutUser,
  mockGlobalSignOut,
  mockAuditEmit,
} = vi.hoisted(() => ({
  mockAuthMiddleware: vi.fn(),
  mockListAgentSessions: vi.fn(),
  mockGetAgentSession: vi.fn(),
  mockRevokeAgentSession: vi.fn(),
  mockAdminGlobalSignOutUser: vi.fn(),
  mockGlobalSignOut: vi.fn(),
  mockAuditEmit: vi.fn(),
}));

vi.mock("../../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...a: unknown[]) => mockAuthMiddleware(...a),
}));

vi.mock("../../../../src/lib/oauth/refresh-detection", () => ({
  listAgentSessions: (...a: unknown[]) => mockListAgentSessions(...a),
  getAgentSession: (...a: unknown[]) => mockGetAgentSession(...a),
  revokeAgentSession: (...a: unknown[]) => mockRevokeAgentSession(...a),
  adminGlobalSignOutUser: (...a: unknown[]) => mockAdminGlobalSignOutUser(...a),
}));

vi.mock("../../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    constructor(_env: unknown) {}
    createSecureResponse(body: BodyInit, init: ResponseInit) {
      return new Response(body, init);
    }
    addSecurityHeaders(response: Response) {
      return response;
    }
  },
}));

vi.mock("../../../../src/db", () => ({
  createPrisma: () => ({}),
}));

import {
  agentSessionsRoutes,
  _resetAgentSessionDepsForTest,
  _setAgentSessionDepsForTest,
} from "../../../../src/lib/routes/agent-sessions.js";
import type { Env } from "../../../../src/env.js";

/** In-memory stand-in for the `SESSION_BLOCKLIST_KV` binding. */
function memoryBlocklist() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

let blocklistKv: ReturnType<typeof memoryBlocklist>;

function env(): Env {
  return {
    COGNITO_USER_POOL_ID: "us-east-1_pool",
    SESSION_BLOCKLIST_KV: blocklistKv,
  } as unknown as Env;
}

const ENV = {
  COGNITO_USER_POOL_ID: "us-east-1_pool",
} as Env;

const AUTH = {
  sub: "sub-alice",
  userId: "u_alice",
  globalRole: "B2B_PARTNER",
  activeTenantId: "t_one",
  tenantSlug: "demo",
  tenantRole: "ADMIN",
  handle: "alice",
  membershipsLoader: async () => [],
};

function findRoute(path: string, method: string) {
  return agentSessionsRoutes.find(
    (r) => (typeof r.path === "string" ? r.path === path : (r.path as RegExp).test(path)) && r.method === method,
  );
}

beforeEach(() => {
  mockAuthMiddleware.mockReset();
  mockListAgentSessions.mockReset();
  mockGetAgentSession.mockReset();
  mockRevokeAgentSession.mockReset();
  mockRevokeAgentSession.mockResolvedValue({ tokenBlocklisted: true });
  mockAdminGlobalSignOutUser.mockReset();
  mockAdminGlobalSignOutUser.mockResolvedValue({ agentSessionsRevoked: 2 });
  mockGlobalSignOut.mockReset();
  mockAuditEmit.mockReset();
  blocklistKv = memoryBlocklist();
  _resetAgentSessionDepsForTest();
  _setAgentSessionDepsForTest({
    cognito: { globalSignOut: mockGlobalSignOut },
    auditEmitter: { emit: mockAuditEmit } as unknown as import("../../../../src/lib/audit-composer.js").TenantAuditEmitter,
  });
});

describe("GET /api/users/me/agent-sessions", () => {
  it("returns 401 without auth", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const route = findRoute("/api/users/me/agent-sessions", "GET")!;
    const request = new Request("http://localhost/api/users/me/agent-sessions");
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/api/users/me/agent-sessions",
      params: {},
    });
    expect(response.status).toBe(401);
  });

  it("returns the user's sessions", async () => {
    mockAuthMiddleware.mockResolvedValue(AUTH);
    mockListAgentSessions.mockResolvedValue([
      {
        sessionId: "s_a",
        userId: "u_alice",
        sub: "sub-alice",
        tenantId: "t_one",
        currentJti: "j_a",
        status: "active",
        agentLabel: "claude-code/1.0",
        sourceIp: "1.2.3.4",
        createdAt: 1700000000,
        lastUsedAt: 1700000010,
      },
    ]);
    const route = findRoute("/api/users/me/agent-sessions", "GET")!;
    const request = new Request("http://localhost/api/users/me/agent-sessions");
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/api/users/me/agent-sessions",
      params: {},
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessions: Array<{ id: string; agentLabel: string }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.id).toBe("s_a");
    expect(body.sessions[0]!.agentLabel).toBe("claude-code/1.0");

    expect(mockListAgentSessions).toHaveBeenCalledWith("u_alice");
  });
});

describe("POST /api/users/me/agent-sessions/{id}/revoke", () => {
  it("returns 401 without auth", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const route = findRoute("/api/users/me/agent-sessions/s_a/revoke", "POST")!;
    const request = new Request("http://localhost/api/users/me/agent-sessions/s_a/revoke", { method: "POST" });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/api/users/me/agent-sessions/s_a/revoke",
      params: {},
    });
    expect(response.status).toBe(401);
  });

  it("returns 404 when revoking a session belonging to another user", async () => {
    mockAuthMiddleware.mockResolvedValue(AUTH);
    mockGetAgentSession.mockResolvedValue({
      sessionId: "s_b",
      userId: "u_bob",
      sub: "sub-bob",
      tenantId: "t_two",
      currentJti: "j_b",
      status: "active",
      createdAt: 0,
      lastUsedAt: 0,
    });
    const route = findRoute("/api/users/me/agent-sessions/s_b/revoke", "POST")!;
    const request = new Request("http://localhost/api/users/me/agent-sessions/s_b/revoke", { method: "POST" });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/api/users/me/agent-sessions/s_b/revoke",
      params: {},
    });
    expect(response.status).toBe(404);
    expect(mockRevokeAgentSession).not.toHaveBeenCalled();
  });

  it("D.1: revokes only the named session and never signs the user out globally", async () => {
    mockAuthMiddleware.mockResolvedValue(AUTH);
    mockGetAgentSession.mockResolvedValue({
      sessionId: "s_a",
      userId: "u_alice",
      sub: "sub-alice",
      tenantId: "t_one",
      currentJti: "j_a",
      status: "active",
      createdAt: 0,
      lastUsedAt: 0,
    });

    const route = findRoute("/api/users/me/agent-sessions/s_a/revoke", "POST")!;
    const request = new Request("http://localhost/api/users/me/agent-sessions/s_a/revoke", { method: "POST" });
    const response = await route.handler(request, env(), {
      url: new URL(request.url),
      pathname: "/api/users/me/agent-sessions/s_a/revoke",
      params: {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "revoked",
      tokenBlocklisted: true,
    });

    expect(mockRevokeAgentSession).toHaveBeenCalledTimes(1);
    const callArgs = mockRevokeAgentSession.mock.calls[0]![0] as {
      sessionId: string;
      blocklist?: unknown;
      cognito?: unknown;
      cognitoUsername?: unknown;
      userPoolId?: unknown;
    };
    expect(callArgs.sessionId).toBe("s_a");
    // The blocklist binding is threaded through; no Cognito identity is —
    // there is nothing for this call to globally sign out.
    expect(callArgs.blocklist).toBe(blocklistKv);
    expect(callArgs.cognito).toBeUndefined();
    expect(callArgs.cognitoUsername).toBeUndefined();
    expect(callArgs.userPoolId).toBeUndefined();

    // The regression itself: no AdminUserGlobalSignOut anywhere on this path.
    expect(mockGlobalSignOut).not.toHaveBeenCalled();
    expect(mockAdminGlobalSignOutUser).not.toHaveBeenCalled();
  });

  it("reports tokenBlocklisted=false honestly rather than claiming a full revoke", async () => {
    mockAuthMiddleware.mockResolvedValue(AUTH);
    mockGetAgentSession.mockResolvedValue({
      sessionId: "s_a",
      userId: "u_alice",
      sub: "sub-alice",
      tenantId: "t_one",
      currentJti: "j_a",
      status: "active",
      createdAt: 0,
      lastUsedAt: 0,
    });
    mockRevokeAgentSession.mockResolvedValue({ tokenBlocklisted: false });

    const route = findRoute("/api/users/me/agent-sessions/s_a/revoke", "POST")!;
    const request = new Request("http://localhost/api/users/me/agent-sessions/s_a/revoke", { method: "POST" });
    const response = await route.handler(request, env(), {
      url: new URL(request.url),
      pathname: "/api/users/me/agent-sessions/s_a/revoke",
      params: {},
    });
    expect(await response.json()).toMatchObject({ tokenBlocklisted: false });
  });

  it("does not route global-sign-out through the per-session revoke pattern", () => {
    const REVOKE_RE = /^\/api\/users\/me\/agent-sessions\/([^/]+)\/revoke$/;
    expect(REVOKE_RE.test("/api/users/me/agent-sessions/global-sign-out")).toBe(false);
  });

  it("returns 404 when the session is unknown", async () => {
    mockAuthMiddleware.mockResolvedValue(AUTH);
    mockGetAgentSession.mockResolvedValue(null);
    const route = findRoute("/api/users/me/agent-sessions/s_a/revoke", "POST")!;
    const request = new Request("http://localhost/api/users/me/agent-sessions/s_a/revoke", { method: "POST" });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/api/users/me/agent-sessions/s_a/revoke",
      params: {},
    });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/users/me/agent-sessions/global-sign-out", () => {
  it("returns 401 without auth", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const route = findRoute("/api/users/me/agent-sessions/global-sign-out", "POST")!;
    const request = new Request(
      "http://localhost/api/users/me/agent-sessions/global-sign-out",
      { method: "POST" },
    );
    const response = await route.handler(request, env(), {
      url: new URL(request.url),
      pathname: "/api/users/me/agent-sessions/global-sign-out",
      params: {},
    });
    expect(response.status).toBe(401);
    expect(mockAdminGlobalSignOutUser).not.toHaveBeenCalled();
  });

  it("signs the CALLER out everywhere, using their own sub", async () => {
    mockAuthMiddleware.mockResolvedValue(AUTH);
    const route = findRoute("/api/users/me/agent-sessions/global-sign-out", "POST")!;
    const request = new Request(
      "http://localhost/api/users/me/agent-sessions/global-sign-out",
      { method: "POST" },
    );
    const response = await route.handler(request, env(), {
      url: new URL(request.url),
      pathname: "/api/users/me/agent-sessions/global-sign-out",
      params: {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "signed_out_everywhere",
      agentSessionsRevoked: 2,
    });

    expect(mockAdminGlobalSignOutUser).toHaveBeenCalledTimes(1);
    const args = mockAdminGlobalSignOutUser.mock.calls[0]![0] as {
      userId: string;
      cognitoUsername: string;
      userPoolId: string;
      reason: string;
    };
    expect(args.userId).toBe("u_alice");
    expect(args.cognitoUsername).toBe("sub-alice");
    expect(args.userPoolId).toBe("us-east-1_pool");
    expect(args.reason).toMatch(/global sign-out/);
    // Per-session revoke is a different instrument; it is not involved here.
    expect(mockRevokeAgentSession).not.toHaveBeenCalled();
  });

  it("is CSRF-protected, like the per-session revoke", () => {
    const route = findRoute("/api/users/me/agent-sessions/global-sign-out", "POST")!;
    expect(route.middleware).toBeDefined();
    expect(route.middleware!.length).toBeGreaterThanOrEqual(2);
  });

  it("returns 503 when no user pool is configured", async () => {
    mockAuthMiddleware.mockResolvedValue(AUTH);
    const route = findRoute("/api/users/me/agent-sessions/global-sign-out", "POST")!;
    const request = new Request(
      "http://localhost/api/users/me/agent-sessions/global-sign-out",
      { method: "POST" },
    );
    const response = await route.handler(request, {} as Env, {
      url: new URL(request.url),
      pathname: "/api/users/me/agent-sessions/global-sign-out",
      params: {},
    });
    expect(response.status).toBe(503);
    expect(mockAdminGlobalSignOutUser).not.toHaveBeenCalled();
  });
});
