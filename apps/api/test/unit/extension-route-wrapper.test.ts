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


vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    acquireClient: () => ({ client: {} }),
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
