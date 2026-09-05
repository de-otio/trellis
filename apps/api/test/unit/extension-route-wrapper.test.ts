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

/**
 * Scope enforcement and request-body validation (plan 034 lane A).
 *
 * The pipeline is authenticate -> scope -> validate -> handle, and the order
 * is asserted, not just the individual steps: each stage is exercised with a
 * request that would also fail a *later* stage, so a reordering shows up as a
 * changed status code rather than passing quietly.
 */
describe("wrapExtensionRoute — scopes and request schemas", () => {
  const bodySchema = z.object({ name: z.string().min(1) });

  const call = (route: ReturnType<typeof wrapExtensionRoute>, request: Request) =>
    route.handler(request, {} as any, {
      url: new URL(request.url),
      pathname: new URL(request.url).pathname,
      params: {},
    });

  const post = (body: string) =>
    new Request("https://test.com/api/ext/dog/walks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(null);
    mockUserFindUnique.mockResolvedValue({ personalTenantId: null });
  });

  describe("scope enforcement", () => {
    const scopedRoute = (handle: any) =>
      wrapExtensionRoute(makeExt(), {
        path: "walks",
        method: "POST",
        auth: "required",
        scopes: ["posts:write"],
        handle,
      });

    it("403s a principal whose grant lacks the scope, naming it in remediation", async () => {
      mockGetSession.mockResolvedValue({
        userId: "u1", email: "a@b.com", role: "END_USER",
        scopes: new Set(["posts:read"]),
      });
      const handler = vi.fn(async () => ({ status: 200, body: {} }));

      const response = await call(scopedRoute(handler), post('{"name":"Rex"}'));

      expect(response.status).toBe(403);
      const body = await response.json();
      // `request_id` is lane C's addition to every `structuredError` envelope —
      // a fresh correlator per response, asserted for presence and then set
      // aside before the value comparison.
      expect(typeof body.request_id).toBe("string");
      expect(body.request_id.length).toBeGreaterThan(0);
      const { request_id: _correlator, ...rest } = body;
      expect(rest).toEqual({
        error: "INSUFFICIENT_SCOPE",
        message:
          "This operation requires the `posts:write` scope, which this credential was not granted.",
        remediation:
          "Request the `posts:write` scope and have the user re-authorize.",
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it("200s a principal that holds the scope", async () => {
      mockGetSession.mockResolvedValue({
        userId: "u1", email: "a@b.com", role: "END_USER",
        scopes: new Set(["posts:write"]),
      });
      const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));

      const response = await call(scopedRoute(handler), post('{"name":"Rex"}'));

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it('200s a first-party session ("*") — the no-regression case that matters most', async () => {
      mockGetSession.mockResolvedValue({
        userId: "u1", email: "a@b.com", role: "END_USER", scopes: "*",
      });
      const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));

      const response = await call(scopedRoute(handler), post('{"name":"Rex"}'));

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it("200s a session predating scopes entirely (field absent)", async () => {
      mockGetSession.mockResolvedValue({ userId: "u1", email: "a@b.com", role: "END_USER" });
      const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));

      const response = await call(scopedRoute(handler), post('{"name":"Rex"}'));

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it("scopes: [] requires authentication and nothing more", async () => {
      const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));
      const route = wrapExtensionRoute(makeExt(), {
        path: "walks", method: "POST", auth: "required", scopes: [], handle: handler,
      });

      // No session -> 401 from the auth stage.
      expect((await call(route, post("{}"))).status).toBe(401);
      expect(handler).not.toHaveBeenCalled();

      // Authenticated with an EMPTY grant -> through, because nothing is asked for.
      mockGetSession.mockResolvedValue({
        userId: "u1", email: "a@b.com", role: "END_USER", scopes: new Set<string>(),
      });
      expect((await call(route, post("{}"))).status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
    });

    /**
     * The third branch of `scopes`: ABSENT. The published contract calls it
     * "first-party only; no third-party client reaches it", and it used to
     * fall through the gate entirely — a missing declaration reads as
     * "nothing to check" unless something says otherwise.
     *
     * Unreachable in production today (nothing populates `clientId`), so
     * these tests construct the principal the gate exists for. That is the
     * point: the gate has to hold BEFORE the first narrowed principal is
     * minted, or every scope-less extension route opens at once on the day
     * it is. (Quality sweep 2026-09-05, C3.)
     */
    describe("first-party-only routes (scopes absent)", () => {
      const unscopedRoute = (handle: any) =>
        wrapExtensionRoute(makeExt(), {
          path: "walks",
          method: "POST",
          auth: "required",
          handle,
        });

      it("403s a third-party client, and does not send it after a scope that cannot exist", async () => {
        mockGetSession.mockResolvedValue({
          userId: "u1", email: "a@b.com", role: "END_USER",
          clientId: "client-abc", scopes: new Set(["posts:write"]),
        });
        const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));

        const response = await call(unscopedRoute(handler), post('{"name":"Rex"}'));

        expect(response.status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
        const body = await response.json();
        expect(body).toMatchObject({
          error: "FIRST_PARTY_ONLY",
          message:
            "This operation is available only to the user's own session, not to a third-party client acting on their behalf.",
        });
        // The remediation must NOT name a scope to request: there is none, and
        // an integration told to ask for one loops forever.
        expect(body.remediation).not.toMatch(/re-authorize/);
      });

      it("403s a third-party client even when its grant is the unscoped '*'", async () => {
        // A client holding "*" is still a client. The gate is written against
        // `clientId`, not against the grant, precisely so this cannot pass.
        mockGetSession.mockResolvedValue({
          userId: "u1", email: "a@b.com", role: "END_USER",
          clientId: "client-abc", scopes: "*",
        });
        const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));

        expect((await call(unscopedRoute(handler), post('{"name":"Rex"}'))).status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
      });

      it("200s the user's own session (no clientId)", async () => {
        mockGetSession.mockResolvedValue({
          userId: "u1", email: "a@b.com", role: "END_USER", scopes: "*",
        });
        const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));

        expect((await call(unscopedRoute(handler), post('{"name":"Rex"}'))).status).toBe(200);
        expect(handler).toHaveBeenCalledOnce();
      });

      it("200s a session predating scopes entirely (both fields absent)", async () => {
        mockGetSession.mockResolvedValue({ userId: "u1", email: "a@b.com", role: "END_USER" });
        const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));

        expect((await call(unscopedRoute(handler), post('{"name":"Rex"}'))).status).toBe(200);
        expect(handler).toHaveBeenCalledOnce();
      });

      it("refuses the third-party client BEFORE reading the body", async () => {
        // Order matters: a 400 here would mean the body was parsed for a
        // caller that is not permitted to reach the route at all.
        mockGetSession.mockResolvedValue({
          userId: "u1", email: "a@b.com", role: "END_USER", clientId: "client-abc",
        });
        const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));
        const route = wrapExtensionRoute(makeExt(), {
          path: "walks", method: "POST", auth: "required",
          requestSchema: bodySchema, handle: handler,
        });

        // Body is invalid too — the scope stage must win.
        expect((await call(route, post('{"name":""}'))).status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
      });
    });

    it('refuses to wire auth: "none" together with a non-empty scopes list', () => {
      // A route with no principal can never have its scopes checked; served,
      // it would look gated and be open. Boot fails instead of serving it.
      expect(() =>
        wrapExtensionRoute(makeExt(), {
          path: "public", method: "GET", auth: "none", scopes: ["posts:write"],
          handle: async () => ({ status: 200, body: {} }),
        }),
      ).toThrow(/auth: "none"/);

      // An empty list is not a gate, so it stays legal.
      expect(() =>
        wrapExtensionRoute(makeExt(), {
          path: "public", method: "GET", auth: "none", scopes: [],
          handle: async () => ({ status: 200, body: {} }),
        }),
      ).not.toThrow();
    });
  });

  describe("requestSchema validation", () => {
    const validatedRoute = (handle: any) =>
      wrapExtensionRoute(makeExt(), {
        path: "walks", method: "POST", auth: "required",
        requestSchema: bodySchema, handle,
      });

    beforeEach(() => {
      mockGetSession.mockResolvedValue({
        userId: "u1", email: "a@b.com", role: "END_USER", scopes: "*",
      });
    });

    it("400s a body that fails the schema, with field set, and never invokes handle", async () => {
      const handler = vi.fn(async () => ({ status: 200, body: {} }));

      const response = await call(validatedRoute(handler), post('{"name":42}'));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_FAILED");
      expect(body.field).toBe("name");
      expect(typeof body.message).toBe("string");
      expect(body.remediation).toBe("Correct the `name` field and retry.");
      expect(handler).not.toHaveBeenCalled();
    });

    it("400s a body that is not JSON at all", async () => {
      const handler = vi.fn(async () => ({ status: 200, body: {} }));

      const response = await call(validatedRoute(handler), post("not json"));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("INVALID_REQUEST_BODY");
      expect(handler).not.toHaveBeenCalled();
    });

    it("leaves the body readable by the handler — the wrapper reads a clone", async () => {
      const handler = vi.fn(async (request: Request) => ({
        status: 200,
        body: await request.json(),
      }));

      const response = await call(validatedRoute(handler), post('{"name":"Rex"}'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ name: "Rex" });
    });

    it("does not try to validate a GET, which has no body to validate", async () => {
      const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));
      const route = wrapExtensionRoute(makeExt(), {
        path: "walks", method: "GET", auth: "required",
        requestSchema: bodySchema, handle: handler,
      });

      const response = await call(route, new Request("https://test.com/api/ext/dog/walks"));

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });
  });

  describe("pipeline order — authenticate, then scope, then validate", () => {
    const fullRoute = (handle: any) =>
      wrapExtensionRoute(makeExt(), {
        path: "walks", method: "POST", auth: "required",
        scopes: ["posts:write"], requestSchema: bodySchema, handle,
      });

    it("an unauthenticated request with a malformed body gets 401, not 400", async () => {
      const handler = vi.fn(async () => ({ status: 200, body: {} }));

      const response = await call(fullRoute(handler), post('{"name":42}'));

      expect(response.status).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });

    it("an under-scoped request with a malformed body gets 403, not 400", async () => {
      // Validating first would describe the body shape to a caller not
      // permitted to send one.
      mockGetSession.mockResolvedValue({
        userId: "u1", email: "a@b.com", role: "END_USER", scopes: new Set<string>(),
      });
      const handler = vi.fn(async () => ({ status: 200, body: {} }));

      const response = await call(fullRoute(handler), post('{"name":42}'));

      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("INSUFFICIENT_SCOPE");
      expect(handler).not.toHaveBeenCalled();
    });

    it("a fully authorized request with a malformed body gets 400", async () => {
      mockGetSession.mockResolvedValue({
        userId: "u1", email: "a@b.com", role: "END_USER",
        scopes: new Set(["posts:write"]),
      });
      const handler = vi.fn(async () => ({ status: 200, body: {} }));

      const response = await call(fullRoute(handler), post('{"name":42}'));

      expect(response.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("the principal crosses the boundary by whitelist", () => {
    it("passes clientId and scopes through to the extension session", async () => {
      mockGetSession.mockResolvedValue({
        userId: "u1", email: "a@b.com", role: "END_USER",
        clientId: "client_abc",
        scopes: new Set(["posts:write"]),
        csrfToken: "secret-csrf",
      });

      const handler = vi.fn(async () => ({ status: 200, body: {} }));
      await call(
        // `scopes: []` — "any authenticated principal". The route must admit a
        // third-party client for this test to have a principal to inspect at
        // all: an ABSENT `scopes` is first-party only and now 403s one before
        // the handler runs (requireFirstParty, sweep C3). The subject here is
        // the whitelist, not the gate, so the route declares the value that
        // lets the caller through rather than relying on the gap that used to.
        wrapExtensionRoute(makeExt(), {
          path: "me", method: "GET", auth: "required", scopes: [], handle: handler,
        }),
        new Request("https://test.com/api/ext/dog/me"),
      );

      const passed = handler.mock.calls[0][2];
      expect(Object.keys(passed).sort()).toEqual([
        "clientId", "email", "role", "scopes", "userId",
      ]);
      expect(passed.clientId).toBe("client_abc");
      expect(passed.scopes).toEqual(new Set(["posts:write"]));
      expect(passed.csrfToken).toBeUndefined();
    });

    it("omits both keys for a session that carries neither", async () => {
      mockGetSession.mockResolvedValue({ userId: "u1", email: "a@b.com", role: "END_USER" });

      const handler = vi.fn(async () => ({ status: 200, body: {} }));
      await call(
        wrapExtensionRoute(makeExt(), {
          path: "me", method: "GET", auth: "required", handle: handler,
        }),
        new Request("https://test.com/api/ext/dog/me"),
      );

      expect(Object.keys(handler.mock.calls[0][2]).sort()).toEqual([
        "email", "role", "userId",
      ]);
    });
  });
});
