/**
 * Events primitive routes (R1, Phase 2 — WIRING).
 *
 * The `Route[]` for the whole events surface (plan §4.5). This file is pure DI
 * ASSEMBLY: it instantiates the Phase-1 handlers, injects the concrete Phase-0
 * seams (`PostFeedAnnouncer` wrapping `PostHandler.createSystemPost`, and the
 * `EventNotificationProducer`), resolves auth, and delegates. No handler body
 * is touched here (review HIGH-2 fix).
 *
 * Two auth conventions coexist among the Phase-1 handlers, and this file bridges
 * both without changing them:
 *  - `EventHandler` / `ShiftHandler` take a resolved `AuthContext`
 *    (`authMiddleware`), mirroring `routes/tenant-classification.ts`.
 *  - `RsvpHandler` takes a `Session` + `activeTenantId` + `RequestContext` and a
 *    constructor-injected Prisma client, mirroring `routes/comments.ts`.
 *
 * Path ordering (Hono is first-match-wins in registration order): the exact
 * `/api/events` collection routes come first, then the sub-resource routes
 * (`…/rsvp`, `…/attendees`, `…/shifts…`), then the bare `/api/events/:id`
 * item routes last (plan §4.5). Every mutation carries CSRF; every route is
 * gated by `featureToggleMiddleware("events_enabled")` (global default off), so
 * a disabled deploy 404s at the middleware before any handler runs.
 *
 * Registered in BOTH `routes/index.ts` (the OpenAPI aggregate) AND
 * `app.ts` `PORTED_ROUTE_SETS` (the served Hono mounts) — `route-mount-parity`
 * fails the build otherwise.
 *
 * Imitates `routes/collections.ts`. Design: plans/events-primitive/README.md
 * §4.5, §4.6, §2.
 */

import { authMiddleware } from "../auth/auth-middleware.js";
import { requireRole } from "../auth/require.js";
import { createPrisma } from "../../db.js";
import type { Env } from "../../env.js";
import { EventHandler } from "../events/event-handler.js";
import { EventNotificationProducer } from "../events/event-notifications.js";
import { PostFeedAnnouncer } from "../events/post-feed-announcer.js";
import { RsvpHandler } from "../events/rsvp-handler.js";
import { ShiftHandler } from "../events/shift-handler.js";
import { featureToggleMiddleware } from "../feature-gate-middleware.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

const EVENTS_BASE = "/api/events";
const EVENTS_MINE = "/api/events/mine";
const EVENT_ID_RE = /^\/api\/events\/([^/]+)$/;
const EVENT_RSVP_RE = /^\/api\/events\/([^/]+)\/rsvp$/;
const EVENT_ATTENDEES_RE = /^\/api\/events\/([^/]+)\/attendees$/;
const EVENT_SHIFTS_RE = /^\/api\/events\/([^/]+)\/shifts$/;
const EVENT_SHIFT_ID_RE = /^\/api\/events\/([^/]+)\/shifts\/([^/]+)$/;
const EVENT_SHIFT_SIGNUP_RE = /^\/api\/events\/([^/]+)\/shifts\/([^/]+)\/signup$/;

const MUTATION_MIDDLEWARE = [
  corsMiddleware(),
  csrfMiddleware(),
  featureToggleMiddleware("events_enabled"),
];
const READ_MIDDLEWARE = [corsMiddleware(), featureToggleMiddleware("events_enabled")];

function unauthorized(securityHeaders: SecurityHeaders): Response {
  return securityHeaders.createSecureResponse(
    JSON.stringify({ error: "Unauthorized" }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

function badPath(securityHeaders: SecurityHeaders): Response {
  return securityHeaders.createSecureResponse(
    JSON.stringify({ error: "VALIDATION_ERROR", message: "Invalid path" }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/** Build an EventHandler with its two injected seams (DI assembly only). */
function newEventHandler(): EventHandler {
  return new EventHandler(new EventNotificationProducer(), new PostFeedAnnouncer());
}

const ONE_HOUR_SECONDS = 3600;

/**
 * Enforce a per-hour write-rate limit (review F-4) via the shared distributed
 * token-bucket limiter (`RateLimiter`, same infra as `rateLimitMiddleware`).
 * `bucketKey` is passed as the limiter's identity so the caller controls the
 * bucket granularity: `session.userId` for the per-user+event RSVP limit, the
 * `eventId` itself for the per-event update limit. Returns a 429 Response when
 * the limit is exceeded, else null. The limiter degrades gracefully (in-memory
 * fallback) if the distributed store is unreachable.
 */
async function enforceWriteRateLimit(
  env: Env,
  request: Request,
  endpoint: string,
  limitPerHour: number,
  bucketKey: string,
): Promise<Response | null> {
  return new RateLimiter().applyRateLimitKV(
    env,
    request,
    endpoint,
    limitPerHour,
    ONE_HOUR_SECONDS,
    undefined,
    undefined,
    bucketKey,
  );
}

export const eventsRoutes: Route[] = [
  // ── Collection ────────────────────────────────────────────────────────────
  {
    path: EVENTS_BASE,
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      const response = await newEventHandler().handleCreate(request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: MUTATION_MIDDLEWARE,
    description: "Create an event",
  },

  {
    path: EVENTS_BASE,
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      const response = await newEventHandler().handleList(request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: READ_MIDDLEWARE,
    description: "List events (visibility-filtered, cursor-paginated)",
  },

  // ── Mine (static path; MUST precede the bare :id capture, plan §4.5/F-7) ─────
  {
    path: EVENTS_MINE,
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      const response = await newEventHandler().handleListMine(request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: READ_MIDDLEWARE,
    description: "List the caller's own events (created or RSVP'd)",
  },

  // ── RSVP (sub-resource; before the bare :id) ────────────────────────────────
  {
    path: EVENT_RSVP_RE,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const session = await new SessionManager().getSession(request, env.SESSION_SECRET, env);
      if (!session) return unauthorized(securityHeaders);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      if (!requestContext) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request context not available" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      const eventId = pathname.match(EVENT_RSVP_RE)?.[1];
      if (!eventId) return badPath(securityHeaders);
      // MEMBER-role floor (review F-2): a GUEST may not RSVP. RsvpHandler takes
      // a Session (no role), so the role gate lives here at the route, mirroring
      // ShiftHandler.handleSignup's requireRole.
      const denied = requireRole(auth, "MEMBER");
      if (denied) return securityHeaders.addSecurityHeaders(denied);
      // Per-user+event RSVP write-rate limit (review F-4): bucket keyed by
      // userId, endpoint carries the eventId → one bucket per (user, event).
      const limited = await enforceWriteRateLimit(
        env,
        request,
        `events:rsvp:${eventId}`,
        env.event.rsvpRatePerHour,
        session.userId,
      );
      if (limited) return securityHeaders.addSecurityHeaders(limited);
      const handler = new RsvpHandler(createPrisma(env));
      const response = await handler.handleRsvp(
        eventId,
        request,
        session,
        env,
        requestContext,
        auth.activeTenantId,
      );
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: MUTATION_MIDDLEWARE,
    description: "Create or change the caller's RSVP",
  },

  {
    path: EVENT_RSVP_RE,
    method: "DELETE",
    handler: async (request, env, { pathname, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const session = await new SessionManager().getSession(request, env.SESSION_SECRET, env);
      if (!session) return unauthorized(securityHeaders);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      if (!requestContext) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request context not available" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      const eventId = pathname.match(EVENT_RSVP_RE)?.[1];
      if (!eventId) return badPath(securityHeaders);
      // MEMBER-role floor (review F-2): withdraw is a MEMBER+ operation too.
      const denied = requireRole(auth, "MEMBER");
      if (denied) return securityHeaders.addSecurityHeaders(denied);
      const handler = new RsvpHandler(createPrisma(env));
      const response = await handler.handleWithdraw(
        eventId,
        request,
        session,
        env,
        requestContext,
        auth.activeTenantId,
      );
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: MUTATION_MIDDLEWARE,
    description: "Withdraw the caller's RSVP",
  },

  {
    path: EVENT_ATTENDEES_RE,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const session = await new SessionManager().getSession(request, env.SESSION_SECRET, env);
      if (!session) return unauthorized(securityHeaders);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      if (!requestContext) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request context not available" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      const eventId = pathname.match(EVENT_ATTENDEES_RE)?.[1];
      if (!eventId) return badPath(securityHeaders);
      const handler = new RsvpHandler(createPrisma(env));
      const response = await handler.handleAttendees(
        eventId,
        request,
        session,
        env,
        requestContext,
        auth.activeTenantId,
      );
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: READ_MIDDLEWARE,
    description: "List an event's attendees (roster, no location fields)",
  },

  // ── Shifts (sub-resource; before the bare :id) ──────────────────────────────
  {
    path: EVENT_SHIFTS_RE,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      const eventId = pathname.match(EVENT_SHIFTS_RE)?.[1];
      if (!eventId) return badPath(securityHeaders);
      const response = await new ShiftHandler().handleCreate(eventId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: MUTATION_MIDDLEWARE,
    description: "Create a shift on an event",
  },

  {
    path: EVENT_SHIFTS_RE,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      const eventId = pathname.match(EVENT_SHIFTS_RE)?.[1];
      if (!eventId) return badPath(securityHeaders);
      const response = await new ShiftHandler().handleList(eventId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: READ_MIDDLEWARE,
    description: "List an event's shifts",
  },

  {
    path: EVENT_SHIFT_SIGNUP_RE,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      const match = pathname.match(EVENT_SHIFT_SIGNUP_RE);
      const eventId = match?.[1];
      const shiftId = match?.[2];
      if (!eventId || !shiftId) return badPath(securityHeaders);
      const response = await new ShiftHandler().handleSignup(eventId, shiftId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: MUTATION_MIDDLEWARE,
    description: "Sign up for a shift",
  },

  {
    path: EVENT_SHIFT_SIGNUP_RE,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      const match = pathname.match(EVENT_SHIFT_SIGNUP_RE);
      const eventId = match?.[1];
      const shiftId = match?.[2];
      if (!eventId || !shiftId) return badPath(securityHeaders);
      const response = await new ShiftHandler().handleWithdraw(eventId, shiftId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: MUTATION_MIDDLEWARE,
    description: "Withdraw from a shift",
  },

  {
    path: EVENT_SHIFT_ID_RE,
    method: "PATCH",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      const match = pathname.match(EVENT_SHIFT_ID_RE);
      const eventId = match?.[1];
      const shiftId = match?.[2];
      if (!eventId || !shiftId) return badPath(securityHeaders);
      const response = await new ShiftHandler().handleUpdate(eventId, shiftId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: MUTATION_MIDDLEWARE,
    description: "Update a shift",
  },

  {
    path: EVENT_SHIFT_ID_RE,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      const match = pathname.match(EVENT_SHIFT_ID_RE);
      const eventId = match?.[1];
      const shiftId = match?.[2];
      if (!eventId || !shiftId) return badPath(securityHeaders);
      const response = await new ShiftHandler().handleDelete(eventId, shiftId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: MUTATION_MIDDLEWARE,
    description: "Delete a shift",
  },

  // ── Item (bare :id; registered LAST so sub-resources win) ───────────────────
  {
    path: EVENT_ID_RE,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      const id = pathname.match(EVENT_ID_RE)?.[1];
      if (!id) return badPath(securityHeaders);
      const response = await newEventHandler().handleGet(id, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: READ_MIDDLEWARE,
    description: "Get an event by id",
  },

  {
    path: EVENT_ID_RE,
    method: "PATCH",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      const id = pathname.match(EVENT_ID_RE)?.[1];
      if (!id) return badPath(securityHeaders);
      // Per-event update write-rate limit (review F-4): bucket keyed by the
      // eventId itself (passed as the limiter identity) → one bucket per event
      // regardless of which editor, bounding EVENT_UPDATED notification churn.
      const limited = await enforceWriteRateLimit(
        env,
        request,
        "events:update",
        env.event.updateRatePerHour,
        id,
      );
      if (limited) return securityHeaders.addSecurityHeaders(limited);
      const response = await newEventHandler().handleUpdate(id, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: MUTATION_MIDDLEWARE,
    description: "Update an event (incl. DRAFT->PUBLISHED publish)",
  },

  {
    path: EVENT_ID_RE,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) return unauthorized(securityHeaders);
      const id = pathname.match(EVENT_ID_RE)?.[1];
      if (!id) return badPath(securityHeaders);
      const response = await newEventHandler().handleDelete(id, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: MUTATION_MIDDLEWARE,
    description: "Cancel an event (soft -> CANCELLED)",
  },
];
