/**
 * Unit tests: RsvpHandler (Events primitive, P1-C).
 *
 * Covers the RSVP state machine decision branches, capacity boundaries
 * (exactly-full via the atomic-claim affected-rows), guest-delta growth/shrink,
 * double-RSVP idempotency (P2002 → return existing), withdrawal no-negative +
 * waitlist promotion, the read-side visibility gate (tenant isolation +
 * GROUP_ONLY membership), and the attendee roster.
 *
 * The Prisma client is mocked with a SQL-ROUTING `$executeRaw`/`$queryRaw` so
 * tests control seat-claim / promotion outcomes by statement, not by call
 * order — the mock inspects the tagged-template SQL text. The no-over-capacity
 * guarantee under real concurrency is proven separately in
 * test/integration/events.integration.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { RsvpHandler } from "../../../src/lib/events/rsvp-handler.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const FUTURE = new Date(NOW.getTime() + 86_400_000); // +1 day
const PAST = new Date(NOW.getTime() - 1_000);

const ctx = {} as TrellisRequestContext;

function rsvpRequest(body: unknown): Request {
  return new Request("https://api.example.com/api/events/evt_1/rsvp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    tenantId: "tenant_1",
    groupId: null,
    status: "PUBLISHED",
    visibility: "TENANT_ONLY",
    startsAt: FUTURE,
    deletedAt: null,
    ...overrides,
  };
}

function makeRsvp(overrides: Record<string, unknown> = {}) {
  return {
    id: "rsvp_1",
    tenantId: "tenant_1",
    eventId: "evt_1",
    userId: "user_1",
    status: "GOING",
    guests: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Mutable per-test state driving the SQL-routing raw mocks.
 *  - claimResults: shifted per seat-claim UPDATE (1 = fits, 0 = full); default 1.
 *  - promoteQueue: shifted per waitlist SELECT (each an array of candidates);
 *    default [] (nothing to promote).
 *  - deleteRows:   returned by the withdrawal DELETE ... RETURNING.
 */
interface RawState {
  claimResults: number[];
  promoteQueue: Array<Array<{ id: string; guests: number }>>;
  deleteRows: Array<{ status: string; guests: number }>;
}

function buildDb(state: RawState) {
  const sqlText = (strings: TemplateStringsArray): string => strings.join(" ");

  const tx = {
    rsvp: {
      findUnique: vi.fn(),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeRsvp(data)),
      ),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Promise.resolve(makeRsvp({ id: where.id, ...data })),
      ),
    },
    // Outbox writer (plan 034 lane E) — `rsvp.updated` is emitted inside this
    // same transaction, so the tx double needs the delegate.
    domainEvent: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: "de_1", ...data }),
      ),
    },
    $executeRaw: vi.fn((strings: TemplateStringsArray) => {
      const sql = sqlText(strings);
      if (sql.includes("rsvp_count = rsvp_count +")) {
        return Promise.resolve(state.claimResults.length ? state.claimResults.shift()! : 1);
      }
      // releases + waitlist adjustments always "succeed" in the mock.
      return Promise.resolve(1);
    }),
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      const sql = sqlText(strings);
      if (sql.includes("DELETE FROM event_rsvps")) {
        return Promise.resolve(state.deleteRows);
      }
      // waitlist promotion SELECT ... FOR UPDATE SKIP LOCKED
      return Promise.resolve(state.promoteQueue.length ? state.promoteQueue.shift()! : []);
    }),
  };

  const db = {
    event: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    groupMember: { findFirst: vi.fn() },
    rsvp: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === "function"
        ? (arg as (t: typeof tx) => unknown)(tx)
        : Promise.resolve(arg),
    ),
  };

  return { db, tx };
}

describe("RsvpHandler", () => {
  let mockEnv: Env;
  let session: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
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
    } as unknown as Env;
    session = {
      userId: "user_1",
      email: "u@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 3_600_000,
      dataRegion: "EU",
      profileContext: "primary",
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -- New RSVP -------------------------------------------------------------

  it("creates a GOING RSVP with a seat when capacity fits (201)", async () => {
    const state: RawState = { claimResults: [1], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 10 }));
    tx.rsvp.findUnique.mockResolvedValue(null);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 2 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("GOING");
    expect(body.guests).toBe(2);
    // seat claim ran once for party = 3
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("waitlists a GOING RSVP when the event is exactly full (affected=0)", async () => {
    const state: RawState = { claimResults: [0], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 1 }));
    tx.rsvp.findUnique.mockResolvedValue(null);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 0 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("WAITLISTED");
    expect(tx.rsvp.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "WAITLISTED" }) }),
    );
  });

  it("creates a MAYBE RSVP without touching capacity", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent());
    tx.rsvp.findUnique.mockResolvedValue(null);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "MAYBE", guests: 5 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("MAYBE");
    expect(body.guests).toBe(0); // guests forced to 0 for non-GOING
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("creates a NOT_GOING RSVP without touching capacity", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent());
    tx.rsvp.findUnique.mockResolvedValue(null);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "NOT_GOING" }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe("NOT_GOING");
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  // -- Guest-delta on an existing GOING RSVP --------------------------------

  it("grows a GOING party when the delta fits (200)", async () => {
    const state: RawState = { claimResults: [1], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 10 }));
    tx.rsvp.findUnique.mockResolvedValue(makeRsvp({ status: "GOING", guests: 1 }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 3 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(200);
    expect((await res.json()).guests).toBe(3);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1); // claimed delta = 2
  });

  it("rejects growing a GOING party when the delta does not fit (409)", async () => {
    const state: RawState = { claimResults: [0], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 2 }));
    tx.rsvp.findUnique.mockResolvedValue(makeRsvp({ status: "GOING", guests: 1 }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 5 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("CAPACITY_FULL");
    expect(body.rsvp.guests).toBe(1); // stays at old size
    expect(tx.rsvp.update).not.toHaveBeenCalled();
  });

  it("shrinks a GOING party (delta<0) and attempts promotion", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [[]], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 10 }));
    tx.rsvp.findUnique.mockResolvedValue(makeRsvp({ status: "GOING", guests: 4 }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 1 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(200);
    expect((await res.json()).guests).toBe(1);
    // release ran (no claim, claimResults empty → not consumed) and a promote SELECT ran
    expect(tx.$queryRaw).toHaveBeenCalled();
  });

  it("is idempotent for an unchanged GOING guest count (200, no SQL)", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 10 }));
    tx.rsvp.findUnique.mockResolvedValue(makeRsvp({ status: "GOING", guests: 2 }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 2 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(200);
    expect((await res.json()).guests).toBe(2);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.rsvp.update).not.toHaveBeenCalled();
  });

  // -- GOING → non-GOING (frees a seat, promotes) ---------------------------

  it("moves GOING → NOT_GOING, releasing the seat and promoting a waitlisted user", async () => {
    const state: RawState = {
      claimResults: [1], // the promoted candidate fits
      promoteQueue: [[{ id: "rsvp_w", guests: 0 }], []],
      deleteRows: [],
    };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 5 }));
    tx.rsvp.findUnique.mockResolvedValue(makeRsvp({ status: "GOING", guests: 1 }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "NOT_GOING" }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("NOT_GOING");
    // promoted candidate set to GOING
    expect(tx.rsvp.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rsvp_w" }, data: { status: "GOING" } }),
    );
  });

  // -- WAITLISTED transitions ----------------------------------------------

  it("promotes a WAITLISTED RSVP to GOING when a seat opens (re-request)", async () => {
    const state: RawState = { claimResults: [1], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 10 }));
    tx.rsvp.findUnique.mockResolvedValue(makeRsvp({ status: "WAITLISTED", guests: 1 }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 4 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("GOING");
    // guests immutable while waitlisted (§4.3): the promotion update sets ONLY
    // status — it never writes the requested guest change (4).
    expect(tx.rsvp.update).toHaveBeenCalledWith({
      where: { id: "rsvp_1" },
      data: { status: "GOING" },
    });
    // the seat claim used the ORIGINAL party (1 + 1 guest), not 1 + 4
    const claimCall = tx.$executeRaw.mock.calls.find((c: any[]) =>
      c[0].join(" ").includes("rsvp_count = rsvp_count +"),
    );
    expect(claimCall).toBeDefined();
    expect(claimCall![1]).toBe(2);
  });

  it("keeps a WAITLISTED RSVP waitlisted when still full (unchanged)", async () => {
    const state: RawState = { claimResults: [0], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 1 }));
    tx.rsvp.findUnique.mockResolvedValue(makeRsvp({ status: "WAITLISTED", guests: 0 }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 0 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("WAITLISTED");
    expect(tx.rsvp.update).not.toHaveBeenCalled();
  });

  it("moves WAITLISTED → NOT_GOING, releasing the waitlist slot", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 1 }));
    tx.rsvp.findUnique.mockResolvedValue(makeRsvp({ status: "WAITLISTED", guests: 2 }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "NOT_GOING" }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("NOT_GOING");
    // a waitlist-release UPDATE ran
    expect(tx.$executeRaw).toHaveBeenCalled();
  });

  // -- MAYBE/NOT_GOING → GOING ----------------------------------------------

  it("moves MAYBE → GOING and claims a seat when it fits", async () => {
    const state: RawState = { claimResults: [1], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 10 }));
    tx.rsvp.findUnique.mockResolvedValue(makeRsvp({ status: "MAYBE", guests: 0 }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 2 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("GOING");
  });

  it("moves MAYBE → GOING but waitlists when full", async () => {
    const state: RawState = { claimResults: [0], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 1 }));
    tx.rsvp.findUnique.mockResolvedValue(makeRsvp({ status: "MAYBE", guests: 0 }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 0 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("WAITLISTED");
  });

  // -- Double-RSVP idempotency (P2002) --------------------------------------

  it("returns the existing RSVP on a unique-violation (double-RSVP, 200)", async () => {
    const state: RawState = { claimResults: [1], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 10 }));
    db.$transaction.mockRejectedValueOnce({ code: "P2002" });
    db.rsvp.findUnique.mockResolvedValue(makeRsvp({ status: "GOING", guests: 0 }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 0 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("GOING");
    expect(db.rsvp.findUnique).toHaveBeenCalledWith({
      where: { eventId_userId: { eventId: "evt_1", userId: "user_1" } },
    });
  });

  it("rethrows a non-P2002 transaction error as 500", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ capacity: 10 }));
    db.$transaction.mockRejectedValueOnce(new Error("boom"));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 0 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(500);
  });

  // -- Validation + gates ---------------------------------------------------

  it("returns 400 when guests exceeds maxGuestsPerRsvp", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING", guests: 999 }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(400);
    expect(db.event.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when the event does not exist", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(null);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING" }), session, mockEnv, ctx, "tenant_1");
    expect(res.status).toBe(404);
  });

  it("returns 404 on cross-tenant access (mandatory handler tenant filter)", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ tenantId: "tenant_OTHER" }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING" }), session, mockEnv, ctx, "tenant_1");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a DRAFT event (invisible to non-creators)", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ status: "DRAFT" }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING" }), session, mockEnv, ctx, "tenant_1");
    expect(res.status).toBe(404);
  });

  it("returns 409 for a CANCELLED event", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ status: "CANCELLED" }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING" }), session, mockEnv, ctx, "tenant_1");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("EVENT_CANCELLED");
  });

  it("returns 409 for an event that has already started", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ startsAt: PAST }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING" }), session, mockEnv, ctx, "tenant_1");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("EVENT_STARTED");
  });

  it("allows RSVP to a GROUP_ONLY event when the caller is a group member", async () => {
    const state: RawState = { claimResults: [1], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ visibility: "GROUP_ONLY", groupId: "grp_1", capacity: 10 }));
    db.user.findUnique.mockResolvedValue({ actorUri: "https://x/users/u1" });
    db.groupMember.findFirst.mockResolvedValue({ id: "gm_1" });
    tx.rsvp.findUnique.mockResolvedValue(null);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING" }), session, mockEnv, ctx, "tenant_1");
    expect(res.status).toBe(201);
  });

  it("returns 404 for a GROUP_ONLY event when the caller is not a member", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ visibility: "GROUP_ONLY", groupId: "grp_1" }));
    db.user.findUnique.mockResolvedValue({ actorUri: "https://x/users/u1" });
    db.groupMember.findFirst.mockResolvedValue(null);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING" }), session, mockEnv, ctx, "tenant_1");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a GROUP_ONLY event when the caller has no actorUri", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ visibility: "GROUP_ONLY", groupId: "grp_1" }));
    db.user.findUnique.mockResolvedValue({ actorUri: null });

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleRsvp("evt_1", rsvpRequest({ status: "GOING" }), session, mockEnv, ctx, "tenant_1");
    expect(res.status).toBe(404);
  });

  // -- Withdrawal (no negative counts, promotion) ---------------------------

  it("withdraws a GOING RSVP, releases the seat, and promotes the waitlist (204)", async () => {
    const state: RawState = {
      claimResults: [1],
      promoteQueue: [[{ id: "rsvp_w", guests: 0 }], []],
      deleteRows: [{ status: "GOING", guests: 1 }],
    };
    const { db, tx } = buildDb(state);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleWithdraw("evt_1", new Request("https://x/api/events/evt_1/rsvp", { method: "DELETE" }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(204);
    // seat release ran + promoted candidate set to GOING
    expect(tx.rsvp.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rsvp_w" }, data: { status: "GOING" } }),
    );
  });

  it("withdraws a WAITLISTED RSVP, releasing the waitlist slot (204)", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [{ status: "WAITLISTED", guests: 0 }] };
    const { db, tx } = buildDb(state);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleWithdraw("evt_1", new Request("https://x", { method: "DELETE" }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(204);
    expect(tx.$executeRaw).toHaveBeenCalled(); // waitlist release
    expect(tx.rsvp.update).not.toHaveBeenCalled(); // nothing promoted
  });

  it("withdraws a MAYBE RSVP with no count change (204)", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [{ status: "MAYBE", guests: 0 }] };
    const { db, tx } = buildDb(state);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleWithdraw("evt_1", new Request("https://x", { method: "DELETE" }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(204);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("is idempotent when withdrawing a nonexistent RSVP (204)", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db, tx } = buildDb(state);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleWithdraw("evt_1", new Request("https://x", { method: "DELETE" }), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(204);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("maps a SyntaxError to 400 and an unexpected error to 500 on withdrawal", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);

    const handler = new RsvpHandler(db as any);

    db.$transaction.mockRejectedValueOnce(new SyntaxError("bad"));
    const res400 = await handler.handleWithdraw("evt_1", new Request("https://x", { method: "DELETE" }), session, mockEnv, ctx, "tenant_1");
    expect(res400.status).toBe(400);

    db.$transaction.mockRejectedValueOnce(new Error("boom"));
    const res500 = await handler.handleWithdraw("evt_1", new Request("https://x", { method: "DELETE" }), session, mockEnv, ctx, "tenant_1");
    expect(res500.status).toBe(500);
  });

  it("maps a P2025 error to 404", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.$transaction.mockRejectedValueOnce({ code: "P2025" });

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleWithdraw("evt_1", new Request("https://x", { method: "DELETE" }), session, mockEnv, ctx, "tenant_1");
    expect(res.status).toBe(404);
  });

  // -- Attendees ------------------------------------------------------------

  it("lists attendees with a roster projection and paginates", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent());
    // 3 rows returned for limit=2 → hasMore true, cursor = 2nd id
    db.rsvp.findMany.mockResolvedValue([
      makeRsvp({ id: "r1", userId: "a", status: "GOING", guests: 1 }),
      makeRsvp({ id: "r2", userId: "b", status: "WAITLISTED", guests: 0 }),
      makeRsvp({ id: "r3", userId: "c", status: "MAYBE", guests: 0 }),
    ]);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleAttendees("evt_1", new Request("https://x/api/events/evt_1/attendees?limit=2"), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    expect(body.cursor).toBe("r2");
    // roster projection: no location/tenant fields leak
    expect(body.items[0]).toEqual(
      expect.objectContaining({ userId: "a", status: "GOING", guests: 1 }),
    );
    expect(body.items[0].tenantId).toBeUndefined();
  });

  it("lists attendees filtered by status and with a cursor", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent());
    db.rsvp.findMany.mockResolvedValue([makeRsvp({ id: "r9", status: "GOING" })]);

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleAttendees("evt_1", new Request("https://x/api/events/evt_1/attendees?status=GOING&cursor=r1"), session, mockEnv, ctx, "tenant_1");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasMore).toBe(false);
    expect(body.cursor).toBeUndefined();
    expect(db.rsvp.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "GOING" }),
        cursor: { id: "r1" },
        skip: 1,
      }),
    );
  });

  it("returns 404 from the attendee list on cross-tenant access", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent({ tenantId: "tenant_OTHER" }));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleAttendees("evt_1", new Request("https://x/api/events/evt_1/attendees"), session, mockEnv, ctx, "tenant_1");
    expect(res.status).toBe(404);
  });

  it("returns 500 from the attendee list when the query throws", async () => {
    const state: RawState = { claimResults: [], promoteQueue: [], deleteRows: [] };
    const { db } = buildDb(state);
    db.event.findUnique.mockResolvedValue(makeEvent());
    db.rsvp.findMany.mockRejectedValue(new Error("db down"));

    const handler = new RsvpHandler(db as any);
    const res = await handler.handleAttendees("evt_1", new Request("https://x/api/events/evt_1/attendees"), session, mockEnv, ctx, "tenant_1");
    expect(res.status).toBe(500);
  });
});
