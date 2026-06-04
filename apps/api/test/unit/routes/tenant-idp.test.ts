/**
 * Unit tests: tenant-idp routes (identity-provider management).
 *
 * Baseline route contract: registration shape + every route rejects an
 * unauthenticated request with 401 (no auth bypass on IdP management).
 * The 401 path returns before any IdpHandler/DB work, so mocking
 * authMiddleware (no auth) + SecurityHeaders is sufficient.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { tenantIdpRoutes } from "../../../src/lib/routes/tenant-idp.js";

const mockEnv = { SESSION_SECRET: "test-secret-32-characters-long!!" } as any;

describe("tenant-idp routes: registration", () => {
  it("exports a non-empty route array covering the IdP surface", () => {
    expect(Array.isArray(tenantIdpRoutes)).toBe(true);
    expect(tenantIdpRoutes.length).toBeGreaterThanOrEqual(4); // POST GET PATCH DELETE
    for (const route of tenantIdpRoutes) {
      expect(route.path === undefined).toBe(false);
      expect(typeof route.handler).toBe("function");
      expect(route.description).toBeTruthy();
      expect(Array.isArray(route.middleware)).toBe(true);
      expect(route.middleware!.length).toBeGreaterThan(0);
    }
  });

  it("guards every mutating route with CSRF middleware (>= 2 middleware items)", () => {
    const mutating = tenantIdpRoutes.filter((r) =>
      ["POST", "PATCH", "PUT", "DELETE"].includes(
        Array.isArray(r.method) ? r.method[0]! : (r.method ?? ""),
      ),
    );
    expect(mutating.length).toBeGreaterThan(0);
    for (const r of mutating) {
      expect(
        r.middleware!.length,
        `mutating route "${r.description}" should carry CSRF in addition to CORS`,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("tenant-idp routes: auth gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue(null); // unauthenticated
  });

  it("every route returns 401 when authMiddleware yields no context", async () => {
    for (const route of tenantIdpRoutes) {
      const method = Array.isArray(route.method) ? route.method[0]! : route.method!;
      // Use a pathname that satisfies IDP_RE: /^\/api\/tenants\/([^/]+)\/identity-provider$/
      const pathname = "/api/tenants/tenant-x1/identity-provider";
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
        `route "${route.description}" (${method}) must gate unauthenticated access with 401`,
      ).toBe(401);
    }
    expect(authMock).toHaveBeenCalledTimes(tenantIdpRoutes.length);
  });
});
