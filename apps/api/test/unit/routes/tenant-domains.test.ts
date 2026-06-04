/**
 * Unit tests: tenant-domain routes (claim, list, delete, verify).
 *
 * Baseline route contract: registration shape + every route rejects an
 * unauthenticated request with 401 (no auth bypass on domain management).
 * The 401 path returns before any DomainHandler/DB work, so mocking
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

import { tenantDomainRoutes } from "../../../src/lib/routes/tenant-domains.js";

const mockEnv = { SESSION_SECRET: "test-secret-32-characters-long!!" } as any;

// ── Registration ─────────────────────────────────────────────────────────────

describe("tenantDomainRoutes: registration", () => {
  it("registers at least 4 routes covering the documented surface", () => {
    expect(tenantDomainRoutes.length).toBeGreaterThanOrEqual(4);
  });

  it("every route has a path, string method, handler function, description, and middleware", () => {
    for (const route of tenantDomainRoutes) {
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

  it("covers POST, GET, and DELETE methods (including the verify POST)", () => {
    const methods = tenantDomainRoutes.map((r) =>
      Array.isArray(r.method) ? r.method[0] : r.method,
    );
    expect(methods).toContain("POST");
    expect(methods).toContain("GET");
    expect(methods).toContain("DELETE");
    // Two POST routes: claim + verify
    expect(methods.filter((m) => m === "POST").length).toBeGreaterThanOrEqual(2);
  });

  it("guards every POST and DELETE route with CSRF middleware (length >= 2)", () => {
    const mutating = tenantDomainRoutes.filter(
      (r) => r.method === "POST" || r.method === "DELETE",
    );
    expect(mutating.length, "there should be at least 3 mutating routes").toBeGreaterThanOrEqual(3);
    for (const r of mutating) {
      expect(
        r.middleware!.length,
        `mutating route "${r.description}" should carry CSRF (+CORS), middleware.length >= 2`,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});

// ── Auth gating ───────────────────────────────────────────────────────────────

describe("tenantDomainRoutes: auth gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue(null); // unauthenticated
  });

  /**
   * Pick a realistic pathname that satisfies the route's path regex.
   * BASE_RE  → /api/tenants/:id/domains
   * MEMBER_RE → /api/tenants/:id/domains/:domainId
   * VERIFY_RE → /api/tenants/:id/domains/:domainId/verify
   */
  function pathnameFor(route: (typeof tenantDomainRoutes)[number]): string {
    const p = route.path;
    if (p instanceof RegExp) {
      const src = p.source;
      if (src.includes("/verify")) return "/api/tenants/t1/domains/d1/verify";
      if (src.includes("domains\\/")) return "/api/tenants/t1/domains/d1";
    }
    return "/api/tenants/t1/domains";
  }

  it("every route returns 401 when authMiddleware yields no context", async () => {
    for (const route of tenantDomainRoutes) {
      const method = Array.isArray(route.method) ? route.method[0] : route.method!;
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
        `route "${route.description}" (${method}) must reject unauthenticated access with 401`,
      ).toBe(401);
    }

    expect(authMock).toHaveBeenCalledTimes(tenantDomainRoutes.length);
  });
});
