/**
 * Unit tests: tenant-classification routes
 *
 * Covers route registration shape, auth gating (401 for unauthenticated),
 * and delegation to ClassificationHandler on authenticated requests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

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

// Mock ClassificationHandler methods
const mockHandleUpsert = vi.fn();
const mockHandleGet = vi.fn();
const mockHandleAddTag = vi.fn();
const mockHandleRemoveTag = vi.fn();

vi.mock("../../../src/lib/tenant/classification-handler", () => ({
  ClassificationHandler: class {
    handleUpsert = mockHandleUpsert;
    handleGet = mockHandleGet;
    handleAddTag = mockHandleAddTag;
    handleRemoveTag = mockHandleRemoveTag;
  },
}));

import { tenantClassificationRoutes } from "../../../src/lib/routes/tenant-classification.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockEnv = { SESSION_SECRET: "test-secret-32-characters-long!!" } as Env;

const BASE_PATHNAME = "/api/tenants/tenant-abc/classification";
const TAGS_PATHNAME = "/api/tenants/tenant-abc/classification/tags";
const TAG_ITEM_PATHNAME = "/api/tenants/tenant-abc/classification/tags/tag-1";

function findRoute(method: string, pathname: string) {
  return tenantClassificationRoutes.find((r) => {
    const m = Array.isArray(r.method) ? r.method[0] : r.method;
    return m === method && (r.path as RegExp).test(pathname);
  });
}

async function callRoute(route: (typeof tenantClassificationRoutes)[number], method: string, pathname: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const request = new Request(`https://api.example.com${pathname}`, init);
  return route.handler(request, mockEnv, {
    url: new URL(`https://api.example.com${pathname}`),
    pathname,
    params: {},
    requestContext: undefined,
  } as any);
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("tenantClassificationRoutes: registration", () => {
  it("exports a non-empty array", () => {
    expect(Array.isArray(tenantClassificationRoutes)).toBe(true);
    expect(tenantClassificationRoutes.length).toBeGreaterThan(0);
  });

  it("every route is well-formed (path, method, handler, description, middleware)", () => {
    for (const route of tenantClassificationRoutes) {
      expect(route.path, "route must have a path").toBeTruthy();
      expect(
        typeof route.method === "string" || Array.isArray(route.method),
        "route.method must be a string or array",
      ).toBe(true);
      expect(typeof route.handler, "route.handler must be a function").toBe("function");
      expect(route.description, "route must have a description").toBeTruthy();
      expect(Array.isArray(route.middleware), "route.middleware must be an array").toBe(true);
      expect(route.middleware!.length).toBeGreaterThan(0);
    }
  });

  it("covers PUT, GET, POST, DELETE methods", () => {
    const methods = tenantClassificationRoutes.map((r) =>
      Array.isArray(r.method) ? r.method[0] : r.method,
    );
    expect(methods).toContain("PUT");
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(methods).toContain("DELETE");
  });

  it("mutating routes (PUT/POST/DELETE) carry at least 2 middleware (CORS + CSRF)", () => {
    const mutating = tenantClassificationRoutes.filter((r) => {
      const m = Array.isArray(r.method) ? r.method[0] : r.method;
      return m === "PUT" || m === "POST" || m === "DELETE";
    });
    expect(mutating.length).toBeGreaterThan(0);
    for (const r of mutating) {
      expect(
        r.middleware!.length,
        `mutating route "${r.description}" should have CORS + CSRF`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("GET route carries at least 1 middleware (CORS)", () => {
    const gets = tenantClassificationRoutes.filter((r) => {
      const m = Array.isArray(r.method) ? r.method[0] : r.method;
      return m === "GET";
    });
    expect(gets.length).toBeGreaterThan(0);
    for (const r of gets) {
      expect(r.middleware!.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ── Auth gating ───────────────────────────────────────────────────────────────

describe("tenantClassificationRoutes: auth gating (unauthenticated → 401)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue(null);
  });

  it("PUT /api/tenants/:id/classification returns 401 when unauthenticated", async () => {
    const route = findRoute("PUT", BASE_PATHNAME)!;
    expect(route).toBeDefined();
    const res = await callRoute(route, "PUT", BASE_PATHNAME, { categoryId: "cat-1" });
    expect(res.status).toBe(401);
  });

  it("GET /api/tenants/:id/classification returns 401 when unauthenticated", async () => {
    const route = findRoute("GET", BASE_PATHNAME)!;
    expect(route).toBeDefined();
    const res = await callRoute(route, "GET", BASE_PATHNAME);
    expect(res.status).toBe(401);
  });

  it("POST /api/tenants/:id/classification/tags returns 401 when unauthenticated", async () => {
    const route = findRoute("POST", TAGS_PATHNAME)!;
    expect(route).toBeDefined();
    const res = await callRoute(route, "POST", TAGS_PATHNAME, { categoryId: "cat-2" });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/tenants/:id/classification/tags/:tagId returns 401 when unauthenticated", async () => {
    const route = findRoute("DELETE", TAG_ITEM_PATHNAME)!;
    expect(route).toBeDefined();
    const res = await callRoute(route, "DELETE", TAG_ITEM_PATHNAME);
    expect(res.status).toBe(401);
  });
});

// ── Delegation ────────────────────────────────────────────────────────────────

describe("tenantClassificationRoutes: handler delegation (authenticated)", () => {
  const fakeAuth = {
    userId: "user-1",
    activeTenantId: "tenant-abc",
    tenantRole: "ADMIN",
    globalRole: "END_USER",
    cognitoSub: "sub-1",
    tenantSlug: "org-a",
    handle: "caller",
    membershipsLoader: async () => [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue(fakeAuth);
  });

  it("PUT delegates to handleUpsert with correct tenantId", async () => {
    const mockResponse = new Response(JSON.stringify({ id: "cls-1" }), { status: 201 });
    mockHandleUpsert.mockResolvedValue(mockResponse);

    const route = findRoute("PUT", BASE_PATHNAME)!;
    const res = await callRoute(route, "PUT", BASE_PATHNAME, { categoryId: "cat-1" });

    expect(mockHandleUpsert).toHaveBeenCalledOnce();
    const [tenantId] = mockHandleUpsert.mock.calls[0];
    expect(tenantId).toBe("tenant-abc");
    expect(res.status).toBe(201);
  });

  it("GET delegates to handleGet with correct tenantId", async () => {
    const mockResponse = new Response(JSON.stringify({ id: "cls-1" }), { status: 200 });
    mockHandleGet.mockResolvedValue(mockResponse);

    const route = findRoute("GET", BASE_PATHNAME)!;
    const res = await callRoute(route, "GET", BASE_PATHNAME);

    expect(mockHandleGet).toHaveBeenCalledOnce();
    const [tenantId] = mockHandleGet.mock.calls[0];
    expect(tenantId).toBe("tenant-abc");
    expect(res.status).toBe(200);
  });

  it("POST (tags) delegates to handleAddTag with correct tenantId", async () => {
    const mockResponse = new Response(JSON.stringify({ id: "tag-1" }), { status: 201 });
    mockHandleAddTag.mockResolvedValue(mockResponse);

    const route = findRoute("POST", TAGS_PATHNAME)!;
    const res = await callRoute(route, "POST", TAGS_PATHNAME, { categoryId: "cat-2" });

    expect(mockHandleAddTag).toHaveBeenCalledOnce();
    const [tenantId] = mockHandleAddTag.mock.calls[0];
    expect(tenantId).toBe("tenant-abc");
    expect(res.status).toBe(201);
  });

  it("DELETE (tag item) delegates to handleRemoveTag with correct tenantId and tagId", async () => {
    const mockResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
    mockHandleRemoveTag.mockResolvedValue(mockResponse);

    const route = findRoute("DELETE", TAG_ITEM_PATHNAME)!;
    const res = await callRoute(route, "DELETE", TAG_ITEM_PATHNAME);

    expect(mockHandleRemoveTag).toHaveBeenCalledOnce();
    const [tenantId, tagId] = mockHandleRemoveTag.mock.calls[0];
    expect(tenantId).toBe("tenant-abc");
    expect(tagId).toBe("tag-1");
    expect(res.status).toBe(200);
  });
});
