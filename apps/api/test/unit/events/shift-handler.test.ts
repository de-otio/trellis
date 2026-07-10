/**
 * Unit tests: ShiftHandler (Events primitive R1, P1-D).
 *
 * Covers:
 *  - shift CRUD (create/list/update/delete), organizer-vs-ADMIN-vs-MEMBER authz
 *  - signup: atomic capacity claim → CONFIRMED, capacity exhausted → WAITLISTED,
 *    idempotent re-signup, event-not-published rejection
 *  - withdraw: CONFIRMED release + waitlist promotion, WAITLISTED withdrawal
 *    (no promotion), not-found
 *  - nested-resource IDOR (§4.4 SEC-7): shift from a different event 404s
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import type { Env } from "../../../src/env.js";
import type { TenantRole, UserRole } from "@prisma/client";
import { ShiftHandler } from "../../../src/lib/events/shift-handler.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const mockDb = {
  event: {
    findFirst: vi.fn(),
  },
  eventShift: {
    count: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  shiftSignup: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
  groupMember: {
    findFirst: vi.fn(),
  },
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
};

vi.mock("../../../src/db", () => ({
  createPrisma: vi.fn(() => mockDb),
}));

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    cognitoSub: "sub_1",
    userId: "user_1",
    globalRole: "END_USER" as UserRole,
    activeTenantId: "tenant_1",
    tenantSlug: "acme",
    tenantRole: "MEMBER" as TenantRole,
    handle: "user1@acme",
    membershipsLoader: async () => [],
    ...overrides,
  };
}

const env = {
  event: {
    maxPerTenant: 500,
    maxShiftsPerEvent: 50,
    maxGuestsPerRsvp: 10,
    rsvpRatePerHour: 60,
    updateRatePerHour: 20,
    updateNotifyCooldownSeconds: 3600,
    listPageMax: 50,
  },
} as unknown as Env;

function makeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "event_1",
    tenantId: "tenant_1",
    creatorId: "user_1",
    status: "PUBLISHED",
    deletedAt: null,
    ...overrides,
  };
}

function makeShift(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "shift_1",
    tenantId: "tenant_1",
    eventId: "event_1",
    title: "Setup crew",
    startsAt: null,
    endsAt: null,
    capacity: 2,
    filledCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSignup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "signup_1",
    tenantId: "tenant_1",
    shiftId: "shift_1",
    userId: "user_1",
    status: "CONFIRMED",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function jsonRequest(body?: unknown): Request {
  return new Request("https://api.example.com/api/events/event_1/shifts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("ShiftHandler", () => {
  let handler: ShiftHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ShiftHandler();
    // Default: $transaction just invokes the callback with mockDb as `tx`.
    mockDb.$transaction.mockImplementation((fn: any) => fn(mockDb));
  });

  describe("handleCreate", () => {
    it("creates a shift for the event creator", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.count.mockResolvedValue(0);
      mockDb.eventShift.create.mockResolvedValue(makeShift());

      const request = jsonRequest({ title: "Setup crew", capacity: 2 });
      const response = await handler.handleCreate("event_1", request, makeAuth(), env);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.id).toBe("shift_1");
      expect(mockDb.eventShift.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tenantId: "tenant_1", eventId: "event_1" }),
        }),
      );
    });

    it("allows an ADMIN who is not the creator", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent({ creatorId: "other_user" }));
      mockDb.eventShift.count.mockResolvedValue(0);
      mockDb.eventShift.create.mockResolvedValue(makeShift());

      const request = jsonRequest({ title: "Setup crew", capacity: 2 });
      const response = await handler.handleCreate(
        "event_1",
        request,
        makeAuth({ tenantRole: "ADMIN" as TenantRole }),
        env,
      );

      expect(response.status).toBe(201);
    });

    it("403s a non-creator MEMBER", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent({ creatorId: "other_user" }));

      const request = jsonRequest({ title: "Setup crew", capacity: 2 });
      const response = await handler.handleCreate("event_1", request, makeAuth(), env);

      expect(response.status).toBe(403);
      expect(mockDb.eventShift.create).not.toHaveBeenCalled();
    });

    it("404s when the event does not exist in the caller's tenant", async () => {
      mockDb.event.findFirst.mockResolvedValue(null);

      const request = jsonRequest({ title: "Setup crew", capacity: 2 });
      const response = await handler.handleCreate("event_1", request, makeAuth(), env);

      expect(response.status).toBe(404);
    });

    it("400s on invalid JSON body", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      const request = new Request("https://api.example.com/api/events/event_1/shifts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });

      const response = await handler.handleCreate("event_1", request, makeAuth(), env);
      expect(response.status).toBe(400);
    });

    it("400s on schema validation failure", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      const request = jsonRequest({ title: "", capacity: 2 });

      const response = await handler.handleCreate("event_1", request, makeAuth(), env);
      expect(response.status).toBe(400);
    });

    it("409s at env.event.maxShiftsPerEvent", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.count.mockResolvedValue(env.event.maxShiftsPerEvent);

      const request = jsonRequest({ title: "Setup crew", capacity: 2 });
      const response = await handler.handleCreate("event_1", request, makeAuth(), env);

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("LIMIT_EXCEEDED");
    });

    it("stores explicit startsAt/endsAt as Dates when provided", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.count.mockResolvedValue(0);
      mockDb.eventShift.create.mockResolvedValue(
        makeShift({
          startsAt: new Date("2026-02-01T09:00:00.000Z"),
          endsAt: new Date("2026-02-01T17:00:00.000Z"),
        }),
      );

      const request = jsonRequest({
        title: "Setup crew",
        capacity: 2,
        startsAt: "2026-02-01T09:00:00.000Z",
        endsAt: "2026-02-01T17:00:00.000Z",
      });
      const response = await handler.handleCreate("event_1", request, makeAuth(), env);

      expect(response.status).toBe(201);
      expect(mockDb.eventShift.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startsAt: new Date("2026-02-01T09:00:00.000Z"),
            endsAt: new Date("2026-02-01T17:00:00.000Z"),
          }),
        }),
      );
    });
  });

  describe("handleList", () => {
    it("lists shifts for the event", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findMany.mockResolvedValue([makeShift()]);

      const response = await handler.handleList("event_1", makeAuth(), env);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.shifts).toHaveLength(1);
    });

    it("404s for an event outside the caller's tenant", async () => {
      mockDb.event.findFirst.mockResolvedValue(null);
      const response = await handler.handleList("event_1", makeAuth(), env);
      expect(response.status).toBe(404);
    });
  });

  describe("handleUpdate", () => {
    it("updates a shift owned by the caller", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      mockDb.eventShift.update.mockResolvedValue(makeShift({ title: "Cleanup crew" }));

      const request = new Request("https://api.example.com/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Cleanup crew" }),
      });

      const response = await handler.handleUpdate(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe("Cleanup crew");
    });

    it("rejects lowering capacity below current signups", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 5, filledCount: 3 }));
      // Race-safe guard (F-8): the conditional UPDATE (`filled_count <= newCap`)
      // matches no row → affected-rows = 0 → 409, without the Prisma update.
      mockDb.$executeRaw.mockResolvedValue(0);

      const request = new Request("https://api.example.com/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capacity: 2 }),
      });

      const response = await handler.handleUpdate(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(409);
      expect(mockDb.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockDb.eventShift.update).not.toHaveBeenCalled();
    });

    it("400s invalid endsAt/startsAt ordering", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());

      const request = new Request("https://api.example.com/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startsAt: "2026-02-01T10:00:00.000Z",
          endsAt: "2026-02-01T09:00:00.000Z",
        }),
      });

      const response = await handler.handleUpdate(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(400);
    });

    /** §4.4 SEC-7: shift belongs to a different event → 404, not a leak. */
    it("404s the nested IDOR case: shift from a different event", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent({ id: "event_A" }));
      // shiftFromB belongs to event_B, not event_A.
      mockDb.eventShift.findFirst.mockResolvedValue(
        makeShift({ id: "shift_from_b", eventId: "event_B" }),
      );

      const request = new Request("https://api.example.com/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hijacked" }),
      });

      const response = await handler.handleUpdate(
        "event_A",
        "shift_from_b",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(404);
      expect(mockDb.eventShift.update).not.toHaveBeenCalled();
    });

    it("404s when the shift does not exist at all", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(null);

      const request = new Request("https://api.example.com/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });

      const response = await handler.handleUpdate("event_1", "nope", request, makeAuth(), env);
      expect(response.status).toBe(404);
    });

    it("403s a non-creator MEMBER", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent({ creatorId: "other_user" }));
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());

      const request = new Request("https://api.example.com/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Cleanup crew" }),
      });

      const response = await handler.handleUpdate(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(403);
      expect(mockDb.eventShift.update).not.toHaveBeenCalled();
    });

    it("applies a capacity increase atomically (affected-rows=1) and updates remaining fields", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 2, filledCount: 1 }));
      // Race-safe guard (F-8): affected-rows=1 means the conditional UPDATE
      // matched → capacity applied, proceed to the remaining Prisma update.
      mockDb.$executeRaw.mockResolvedValue(1);
      mockDb.eventShift.update.mockResolvedValue(makeShift({ capacity: 10 }));

      const request = new Request("https://api.example.com/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capacity: 10 }),
      });

      const response = await handler.handleUpdate(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(200);
      expect(mockDb.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockDb.eventShift.update).toHaveBeenCalledTimes(1);
    });

    it("applies startsAt and endsAt when both are provided with valid ordering", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      mockDb.eventShift.update.mockResolvedValue(
        makeShift({
          startsAt: new Date("2026-02-01T10:00:00.000Z"),
          endsAt: new Date("2026-02-01T12:00:00.000Z"),
        }),
      );

      const request = new Request("https://api.example.com/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startsAt: "2026-02-01T10:00:00.000Z",
          endsAt: "2026-02-01T12:00:00.000Z",
        }),
      });

      const response = await handler.handleUpdate(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(200);
      expect(mockDb.eventShift.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startsAt: new Date("2026-02-01T10:00:00.000Z"),
            endsAt: new Date("2026-02-01T12:00:00.000Z"),
          }),
        }),
      );
    });

    it("maps an unexpected database error to 500", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      mockDb.eventShift.update.mockRejectedValue(new Error("boom"));

      const request = new Request("https://api.example.com/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Cleanup crew" }),
      });

      const response = await handler.handleUpdate(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(500);
    });
  });

  describe("handleDelete", () => {
    it("deletes a shift owned by the caller", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      mockDb.eventShift.delete.mockResolvedValue(makeShift());

      const response = await handler.handleDelete("event_1", "shift_1", makeAuth(), env);
      expect(response.status).toBe(204);
      expect(mockDb.eventShift.delete).toHaveBeenCalledWith({ where: { id: "shift_1" } });
    });

    it("403s a non-creator MEMBER", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent({ creatorId: "other_user" }));
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());

      const response = await handler.handleDelete("event_1", "shift_1", makeAuth(), env);
      expect(response.status).toBe(403);
      expect(mockDb.eventShift.delete).not.toHaveBeenCalled();
    });

    /** §4.4 SEC-7 nested IDOR, delete side. */
    it("404s the nested IDOR case: shift from a different event", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent({ id: "event_A" }));
      mockDb.eventShift.findFirst.mockResolvedValue(
        makeShift({ id: "shift_from_b", eventId: "event_B" }),
      );

      const response = await handler.handleDelete("event_A", "shift_from_b", makeAuth(), env);
      expect(response.status).toBe(404);
      expect(mockDb.eventShift.delete).not.toHaveBeenCalled();
    });
  });

  describe("handleSignup", () => {
    it("confirms signup when the atomic capacity claim succeeds", async () => {
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 2, filledCount: 0 }));
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.shiftSignup.findUnique.mockResolvedValue(null);
      // Atomic seat claim (F-1) is a conditional raw UPDATE now; affected-rows=1
      // ⇒ CONFIRMED. The `filled_count + 1 <= capacity` guard references live
      // DB columns, not the stale JS `shift.capacity`.
      mockDb.$executeRaw.mockResolvedValue(1);
      mockDb.shiftSignup.create.mockResolvedValue(makeSignup({ status: "CONFIRMED" }));

      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.status).toBe("CONFIRMED");
      expect(mockDb.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockDb.eventShift.updateMany).not.toHaveBeenCalled();
      expect(mockDb.shiftSignup.create).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant_1",
          shiftId: "shift_1",
          userId: "user_1",
          status: "CONFIRMED",
        },
      });
    });

    it("waitlists signup when the atomic capacity claim fails (shift full)", async () => {
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 1, filledCount: 1 }));
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.shiftSignup.findUnique.mockResolvedValue(null);
      // Affected-rows = 0: capacity exhausted, the conditional UPDATE matched
      // no row → WAITLISTED.
      mockDb.$executeRaw.mockResolvedValue(0);
      mockDb.shiftSignup.create.mockResolvedValue(makeSignup({ status: "WAITLISTED" }));

      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.status).toBe("WAITLISTED");
      expect(mockDb.shiftSignup.create).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant_1",
          shiftId: "shift_1",
          userId: "user_1",
          status: "WAITLISTED",
        },
      });
    });

    it("is idempotent: an existing non-cancelled signup is returned as-is", async () => {
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.shiftSignup.findUnique.mockResolvedValue(makeSignup({ status: "CONFIRMED" }));

      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(200);
      expect(mockDb.$executeRaw).not.toHaveBeenCalled();
      expect(mockDb.shiftSignup.create).not.toHaveBeenCalled();
    });

    it("re-signup after a CANCELLED withdrawal reuses the row via update", async () => {
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 2, filledCount: 0 }));
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.shiftSignup.findUnique.mockResolvedValue(makeSignup({ status: "CANCELLED" }));
      mockDb.$executeRaw.mockResolvedValue(1);
      mockDb.shiftSignup.update.mockResolvedValue(makeSignup({ status: "CONFIRMED" }));

      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(200);
      expect(mockDb.shiftSignup.update).toHaveBeenCalledWith({
        where: { id: "signup_1" },
        data: { status: "CONFIRMED" },
      });
      expect(mockDb.shiftSignup.create).not.toHaveBeenCalled();
    });

    it("409s when the event is not PUBLISHED", async () => {
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      mockDb.event.findFirst.mockResolvedValue(makeEvent({ status: "DRAFT" }));

      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(409);
      expect(mockDb.shiftSignup.findUnique).not.toHaveBeenCalled();
    });

    it("403s below MEMBER (GUEST)", async () => {
      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth({ tenantRole: "GUEST" as TenantRole }),
        env,
      );

      expect(response.status).toBe(403);
      expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    });

    /** §4.4 SEC-7 nested IDOR, mutation side. */
    it("404s signup against a shift from a different event", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent({ id: "event_A" }));
      mockDb.eventShift.findFirst.mockResolvedValue(
        makeShift({ id: "shift_from_b", eventId: "event_B" }),
      );

      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_A",
        "shift_from_b",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(404);
    });

    /**
     * §4.4 / review F-3: a same-tenant caller who is NOT a group member (and
     * neither the creator nor a moderator) cannot even see — let alone sign up
     * for — a GROUP_ONLY event's shift. The visibility gate 404s before any
     * seat claim, so no CONFIRMED/WAITLISTED row is ever created.
     */
    it("404s signup for a GROUP_ONLY event when the caller is not a group member", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEvent({ visibility: "GROUP_ONLY", groupId: "grp_1", creatorId: "other_user" }),
      );
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      mockDb.user.findUnique.mockResolvedValue({ actorUri: "https://x/users/u1" });
      mockDb.groupMember.findFirst.mockResolvedValue(null); // not a member

      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(), // MEMBER, not creator, not moderator
        env,
      );

      expect(response.status).toBe(404);
      expect(mockDb.$executeRaw).not.toHaveBeenCalled();
      expect(mockDb.shiftSignup.create).not.toHaveBeenCalled();
    });

    /** A group member CAN sign up for a GROUP_ONLY event's shift. */
    it("confirms signup for a GROUP_ONLY event when the caller IS a group member", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEvent({ visibility: "GROUP_ONLY", groupId: "grp_1", creatorId: "other_user" }),
      );
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 2, filledCount: 0 }));
      mockDb.user.findUnique.mockResolvedValue({ actorUri: "https://x/users/u1" });
      mockDb.groupMember.findFirst.mockResolvedValue({ id: "gm_1" }); // is a member
      mockDb.shiftSignup.findUnique.mockResolvedValue(null);
      mockDb.$executeRaw.mockResolvedValue(1);
      mockDb.shiftSignup.create.mockResolvedValue(makeSignup({ status: "CONFIRMED" }));

      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(201);
      expect((await response.json()).status).toBe("CONFIRMED");
    });

    it("400s on invalid JSON body", async () => {
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      mockDb.event.findFirst.mockResolvedValue(makeEvent());

      const request = new Request("https://api.example.com/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(400);
    });

    /**
     * shiftSignupSchema = z.object({}) — valid JSON that parses to a
     * non-object (e.g. an array) fails `safeParse` even though the body is
     * syntactically valid JSON, exercising the VALIDATION_ERROR branch
     * distinct from the malformed-JSON case above.
     */
    it("400s when the signup body parses to a non-object value", async () => {
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      mockDb.event.findFirst.mockResolvedValue(makeEvent());

      const request = new Request("https://api.example.com/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[]",
      });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("maps a non-P2002 error thrown during the seat-claim transaction to 500", async () => {
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 2, filledCount: 0 }));
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.shiftSignup.findUnique.mockResolvedValue(null);
      mockDb.$transaction.mockRejectedValue(new Error("connection reset"));

      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(500);
    });

    it("falls back to 409 when the P2002 recovery re-fetch resolves null (row genuinely gone)", async () => {
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 2, filledCount: 0 }));
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      // Pre-check: no existing row. Post-P2002 recovery lookup: still nothing
      // (resolves null rather than rejecting) — falls through to mapError,
      // which still maps the original P2002 to 409.
      mockDb.shiftSignup.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      mockDb.$executeRaw.mockResolvedValue(1);
      const err = Object.assign(new Error("dup"), { code: "P2002" });
      mockDb.shiftSignup.create.mockRejectedValue(err);

      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(409);
    });

    it("recovers a concurrent duplicate signup (P2002) idempotently", async () => {
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 2, filledCount: 0 }));
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      // First findUnique (pre-check): no existing row — races another request.
      // Second findUnique (post-P2002 recovery): the winner's row is now visible.
      mockDb.shiftSignup.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeSignup({ status: "CONFIRMED" }));
      mockDb.$executeRaw.mockResolvedValue(1);
      const err = Object.assign(new Error("dup"), { code: "P2002" });
      mockDb.shiftSignup.create.mockRejectedValue(err);

      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.id).toBe("signup_1");
    });

    it("falls back to 409 when P2002 recovery's re-fetch also fails", async () => {
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 2, filledCount: 0 }));
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.shiftSignup.findUnique
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("db down"));
      mockDb.$executeRaw.mockResolvedValue(1);
      const err = Object.assign(new Error("dup"), { code: "P2002" });
      mockDb.shiftSignup.create.mockRejectedValue(err);

      const request = new Request("https://api.example.com/x", { method: "POST" });
      const response = await handler.handleSignup(
        "event_1",
        "shift_1",
        request,
        makeAuth(),
        env,
      );

      expect(response.status).toBe(409);
    });
  });

  describe("handleWithdraw", () => {
    it("releases the seat and promotes the oldest waitlisted signup", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 1, filledCount: 1 }));
      mockDb.shiftSignup.findUnique.mockResolvedValue(makeSignup({ status: "CONFIRMED" }));
      mockDb.shiftSignup.update.mockResolvedValue(makeSignup({ status: "CANCELLED" }));
      mockDb.eventShift.updateMany.mockResolvedValue({ count: 1 });
      mockDb.$executeRaw.mockResolvedValue(1); // one waitlisted row promoted
      mockDb.eventShift.update.mockResolvedValue(makeShift({ filledCount: 1 }));

      const response = await handler.handleWithdraw("event_1", "shift_1", makeAuth(), env);

      expect(response.status).toBe(204);
      expect(mockDb.shiftSignup.update).toHaveBeenCalledWith({
        where: { id: "signup_1" },
        data: { status: "CANCELLED" },
      });
      expect(mockDb.eventShift.updateMany).toHaveBeenCalledWith({
        where: { id: "shift_1", filledCount: { gte: 1 } },
        data: { filledCount: { decrement: 1 } },
      });
      expect(mockDb.$executeRaw).toHaveBeenCalled();
      // Promotion succeeded → seat re-claimed for the promoted signup.
      expect(mockDb.eventShift.update).toHaveBeenCalledWith({
        where: { id: "shift_1" },
        data: { filledCount: { increment: 1 } },
      });
    });

    it("releases the seat with no promotion when nobody is waitlisted", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 2, filledCount: 1 }));
      mockDb.shiftSignup.findUnique.mockResolvedValue(makeSignup({ status: "CONFIRMED" }));
      mockDb.shiftSignup.update.mockResolvedValue(makeSignup({ status: "CANCELLED" }));
      mockDb.eventShift.updateMany.mockResolvedValue({ count: 1 });
      mockDb.$executeRaw.mockResolvedValue(0); // nobody waitlisted

      const response = await handler.handleWithdraw("event_1", "shift_1", makeAuth(), env);

      expect(response.status).toBe(204);
      expect(mockDb.$executeRaw).toHaveBeenCalled();
      expect(mockDb.eventShift.update).not.toHaveBeenCalled();
    });

    it("withdrawing a WAITLISTED signup does not touch filledCount", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 1, filledCount: 1 }));
      mockDb.shiftSignup.findUnique.mockResolvedValue(makeSignup({ status: "WAITLISTED" }));
      mockDb.shiftSignup.update.mockResolvedValue(makeSignup({ status: "CANCELLED" }));

      const response = await handler.handleWithdraw("event_1", "shift_1", makeAuth(), env);

      expect(response.status).toBe(204);
      expect(mockDb.eventShift.updateMany).not.toHaveBeenCalled();
      expect(mockDb.$executeRaw).not.toHaveBeenCalled();
    });

    it("404s when there is no signup to withdraw", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      mockDb.shiftSignup.findUnique.mockResolvedValue(null);

      const response = await handler.handleWithdraw("event_1", "shift_1", makeAuth(), env);
      expect(response.status).toBe(404);
    });

    it("404s when the signup is already CANCELLED", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      mockDb.shiftSignup.findUnique.mockResolvedValue(makeSignup({ status: "CANCELLED" }));

      const response = await handler.handleWithdraw("event_1", "shift_1", makeAuth(), env);
      expect(response.status).toBe(404);
    });

    /** §4.4 SEC-7 nested IDOR, withdraw side. */
    it("404s withdraw against a shift from a different event", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent({ id: "event_A" }));
      mockDb.eventShift.findFirst.mockResolvedValue(
        makeShift({ id: "shift_from_b", eventId: "event_B" }),
      );

      const response = await handler.handleWithdraw("event_A", "shift_from_b", makeAuth(), env);
      expect(response.status).toBe(404);
    });

    it("skips promotion when the seat release loses the race (updateMany count!==1)", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift({ capacity: 1, filledCount: 1 }));
      mockDb.shiftSignup.findUnique.mockResolvedValue(makeSignup({ status: "CONFIRMED" }));
      mockDb.shiftSignup.update.mockResolvedValue(makeSignup({ status: "CANCELLED" }));
      // A concurrent withdrawal already released this seat first — our
      // conditional decrement matches no row, so we must not attempt to
      // promote a waitlisted signup on top of it.
      mockDb.eventShift.updateMany.mockResolvedValue({ count: 0 });

      const response = await handler.handleWithdraw("event_1", "shift_1", makeAuth(), env);

      expect(response.status).toBe(204);
      expect(mockDb.$executeRaw).not.toHaveBeenCalled();
      expect(mockDb.eventShift.update).not.toHaveBeenCalled();
    });

    it("maps an unexpected error to 500", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      mockDb.shiftSignup.findUnique.mockResolvedValue(makeSignup({ status: "CONFIRMED" }));
      mockDb.$transaction.mockRejectedValue(new Error("boom"));

      const response = await handler.handleWithdraw("event_1", "shift_1", makeAuth(), env);
      expect(response.status).toBe(500);
    });
  });

  describe("error mapping", () => {
    it("maps a P2002 unique-violation to 409", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.count.mockResolvedValue(0);
      const err = Object.assign(new Error("dup"), { code: "P2002" });
      mockDb.eventShift.create.mockRejectedValue(err);

      const request = jsonRequest({ title: "x", capacity: 1 });
      const response = await handler.handleCreate("event_1", request, makeAuth(), env);

      expect(response.status).toBe(409);
    });

    it("maps a P2025 not-found to 404", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findFirst.mockResolvedValue(makeShift());
      const err = Object.assign(new Error("missing"), { code: "P2025" });
      mockDb.eventShift.delete.mockRejectedValue(err);

      const response = await handler.handleDelete("event_1", "shift_1", makeAuth(), env);
      expect(response.status).toBe(404);
    });

    it("maps an unexpected error to 500", async () => {
      mockDb.event.findFirst.mockRejectedValue(new Error("boom"));

      const response = await handler.handleList("event_1", makeAuth(), env);
      expect(response.status).toBe(500);
    });

    it("maps a thrown SyntaxError to a 400 'Invalid JSON body' response", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEvent());
      mockDb.eventShift.findMany.mockRejectedValue(new SyntaxError("Unexpected token"));

      const response = await handler.handleList("event_1", makeAuth(), env);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({ error: "VALIDATION_ERROR", message: "Invalid JSON body" });
    });
  });
});
