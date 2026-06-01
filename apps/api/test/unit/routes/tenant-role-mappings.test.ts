/**
 * Unit tests: tenant role-mapping routes.
 *
 * Covers:
 *  - Registration shape (path / method / handler / description / middleware).
 *  - CSRF guarding on every mutating route (POST/PATCH/DELETE).
 *  - Auth-gating: every route returns 401 when authMiddleware yields null.
 *
 * Auth returns null → handler returns before touching RoleMappingHandler/DB,
 * so no database or handler mocks are needed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));

vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: authMock,
  // requireActiveTenant is imported by role-mapping-handler, not routes —
  // the route returns before reaching the handler, so no stub needed here.
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

import { tenantRoleMappingRoutes } from "../../../src/lib/routes/tenant-role-mappings.js";

const mockEnv = { SESSION_SECRET: "test-secret-32-characters-long!!" } as any;

// Representative pathnames that satisfy each regex used in the route file.
// MAPPINGS_LIST routes  → /api/tenants/:id/role-mappings
// MAPPING_ITEM routes   → /api/tenants/:id/role-mappings/:mappingId
function pathnameFor(route: (typeof tenantRoleMappingRoutes)[number]): string {
  const path = route.path as RegExp;
  // Item-level pattern has two capture groups (tenant + mapping id).
  if (path.source.includes("role-mappings\\/")) {
    return "/api/tenants/tenant-1/role-mappings/mapping-1";
  }
  return "/api/tenants/tenant-1/role-mappings";
}

describe("tenantRoleMappingRoutes: registration", () => {
  it("exports a non-empty route array", () => {
    expect(Array.isArray(tenantRoleMappingRoutes)).toBe(true);
    expect(tenantRoleMappingRoutes.length).toBeGreaterThanOrEqual(4);
  });

  it("each route is well-formed (path, method, handler, description, middleware)", () => {
    for (const route of tenantRoleMappingRoutes) {
      // path: must be present (RegExp or string)
      expect(route.path, `route "${route.description}" must have a path`).toBeTruthy();

      // method: must be a non-empty string
      const method = Array.isArray(route.method) ? route.method[0] : route.method;
      expect(typeof method, `route "${route.description}" must have a string method`).toBe("string");
      expect((method as string).length).toBeGreaterThan(0);

      // handler: must be a function
      expect(
        typeof route.handler,
        `route "${route.description}" must expose a handler function`,
      ).toBe("function");

      // description: truthy
      expect(route.description, "route must have a truthy description").toBeTruthy();

      // middleware: non-empty array
      expect(
        Array.isArray(route.middleware),
        `route "${route.description}" must have a middleware array`,
      ).toBe(true);
      expect(
        route.middleware!.length,
        `route "${route.description}" must have at least one middleware`,
      ).toBeGreaterThan(0);
    }
  });

  it("covers the documented surface: GET + POST on list, PATCH + DELETE on item", () => {
    const methods = tenantRoleMappingRoutes.map((r) =>
      (Array.isArray(r.method) ? r.method[0] : r.method) as string,
    );
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(methods).toContain("PATCH");
    expect(methods).toContain("DELETE");
  });
});

describe("tenantRoleMappingRoutes: CSRF on mutating routes", () => {
  it("every POST/PATCH/DELETE route has at least 2 middleware (CORS + CSRF)", () => {
    const mutating = tenantRoleMappingRoutes.filter((r) => {
      const m = (Array.isArray(r.method) ? r.method[0] : r.method) as string;
      return m === "POST" || m === "PATCH" || m === "DELETE";
    });
    expect(mutating.length).toBeGreaterThan(0);
    for (const route of mutating) {
      expect(
        route.middleware!.length,
        `mutating route "${route.description}" must carry CORS + CSRF middleware`,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("tenantRoleMappingRoutes: auth gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue(null); // unauthenticated
  });

  it("every route returns 401 when authMiddleware yields null", async () => {
    for (const route of tenantRoleMappingRoutes) {
      const method = (Array.isArray(route.method) ? route.method[0] : route.method) as string;
      const pathname = pathnameFor(route);

      const init: RequestInit = { method };
      if (method !== "GET" && method !== "HEAD") {
        init.body = JSON.stringify({});
        init.headers = { "content-type": "application/json" };
      }
      const request = new Request(`https://api.example.com${pathname}`, init);

      const res = await route.handler(request, mockEnv, {
        url: new URL(`https://api.example.com${pathname}`),
        pathname,
        params: {},
        requestContext: undefined,
      } as any);

      expect(
        res.status,
        `route "${route.description}" (${method}) must reject unauthenticated request with 401`,
      ).toBe(401);
    }

    // authMiddleware must have been called exactly once per route.
    expect(authMock).toHaveBeenCalledTimes(tenantRoleMappingRoutes.length);
  });
});
