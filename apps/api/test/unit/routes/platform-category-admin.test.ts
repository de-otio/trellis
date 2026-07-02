/**
 * Unit Tests: platform-category-admin routes
 *
 * Covers:
 *   - Route registration shape (path, method, middleware, description)
 *   - Every route returns 401 when authMiddleware yields no context
 *   - Every route delegates to PlatformCategoryAdminHandler when auth is present
 *
 * The handler itself is mocked — handler-level logic is tested in
 * platform-category-admin-handler.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));

vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: authMock,
}));

const { mockHandleCreate, mockHandleDeactivate, mockHandleReparent } = vi.hoisted(() => ({
  mockHandleCreate: vi.fn(),
  mockHandleDeactivate: vi.fn(),
  mockHandleReparent: vi.fn(),
}));

vi.mock("../../../src/lib/tenant/platform-category-admin-handler", () => ({
  PlatformCategoryAdminHandler: class {
    handleCreate = mockHandleCreate;
    handleDeactivate = mockHandleDeactivate;
    handleReparent = mockHandleReparent;
  },
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

import { platformCategoryAdminRoutes } from "../../../src/lib/routes/platform-category-admin.js";

const mockEnv = { DATABASE_URL: "postgresql://test" } as any;

// A minimal SUPER_ADMIN auth context.
const mockAuth = {
  userId: "super-id",
  globalRole: "SUPER_ADMIN",
  activeTenantId: "platform-tenant",
  tenantSlug: "platform",
  tenantRole: "OWNER",
  handle: "admin",
  cognitoSub: "sub-super",
  membershipsLoader: async () => [],
};

function makeRouteContext(pathname: string) {
  return {
    url: new URL(`https://api.example.com${pathname}`),
    pathname,
    params: {},
    requestContext: undefined as any,
  };
}

function makeRequest(method: string, pathname: string, body?: unknown): Request {
  return new Request(`https://api.example.com${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

describe("platformCategoryAdminRoutes: registration shape", () => {
  it("registers 3 routes", () => {
    expect(platformCategoryAdminRoutes).toHaveLength(3);
  });

  it("every route has a description and middleware", () => {
    for (const route of platformCategoryAdminRoutes) {
      expect(route.description).toBeTruthy();
      expect(Array.isArray(route.middleware)).toBe(true);
      expect(route.middleware!.length).toBeGreaterThanOrEqual(2); // CORS + CSRF
    }
  });

  it("all routes are POST", () => {
    for (const route of platformCategoryAdminRoutes) {
      expect(route.method).toBe("POST");
    }
  });
});

describe("platformCategoryAdminRoutes: auth gating (401)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue(null); // unauthenticated
  });

  it("POST /api/admin/platform-categories returns 401 when unauthenticated", async () => {
    const [createRoute] = platformCategoryAdminRoutes;
    const pathname = "/api/admin/platform-categories";
    const response = await createRoute.handler(
      makeRequest("POST", pathname, { code: "nonprofit", displayName: "Nonprofit" }),
      mockEnv,
      makeRouteContext(pathname),
    );
    expect(response.status).toBe(401);
  });

  it("POST /api/admin/platform-categories/:id/deactivate returns 401 when unauthenticated", async () => {
    const deactivateRoute = platformCategoryAdminRoutes[1];
    const pathname = "/api/admin/platform-categories/cat-01/deactivate";
    const response = await deactivateRoute.handler(
      makeRequest("POST", pathname, {}),
      mockEnv,
      makeRouteContext(pathname),
    );
    expect(response.status).toBe(401);
  });

  it("POST /api/admin/platform-categories/:id/reparent returns 401 when unauthenticated", async () => {
    const reparentRoute = platformCategoryAdminRoutes[2];
    const pathname = "/api/admin/platform-categories/cat-01/reparent";
    const response = await reparentRoute.handler(
      makeRequest("POST", pathname, { newParentCategoryId: "other-id" }),
      mockEnv,
      makeRouteContext(pathname),
    );
    expect(response.status).toBe(401);
  });
});

describe("platformCategoryAdminRoutes: delegation to handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue(mockAuth);
  });

  it("POST /api/admin/platform-categories calls handleCreate", async () => {
    mockHandleCreate.mockResolvedValue(new Response(JSON.stringify({ id: "cat-01" }), { status: 201 }));

    const [createRoute] = platformCategoryAdminRoutes;
    const pathname = "/api/admin/platform-categories";
    const response = await createRoute.handler(
      makeRequest("POST", pathname, { code: "nonprofit", displayName: "Nonprofit" }),
      mockEnv,
      makeRouteContext(pathname),
    );

    expect(mockHandleCreate).toHaveBeenCalledOnce();
    expect(response.status).toBe(201);
  });

  it("POST /api/admin/platform-categories/:id/deactivate calls handleDeactivate", async () => {
    mockHandleDeactivate.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const deactivateRoute = platformCategoryAdminRoutes[1];
    const pathname = "/api/admin/platform-categories/cat-01/deactivate";
    const response = await deactivateRoute.handler(
      makeRequest("POST", pathname, {}),
      mockEnv,
      makeRouteContext(pathname),
    );

    expect(mockHandleDeactivate).toHaveBeenCalledOnce();
    // Verify that the extracted categoryId was passed correctly.
    const [calledCategoryId] = mockHandleDeactivate.mock.calls[0];
    expect(calledCategoryId).toBe("cat-01");
    expect(response.status).toBe(200);
  });

  it("POST /api/admin/platform-categories/:id/reparent calls handleReparent", async () => {
    mockHandleReparent.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const reparentRoute = platformCategoryAdminRoutes[2];
    const pathname = "/api/admin/platform-categories/cat-02/reparent";
    const response = await reparentRoute.handler(
      makeRequest("POST", pathname, { newParentCategoryId: "other-id" }),
      mockEnv,
      makeRouteContext(pathname),
    );

    expect(mockHandleReparent).toHaveBeenCalledOnce();
    const [calledCategoryId] = mockHandleReparent.mock.calls[0];
    expect(calledCategoryId).toBe("cat-02");
    expect(response.status).toBe(200);
  });
});
