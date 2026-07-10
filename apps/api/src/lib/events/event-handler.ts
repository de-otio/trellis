/**
 * Event Handler — CRUD for the Events primitive (R1, P1-B).
 *
 * create/get/list/update(patch)/delete(soft->CANCELLED) against `prisma.event`.
 * Cross-cutting behaviors (companion feed post, EVENT_* notifications) are
 * reached ONLY through the injected `FeedAnnouncer` / `NotificationProducer`
 * seams (constructor DI) — this file never touches `post-handler.ts` or
 * `notification-handler.ts` internals, so it unit-tests with mocks and needs
 * no Phase-2 wiring to be complete (design plan §2, §4.6).
 *
 * Enforced here (design plan §4.4):
 *  - Capability gate: `EventCreate` (MEMBER+ floor) for create;
 *    `EventUpdate`/`EventDelete` are own-only for MEMBER, unconditional for
 *    `EventModerate` holders (ADMIN+) — via `requireCapability`'s own-only
 *    fallback (`auth/require.ts`).
 *  - Read-side visibility: TENANT_ONLY (same tenant), GROUP_ONLY (event's
 *    tenant + GroupMember of `event.groupId`), PUBLIC (any authenticated
 *    caller, any tenant). DRAFT events are visible only to their creator or
 *    an `EventModerate` holder of the owning tenant (not yet announced).
 *  - Mandatory explicit `tenantId` filtering on every query — `TENANT_SCOPE_MODE`
 *    defaults to `off`, so the auto-scope middleware is a no-op by default;
 *    this handler filters `tenantId` itself on every read/write (belt), never
 *    relying on middleware-level scoping (suspenders).
 *  - Location responses are precision-filtered (`precisionFilteredLocation`
 *    from `seams.ts`) — raw `lat`/`lng` never serialize below EXACT precision
 *    (§4.6 SEC-6).
 *  - `events_enabled` feature toggle checked directly (defense-in-depth,
 *    mirrors `entity-handler.ts`'s `entity_profiles_enabled` check) in
 *    addition to the route-level `featureToggleMiddleware` Phase 2 will add;
 *    disabled reads as 404 (indistinguishable from a non-existent route, same
 *    convention as `feature-gate-middleware.ts`).
 *
 * Design: plans/events-primitive/README.md §4.4, §4.5, §4.6.
 */

import type { Event as EventRecord, Prisma } from "@prisma/client";
import type { Env } from "../../env.js";
import type { AuthContext } from "../auth/auth-context.js";
import { Capability, requireCapability } from "../auth/require.js";
import { RoleGrants } from "../auth/role-grants.js";
import { getLogger, Logger } from "../logger.js";
import {
  precisionFilteredLocation,
  type EventAnnouncementInput,
  type EventChangedField,
  type EventLocationSnapshot,
  type FeedAnnouncer,
  type NotificationProducer,
} from "./seams.js";

// ============================================================================
// Response helpers
// ============================================================================

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFound(message = "Event not found"): Response {
  return jsonResponse({ error: "NOT_FOUND", message }, 404);
}

function toLocationSnapshot(event: EventRecord): EventLocationSnapshot {
  return {
    precision: event.locationPrecision,
    locationName: event.locationName,
    lat: event.lat,
    lng: event.lng,
    displayLat: event.displayLat,
    displayLng: event.displayLng,
  };
}

/**
 * Serialize an Event row for API responses. Never exposes raw `lat`/`lng` —
 * `location` is always the precision-filtered view (§4.6 SEC-6).
 */
function serializeEvent(event: EventRecord) {
  const location = precisionFilteredLocation(toLocationSnapshot(event));
  return {
    id: event.id,
    tenantId: event.tenantId,
    groupId: event.groupId,
    creatorId: event.creatorId,
    title: event.title,
    description: event.description,
    status: event.status,
    visibility: event.visibility,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    location: {
      precision: event.locationPrecision,
      label: location.label,
      lat: location.lat,
      lng: location.lng,
    },
    capacity: event.capacity,
    rsvpCount: event.rsvpCount,
    waitlistCount: event.waitlistCount,
    announcePostId: event.announcePostId,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

// ============================================================================
// Keyset pagination cursor — (startsAt, id), mirrors feed-handler.ts's
// (createdAt, id) FeedCursor.
// ============================================================================

interface EventCursor {
  startsAt: Date;
  eventId: string;
}

function decodeEventCursor(raw?: string): EventCursor | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
      startsAt?: unknown;
      eventId?: unknown;
    };
    if (typeof d.startsAt === "string" && typeof d.eventId === "string") {
      const t = new Date(d.startsAt);
      if (!Number.isNaN(t.getTime())) return { startsAt: t, eventId: d.eventId };
    }
  } catch {
    // Malformed cursor — treat as absent (first page).
  }
  return null;
}

function encodeEventCursor(startsAt: Date, eventId: string): string {
  return Buffer.from(
    JSON.stringify({ startsAt: startsAt.toISOString(), eventId }),
  ).toString("base64");
}

// ============================================================================
// EventHandler
// ============================================================================

export class EventHandler {
  constructor(
    private readonly notificationProducer: NotificationProducer,
    private readonly feedAnnouncer: FeedAnnouncer,
  ) {}

  /** POST /api/events */
  async handleCreate(
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    try {
      if (!(await this.featureEnabled(env))) return notFound();

      const denied = requireCapability(auth, Capability.EventCreate);
      if (denied) return denied;

      const { validateRequest } = await import("../validate-request.js");
      const { createEventSchema } = await import("../schemas.js");
      const validation = await validateRequest(request, createEventSchema);
      if (!validation.success) return validation.error;
      const body = validation.data;

      const visibility = body.visibility ?? "TENANT_ONLY";
      if (visibility === "GROUP_ONLY" && !body.groupId) {
        return jsonResponse(
          {
            error: "VALIDATION_ERROR",
            message: "groupId is required for GROUP_ONLY visibility",
          },
          400,
        );
      }

      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);

      if (body.groupId) {
        const group = await db.group.findFirst({
          where: { id: body.groupId, tenantId: auth.activeTenantId },
          select: { id: true },
        });
        if (!group) {
          return jsonResponse(
            { error: "GROUP_NOT_FOUND", message: "Group not found" },
            404,
          );
        }
      }

      // Quota counts only LIVE events (review F-5): a CANCELLED event no longer
      // occupies a tenant's slot, so cancelling frees quota rather than
      // permanently consuming it.
      const activeCount = await db.event.count({
        where: {
          tenantId: auth.activeTenantId,
          deletedAt: null,
          status: { not: "CANCELLED" },
        },
      });
      if (activeCount >= env.event.maxPerTenant) {
        return jsonResponse(
          {
            error: "LIMIT_EXCEEDED",
            message: `Tenants may have at most ${env.event.maxPerTenant} events`,
          },
          409,
        );
      }

      const locationPrecision = body.locationPrecision ?? "CITY";
      const display = await this.resolveDisplayCoords(
        locationPrecision,
        body.lat ?? null,
        body.lng ?? null,
      );

      const event = await db.event.create({
        data: {
          tenantId: auth.activeTenantId,
          groupId: body.groupId ?? null,
          creatorId: auth.userId,
          title: body.title,
          description: body.description ?? null,
          visibility,
          startsAt: new Date(body.startsAt),
          endsAt: body.endsAt ? new Date(body.endsAt) : null,
          timezone: body.timezone ?? "Europe/Berlin",
          locationName: body.locationName ?? null,
          lat: body.lat ?? null,
          lng: body.lng ?? null,
          displayLat: display.displayLat,
          displayLng: display.displayLng,
          locationPrecision,
          capacity: body.capacity ?? null,
        },
      });

      return jsonResponse(serializeEvent(event), 201);
    } catch (error) {
      return this.mapError(error);
    }
  }

  /** GET /api/events/:id */
  async handleGet(id: string, auth: AuthContext, env: Env): Promise<Response> {
    try {
      if (!(await this.featureEnabled(env))) return notFound();

      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);

      // Tenant-scoped lookup first (review F-6): a TENANT_ONLY/GROUP_ONLY event
      // in another tenant must be indistinguishable from a non-existent one, so
      // it must never even be fetched here. Only if the tenant-scoped lookup
      // misses do we fall back to an UNSCOPED lookup constrained to PUBLIC —
      // the sole visibility that is legitimately cross-tenant readable — so the
      // response timing/shape cannot be used to probe for private events in
      // other tenants.
      let event = await db.event.findFirst({
        where: { id, deletedAt: null, tenantId: auth.activeTenantId },
      });
      if (!event) {
        event = await db.event.findFirst({
          where: { id, deletedAt: null, visibility: "PUBLIC" },
        });
      }
      if (!event) return notFound();

      const allowed = await this.canRead(db, event, auth);
      if (!allowed) return notFound();

      return jsonResponse(serializeEvent(event), 200);
    } catch (error) {
      return this.mapError(error);
    }
  }

  /** GET /api/events (cursor-paginated, visibility-filtered). */
  async handleList(
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    try {
      if (!(await this.featureEnabled(env))) return notFound();

      const { validateQueryParams } = await import("../validate-request.js");
      const { eventListQuerySchema } = await import("../schemas.js");
      const url = new URL(request.url);
      const validation = validateQueryParams(
        url,
        eventListQuerySchema(env.event.listPageMax),
      );
      if (!validation.success) return validation.error;
      const query = validation.data;

      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);

      const memberGroupIds = await this.memberGroupIds(db, auth);
      const isModerator = this.isModerator(auth);
      const cursor = decodeEventCursor(query.cursor);

      const visibilityFilter: Prisma.EventWhereInput = {
        OR: [
          { visibility: { in: ["TENANT_ONLY", "PUBLIC"] } },
          { visibility: "GROUP_ONLY", groupId: { in: memberGroupIds } },
        ],
      };
      const draftFilter: Prisma.EventWhereInput = isModerator
        ? {}
        : { OR: [{ status: { not: "DRAFT" } }, { creatorId: auth.userId }] };
      const cursorFilter: Prisma.EventWhereInput = cursor
        ? {
            OR: [
              { startsAt: { gt: cursor.startsAt } },
              { startsAt: cursor.startsAt, id: { gt: cursor.eventId } },
            ],
          }
        : {};

      const where: Prisma.EventWhereInput = {
        tenantId: auth.activeTenantId,
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.groupId ? { groupId: query.groupId } : {}),
        ...(query.upcoming ? { startsAt: { gte: new Date() } } : {}),
        AND: [visibilityFilter, draftFilter, cursorFilter],
      };

      const events = await db.event.findMany({
        where,
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        take: query.limit + 1,
      });

      const hasMore = events.length > query.limit;
      const page = hasMore ? events.slice(0, query.limit) : events;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? encodeEventCursor(last.startsAt, last.id) : undefined;

      return jsonResponse(
        { items: page.map(serializeEvent), cursor: nextCursor, hasMore },
        200,
      );
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * GET /api/events/mine (plan §4.5, review F-7) — the caller's own events in
   * the active tenant: events they created OR have an RSVP on. Cursor-paginated
   * exactly like `handleList` (keyset `(startsAt, id)`). No cross-tenant rows
   * and no visibility filter is needed — every row is one the caller already
   * owns or has RSVP'd to, so it is inherently visible to them.
   */
  async handleListMine(
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    try {
      if (!(await this.featureEnabled(env))) return notFound();

      const { validateQueryParams } = await import("../validate-request.js");
      const { eventListQuerySchema } = await import("../schemas.js");
      const url = new URL(request.url);
      const validation = validateQueryParams(
        url,
        eventListQuerySchema(env.event.listPageMax),
      );
      if (!validation.success) return validation.error;
      const query = validation.data;

      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);

      const cursor = decodeEventCursor(query.cursor);
      const cursorFilter: Prisma.EventWhereInput = cursor
        ? {
            OR: [
              { startsAt: { gt: cursor.startsAt } },
              { startsAt: cursor.startsAt, id: { gt: cursor.eventId } },
            ],
          }
        : {};

      const where: Prisma.EventWhereInput = {
        tenantId: auth.activeTenantId,
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.groupId ? { groupId: query.groupId } : {}),
        ...(query.upcoming ? { startsAt: { gte: new Date() } } : {}),
        // Mine = created by the caller OR the caller has an RSVP on it.
        OR: [
          { creatorId: auth.userId },
          { rsvps: { some: { userId: auth.userId } } },
        ],
        AND: [cursorFilter],
      };

      const events = await db.event.findMany({
        where,
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        take: query.limit + 1,
      });

      const hasMore = events.length > query.limit;
      const page = hasMore ? events.slice(0, query.limit) : events;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? encodeEventCursor(last.startsAt, last.id) : undefined;

      return jsonResponse(
        { items: page.map(serializeEvent), cursor: nextCursor, hasMore },
        200,
      );
    } catch (error) {
      return this.mapError(error);
    }
  }

  /** PATCH /api/events/:id — partial update; carries the DRAFT->PUBLISHED transition. */
  async handleUpdate(
    id: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    try {
      if (!(await this.featureEnabled(env))) return notFound();

      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);

      const existing = await db.event.findFirst({ where: { id, deletedAt: null } });
      if (!existing || existing.tenantId !== auth.activeTenantId) return notFound();

      const denied = requireCapability(auth, Capability.EventUpdate, {
        resource: { authorId: existing.creatorId },
      });
      if (denied) return denied;

      if (existing.status === "CANCELLED") {
        return jsonResponse(
          { error: "CONFLICT", message: "Cancelled events cannot be edited" },
          409,
        );
      }

      const { validateRequest } = await import("../validate-request.js");
      const { editEventSchema } = await import("../schemas.js");
      const validation = await validateRequest(request, editEventSchema);
      if (!validation.success) return validation.error;
      const patch = validation.data;

      const nextVisibility = patch.visibility ?? existing.visibility;
      if (nextVisibility === "GROUP_ONLY" && !existing.groupId) {
        return jsonResponse(
          {
            error: "VALIDATION_ERROR",
            message: "groupId is required for GROUP_ONLY visibility",
          },
          400,
        );
      }

      const nextLocationPrecision = patch.locationPrecision ?? existing.locationPrecision;
      const nextLat = patch.lat !== undefined ? patch.lat : existing.lat;
      const nextLng = patch.lng !== undefined ? patch.lng : existing.lng;
      const nextLocationName =
        patch.locationName !== undefined ? patch.locationName : existing.locationName;
      const nextStartsAt = patch.startsAt ? new Date(patch.startsAt) : existing.startsAt;
      const nextEndsAt =
        patch.endsAt !== undefined
          ? patch.endsAt
            ? new Date(patch.endsAt)
            : null
          : existing.endsAt;

      const display = await this.resolveDisplayCoords(
        nextLocationPrecision,
        nextLat,
        nextLng,
      );

      const changedFields = this.computeChangedFields(existing, {
        startsAt: nextStartsAt,
        endsAt: nextEndsAt,
        locationName: nextLocationName,
        lat: nextLat,
        lng: nextLng,
        locationPrecision: nextLocationPrecision,
      });

      const requestedStatus = patch.status ?? existing.status;
      // `existing.status` is already narrowed to DRAFT | PUBLISHED by the
      // CANCELLED early-return guard above, so cancelling is decided solely by
      // the requested status.
      const isCancelling = requestedStatus === "CANCELLED";
      const isPublishing = existing.status === "DRAFT" && requestedStatus === "PUBLISHED";

      const updated = await db.event.update({
        where: { id },
        data: {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
          ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
          ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
          startsAt: nextStartsAt,
          endsAt: nextEndsAt,
          locationName: nextLocationName,
          lat: nextLat,
          lng: nextLng,
          displayLat: display.displayLat,
          displayLng: display.displayLng,
          locationPrecision: nextLocationPrecision,
          status: isCancelling ? "CANCELLED" : requestedStatus,
        },
      });

      if (isCancelling) {
        if (existing.status === "PUBLISHED") {
          await this.retractAndNotifyCancelled(updated, env);
        }
        return jsonResponse(serializeEvent(updated), 200);
      }

      if (isPublishing) {
        const postId = await this.feedAnnouncer.announce(
          this.toAnnouncementInput(updated),
          env,
        );
        const withPost = postId
          ? await db.event.update({
              where: { id },
              data: { announcePostId: postId },
            })
          : updated;
        return jsonResponse(serializeEvent(withPost), 200);
      }

      if (updated.status === "PUBLISHED" && changedFields.length > 0) {
        const announcementInput = this.toAnnouncementInput(updated);
        if (updated.announcePostId) {
          await this.feedAnnouncer.update(announcementInput, env);
        }
        await this.notificationProducer.notifyEventUpdated(
          {
            eventId: updated.id,
            tenantId: updated.tenantId,
            title: updated.title,
            startsAt: updated.startsAt.toISOString(),
            changedFields,
          },
          env,
        );
      }

      return jsonResponse(serializeEvent(updated), 200);
    } catch (error) {
      return this.mapError(error);
    }
  }

  /** DELETE /api/events/:id — soft cancel (status -> CANCELLED). Idempotent. */
  async handleDelete(id: string, auth: AuthContext, env: Env): Promise<Response> {
    try {
      if (!(await this.featureEnabled(env))) return notFound();

      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);

      const existing = await db.event.findFirst({ where: { id, deletedAt: null } });
      if (!existing || existing.tenantId !== auth.activeTenantId) return notFound();

      const denied = requireCapability(auth, Capability.EventDelete, {
        resource: { authorId: existing.creatorId },
      });
      if (denied) return denied;

      if (existing.status === "CANCELLED") {
        return jsonResponse(serializeEvent(existing), 200);
      }

      const wasPublished = existing.status === "PUBLISHED";
      const updated = await db.event.update({
        where: { id },
        data: { status: "CANCELLED" },
      });

      if (wasPublished) {
        await this.retractAndNotifyCancelled(updated, env);
      }

      return jsonResponse(serializeEvent(updated), 200);
    } catch (error) {
      return this.mapError(error);
    }
  }

  // ── Read-side visibility (§4.4) ──────────────────────────────────────────

  private isModerator(auth: AuthContext): boolean {
    if (auth.globalRole === "SUPER_ADMIN") return true;
    return RoleGrants[auth.tenantRole]?.has(Capability.EventModerate) === true;
  }

  private async isGroupMember(
    db: { user: { findUnique: (...args: any[]) => any } },
    groupId: string,
    userId: string,
  ): Promise<boolean> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { actorUri: true },
    });
    if (!user?.actorUri) return false;
    const { GroupService } = await import("../activitypub/group-service.js");
    return GroupService.isMember(db as any, groupId, user.actorUri);
  }

  private async memberGroupIds(
    db: {
      user: { findUnique: (...args: any[]) => any };
      groupMember: { findMany: (...args: any[]) => any };
    },
    auth: AuthContext,
  ): Promise<string[]> {
    const user = await db.user.findUnique({
      where: { id: auth.userId },
      select: { actorUri: true },
    });
    if (!user?.actorUri) return [];
    const memberships = await db.groupMember.findMany({
      where: { tenantId: auth.activeTenantId, actorUri: user.actorUri },
      select: { groupId: true },
    });
    return memberships.map((m: { groupId: string }) => m.groupId);
  }

  private async canRead(
    db: {
      user: { findUnique: (...args: any[]) => any };
    },
    event: EventRecord,
    auth: AuthContext,
  ): Promise<boolean> {
    const isCreator = event.creatorId === auth.userId;
    const isModerator = this.isModerator(auth);

    // DRAFT events are unpublished — visible only to their creator or a
    // moderator of the owning tenant, regardless of `visibility`.
    if (event.status === "DRAFT") {
      if (event.tenantId !== auth.activeTenantId) return false;
      return isCreator || isModerator;
    }

    switch (event.visibility) {
      case "PUBLIC":
        return true;
      case "TENANT_ONLY":
        return event.tenantId === auth.activeTenantId;
      case "GROUP_ONLY": {
        if (!event.groupId) return false;
        if (event.tenantId !== auth.activeTenantId) return false;
        if (isCreator || isModerator) return true;
        return this.isGroupMember(db, event.groupId, auth.userId);
      }
      default:
        return false;
    }
  }

  // ── Companion post / notification wiring ─────────────────────────────────

  private toAnnouncementInput(event: EventRecord): EventAnnouncementInput {
    return {
      eventId: event.id,
      tenantId: event.tenantId,
      creatorId: event.creatorId,
      visibility: event.visibility,
      title: event.title,
      description: event.description,
      startsAt: event.startsAt.toISOString(),
      timezone: event.timezone,
      location: toLocationSnapshot(event),
      announcePostId: event.announcePostId,
    };
  }

  private async retractAndNotifyCancelled(event: EventRecord, env: Env): Promise<void> {
    if (event.announcePostId) {
      await this.feedAnnouncer.retract(this.toAnnouncementInput(event), env);
    }
    await this.notificationProducer.notifyEventCancelled(
      {
        eventId: event.id,
        tenantId: event.tenantId,
        title: event.title,
        startsAt: event.startsAt.toISOString(),
      },
      env,
    );
  }

  // ── Pure-ish helpers ──────────────────────────────────────────────────────

  private computeChangedFields(
    existing: EventRecord,
    next: {
      startsAt: Date;
      endsAt: Date | null;
      locationName: string | null;
      lat: number | null;
      lng: number | null;
      locationPrecision: string;
    },
  ): EventChangedField[] {
    const changed: EventChangedField[] = [];
    if (existing.startsAt.getTime() !== next.startsAt.getTime()) changed.push("startsAt");

    const oldEnds = existing.endsAt ? existing.endsAt.getTime() : null;
    const newEnds = next.endsAt ? next.endsAt.getTime() : null;
    if (oldEnds !== newEnds) changed.push("endsAt");

    const locationChanged =
      existing.locationName !== next.locationName ||
      existing.lat !== next.lat ||
      existing.lng !== next.lng ||
      existing.locationPrecision !== next.locationPrecision;
    if (locationChanged) changed.push("location");

    return changed;
  }

  /**
   * Recompute `displayLat`/`displayLng` for the given precision + true
   * coordinates. Only NEIGHBORHOOD precision stores a fuzzed display pair
   * (mirrors `TenantDirectoryProfile` / `directory-profile-handler.ts`'s
   * `computeNeighborhoodDisplay`, which is not exported — the algorithm is
   * duplicated here rather than imported). The fuzz radius is runtime config
   * via `resolveDirectoryProfileConfig()` (`NEIGHBORHOOD_FUZZ_RADIUS_METERS`),
   * reused rather than adding a second knob for the same concept.
   */
  private async resolveDisplayCoords(
    precision: string,
    lat: number | null,
    lng: number | null,
  ): Promise<{ displayLat: number | null; displayLng: number | null }> {
    if (precision !== "NEIGHBORHOOD" || lat == null || lng == null) {
      return { displayLat: null, displayLng: null };
    }
    const { resolveDirectoryProfileConfig } = await import(
      "../org-category/directory-profile-config.js"
    );
    const { neighborhoodFuzzMeters } = resolveDirectoryProfileConfig();
    return this.fuzzNeighborhood(lat, lng, neighborhoodFuzzMeters);
  }

  private fuzzNeighborhood(
    lat: number,
    lng: number,
    fuzzMeters: number,
  ): { displayLat: number; displayLng: number } {
    const angle = Math.random() * 2 * Math.PI;
    const distance = Math.sqrt(Math.random()) * fuzzMeters;
    const latDegPerMeter = 1 / 111_000;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const lngDegPerMeter = cosLat > 1e-6 ? 1 / (111_000 * cosLat) : latDegPerMeter;
    return {
      displayLat: lat + Math.sin(angle) * distance * latDegPerMeter,
      displayLng: lng + Math.cos(angle) * distance * lngDegPerMeter,
    };
  }

  private async featureEnabled(env: Env): Promise<boolean> {
    const { createPrisma } = await import("../../db.js");
    const { FeatureToggleService } = await import("../feature-toggle-service.js");
    const toggleService = new FeatureToggleService(createPrisma(env));
    return toggleService.isEnabled("events_enabled");
  }

  private mapError(error: any): Response {
    const logger: Logger = getLogger();

    if (error instanceof SyntaxError) {
      return jsonResponse({ error: "VALIDATION_ERROR", message: "Invalid JSON body" }, 400);
    }
    if (error?.code === "P2002") {
      logger.warn("[EventHandler] Unique constraint violation:", error.message);
      return jsonResponse({ error: "CONFLICT", message: "Conflicting event state" }, 409);
    }
    if (error?.code === "P2025") {
      logger.warn("[EventHandler] Record not found:", error.message);
      return notFound();
    }

    logger.error("[EventHandler] Unexpected error:", error);
    return jsonResponse({ error: "INTERNAL_ERROR", message: "Internal server error" }, 500);
  }
}
