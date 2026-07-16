import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Mock extensions to avoid import chain
vi.mock("../../src/extensions", () => ({
  extensions: [],
  getExtension: vi.fn(),
}));

// Mock security infrastructure
const mockCreateSecureResponse = vi.fn((body, opts) => new Response(body, opts));
const mockAddSecurityHeaders = vi.fn((r) => r);
vi.mock("../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
  },
}));

// Mock session
const mockGetSession = vi.fn();
vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));


// Cookie-fallback tenant read (extension-route-wrapper resolveTenantId).
// Defaults to no personal tenant → extSession carries no tenantId, which keeps
// the pre-05a behavioural assertions (session passthrough) intact.
const mockUserFindUnique = vi.fn().mockResolvedValue({ personalTenantId: null });
vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    acquireClient: () => ({ client: { user: { findUnique: mockUserFindUnique } } }),
  },
}));

vi.mock("../../src/db", () => ({
  createPrismaForRegion: vi.fn(),
}));

vi.mock("../../src/lib/region-detection", () => ({
  detectRegionSync: () => "US",
}));

vi.mock("../../src/lib/extension-context", () => ({
  createExtensionContext: () => ({
    db: {},
    appDomain: "test.com",
    appUrl: "https://test.com",
    stage: "test",
    config: {},
  }),
}));

vi.mock("../../src/lib/graph", () => ({
  createGraphServiceFromEnv: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../src/lib/middleware", () => ({
  corsMiddleware: () => async (_ctx: any, next: any) => next(),
  csrfMiddleware: () => async (_ctx: any, next: any) => next(),
}));

import { wrapExtensionRoute } from "../../src/lib/extension-route-wrapper.js";
import type { TrellisExtension, ExtensionRouteDefinition } from "@de-otio/trellis-extension-api";

function makeExt(): TrellisExtension {
  return {
    id: "dog",
    terminology: { entity: "dog", entityPlural: "dogs" },
    routes: [],
    metadataSchema: z.object({}),
  };
}

describe("wrapExtensionRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(null);
    mockUserFindUnique.mockResolvedValue({ personalTenantId: null });
  });

  it("wraps handler at /api/ext/{id}/{path}", () => {
    const route = wrapExtensionRoute(makeExt(), {
      path: "breeds",
      method: "GET",
      handle: async () => ({ status: 200, body: { breeds: [] } }),
    });

    expect(route.path).toBe("/api/ext/dog/breeds");
    expect(route.method).toBe("GET");
  });

  it("returns 401 when auth required and no session", async () => {
    const route = wrapExtensionRoute(makeExt(), {
      path: "breeds",
      method: "GET",
      auth: "required",
      handle: async () => ({ status: 200, body: {} }),
    });

    const request = new Request("https://test.com/api/ext/dog/breeds");
    const response = await route.handler(request, {} as any, {
      url: new URL(request.url),
      pathname: "/api/ext/dog/breeds",
      params: {},
    });

    expect(response.status).toBe(401);
  });

  it("allows unauthenticated access when auth is none", async () => {
    const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    const route = wrapExtensionRoute(makeExt(), {
      path: "public",
      method: "GET",
      auth: "none",
      handle: handler,
    });

    const request = new Request("https://test.com/api/ext/dog/public");
    await route.handler(request, {} as any, {
      url: new URL(request.url),
      pathname: "/api/ext/dog/public",
      params: {},
    });

    expect(handler).toHaveBeenCalled();
  });

  it("passes session to handler when authenticated", async () => {
    const mockSession = { userId: "u1", email: "a@b.com", role: "END_USER" };
    mockGetSession.mockResolvedValue(mockSession);

    const handler = vi.fn(async (_req, _params, session) => {
      return { status: 200, body: { userId: session?.userId } };
    });

    const route = wrapExtensionRoute(makeExt(), {
      path: "me",
      method: "GET",
      auth: "required",
      handle: handler,
    });

    const request = new Request("https://test.com/api/ext/dog/me");
    await route.handler(request, {} as any, {
      url: new URL(request.url),
      pathname: "/api/ext/dog/me",
      params: {},
    });

    expect(handler).toHaveBeenCalledWith(
      request,
      expect.any(Object),
      mockSession,
      expect.objectContaining({ appDomain: "test.com" }),
    );
  });

  it("mints tenantId from a verified JWT session's activeTenantId", async () => {
    mockGetSession.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      role: "END_USER",
      activeTenantId: "cmtaxonaaa000000000000001",
    });

    const handler = vi.fn(async (_req, _params, session) => ({
      status: 200,
      body: { tenantId: session?.tenantId },
    }));
    const route = wrapExtensionRoute(makeExt(), {
      path: "me",
      method: "GET",
      auth: "required",
      handle: handler,
    });

    await route.handler(new Request("https://test.com/api/ext/dog/me"), {} as any, {
      url: new URL("https://test.com/api/ext/dog/me"),
      pathname: "/api/ext/dog/me",
      params: {},
    });

    // No DB fallback when the JWT already carried the tenant.
    expect(mockUserFindUnique).not.toHaveBeenCalled();
    expect(handler.mock.calls[0][2].tenantId).toBe("cmtaxonaaa000000000000001");
  });

  it("falls back to personalTenantId for a cookie session (no JWT claim)", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1", email: "a@b.com", role: "END_USER" });
    mockUserFindUnique.mockResolvedValue({ personalTenantId: "cmtaxonaaa000000000000001" });

    const handler = vi.fn(async () => ({ status: 200, body: {} }));
    const route = wrapExtensionRoute(makeExt(), {
      path: "me", method: "GET", auth: "required", handle: handler,
    });

    await route.handler(new Request("https://test.com/api/ext/dog/me"), {} as any, {
      url: new URL("https://test.com/api/ext/dog/me"),
      pathname: "/api/ext/dog/me",
      params: {},
    });

    expect(mockUserFindUnique).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][2].tenantId).toBe("cmtaxonaaa000000000000001");
  });

  it("yields no tenantId when the fallback personalTenantId is malformed/absent", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1", email: "a@b.com", role: "END_USER" });
    mockUserFindUnique.mockResolvedValue({ personalTenantId: "not-a-cuid" });

    const handler = vi.fn(async () => ({ status: 200, body: {} }));
    const route = wrapExtensionRoute(makeExt(), {
      path: "me", method: "GET", auth: "required", handle: handler,
    });

    await route.handler(new Request("https://test.com/api/ext/dog/me"), {} as any, {
      url: new URL("https://test.com/api/ext/dog/me"),
      pathname: "/api/ext/dog/me",
      params: {},
    });

    expect(handler.mock.calls[0][2].tenantId).toBeUndefined();
  });

  it("whitelists the extension session — internal fields never cross the boundary", async () => {
    // getSession returns a full internal Session with sensitive fields.
    mockGetSession.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      role: "END_USER",
      activeTenantId: "cmtaxonaaa000000000000001",
      csrfToken: "secret-csrf",
      mfaVerified: true,
      dataRegion: "EU",
      ageTier: "ADULT",
      expiresAt: Date.now() + 3_600_000,
    });

    const handler = vi.fn(async () => ({ status: 200, body: {} }));
    const route = wrapExtensionRoute(makeExt(), {
      path: "me", method: "GET", auth: "required", handle: handler,
    });

    await route.handler(new Request("https://test.com/api/ext/dog/me"), {} as any, {
      url: new URL("https://test.com/api/ext/dog/me"),
      pathname: "/api/ext/dog/me",
      params: {},
    });

    const passed = handler.mock.calls[0][2];
    expect(Object.keys(passed).sort()).toEqual(["email", "role", "tenantId", "userId"]);
    expect(passed.csrfToken).toBeUndefined();
    expect(passed.mfaVerified).toBeUndefined();
    expect(passed.dataRegion).toBeUndefined();
    expect(passed.ageTier).toBeUndefined();
  });

  it("returns 500 (clean envelope) when the fallback tenant read throws", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1", email: "a@b.com", role: "END_USER" });
    mockUserFindUnique.mockRejectedValue(new Error("db down"));

    const route = wrapExtensionRoute(makeExt(), {
      path: "me", method: "GET", auth: "required",
      handle: async () => ({ status: 200, body: {} }),
    });

    const response = await route.handler(new Request("https://test.com/api/ext/dog/me"), {} as any, {
      url: new URL("https://test.com/api/ext/dog/me"),
      pathname: "/api/ext/dog/me",
      params: {},
    });

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Internal server error");
  });

  it("returns 500 when handler throws", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1" });

    const route = wrapExtensionRoute(makeExt(), {
      path: "broken",
      method: "GET",
      handle: async () => { throw new Error("boom"); },
    });

    const request = new Request("https://test.com/api/ext/dog/broken");
    const response = await route.handler(request, {} as any, {
      url: new URL(request.url),
      pathname: "/api/ext/dog/broken",
      params: {},
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Internal server error");
  });

  it("handler receives ExtensionContext, not Env", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1" });

    const handler = vi.fn(async (_req, _params, _session, ctx) => {
      return { status: 200, body: { hasDb: !!ctx.db, hasConfig: !!ctx.config } };
    });

    const route = wrapExtensionRoute(makeExt(), {
      path: "check",
      method: "GET",
      handle: handler,
    });

    const request = new Request("https://test.com/api/ext/dog/check");
    await route.handler(request, {} as any, {
      url: new URL(request.url),
      pathname: "/api/ext/dog/check",
      params: {},
    });

    const ctx = handler.mock.calls[0][3];
    expect(ctx).toHaveProperty("db");
    expect(ctx).toHaveProperty("config");
    expect(ctx).not.toHaveProperty("SESSION_SECRET");
    expect(ctx).not.toHaveProperty("DATABASE_URL");
  });
});
