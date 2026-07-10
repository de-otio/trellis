/**
 * Unit tests: Events primitive ROUTES (routes/events.ts) — Phase 2 wiring.
 *
 * Exercises the request→route→handler DI assembly directly at the route layer
 * (same approach as routes/media-review-routes.test.ts): the Phase-1 handlers
 * are mocked to spy on delegation, `authMiddleware` / `SessionManager` are
 * mocked to drive the auth forks, and each route's handler is invoked with a
 * synthesized context. This hits the branches unique to routes/events.ts — the
 * 401 (no session / no auth / no tenant), the 400 bad-path, the 500 missing
 * request-context, and the happy-path delegation with the correctly extracted
 * path params — without a database.
 *
 * The route/aggregate/Hono-mount PARITY is asserted separately by
 * test/unit/route-mount-parity.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
}));

vi.mock("../../../src/db", () => ({
  createPrisma: vi.fn(() => ({})),
}));

vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse(body: BodyInit | null, init: ResponseInit) {
      return new Response(body, init);
    }
    addSecurityHeaders(response: Response) {
      return response;
    }
  },
}));

vi.mock("../../../src/lib/middleware", () => ({
  corsMiddleware: vi.fn(() => ({ name: "cors" })),
  csrfMiddleware: vi.fn(() => ({ name: "csrf" })),
}));

vi.mock("../../../src/lib/feature-gate-middleware", () => ({
  featureToggleMiddleware: vi.fn(() => ({ name: "feature-toggle" })),
}));

// Rate limiter (F-4): programmable spy. Defaults to allow (null); a test can
// make it deny by resolving a 429 Response, exercising the route's `if (limited)`
// short-circuit without touching the token-bucket store. The per-hour caps are
// read from `env.event.*` (provided below) before this is invoked.
const mockApplyRateLimitKV = vi.fn(async (..._args: unknown[]): Promise<Response | null> => null);
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = mockApplyRateLimitKV;
  },
}));

// Handler spies. Each method returns a recognizable Response so the route's
// delegation + response pass-through is observable.
const eventSpies = {
  handleCreate: vi.fn(async () => tagged(201, "event.create")),
  handleList: vi.fn(async () => tagged(200, "event.list")),
  handleListMine: vi.fn(async () => tagged(200, "event.listMine")),
  handleGet: vi.fn(async () => tagged(200, "event.get")),
  handleUpdate: vi.fn(async () => tagged(200, "event.update")),
  handleDelete: vi.fn(async () => tagged(200, "event.delete")),
};
vi.mock("../../../src/lib/events/event-handler", () => ({
  EventHandler: class {
    handleCreate = eventSpies.handleCreate;
    handleList = eventSpies.handleList;
    handleListMine = eventSpies.handleListMine;
    handleGet = eventSpies.handleGet;
    handleUpdate = eventSpies.handleUpdate;
    handleDelete = eventSpies.handleDelete;
  },
}));

const rsvpSpies = {
  handleRsvp: vi.fn(async () => tagged(201, "rsvp.create")),
  handleWithdraw: vi.fn(async () => new Response(null, { status: 204 })),
  handleAttendees: vi.fn(async () => tagged(200, "rsvp.attendees")),
};
vi.mock("../../../src/lib/events/rsvp-handler", () => ({
  RsvpHandler: class {
    constructor(_db: unknown) {}
    handleRsvp = rsvpSpies.handleRsvp;
    handleWithdraw = rsvpSpies.handleWithdraw;
    handleAttendees = rsvpSpies.handleAttendees;
  },
}));

const shiftSpies = {
  handleCreate: vi.fn(async () => tagged(201, "shift.create")),
  handleList: vi.fn(async () => tagged(200, "shift.list")),
  handleUpdate: vi.fn(async () => tagged(200, "shift.update")),
  handleDelete: vi.fn(async () => new Response(null, { status: 204 })),
  handleSignup: vi.fn(async () => tagged(201, "shift.signup")),
  handleWithdraw: vi.fn(async () => new Response(null, { status: 204 })),
};
vi.mock("../../../src/lib/events/shift-handler", () => ({
  ShiftHandler: class {
    handleCreate = shiftSpies.handleCreate;
    handleList = shiftSpies.handleList;
    handleUpdate = shiftSpies.handleUpdate;
    handleDelete = shiftSpies.handleDelete;
    handleSignup = shiftSpies.handleSignup;
    handleWithdraw = shiftSpies.handleWithdraw;
  },
}));

// The event handler is constructed with two injected seams; they are cheap to
// construct (no DB at construction) so they are left real — but stub them so
// the import graph stays light.
vi.mock("../../../src/lib/events/event-notifications", () => ({
  EventNotificationProducer: class {},
}));
vi.mock("../../../src/lib/events/post-feed-announcer", () => ({
  PostFeedAnnouncer: class {},
}));

import { eventsRoutes } from "../../../src/lib/routes/events.js";
import type { Route } from "../../../src/lib/routes/types.js";

function tagged(status: number, tag: string): Response {
  return new Response(JSON.stringify({ tag }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const env = {
  SESSION_SECRET: "test-secret-32-characters-long!!",
  event: {
    maxPerTenant: 500,
    maxShiftsPerEvent: 50,
    maxGuestsPerRsvp: 10,
    rsvpRatePerHour: 60,
    updateRatePerHour: 20,
    updateNotifyCooldownSeconds: 3600,
    listPageMax: 50,
  },
} as any;

const AUTH = {
  userId: "u1",
  activeTenantId: "t1",
  cognitoSub: "sub",
  globalRole: "END_USER",
  tenantRole: "MEMBER",
  tenantSlug: "acme",
  handle: "u1@acme",
  membershipsLoader: async () => [],
};

function routeFor(method: string, matchPath: string): Route {
  const r = eventsRoutes.find((rt) => {
    const methods = Array.isArray(rt.method) ? rt.method : [rt.method];
    if (!methods.includes(method as any)) return false;
    return typeof rt.path === "string" ? rt.path === matchPath : rt.path.test(matchPath);
  });
  if (!r) throw new Error(`no events route for ${method} ${matchPath}`);
  return r;
}

function ctx(pathname: string, opts: { requestContext?: unknown } = {}) {
  return {
    url: new URL(`https://api.example.com${pathname}`),
    pathname,
    params: {},
    requestContext:
      "requestContext" in opts ? opts.requestContext : { region: "EU" },
  } as any;
}

function req(method: string, pathname: string, body?: unknown): Request {
  return new Request(`https://api.example.com${pathname}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

function invoke(method: string, pathname: string, body?: unknown, c = ctx(pathname)) {
  return routeFor(method, pathname).handler(req(method, pathname, body), env, c);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthMiddleware.mockResolvedValue(AUTH);
  mockGetSession.mockResolvedValue({ userId: "u1" });
  mockApplyRateLimitKV.mockResolvedValue(null);
});

describe("collection routes (/api/events)", () => {
  it("POST delegates to EventHandler.handleCreate (201)", async () => {
    const res = await invoke("POST", "/api/events", { title: "x" });
    expect(res.status).toBe(201);
    expect(eventSpies.handleCreate).toHaveBeenCalledOnce();
  });

  it("GET delegates to EventHandler.handleList (200)", async () => {
    const res = await invoke("GET", "/api/events");
    expect(res.status).toBe(200);
    expect(eventSpies.handleList).toHaveBeenCalledOnce();
  });

  it("401 when unauthenticated (no auth context)", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("POST", "/api/events", { title: "x" });
    expect(res.status).toBe(401);
    expect(eventSpies.handleCreate).not.toHaveBeenCalled();
  });

  it("401 when auth has no active tenant", async () => {
    mockAuthMiddleware.mockResolvedValue({ ...AUTH, activeTenantId: "" });
    const res = await invoke("GET", "/api/events");
    expect(res.status).toBe(401);
  });
});

describe("mine route (/api/events/mine)", () => {
  it("GET delegates to EventHandler.handleListMine (200)", async () => {
    const res = await invoke("GET", "/api/events/mine");
    expect(res.status).toBe(200);
    expect(eventSpies.handleListMine).toHaveBeenCalledWith(
      expect.any(Request),
      AUTH,
      env,
    );
    // The static /mine route must win over the bare :id capture.
    expect(eventSpies.handleGet).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("GET", "/api/events/mine");
    expect(res.status).toBe(401);
    expect(eventSpies.handleListMine).not.toHaveBeenCalled();
  });

  it("401 when auth has no active tenant", async () => {
    mockAuthMiddleware.mockResolvedValue({ ...AUTH, activeTenantId: "" });
    const res = await invoke("GET", "/api/events/mine");
    expect(res.status).toBe(401);
  });
});

describe("write rate limit (F-4)", () => {
  it("POST /rsvp returns the limiter's 429 and does not call the handler", async () => {
    mockApplyRateLimitKV.mockResolvedValue(
      new Response(JSON.stringify({ error: "RATE_LIMITED" }), { status: 429 }),
    );
    const res = await invoke("POST", "/api/events/ev1/rsvp", { status: "GOING" });
    expect(res.status).toBe(429);
    expect(rsvpSpies.handleRsvp).not.toHaveBeenCalled();
    // Bucket identity for the per-user+event RSVP limit is the session userId.
    expect(mockApplyRateLimitKV).toHaveBeenCalledWith(
      env,
      expect.any(Request),
      "events:rsvp:ev1",
      env.event.rsvpRatePerHour,
      3600,
      undefined,
      undefined,
      "u1",
    );
  });

  it("PATCH /:id returns the limiter's 429 and does not call handleUpdate", async () => {
    mockApplyRateLimitKV.mockResolvedValue(
      new Response(JSON.stringify({ error: "RATE_LIMITED" }), { status: 429 }),
    );
    const res = await invoke("PATCH", "/api/events/ev123", { title: "y" });
    expect(res.status).toBe(429);
    expect(eventSpies.handleUpdate).not.toHaveBeenCalled();
    // Bucket identity for the per-event update limit is the eventId itself.
    expect(mockApplyRateLimitKV).toHaveBeenCalledWith(
      env,
      expect.any(Request),
      "events:update",
      env.event.updateRatePerHour,
      3600,
      undefined,
      undefined,
      "ev123",
    );
  });

  it("PATCH /:id proceeds to handleUpdate when the limiter allows (null)", async () => {
    mockApplyRateLimitKV.mockResolvedValue(null);
    const res = await invoke("PATCH", "/api/events/ev123", { title: "y" });
    expect(res.status).toBe(200);
    expect(eventSpies.handleUpdate).toHaveBeenCalledOnce();
  });
});

describe("RSVP MEMBER-role floor (F-2)", () => {
  it("403 for a GUEST on POST /rsvp (never reaches the rate limiter or handler)", async () => {
    mockAuthMiddleware.mockResolvedValue({ ...AUTH, tenantRole: "GUEST" });
    const res = await invoke("POST", "/api/events/ev1/rsvp", { status: "GOING" });
    expect(res.status).toBe(403);
    expect(rsvpSpies.handleRsvp).not.toHaveBeenCalled();
    expect(mockApplyRateLimitKV).not.toHaveBeenCalled();
  });

  it("403 for a GUEST on DELETE /rsvp (withdraw is MEMBER+ too)", async () => {
    mockAuthMiddleware.mockResolvedValue({ ...AUTH, tenantRole: "GUEST" });
    const res = await invoke("DELETE", "/api/events/ev1/rsvp");
    expect(res.status).toBe(403);
    expect(rsvpSpies.handleWithdraw).not.toHaveBeenCalled();
  });

  it("allows a MEMBER through to handleRsvp", async () => {
    mockAuthMiddleware.mockResolvedValue({ ...AUTH, tenantRole: "MEMBER" });
    const res = await invoke("POST", "/api/events/ev1/rsvp", { status: "GOING" });
    expect(res.status).toBe(201);
    expect(rsvpSpies.handleRsvp).toHaveBeenCalledOnce();
  });
});

describe("item routes (/api/events/:id)", () => {
  it("GET extracts the id and delegates to handleGet", async () => {
    const res = await invoke("GET", "/api/events/ev123");
    expect(res.status).toBe(200);
    expect(eventSpies.handleGet).toHaveBeenCalledWith("ev123", AUTH, env);
  });

  it("PATCH delegates to handleUpdate with the id", async () => {
    const res = await invoke("PATCH", "/api/events/ev123", { title: "y" });
    expect(res.status).toBe(200);
    expect(eventSpies.handleUpdate).toHaveBeenCalledWith(
      "ev123",
      expect.any(Request),
      AUTH,
      env,
    );
  });

  it("DELETE delegates to handleDelete with the id", async () => {
    const res = await invoke("DELETE", "/api/events/ev123");
    expect(res.status).toBe(200);
    expect(eventSpies.handleDelete).toHaveBeenCalledWith("ev123", AUTH, env);
  });

  it("401 when unauthenticated", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("GET", "/api/events/ev123");
    expect(res.status).toBe(401);
  });

  it("400 on a path that does not match the id capture", async () => {
    const route = routeFor("GET", "/api/events/ev123");
    const res = await route.handler(req("GET", "/nope"), env, ctx("/nope"));
    expect(res.status).toBe(400);
  });

  it("401 when unauthenticated on PATCH /:id", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("PATCH", "/api/events/ev123", { title: "y" });
    expect(res.status).toBe(401);
    expect(eventSpies.handleUpdate).not.toHaveBeenCalled();
    // No point checking the rate limiter for an unauthenticated caller.
    expect(mockApplyRateLimitKV).not.toHaveBeenCalled();
  });

  it("400 on a path that does not match the id capture (PATCH)", async () => {
    const route = routeFor("PATCH", "/api/events/ev123");
    const res = await route.handler(req("PATCH", "/nope", { title: "y" }), env, ctx("/nope"));
    expect(res.status).toBe(400);
    expect(eventSpies.handleUpdate).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated on DELETE /:id", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("DELETE", "/api/events/ev123");
    expect(res.status).toBe(401);
    expect(eventSpies.handleDelete).not.toHaveBeenCalled();
  });

  it("400 on a path that does not match the id capture (DELETE)", async () => {
    const route = routeFor("DELETE", "/api/events/ev123");
    const res = await route.handler(req("DELETE", "/nope"), env, ctx("/nope"));
    expect(res.status).toBe(400);
    expect(eventSpies.handleDelete).not.toHaveBeenCalled();
  });
});

describe("RSVP routes", () => {
  it("POST /rsvp delegates to RsvpHandler.handleRsvp with eventId + tenant", async () => {
    const res = await invoke("POST", "/api/events/ev1/rsvp", { status: "GOING" });
    expect(res.status).toBe(201);
    expect(rsvpSpies.handleRsvp).toHaveBeenCalledWith(
      "ev1",
      expect.any(Request),
      { userId: "u1" },
      env,
      { region: "EU" },
      "t1",
    );
  });

  it("DELETE /rsvp delegates to handleWithdraw (204)", async () => {
    const res = await invoke("DELETE", "/api/events/ev1/rsvp");
    expect(res.status).toBe(204);
    expect(rsvpSpies.handleWithdraw).toHaveBeenCalledOnce();
  });

  it("GET /attendees delegates to handleAttendees (200)", async () => {
    const res = await invoke("GET", "/api/events/ev1/attendees");
    expect(res.status).toBe(200);
    expect(rsvpSpies.handleAttendees).toHaveBeenCalledOnce();
  });

  it("401 when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await invoke("POST", "/api/events/ev1/rsvp", { status: "GOING" });
    expect(res.status).toBe(401);
    expect(rsvpSpies.handleRsvp).not.toHaveBeenCalled();
  });

  it("401 when session present but auth missing", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("DELETE", "/api/events/ev1/rsvp");
    expect(res.status).toBe(401);
  });

  it("500 when the request context is unavailable (GET /attendees)", async () => {
    const res = await invoke(
      "GET",
      "/api/events/ev1/attendees",
      undefined,
      ctx("/api/events/ev1/attendees", { requestContext: undefined }),
    );
    expect(res.status).toBe(500);
  });

  it("500 when the request context is unavailable (POST /rsvp)", async () => {
    const res = await invoke(
      "POST",
      "/api/events/ev1/rsvp",
      { status: "GOING" },
      ctx("/api/events/ev1/rsvp", { requestContext: undefined }),
    );
    expect(res.status).toBe(500);
    expect(rsvpSpies.handleRsvp).not.toHaveBeenCalled();
  });

  it("500 when the request context is unavailable (DELETE /rsvp)", async () => {
    const res = await invoke(
      "DELETE",
      "/api/events/ev1/rsvp",
      undefined,
      ctx("/api/events/ev1/rsvp", { requestContext: undefined }),
    );
    expect(res.status).toBe(500);
    expect(rsvpSpies.handleWithdraw).not.toHaveBeenCalled();
  });

  it("400 on a bad rsvp path", async () => {
    const route = routeFor("POST", "/api/events/ev1/rsvp");
    const res = await route.handler(req("POST", "/x"), env, ctx("/x"));
    expect(res.status).toBe(400);
  });

  it("401 when unauthenticated on POST /rsvp (session present, auth missing)", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("POST", "/api/events/ev1/rsvp", { status: "GOING" });
    expect(res.status).toBe(401);
    expect(rsvpSpies.handleRsvp).not.toHaveBeenCalled();
  });

  it("401 when there is no session on DELETE /rsvp", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await invoke("DELETE", "/api/events/ev1/rsvp");
    expect(res.status).toBe(401);
    expect(rsvpSpies.handleWithdraw).not.toHaveBeenCalled();
  });

  it("400 on a bad DELETE-rsvp path", async () => {
    const route = routeFor("DELETE", "/api/events/ev1/rsvp");
    const res = await route.handler(req("DELETE", "/x"), env, ctx("/x"));
    expect(res.status).toBe(400);
  });

  it("401 when there is no session on GET /attendees", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await invoke("GET", "/api/events/ev1/attendees");
    expect(res.status).toBe(401);
    expect(rsvpSpies.handleAttendees).not.toHaveBeenCalled();
  });

  it("401 when session present but auth missing on GET /attendees", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("GET", "/api/events/ev1/attendees");
    expect(res.status).toBe(401);
  });

  it("400 on a bad attendees path", async () => {
    const route = routeFor("GET", "/api/events/ev1/attendees");
    const res = await route.handler(req("GET", "/x"), env, ctx("/x"));
    expect(res.status).toBe(400);
  });
});

describe("shift routes", () => {
  it("POST /shifts delegates to ShiftHandler.handleCreate with eventId", async () => {
    const res = await invoke("POST", "/api/events/ev1/shifts", { title: "s", capacity: 2 });
    expect(res.status).toBe(201);
    expect(shiftSpies.handleCreate).toHaveBeenCalledWith(
      "ev1",
      expect.any(Request),
      AUTH,
      env,
    );
  });

  it("GET /shifts delegates to handleList", async () => {
    const res = await invoke("GET", "/api/events/ev1/shifts");
    expect(res.status).toBe(200);
    expect(shiftSpies.handleList).toHaveBeenCalledWith("ev1", AUTH, env);
  });

  it("PATCH /shifts/:shiftId delegates with both ids", async () => {
    const res = await invoke("PATCH", "/api/events/ev1/shifts/s1", { title: "z" });
    expect(res.status).toBe(200);
    expect(shiftSpies.handleUpdate).toHaveBeenCalledWith(
      "ev1",
      "s1",
      expect.any(Request),
      AUTH,
      env,
    );
  });

  it("DELETE /shifts/:shiftId delegates with both ids (204)", async () => {
    const res = await invoke("DELETE", "/api/events/ev1/shifts/s1");
    expect(res.status).toBe(204);
    expect(shiftSpies.handleDelete).toHaveBeenCalledWith("ev1", "s1", AUTH, env);
  });

  it("POST /shifts/:shiftId/signup delegates with both ids", async () => {
    const res = await invoke("POST", "/api/events/ev1/shifts/s1/signup", {});
    expect(res.status).toBe(201);
    expect(shiftSpies.handleSignup).toHaveBeenCalledWith(
      "ev1",
      "s1",
      expect.any(Request),
      AUTH,
      env,
    );
  });

  it("DELETE /shifts/:shiftId/signup delegates with both ids (204)", async () => {
    const res = await invoke("DELETE", "/api/events/ev1/shifts/s1/signup");
    expect(res.status).toBe(204);
    expect(shiftSpies.handleWithdraw).toHaveBeenCalledWith("ev1", "s1", AUTH, env);
  });

  it("401 when unauthenticated on a shift route", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("POST", "/api/events/ev1/shifts", { title: "s", capacity: 1 });
    expect(res.status).toBe(401);
  });

  it("400 on a bad shift-signup path", async () => {
    const route = routeFor("POST", "/api/events/ev1/shifts/s1/signup");
    const res = await route.handler(req("POST", "/x"), env, ctx("/x"));
    expect(res.status).toBe(400);
  });

  it("400 on a bad shift-item path", async () => {
    const route = routeFor("PATCH", "/api/events/ev1/shifts/s1");
    const res = await route.handler(req("PATCH", "/x"), env, ctx("/x"));
    expect(res.status).toBe(400);
  });

  it("400 on a bad shifts-collection path", async () => {
    const route = routeFor("POST", "/api/events/ev1/shifts");
    const res = await route.handler(req("POST", "/x"), env, ctx("/x"));
    expect(res.status).toBe(400);
  });

  it("401 when unauthenticated on GET /shifts", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("GET", "/api/events/ev1/shifts");
    expect(res.status).toBe(401);
    expect(shiftSpies.handleList).not.toHaveBeenCalled();
  });

  it("400 on a bad GET-shifts-collection path", async () => {
    const route = routeFor("GET", "/api/events/ev1/shifts");
    const res = await route.handler(req("GET", "/x"), env, ctx("/x"));
    expect(res.status).toBe(400);
  });

  it("401 when unauthenticated on POST /shifts/:shiftId/signup", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("POST", "/api/events/ev1/shifts/s1/signup", {});
    expect(res.status).toBe(401);
    expect(shiftSpies.handleSignup).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated on DELETE /shifts/:shiftId/signup", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("DELETE", "/api/events/ev1/shifts/s1/signup");
    expect(res.status).toBe(401);
    expect(shiftSpies.handleWithdraw).not.toHaveBeenCalled();
  });

  it("400 on a bad DELETE-shift-signup path", async () => {
    const route = routeFor("DELETE", "/api/events/ev1/shifts/s1/signup");
    const res = await route.handler(req("DELETE", "/x"), env, ctx("/x"));
    expect(res.status).toBe(400);
  });

  it("401 when unauthenticated on PATCH /shifts/:shiftId", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("PATCH", "/api/events/ev1/shifts/s1", { title: "z" });
    expect(res.status).toBe(401);
    expect(shiftSpies.handleUpdate).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated on DELETE /shifts/:shiftId", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const res = await invoke("DELETE", "/api/events/ev1/shifts/s1");
    expect(res.status).toBe(401);
    expect(shiftSpies.handleDelete).not.toHaveBeenCalled();
  });

  it("400 on a bad DELETE-shift-item path", async () => {
    const route = routeFor("DELETE", "/api/events/ev1/shifts/s1");
    const res = await route.handler(req("DELETE", "/x"), env, ctx("/x"));
    expect(res.status).toBe(400);
  });
});
