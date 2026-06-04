/**
 * Unit tests: tenant routes (federation tenant CRUD).
 *
 * Baseline route contract: registration shape + every route rejects an
 * unauthenticated request with 401 (no auth bypass on tenant management).
 * The 401 path returns before any TenantHandler/DB work, so mocking
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

import { tenantRoutes } from "../../../src/lib/routes/tenants.js";

const mockEnv = { SESSION_SECRET: "test-secret-32-characters-long!!" } as any;

describe("tenant routes: registration", () => {
  it("registers the documented tenant surface", () => {
    expect(tenantRoutes.length).toBeGreaterThanOrEqual(6);
    for (const route of tenantRoutes) {
      expect(route.path === undefined).toBe(false);
      expect(typeof route.handler).toBe("function");
      expect(route.description).toBeTruthy();
      expect(Array.isArray(route.middleware)).toBe(true);
      expect(route.middleware!.length).toBeGreaterThan(0);
    }
  });

  it("guards every mutating route with CSRF middleware", () => {
    // POST/PATCH routes must carry more than the bare CORS middleware.
    const mutating = tenantRoutes.filter((r) => r.method === "POST" || r.method === "PATCH");
    expect(mutating.length).toBeGreaterThan(0);
    for (const r of mutating) {
      expect(
        r.middleware!.length,
        `mutating route "${r.description}" should attach CSRF (+CORS)`,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("tenant routes: auth gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue(null); // unauthenticated
  });

  it("every route returns 401 when authMiddleware yields no context", async () => {
    for (const route of tenantRoutes) {
      const method = Array.isArray(route.method) ? route.method[0] : route.method!;
      const pathname = "/api/tenants/tenant-123";
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
        `route "${route.description}" (${method}) must gate unauthenticated access`,
      ).toBe(401);
    }
    expect(authMock).toHaveBeenCalledTimes(tenantRoutes.length);
  });
});
