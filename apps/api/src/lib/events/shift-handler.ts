/**
 * ShiftHandler — Events primitive (R1), P1-D.
 *
 * CRUD for `EventShift` (Dienstplan slots) within an event, plus member
 * signup/withdrawal. Uses the SAME atomic capacity + waitlist pattern as
 * RSVP (§4.3): a conditional `updateMany` claims (or releases) a seat, the
 * affected-row count decides CONFIRMED vs WAITLISTED, and a freed seat is
 * promoted via `FOR UPDATE SKIP LOCKED` so two concurrent withdrawals can
 * never promote the same waitlisted signup twice.
 *
 * Authorization (§4.4):
 *  - Shift create/update/delete: event creator (own) or ADMIN+ (`EventModerate`)
 *    — reuses `Capability.EventUpdate`/`Capability.EventDelete`, whose
 *    own-only fallback (`require.ts` `OWN_ONLY_FALLBACK`) already maps to
 *    `EventModerate`.
 *  - Signup/withdraw: any `MEMBER`+ in the event's tenant.
 *
 * Nested-resource IDOR guard (§4.4 SEC-7): every shift op validates
 * `shift.eventId === params.eventId` AND `event.tenantId === activeTenantId`
 * via `loadScopedShift` — a shift belonging to a different event (even one
 * the caller can otherwise reach) 404s, never leaking existence.
 *
 * No shared files are edited here — Prisma access is via `createPrisma(env)`
 * (dynamic import, matching `collection-handler.ts` / `tenant/member-handler.ts`),
 * and the injected `FeedAnnouncer`/`NotificationProducer` seams are not
 * needed by this handler (shifts have no feed/notification surface of their
 * own — only Event does).
 *
 * Design: plans/events-primitive/README.md §4.3, §4.4, §4.5.
 */

import type { Env } from "../../env.js";
import type { AuthContext } from "../auth/auth-context.js";
import { Capability, requireCapability, requireRole } from "../auth/require.js";
import { isEventModerator, isGroupMember } from "./event-visibility.js";
import { shiftSchema, shiftSignupSchema } from "../schemas.js";
import { getLogger, Logger } from "../logger.js";

const JSON_HEADERS = { "content-type": "application/json" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function notFound(message = "Not found"): Response {
  return jsonResponse(404, { error: "NOT_FOUND", message });
}

interface ShiftLike {
  id: string;
  tenantId: string;
  eventId: string;
  title: string;
  startsAt: Date | null;
  endsAt: Date | null;
  capacity: number;
  filledCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface EventLike {
  id: string;
  tenantId: string;
  creatorId: string;
  status: string;
  visibility: string;
  groupId: string | null;
  deletedAt: Date | null;
}

interface SignupLike {
  id: string;
  tenantId: string;
  shiftId: string;
  userId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

function serializeShift(shift: ShiftLike) {
  return {
    id: shift.id,
    eventId: shift.eventId,
    title: shift.title,
    startsAt: shift.startsAt,
    endsAt: shift.endsAt,
    capacity: shift.capacity,
    filledCount: shift.filledCount,
    createdAt: shift.createdAt,
    updatedAt: shift.updatedAt,
  };
}

function serializeSignup(signup: SignupLike) {
  return {
    id: signup.id,
    shiftId: signup.shiftId,
    userId: signup.userId,
    status: signup.status,
    createdAt: signup.createdAt,
    updatedAt: signup.updatedAt,
  };
}

/**
 * Edit body for PATCH shift. Hand-written (not `shiftSchema.partial()`) — the
 * `.refine()` on `shiftSchema` produces a `ZodEffects`, which has no
 * `.partial()`; mirrors how `editEventSchema` is a standalone object rather
 * than `createEventSchema.partial()`.
 */
async function buildEditShiftSchema() {
  const { z } = await import("zod");
  return z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      startsAt: z.string().datetime({ offset: true }).optional(),
      endsAt: z.string().datetime({ offset: true }).optional(),
      capacity: z.number().int().min(1).max(1_000_000).optional(),
    })
    .refine(
      (v) => v.startsAt === undefined || v.endsAt === undefined || v.endsAt >= v.startsAt,
      { message: "endsAt must not precede startsAt", path: ["endsAt"] },
    );
}

export class ShiftHandler {
  /** POST /api/events/:eventId/shifts — organizer (creator) or ADMIN+. */
  async handleCreate(
    eventId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    try {
      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);

      const event = await this.loadEvent(eventId, auth, db);
      if (!event) return notFound("Event not found");

      const denied = requireCapability(auth, Capability.EventUpdate, {
        resource: { ownerUserId: event.creatorId },
      });
      if (denied) return denied;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(400, { error: "INVALID_JSON", message: "Body must be valid JSON" });
      }

      const parsed = shiftSchema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse(400, {
          error: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message,
        });
      }

      const existingCount = await db.eventShift.count({ where: { eventId } });
      if (existingCount >= env.event.maxShiftsPerEvent) {
        return jsonResponse(409, {
          error: "LIMIT_EXCEEDED",
          message: `Events may have at most ${env.event.maxShiftsPerEvent} shifts`,
        });
      }

      const shift = await db.eventShift.create({
        data: {
          tenantId: auth.activeTenantId,
          eventId,
          title: parsed.data.title,
          startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : null,
          endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
          capacity: parsed.data.capacity,
        },
      });

      return jsonResponse(201, serializeShift(shift));
    } catch (error) {
      return this.mapError(error);
    }
  }

  /** GET /api/events/:eventId/shifts — any member of the event's tenant. */
  async handleList(eventId: string, auth: AuthContext, env: Env): Promise<Response> {
    try {
      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);

      const event = await this.loadEvent(eventId, auth, db);
      if (!event) return notFound("Event not found");

      const shifts = await db.eventShift.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      });

      return jsonResponse(200, { shifts: shifts.map(serializeShift) });
    } catch (error) {
      return this.mapError(error);
    }
  }

  /** PATCH /api/events/:eventId/shifts/:shiftId — organizer (creator) or ADMIN+. */
  async handleUpdate(
    eventId: string,
    shiftId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    try {
      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);

      const scoped = await this.loadScopedShift(eventId, shiftId, auth, db);
      if (!scoped) return notFound("Shift not found");
      const { event, shift } = scoped;

      const denied = requireCapability(auth, Capability.EventUpdate, {
        resource: { ownerUserId: event.creatorId },
      });
      if (denied) return denied;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(400, { error: "INVALID_JSON", message: "Body must be valid JSON" });
      }

      const editShiftSchema = await buildEditShiftSchema();
      const parsed = editShiftSchema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse(400, {
          error: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message,
        });
      }

      // Capacity reduction is race-safe (review F-8): rather than compare a
      // stale `shift.filledCount` read outside any lock, apply the new capacity
      // with a conditional UPDATE that references the live `filled_count`
      // column. Affected-rows=0 means the shift already has more signups than
      // the requested capacity → reject (never silently shrink below the fill).
      if (parsed.data.capacity !== undefined) {
        const newCapacity = parsed.data.capacity;
        const affected = await db.$executeRaw`
          UPDATE event_shifts
          SET capacity = ${newCapacity}, updated_at = now()
          WHERE id = ${shiftId}
            AND tenant_id = ${auth.activeTenantId}
            AND filled_count <= ${newCapacity}
        `;
        if (affected === 0) {
          return jsonResponse(409, {
            error: "LIMIT_EXCEEDED",
            message: "New capacity cannot be below the current number of signups",
          });
        }
      }

      const updated = await db.eventShift.update({
        where: { id: shiftId },
        data: {
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          ...(parsed.data.startsAt !== undefined
            ? { startsAt: new Date(parsed.data.startsAt) }
            : {}),
          ...(parsed.data.endsAt !== undefined ? { endsAt: new Date(parsed.data.endsAt) } : {}),
          // `capacity` is already applied atomically above; the Prisma update
          // covers only the remaining (non-raced) fields.
        },
      });

      return jsonResponse(200, serializeShift(updated));
    } catch (error) {
      return this.mapError(error);
    }
  }

  /** DELETE /api/events/:eventId/shifts/:shiftId — organizer (creator) or ADMIN+. */
  async handleDelete(
    eventId: string,
    shiftId: string,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    try {
      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);

      const scoped = await this.loadScopedShift(eventId, shiftId, auth, db);
      if (!scoped) return notFound("Shift not found");
      const { event } = scoped;

      const denied = requireCapability(auth, Capability.EventDelete, {
        resource: { ownerUserId: event.creatorId },
      });
      if (denied) return denied;

      await db.eventShift.delete({ where: { id: shiftId } }); // cascades ShiftSignup rows

      return new Response(null, { status: 204 });
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * POST /api/events/:eventId/shifts/:shiftId/signup — any MEMBER+.
   *
   * Atomic capacity claim (§4.3, applied to shifts): a conditional
   * `updateMany` on `filledCount < capacity` decides CONFIRMED vs
   * WAITLISTED from its affected-row count — never from a prior read, so two
   * concurrent signups against the last open seat cannot both win.
   * Idempotent: signing up again while CONFIRMED/WAITLISTED returns the
   * existing row unchanged; re-signing up after a CANCELLED withdrawal
   * reuses the unique `(shiftId, userId)` row via `update`.
   */
  async handleSignup(
    eventId: string,
    shiftId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    try {
      const denied = requireRole(auth, "MEMBER");
      if (denied) return denied;

      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);

      const scoped = await this.loadScopedShift(eventId, shiftId, auth, db);
      if (!scoped) return notFound("Shift not found");
      const { event } = scoped;

      if (event.status !== "PUBLISHED" || event.deletedAt) {
        return jsonResponse(409, {
          error: "CONFLICT",
          message: "Event is not open for shift signups",
        });
      }

      let raw: unknown = {};
      try {
        const text = await request.text();
        if (text) raw = JSON.parse(text);
      } catch {
        return jsonResponse(400, { error: "INVALID_JSON", message: "Body must be valid JSON" });
      }
      const parsed = shiftSignupSchema.safeParse(raw);
      if (!parsed.success) {
        return jsonResponse(400, {
          error: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message,
        });
      }

      const existing: SignupLike | null = await db.shiftSignup.findUnique({
        where: { shiftId_userId: { shiftId, userId: auth.userId } },
      });
      if (existing && existing.status !== "CANCELLED") {
        return jsonResponse(200, serializeSignup(existing));
      }

      const signup = await db.$transaction(
        async (tx) => {
          // Atomic seat claim (review F-1): the conditional references the live
          // `filled_count`/`capacity` COLUMNS, not the stale `shift.capacity`
          // read outside the transaction — so two concurrent signups racing for
          // the last seat cannot both be confirmed. Affected-rows=1 ⇒ CONFIRMED,
          // =0 ⇒ shift full ⇒ WAITLISTED (same pattern as RsvpHandler.claimSeats).
          const claim = await tx.$executeRaw`
            UPDATE event_shifts
            SET filled_count = filled_count + 1, updated_at = now()
            WHERE id = ${shiftId}
              AND tenant_id = ${auth.activeTenantId}
              AND filled_count + 1 <= capacity
          `;
          const status: "CONFIRMED" | "WAITLISTED" =
            claim === 1 ? "CONFIRMED" : "WAITLISTED";

          if (existing) {
            return tx.shiftSignup.update({ where: { id: existing.id }, data: { status } });
          }
          return tx.shiftSignup.create({
            data: { tenantId: auth.activeTenantId, shiftId, userId: auth.userId, status },
          });
        },
        { timeout: 3000 },
      );

      return jsonResponse(existing ? 200 : 201, serializeSignup(signup));
    } catch (error) {
      if ((error as { code?: string })?.code === "P2002") {
        // Concurrent duplicate signup lost the create race — return the
        // now-existing row idempotently rather than a 500.
        try {
          const { createPrisma } = await import("../../db.js");
          const db = createPrisma(env);
          const existing: SignupLike | null = await db.shiftSignup.findUnique({
            where: { shiftId_userId: { shiftId, userId: auth.userId } },
          });
          if (existing) return jsonResponse(200, serializeSignup(existing));
        } catch {
          // fall through to mapError below
        }
      }
      return this.mapError(error);
    }
  }

  /**
   * DELETE /api/events/:eventId/shifts/:shiftId/signup — withdraw.
   *
   * Marks the caller's signup CANCELLED (ShiftSignupStatus has a CANCELLED
   * member, unlike RsvpStatus — so this is a status flip, not a row delete).
   * If the withdrawn signup was CONFIRMED, atomically releases the seat
   * (conditional decrement, no negative counts) then promotes the
   * oldest WAITLISTED signup via `FOR UPDATE SKIP LOCKED` so two concurrent
   * withdrawals promote two *different* waitlisted users.
   */
  async handleWithdraw(
    eventId: string,
    shiftId: string,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    try {
      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);

      const scoped = await this.loadScopedShift(eventId, shiftId, auth, db);
      if (!scoped) return notFound("Shift not found");

      const existing: SignupLike | null = await db.shiftSignup.findUnique({
        where: { shiftId_userId: { shiftId, userId: auth.userId } },
      });
      if (!existing || existing.status === "CANCELLED") {
        return notFound("Signup not found");
      }

      const wasConfirmed = existing.status === "CONFIRMED";

      await db.$transaction(
        async (tx) => {
          await tx.shiftSignup.update({
            where: { id: existing.id },
            data: { status: "CANCELLED" },
          });

          if (!wasConfirmed) return;

          const released = await tx.eventShift.updateMany({
            where: { id: shiftId, filledCount: { gte: 1 } },
            data: { filledCount: { decrement: 1 } },
          });
          if (released.count !== 1) return;

          const promoted = await tx.$executeRaw`
            UPDATE event_shift_signups
            SET status = 'CONFIRMED'::"ShiftSignupStatus", updated_at = now()
            WHERE id = (
              SELECT id FROM event_shift_signups
              WHERE shift_id = ${shiftId} AND status = 'WAITLISTED'
              ORDER BY created_at ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED
            )
          `;
          if (promoted === 1) {
            await tx.eventShift.update({
              where: { id: shiftId },
              data: { filledCount: { increment: 1 } },
            });
          }
        },
        { timeout: 3000 },
      );

      return new Response(null, { status: 204 });
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * Load the parent event, scoped to the caller's active tenant AND enforcing
   * read-side visibility (§4.4, review F-3): a `GROUP_ONLY` event is invisible
   * (→ 404) to anyone who is not the creator, an `EventModerate` holder, or a
   * `GroupMember` of `event.groupId` — the same gate `RsvpHandler` applies, so a
   * same-tenant non-group-member can neither list nor sign up for its shifts.
   */
  private async loadEvent(
    eventId: string,
    auth: AuthContext,
    db: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  ): Promise<EventLike | null> {
    const event: EventLike | null = await db.event.findFirst({
      where: { id: eventId, tenantId: auth.activeTenantId, deletedAt: null },
    });
    if (!event) return null;

    if (
      event.visibility === "GROUP_ONLY" &&
      event.creatorId !== auth.userId &&
      !isEventModerator(auth) &&
      !(await isGroupMember(db, event.groupId, auth.userId, auth.activeTenantId))
    ) {
      return null;
    }

    return event;
  }

  /**
   * Nested-resource IDOR guard (§4.4 SEC-7): loads the shift ONLY if it
   * belongs to `eventId`, AND `eventId` belongs to the caller's tenant and is
   * visible to the caller. Returns null (→ 404 at the call site) for a shift
   * that exists but under a different event/tenant — never distinguishing that
   * from "does not exist".
   */
  private async loadScopedShift(
    eventId: string,
    shiftId: string,
    auth: AuthContext,
    db: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  ): Promise<{ event: EventLike; shift: ShiftLike } | null> {
    const event = await this.loadEvent(eventId, auth, db);
    if (!event) return null;

    const shift: ShiftLike | null = await db.eventShift.findFirst({ where: { id: shiftId } });
    if (!shift || shift.eventId !== eventId || shift.tenantId !== auth.activeTenantId) return null;

    return { event, shift };
  }

  private mapError(error: unknown): Response {
    const logger: Logger = getLogger();
    const err = error as { code?: string; message?: string } | null;

    if (error instanceof SyntaxError) {
      return jsonResponse(400, { error: "VALIDATION_ERROR", message: "Invalid JSON body" });
    }

    if (err?.code === "P2002") {
      logger.warn("[ShiftHandler] Unique constraint violation:", err.message);
      return jsonResponse(409, { error: "CONFLICT", message: "Already signed up for this shift" });
    }

    if (err?.code === "P2025") {
      logger.warn("[ShiftHandler] Record not found:", err.message);
      return jsonResponse(404, { error: "NOT_FOUND", message: "Not found" });
    }

    logger.error("[ShiftHandler] Unexpected error:", error);
    return jsonResponse(500, { error: "INTERNAL_ERROR", message: "Internal server error" });
  }
}
