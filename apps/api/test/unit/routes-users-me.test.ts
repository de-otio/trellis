/**
 * Unit tests: GET /api/users/me.
 *
 * The endpoint exists so clients stop decoding `custom:*` claims out of the ID
 * token — claim names are a per-deployment choice and are absent entirely on
 * the Keycloak realm backing skybber dev. These tests pin the contract that
 * replaces them: the identity comes from the resolved AuthContext, is gated on
 * auth, is never cached, and fails closed if the user row disappears.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

const mockUser = { findUnique: vi.fn() };
const mockPrisma = { user: mockUser };

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

const mockAuthMiddleware = vi.fn();
vi.mock("../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
}));

vi.mock("../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse(body: BodyInit | null, init: ResponseInit) {
      return new Response(body, init);
    }
    addSecurityHeaders(response: Response) {
      return response;
    }
  },
}));

vi.mock("../../src/lib/middleware", () => ({
  corsMiddleware: vi.fn(() => ({ name: "cors" })),
  csrfMiddleware: vi.fn(() => ({ name: "csrf" })),
  rateLimitMiddleware: vi.fn(() => ({ name: "rateLimit" })),
}));

import { userRoutes } from "../../src/lib/routes/user.js";

const USER_ID = "cmqurmq7x000002i80nqmgfr8";
const TENANT_ID = "cmqurmq7x000002i80nqmgfr9";

const meRoute = userRoutes.find(
  (r) => r.path === "/api/users/me" && r.method === "GET",
);

const env = {} as Env;

function request() {
  return new Request("https://api.example.com/api/users/me", {
    headers: { authorization: "Bearer h.p.s" },
  });
}

function ctx() {
  return {
    pathname: "/api/users/me",
    requestContext: {} as never,
  } as never;
}

function invoke() {
  // The route is looked up by path above; a missing route would make every
  // assertion below vacuously pass, so the existence check is its own test.
  return (meRoute!.handler as (r: Request, e: Env, c: unknown) => Promise<Response>)(
    request(),
    env,
    ctx(),
  );
}

const AUTH = {
  sub: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
  userId: USER_ID,
  globalRole: "END_USER",
  activeTenantId: TENANT_ID,
  tenantSlug: "acme",
  tenantRole: "OWNER",
  handle: "someone",
  membershipsLoader: vi.fn(),
};

describe("GET /api/users/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is registered as a GET route", () => {
    expect(meRoute).toBeDefined();
  });

  it("returns the resolved identity from the AuthContext", async () => {
    mockAuthMiddleware.mockResolvedValue(AUTH);
    mockUser.findUnique.mockResolvedValue({ email: "user@example.com" });

    const response = await invoke();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId: USER_ID,
      activeTenantId: TENANT_ID,
      email: "user@example.com",
      globalRole: "END_USER",
      tenantSlug: "acme",
      tenantRole: "OWNER",
      handle: "someone",
    });
  });

  it("reads email by primary key only, selecting nothing else", async () => {
    // Guards the "cheap enough to call at startup" claim in the route comment:
    // a widening select here silently turns this into an expensive endpoint.
    mockAuthMiddleware.mockResolvedValue(AUTH);
    mockUser.findUnique.mockResolvedValue({ email: "user@example.com" });

    await invoke();

    expect(mockUser.findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { email: true },
    });
  });

  it("is never cached — identity changes on tenant switch", async () => {
    mockAuthMiddleware.mockResolvedValue(AUTH);
    mockUser.findUnique.mockResolvedValue({ email: "user@example.com" });

    const response = await invoke();

    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns 401 when unauthenticated, without touching the DB", async () => {
    mockAuthMiddleware.mockResolvedValue(null);

    const response = await invoke();

    expect(response.status).toBe(401);
    expect(mockUser.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 when the user row vanished mid-request", async () => {
    // authMiddleware resolved the id against the DB, so a miss means deletion
    // raced the request. Fail closed rather than serve a half-populated body.
    mockAuthMiddleware.mockResolvedValue(AUTH);
    mockUser.findUnique.mockResolvedValue(null);

    const response = await invoke();

    expect(response.status).toBe(401);
  });

  it("does not require CSRF (it is a read)", () => {
    const names = (meRoute!.middleware ?? []).map(
      (m: unknown) => (m as { name?: string }).name,
    );
    expect(names).toContain("cors");
    expect(names).not.toContain("csrf");
  });
});
