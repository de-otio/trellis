/**
 * RSVP Handler (Events primitive, R1 — P1-C).
 *
 * Owns RSVP create / change / withdrawal and the attendee list for an event,
 * with the **no-over-capacity guarantee living in the SQL affected-rows** (plan
 * §4.3, review MED-1) — NOT in a pure decision function. Concretely, every seat
 * claim is a single atomic conditional `UPDATE ... WHERE capacity IS NULL OR
 * rsvp_count + party <= capacity` whose affected-row count decides GOING vs
 * WAITLISTED; concurrent claims serialise on the event row lock, each
 * re-evaluating the guard, so the count can never exceed capacity. The real
 * proof of that property is the concurrency integration test
 * (`test/integration/events.integration.test.ts`), not this file's unit tests.
 *
 * Seat accounting (both counts are SEAT-based — party = 1 + guests):
 *  - `Event.rsvpCount`     = confirmed (GOING) seats consumed.
 *  - `Event.waitlistCount` = waitlisted seats held.
 *
 * Design: plans/events-primitive/README.md §4.3, §4.4. Handler shape mirrors
 * `collection-handler.ts`; DI-of-Prisma + interactive `$transaction` mirrors
 * `graph/postgres/relationships.ts`; `activeTenantId` method param mirrors
 * `comment-handler.ts`. `env.event.*` thresholds are runtime config, never
 * compiled constants (CLAUDE.md rule 8, §4.8).
 *
 * NOTE (parallel-build decision): this handler deliberately does NOT import
 * `event-core.ts`'s `decideRsvpOutcome`. Per §4.3/MED-1 the capacity decision is
 * authoritative in the atomic SQL (affected-rows), and party arithmetic
 * (`1 + guests`, already clamped at the Zod boundary) is trivial. Keeping the
 * decision in SQL also keeps this file independently testable during the
 * Phase-1 fan-out.
 */

import type { Prisma, PrismaClient, RsvpStatus } from "@prisma/client";
import type { Env } from "../../env.js";
import { emitDomainEvent } from "./emit.js";
import { getLogger, type Logger } from "../logger.js";
import { mintTenantId } from "../mint-tenant-id.js";
import type { TrellisRequestContext } from "../request-context.js";
import type { Session } from "../session-cookie.js";

/** Bound on a single promotion pass (Infinite Loop Prevention house rule). */
const MAX_PROMOTIONS_PER_PASS = 10_000;

type TxClient = Prisma.TransactionClient;

interface RsvpRow {
  id: string;
  tenantId: string;
  eventId: string;
  userId: string;
  status: RsvpStatus;
  guests: number;
  createdAt: Date;
  updatedAt: Date;
}

interface EventGateRow {
  id: string;
  tenantId: string;
  groupId: string | null;
  status: string;
  visibility: string;
  startsAt: Date;
  deletedAt: Date | null;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function serializeRsvp(rsvp: RsvpRow) {
  return {
    id: rsvp.id,
    eventId: rsvp.eventId,
    userId: rsvp.userId,
    status: rsvp.status,
    guests: rsvp.guests,
    createdAt: rsvp.createdAt,
    updatedAt: rsvp.updatedAt,
  };
}

/**
 * Attendee-list projection (§4.4): NO event-location fields ever appear here —
 * it is an attendee roster, so it only carries who and how many.
 */
function serializeAttendee(rsvp: RsvpRow) {
  return {
    userId: rsvp.userId,
    status: rsvp.status,
    guests: rsvp.guests,
    createdAt: rsvp.createdAt,
  };
}

/** Outcome the transaction hands back to the public method to pick a status code. */
type RsvpTxResult =
  | { readonly kind: "created"; readonly rsvp: RsvpRow }
  | { readonly kind: "updated"; readonly rsvp: RsvpRow }
  | { readonly kind: "unchanged"; readonly rsvp: RsvpRow }
  | { readonly kind: "capacity-rejected"; readonly rsvp: RsvpRow };

export class RsvpHandler {
  private readonly logger: Logger;

  /**
   * @param db Injected Prisma client. Unit tests pass a mock; the concurrency
   *   integration test and the route layer (Phase 2) pass a real client so all
   *   parallel RSVPs share one connection pool and serialise on the event row.
   */
  constructor(private readonly db: PrismaClient) {
    this.logger = getLogger();
  }

  // ==========================================================================
  // POST /api/events/:id/rsvp — create or change the caller's RSVP
  // ==========================================================================

  async handleRsvp(
    eventId: string,
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      const { validateRequest } = await import("../validate-request.js");
      const { rsvpSchema } = await import("../schemas.js");
      const validation = await validateRequest(
        request,
        rsvpSchema(env.event.maxGuestsPerRsvp),
      );
      if (!validation.success) return validation.error;
      const body = validation.data;

      const gate = await this.loadVisibleEvent(eventId, session, activeTenantId);
      if ("error" in gate) return gate.error;
      const event = gate.event;

      // Status / time gate (§4.3, §5). DRAFT is invisible to non-creators → 404
      // (do not confirm existence); CANCELLED / past-start → 409.
      if (event.status === "DRAFT") {
        return jsonResponse({ error: "NOT_FOUND", message: "Event not found" }, 404);
      }
      if (event.status === "CANCELLED") {
        return jsonResponse(
          { error: "EVENT_CANCELLED", message: "This event has been cancelled" },
          409,
        );
      }
      if (event.startsAt.getTime() <= Date.now()) {
        return jsonResponse(
          { error: "EVENT_STARTED", message: "This event has already started" },
          409,
        );
      }

      const userId = session.userId;
      const newStatus = body.status; // GOING | MAYBE | NOT_GOING
      const newGuests = newStatus === "GOING" ? body.guests : 0;

      let result: RsvpTxResult;
      try {
        // Minted before the transaction opens: an invalid tenant id should be
        // rejected without costing a transaction, and only plain values cross
        // into the callback.
        const eventTenantId = mintTenantId(activeTenantId, "session");
        result = await this.db.$transaction(async (tx) => {
          const applied = await this.applyRsvp(tx, {
            eventId,
            tenantId: activeTenantId,
            userId,
            newStatus,
            newGuests,
          });

          // Domain event, IN THIS TRANSACTION (plan 034 lane E) — the update
          // shape, standing in for `entity.updated`, which does not run in a
          // transaction today (see the lane report). Only a real transition
          // is announced: `unchanged` and `capacity-rejected` changed no row,
          // and an event for them would be a lie a subscriber acts on.
          //
          // Inside the transaction, so the P2002 path below — a concurrent
          // duplicate RSVP whose losing transaction rolls back — takes the
          // event with it rather than leaving a row for a seat nobody holds.
          //
          // Payload is ids and changed field names only; the RSVP's status and
          // party size are the row's content and stay in the row.
          if (applied.kind === "updated") {
            await emitDomainEvent(tx, {
              type: "rsvp.updated",
              tenantId: eventTenantId,
              subjectKind: "rsvp",
              subjectId: applied.rsvp.id,
              payload: {
                rsvpId: applied.rsvp.id,
                eventId,
                userId,
                fields: ["status", "guests"],
              },
            });
          }

          return applied;
        });
      } catch (error) {
        // Double-RSVP idempotency (§4.3): a concurrent create for the same
        // (eventId,userId) hits @@unique([eventId,userId]) → the losing tx
        // rolls back (no double seat). Re-read and return the winner's row.
        if ((error as { code?: string })?.code === "P2002") {
          const existing = await this.db.rsvp.findUnique({
            where: { eventId_userId: { eventId, userId } },
          });
          if (existing) {
            return jsonResponse(serializeRsvp(existing as RsvpRow), 200);
          }
        }
        throw error;
      }

      switch (result.kind) {
        case "created":
          return jsonResponse(serializeRsvp(result.rsvp), 201);
        case "capacity-rejected":
          return jsonResponse(
            {
              error: "CAPACITY_FULL",
              message: "Not enough capacity for the requested party size",
              rsvp: serializeRsvp(result.rsvp),
            },
            409,
          );
        default:
          return jsonResponse(serializeRsvp(result.rsvp), 200);
      }
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * The RSVP state machine, run inside one interactive transaction. Capacity is
   * claimed/released via atomic conditional UPDATEs (affected-rows authoritative).
   */
  private async applyRsvp(
    tx: TxClient,
    input: {
      eventId: string;
      tenantId: string;
      userId: string;
      newStatus: "GOING" | "MAYBE" | "NOT_GOING";
      newGuests: number;
    },
  ): Promise<RsvpTxResult> {
    const { eventId, tenantId, userId, newStatus, newGuests } = input;
    const newParty = 1 + newGuests;

    const existing = (await tx.rsvp.findUnique({
      where: { eventId_userId: { eventId, userId } },
    })) as RsvpRow | null;

    // ---- No existing RSVP: create -----------------------------------------
    if (!existing) {
      if (newStatus !== "GOING") {
        const created = (await tx.rsvp.create({
          data: { tenantId, eventId, userId, status: newStatus, guests: 0 },
        })) as RsvpRow;
        return { kind: "created", rsvp: created };
      }
      const claimed = await this.claimSeats(tx, eventId, newParty);
      if (claimed) {
        const created = (await tx.rsvp.create({
          data: { tenantId, eventId, userId, status: "GOING", guests: newGuests },
        })) as RsvpRow;
        return { kind: "created", rsvp: created };
      }
      const created = (await tx.rsvp.create({
        data: { tenantId, eventId, userId, status: "WAITLISTED", guests: newGuests },
      })) as RsvpRow;
      await this.addWaitlist(tx, eventId, newParty);
      return { kind: "created", rsvp: created };
    }

    // ---- Existing RSVP: transition ----------------------------------------
    const oldStatus = existing.status;
    const oldParty = 1 + existing.guests;

    // Target is MAYBE / NOT_GOING: give back any held seat / waitlist slot.
    if (newStatus !== "GOING") {
      if (oldStatus === "GOING") {
        await this.releaseSeats(tx, eventId, oldParty);
        await this.promoteWaitlist(tx, eventId);
      } else if (oldStatus === "WAITLISTED") {
        await this.releaseWaitlist(tx, eventId, oldParty);
      }
      const updated = (await tx.rsvp.update({
        where: { id: existing.id },
        data: { status: newStatus, guests: 0 },
      })) as RsvpRow;
      return { kind: "updated", rsvp: updated };
    }

    // Target is GOING.
    if (oldStatus === "GOING") {
      const delta = newParty - oldParty;
      if (delta === 0) {
        return { kind: "unchanged", rsvp: existing };
      }
      if (delta < 0) {
        // Shrinking a party always succeeds and can never go negative
        // (oldParty was already counted). Frees seats → promote waitlist.
        await this.releaseSeats(tx, eventId, -delta);
        const updated = (await tx.rsvp.update({
          where: { id: existing.id },
          data: { guests: newGuests },
        })) as RsvpRow;
        await this.promoteWaitlist(tx, eventId);
        return { kind: "updated", rsvp: updated };
      }
      // Growing a party: claim only the delta (§4.3 SEC-1 guest-delta).
      const claimed = await this.claimSeats(tx, eventId, delta);
      if (!claimed) {
        // Reject the growth, stay at the old size.
        return { kind: "capacity-rejected", rsvp: existing };
      }
      const updated = (await tx.rsvp.update({
        where: { id: existing.id },
        data: { guests: newGuests },
      })) as RsvpRow;
      return { kind: "updated", rsvp: updated };
    }

    if (oldStatus === "WAITLISTED") {
      // Guests are IMMUTABLE while waitlisted (§4.3) — claim for the ORIGINAL
      // party and re-validate on promotion. If a seat frees up, promote.
      const claimed = await this.claimSeats(tx, eventId, oldParty);
      if (claimed) {
        await this.releaseWaitlist(tx, eventId, oldParty);
        const updated = (await tx.rsvp.update({
          where: { id: existing.id },
          data: { status: "GOING" },
        })) as RsvpRow;
        return { kind: "updated", rsvp: updated };
      }
      return { kind: "unchanged", rsvp: existing };
    }

    // oldStatus is MAYBE / NOT_GOING → GOING: same as a fresh GOING claim.
    const claimed = await this.claimSeats(tx, eventId, newParty);
    if (claimed) {
      const updated = (await tx.rsvp.update({
        where: { id: existing.id },
        data: { status: "GOING", guests: newGuests },
      })) as RsvpRow;
      return { kind: "updated", rsvp: updated };
    }
    const updated = (await tx.rsvp.update({
      where: { id: existing.id },
      data: { status: "WAITLISTED", guests: newGuests },
    })) as RsvpRow;
    await this.addWaitlist(tx, eventId, newParty);
    return { kind: "updated", rsvp: updated };
  }

  // ==========================================================================
  // DELETE /api/events/:id/rsvp — withdraw the caller's RSVP
  // ==========================================================================

  async handleWithdraw(
    eventId: string,
    _request: Request,
    session: Session,
    _env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      const userId = session.userId;

      await this.db.$transaction(async (tx) => {
        // Atomic delete-with-RETURNING: the @@unique guarantees at most one row,
        // so the returned row (if any) is exactly what to reconcile counts by.
        // No read-then-delete race (§4.3 SEC-8).
        const deleted = await tx.$queryRaw<Array<{ status: RsvpStatus; guests: number }>>`
          DELETE FROM event_rsvps
          WHERE event_id = ${eventId}
            AND user_id = ${userId}
            AND tenant_id = ${activeTenantId}
          RETURNING status, guests
        `;

        const row = deleted[0];
        if (!row) return; // Idempotent: nothing to withdraw.

        const party = 1 + row.guests;
        if (row.status === "GOING") {
          await this.releaseSeats(tx, eventId, party);
          await this.promoteWaitlist(tx, eventId);
        } else if (row.status === "WAITLISTED") {
          await this.releaseWaitlist(tx, eventId, party);
        }
        // MAYBE / NOT_GOING held no seat — nothing to reconcile.
      });

      return new Response(null, { status: 204 });
    } catch (error) {
      return this.mapError(error);
    }
  }

  // ==========================================================================
  // GET /api/events/:id/attendees — roster (no location fields, §4.4)
  // ==========================================================================

  async handleAttendees(
    eventId: string,
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      const gate = await this.loadVisibleEvent(eventId, session, activeTenantId);
      if ("error" in gate) return gate.error;

      const url = new URL(request.url);
      const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit =
        Number.isFinite(limitParam) && limitParam > 0
          ? Math.min(limitParam, env.event.listPageMax)
          : Math.min(20, env.event.listPageMax);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const statusParam = url.searchParams.get("status");
      const statusFilter =
        statusParam === "GOING" ||
        statusParam === "WAITLISTED" ||
        statusParam === "MAYBE" ||
        statusParam === "NOT_GOING"
          ? (statusParam as RsvpStatus)
          : undefined;

      const rows = (await this.db.rsvp.findMany({
        where: {
          eventId,
          tenantId: activeTenantId,
          ...(statusFilter
            ? { status: statusFilter }
            : { status: { in: ["GOING", "WAITLISTED", "MAYBE"] } }),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })) as RsvpRow[];

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;

      return jsonResponse(
        {
          items: page.map(serializeAttendee),
          ...(nextCursor ? { cursor: nextCursor } : {}),
          hasMore,
        },
        200,
      );
    } catch (error) {
      return this.mapError(error);
    }
  }

  // ==========================================================================
  // Atomic capacity primitives (affected-rows authoritative)
  // ==========================================================================

  /**
   * Atomically claim `party` seats. Returns true iff the row was updated — i.e.
   * the event is live, PUBLISHED, and either uncapped or has room. The `WHERE`
   * re-evaluates `rsvp_count` against the CURRENT committed value under a row
   * lock, which is what makes concurrent claims safe (no over-capacity).
   */
  private async claimSeats(tx: TxClient, eventId: string, party: number): Promise<boolean> {
    const affected = await tx.$executeRaw`
      UPDATE events
      SET rsvp_count = rsvp_count + ${party}, updated_at = NOW()
      WHERE id = ${eventId}
        AND deleted_at IS NULL
        AND status = 'PUBLISHED'
        AND (capacity IS NULL OR rsvp_count + ${party} <= capacity)
    `;
    return affected === 1;
  }

  /** Release `party` confirmed seats; guarded so `rsvp_count` never goes negative. */
  private async releaseSeats(tx: TxClient, eventId: string, party: number): Promise<void> {
    await tx.$executeRaw`
      UPDATE events
      SET rsvp_count = rsvp_count - ${party}, updated_at = NOW()
      WHERE id = ${eventId} AND rsvp_count >= ${party}
    `;
  }

  /** Add `party` waitlisted seats. */
  private async addWaitlist(tx: TxClient, eventId: string, party: number): Promise<void> {
    await tx.$executeRaw`
      UPDATE events
      SET waitlist_count = waitlist_count + ${party}, updated_at = NOW()
      WHERE id = ${eventId}
    `;
  }

  /** Release `party` waitlisted seats; guarded so `waitlist_count` never goes negative. */
  private async releaseWaitlist(tx: TxClient, eventId: string, party: number): Promise<void> {
    await tx.$executeRaw`
      UPDATE events
      SET waitlist_count = waitlist_count - ${party}, updated_at = NOW()
      WHERE id = ${eventId} AND waitlist_count >= ${party}
    `;
  }

  /**
   * Promote waitlisted RSVPs (oldest first) into freed capacity. Each candidate
   * is locked with `FOR UPDATE SKIP LOCKED` so two concurrent withdrawals
   * promote two DIFFERENT users (§4.3 SEC-3); the atomic `claimSeats` re-check
   * decides whether it actually fits. FIFO: stop at the first oldest that does
   * not fit. Bounded per the Infinite Loop Prevention house rule.
   */
  private async promoteWaitlist(tx: TxClient, eventId: string): Promise<void> {
    for (let i = 0; i < MAX_PROMOTIONS_PER_PASS; i++) {
      const candidates = await tx.$queryRaw<Array<{ id: string; guests: number }>>`
        SELECT id, guests
        FROM event_rsvps
        WHERE event_id = ${eventId} AND status = 'WAITLISTED'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      const candidate = candidates[0];
      if (!candidate) return; // No promotable waitlisted rows remain.

      const party = 1 + candidate.guests;
      const claimed = await this.claimSeats(tx, eventId, party);
      if (!claimed) return; // Oldest does not fit → FIFO stop.

      await tx.rsvp.update({ where: { id: candidate.id }, data: { status: "GOING" } });
      await this.releaseWaitlist(tx, eventId, party);
    }
    this.logger.warn(
      `[RsvpHandler] promoteWaitlist hit the ${MAX_PROMOTIONS_PER_PASS} circuit breaker for event ${eventId}`,
    );
  }

  // ==========================================================================
  // Visibility gate (§4.4) + error mapping
  // ==========================================================================

  /**
   * Load the event and enforce the read-side visibility gate. Mandatory
   * handler-level tenant filter (§4.4/MED-2): cross-tenant access is a 404, even
   * with auto-scope off. GROUP_ONLY requires group membership (resolved via the
   * caller's actorUri). DRAFT/CANCELLED status is NOT gated here — callers apply
   * their own status rules.
   */
  private async loadVisibleEvent(
    eventId: string,
    session: Session,
    activeTenantId: string,
  ): Promise<{ event: EventGateRow } | { error: Response }> {
    const event = (await this.db.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        tenantId: true,
        groupId: true,
        status: true,
        visibility: true,
        startsAt: true,
        deletedAt: true,
      },
    })) as EventGateRow | null;

    // Not found, soft-deleted, or cross-tenant → 404 (never confirm existence).
    if (!event || event.deletedAt || event.tenantId !== activeTenantId) {
      return { error: jsonResponse({ error: "NOT_FOUND", message: "Event not found" }, 404) };
    }

    if (event.visibility === "GROUP_ONLY") {
      const member = await this.isGroupMember(event.groupId, session.userId, event.tenantId);
      if (!member) {
        return { error: jsonResponse({ error: "NOT_FOUND", message: "Event not found" }, 404) };
      }
    }
    // TENANT_ONLY / PUBLIC: same-tenant membership already enforced above.

    return { event };
  }

  /** Is the caller a member of `groupId`? Resolved via the user's actorUri. */
  private async isGroupMember(
    groupId: string | null,
    userId: string,
    tenantId: string,
  ): Promise<boolean> {
    if (!groupId) return false;
    const user = (await this.db.user.findUnique({
      where: { id: userId },
      select: { actorUri: true },
    })) as { actorUri: string | null } | null;
    if (!user?.actorUri) return false;
    const membership = await this.db.groupMember.findFirst({
      where: { groupId, actorUri: user.actorUri, tenantId },
      select: { id: true },
    });
    return membership !== null;
  }

  private mapError(error: unknown): Response {
    if (error instanceof SyntaxError) {
      return jsonResponse({ error: "VALIDATION_ERROR", message: "Invalid JSON body" }, 400);
    }
    const code = (error as { code?: string })?.code;
    if (code === "P2025") {
      return jsonResponse({ error: "NOT_FOUND", message: "Not found" }, 404);
    }
    this.logger.error("[RsvpHandler] Unexpected error:", error);
    return jsonResponse({ error: "INTERNAL_ERROR", message: "Internal server error" }, 500);
  }
}
