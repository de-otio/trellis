/**
 * Unit tests: tenant-directory-profile routes
 *
 * Registration shape + auth-gating contract:
 *   - Three routes exported: POST, PATCH, GET.
 *   - Every route rejects an unauthenticated caller with 401.
 *   - POST and PATCH carry CSRF middleware (length >= 2).
 *   - GET carries only CORS middleware (no CSRF for read-only).
 *
 * The DirectoryProfileHandler is mocked so route-level tests don't
 * re-exercise handler logic — those live in directory-profile-handler.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));

vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: authMock,
}));

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

// Mock the handler so routes tests don't depend on DB.
const mockHandleCreate = vi.fn();
const mockHandleUpdate = vi.fn();
const mockHandleGet = vi.fn();

vi.mock("../../../src/lib/tenant/directory-profile-handler", () => ({
  DirectoryProfileHandler: class {
    handleCreate = mockHandleCreate;
    handleUpdate = mockHandleUpdate;
    handleGet = mockHandleGet;
    constructor(_config?: unknown) {}
  },
}));

import { tenantDirectoryProfileRoutes } from "../../../src/lib/routes/tenant-directory-profile.js";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const mockEnv: Env = {
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  SESSION_SECRET: "test-secret-32-characters-long!!",
} as Env;

const TENANT_ID = "ctenantaaa0000000000000001";
const PROFILE_PATH = `/api/tenants/${TENANT_ID}/directory-profile`;

const mockAuthContext = {
  userId: "cuseradmin0000000000000001",
  activeTenantId: TENANT_ID,
  tenantRole: "ADMIN",
  globalRole: "END_USER",
};

// ─── Registration tests ───────────────────────────────────────────────────────

describe("tenantDirectoryProfileRoutes: registration", () => {
  it("exports exactly 3 routes (POST, PATCH, GET)", () => {
    expect(tenantDirectoryProfileRoutes).toHaveLength(3);
  });

  it("every route has a path, method, handler, description, and middleware", () => {
    for (const route of tenantDirectoryProfileRoutes) {
      expect(route.path, "path must be defined").toBeDefined();
      expect(typeof route.method, "method must be a string").toBe("string");
      expect(typeof route.handler, "handler must be a function").toBe("function");
      expect(route.description, "description must be truthy").toBeTruthy();
      expect(Array.isArray(route.middleware), "middleware must be an array").toBe(true);
      expect(
        route.middleware!.length,
        `route "${route.description}" must have at least one middleware`,
      ).toBeGreaterThan(0);
    }
  });

  it("covers POST, PATCH, and GET methods", () => {
    const methods = tenantDirectoryProfileRoutes.map((r) =>
      Array.isArray(r.method) ? r.method[0] : r.method,
    );
    expect(methods).toContain("POST");
    expect(methods).toContain("PATCH");
    expect(methods).toContain("GET");
  });

  it("mutating routes (POST, PATCH) carry CSRF middleware (>= 2 middleware entries)", () => {
    const mutating = tenantDirectoryProfileRoutes.filter(
      (r) => r.method === "POST" || r.method === "PATCH",
    );
    expect(mutating).toHaveLength(2);
    for (const r of mutating) {
      expect(
        r.middleware!.length,
        `mutating route "${r.description}" must carry CSRF (+CORS), middleware.length >= 2`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("GET route has only CORS middleware (no CSRF for read-only)", () => {
    const getRoute = tenantDirectoryProfileRoutes.find((r) => r.method === "GET");
    expect(getRoute).toBeDefined();
    // GET carries cors only (length 1).
    expect(getRoute!.middleware!.length).toBe(1);
  });

  it("all routes match the expected path regex", () => {
    const expectedPath = PROFILE_RE_SOURCE;
    for (const route of tenantDirectoryProfileRoutes) {
      const p = route.path;
      expect(p instanceof RegExp, `route "${route.description}" path should be a RegExp`).toBe(true);
      expect(
        (p as RegExp).test(PROFILE_PATH),
        `route "${route.description}" regex should match ${PROFILE_PATH}`,
      ).toBe(true);
      // Must NOT match a sub-path like /api/tenants/:id/directory-profile/extra
      expect(
        (p as RegExp).test(`${PROFILE_PATH}/extra`),
        `route "${route.description}" regex must not match sub-paths`,
      ).toBe(false);
    }
  });
});

// Helper: the expected regex source for the profile route.
const PROFILE_RE_SOURCE = /^\/api\/tenants\/([^/]+)\/directory-profile$/.test(PROFILE_PATH);

// ─── Auth gating ──────────────────────────────────────────────────────────────

describe("tenantDirectoryProfileRoutes: auth gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue(null); // unauthenticated by default
  });

  async function invokeRoute(route: (typeof tenantDirectoryProfileRoutes)[number]): Promise<Response> {
    const method = Array.isArray(route.method) ? route.method[0] : route.method!;
    const init: RequestInit = { method };
    if (method !== "GET" && method !== "HEAD") {
      init.body = JSON.stringify({});
      init.headers = { "content-type": "application/json" };
    }
    const request = new Request(`https://api.example.com${PROFILE_PATH}`, init);
    return route.handler(request, mockEnv, {
      url: new URL(`https://api.example.com${PROFILE_PATH}`),
      pathname: PROFILE_PATH,
      params: {},
      requestContext: undefined,
    } as any);
  }

  it("every route returns 401 when authMiddleware yields no context", async () => {
    for (const route of tenantDirectoryProfileRoutes) {
      const res = await invokeRoute(route);
      expect(
        res.status,
        `route "${route.description}" must reject unauthenticated access with 401`,
      ).toBe(401);
    }
    expect(authMock).toHaveBeenCalledTimes(tenantDirectoryProfileRoutes.length);
  });

  it("handler is NOT called when auth fails (handler mocks remain untouched)", async () => {
    for (const route of tenantDirectoryProfileRoutes) {
      await invokeRoute(route);
    }
    expect(mockHandleCreate).not.toHaveBeenCalled();
    expect(mockHandleUpdate).not.toHaveBeenCalled();
    expect(mockHandleGet).not.toHaveBeenCalled();
  });
});

// ─── Authenticated dispatch ───────────────────────────────────────────────────

describe("tenantDirectoryProfileRoutes: authenticated dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue(mockAuthContext);
    mockHandleCreate.mockResolvedValue(new Response("{}", { status: 201 }));
    mockHandleUpdate.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleGet.mockResolvedValue(new Response("{}", { status: 200 }));
  });

  it("POST route dispatches to handleCreate with the resolved tenantId", async () => {
    const postRoute = tenantDirectoryProfileRoutes.find((r) => r.method === "POST")!;
    const request = new Request(`https://api.example.com${PROFILE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isDiscoverable: true }),
    });

    const res = await postRoute.handler(request, mockEnv, {
      url: new URL(`https://api.example.com${PROFILE_PATH}`),
      pathname: PROFILE_PATH,
      params: {},
      requestContext: undefined,
    } as any);

    expect(res.status).toBe(201);
    expect(mockHandleCreate).toHaveBeenCalledOnce();
    // First argument to handleCreate is the tenantId extracted from the path.
    const [calledTenantId] = mockHandleCreate.mock.calls[0] as [string, ...unknown[]];
    expect(calledTenantId).toBe(TENANT_ID);
  });

  it("PATCH route dispatches to handleUpdate with the resolved tenantId", async () => {
    const patchRoute = tenantDirectoryProfileRoutes.find((r) => r.method === "PATCH")!;
    const request = new Request(`https://api.example.com${PROFILE_PATH}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isDiscoverable: false }),
    });

    const res = await patchRoute.handler(request, mockEnv, {
      url: new URL(`https://api.example.com${PROFILE_PATH}`),
      pathname: PROFILE_PATH,
      params: {},
      requestContext: undefined,
    } as any);

    expect(res.status).toBe(200);
    expect(mockHandleUpdate).toHaveBeenCalledOnce();
    const [calledTenantId] = mockHandleUpdate.mock.calls[0] as [string, ...unknown[]];
    expect(calledTenantId).toBe(TENANT_ID);
  });

  it("GET route dispatches to handleGet with the resolved tenantId", async () => {
    const getRoute = tenantDirectoryProfileRoutes.find((r) => r.method === "GET")!;
    const request = new Request(`https://api.example.com${PROFILE_PATH}`, { method: "GET" });

    const res = await getRoute.handler(request, mockEnv, {
      url: new URL(`https://api.example.com${PROFILE_PATH}`),
      pathname: PROFILE_PATH,
      params: {},
      requestContext: undefined,
    } as any);

    expect(res.status).toBe(200);
    expect(mockHandleGet).toHaveBeenCalledOnce();
    const [calledTenantId] = mockHandleGet.mock.calls[0] as [string, ...unknown[]];
    expect(calledTenantId).toBe(TENANT_ID);
  });
});
