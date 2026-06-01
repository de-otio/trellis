/**
 * Unit tests: tenant-member routes (member list, role patch, member remove).
 *
 * Baseline route contract: registration shape + every route rejects an
 * unauthenticated request with 401 (no auth bypass on member management).
 * The 401 path returns before any MemberHandler/DB work, so mocking
 * authMiddleware (returning null) + SecurityHeaders is sufficient.
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

import { tenantMemberRoutes } from "../../../src/lib/routes/tenant-members.js";

const mockEnv = { SESSION_SECRET: "test-secret-32-characters-long!!" } as any;

// Canonical pathnames that match the two regexes defined in the route file.
// MEMBERS_LIST: /^\/api\/tenants\/([^/]+)\/members$/
// MEMBER_ITEM:  /^\/api\/tenants\/([^/]+)\/members\/([^/]+)$/
const LIST_PATHNAME = "/api/tenants/t1/members";
const ITEM_PATHNAME = "/api/tenants/t1/members/m1";

/** Pick a pathname that satisfies the route's path regex. */
function pathnameFor(route: (typeof tenantMemberRoutes)[number]): string {
  const pattern = route.path as RegExp;
  if (pattern.test(ITEM_PATHNAME)) {
    // MEMBER_ITEM regex matches both paths; prefer the more specific one.
    return ITEM_PATHNAME;
  }
  return LIST_PATHNAME;
}

describe("tenantMemberRoutes: registration", () => {
  it("exports a non-empty array", () => {
    expect(Array.isArray(tenantMemberRoutes)).toBe(true);
    expect(tenantMemberRoutes.length).toBeGreaterThan(0);
  });

  it("every route is well-formed (path, method, handler, description, middleware)", () => {
    for (const route of tenantMemberRoutes) {
      expect(route.path, "route must have a path").toBeTruthy();
      expect(
        typeof route.method === "string" || Array.isArray(route.method),
        "route.method must be a string or array",
      ).toBe(true);
      expect(typeof route.handler, "route.handler must be a function").toBe("function");
      expect(route.description, "route must have a description").toBeTruthy();
      expect(Array.isArray(route.middleware), "route.middleware must be an array").toBe(true);
      expect(
        route.middleware!.length,
        `route "${route.description}" must have at least one middleware`,
      ).toBeGreaterThan(0);
    }
  });

  it("covers the three documented HTTP methods (GET, PATCH, DELETE)", () => {
    const methods = tenantMemberRoutes.map((r) =>
      Array.isArray(r.method) ? r.method[0] : r.method,
    );
    expect(methods).toContain("GET");
    expect(methods).toContain("PATCH");
    expect(methods).toContain("DELETE");
  });
});

describe("tenantMemberRoutes: CSRF on mutating routes", () => {
  it("every POST/PATCH/DELETE route carries at least two middleware (CORS + CSRF)", () => {
    const mutating = tenantMemberRoutes.filter((r) => {
      const m = Array.isArray(r.method) ? r.method[0] : r.method;
      return m === "POST" || m === "PATCH" || m === "DELETE";
    });
    expect(mutating.length, "there must be at least one mutating route").toBeGreaterThan(0);
    for (const r of mutating) {
      expect(
        r.middleware!.length,
        `mutating route "${r.description}" should attach CSRF (+CORS)`,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("tenantMemberRoutes: auth gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue(null); // unauthenticated
  });

  it("every route returns 401 when authMiddleware yields no context", async () => {
    for (const route of tenantMemberRoutes) {
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
        `route "${route.description}" (${method}) must gate unauthenticated access`,
      ).toBe(401);
    }
    expect(authMock).toHaveBeenCalledTimes(tenantMemberRoutes.length);
  });
});
