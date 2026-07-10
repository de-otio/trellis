/**
 * Integration tests for the Events RSVP capacity/waitlist core (R1, P1-C)
 * against a real Postgres (Docker Compose `postgis` service).
 *
 * The CONCURRENCY test is the real proof of the no-over-capacity guarantee
 * (plan §4.3, MED-1): N parallel RSVPs race for C seats via the atomic
 * conditional `UPDATE ... WHERE rsvp_count + party <= capacity`, and we assert
 * `rsvpCount <= capacity` (in fact `=== capacity`) with the remainder correctly
 * waitlisted. This is a property the pure decision function cannot establish;
 * only real row-lock serialisation under contention can.
 *
 * The handler takes an injected Prisma client and filters `tenantId` explicitly
 * (no ambient tenant context, no RLS) — so this suite also exercises the
 * mandatory handler-level tenant filter (§4.4/MED-2) with `TENANT_SCOPE_MODE`
 * unset.
 *
 * Runs setup-free against an explicit DATABASE_URL (same approach as the other
 * curated Phase-0 integration lanes); registered in
 * `vitest.integration-ci.config.ts` (PHASE0_INTEGRATION) by the wiring phase.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import type { Session } from "../../src/lib/session-cookie.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { AuthContext } from "../../src/lib/auth/auth-context.js";
import type { TenantRole, UserRole } from "@prisma/client";
import { RsvpHandler } from "../../src/lib/events/rsvp-handler.js";
import { ShiftHandler } from "../../src/lib/events/shift-handler.js";

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const RUN = `evt-itest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const TENANT_ID = `${RUN}-tenant`;

const ctx = {} as TrellisRequestContext;

let prisma: PrismaClient;
let handler: RsvpHandler;
let env: Env;

function session(userId: string): Session {
  return {
    userId,
    email: `${userId}@test.example.com`,
    expiresAt: Date.now() + 3_600_000,
    dataRegion: "EU",
    profileContext: "primary",
  } as Session;
}

function auth(userId: string): AuthContext {
  return {
    cognitoSub: `sub-${userId}`,
    userId,
    globalRole: "END_USER" as UserRole,
    activeTenantId: TENANT_ID,
    tenantSlug: TENANT_ID,
    tenantRole: "MEMBER" as TenantRole,
    handle: userId,
    membershipsLoader: async () => [],
  } as unknown as AuthContext;
}

function signupReq(): Request {
  return new Request("https://api.test.example.com/api/events/e/shifts/s/signup", {
    method: "POST",
  });
}

function rsvpReq(status: "GOING" | "MAYBE" | "NOT_GOING", guests = 0): Request {
  return new Request("https://api.test.example.com/api/events/e/rsvp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, guests }),
  });
}

function delReq(): Request {
  return new Request("https://api.test.example.com/api/events/e/rsvp", { method: "DELETE" });
}

async function makeUser(tag: string): Promise<string> {
  const u = await prisma.user.create({
    data: {
      email: `${RUN}-${tag}@test.example.com`,
      handle: `${RUN}-${tag}`,
      role: "END_USER",
    },
  });
  return u.id;
}

async function makeEvent(opts: { capacity: number | null; creatorId: string }): Promise<string> {
  const e = await prisma.event.create({
    data: {
      tenantId: TENANT_ID,
      creatorId: opts.creatorId,
      title: "Concurrency test event",
      status: "PUBLISHED",
      visibility: "TENANT_ONLY",
      startsAt: new Date(Date.now() + 7 * 86_400_000),
      capacity: opts.capacity,
    },
  });
  return e.id;
}

async function makeShift(eventId: string, capacity: number): Promise<string> {
  const s = await prisma.eventShift.create({
    data: { tenantId: TENANT_ID, eventId, title: "Setup crew", capacity },
  });
  return s.id;
}

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DB_URL }) });
  await prisma.$connect();

  await prisma.tenant.create({
    data: { id: TENANT_ID, slug: TENANT_ID, displayName: TENANT_ID, type: "ORGANIZATION" },
  });

  env = {
    DATABASE_URL: TEST_DB_URL,
    SESSION_SECRET: "integration-test-secret-32-chars!!",
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

  handler = new RsvpHandler(prisma);
});

afterAll(async () => {
  // Cascade: deleting the tenant removes its events, which cascade-remove rsvps
  // and shifts (and their signups). Explicit deletes keep cleanup deterministic.
  await prisma.shiftSignup.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.eventShift.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.rsvp.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.event.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
  await prisma.$disconnect();
});

describe("RSVP capacity under concurrency (real Postgres)", () => {
  it("never exceeds capacity when N RSVPs race for C seats", async () => {
    const CAPACITY = 5;
    const N = 25;

    const creator = await makeUser("cc-creator");
    const eventId = await makeEvent({ capacity: CAPACITY, creatorId: creator });
    const users = await Promise.all(
      Array.from({ length: N }, (_, i) => makeUser(`cc-u${i}`)),
    );

    // Fire all N GOING RSVPs concurrently against the SAME event row.
    const responses = await Promise.all(
      users.map((uid) =>
        handler.handleRsvp(eventId, rsvpReq("GOING"), session(uid), env, ctx, TENANT_ID),
      ),
    );
    // All should be accepted (created) — some GOING, some WAITLISTED.
    for (const r of responses) expect(r.status).toBe(201);

    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    const going = await prisma.rsvp.count({ where: { eventId, status: "GOING" } });
    const waitlisted = await prisma.rsvp.count({ where: { eventId, status: "WAITLISTED" } });

    // The core property: seats never oversubscribed.
    expect(event.rsvpCount).toBeLessThanOrEqual(CAPACITY);
    // And, with party size 1 each, exactly the capacity is filled.
    expect(event.rsvpCount).toBe(CAPACITY);
    expect(going).toBe(CAPACITY);
    expect(waitlisted).toBe(N - CAPACITY);
    expect(event.waitlistCount).toBe(N - CAPACITY);
  }, 30_000);

  it("counts guests as seats: a full party fills the event exactly", async () => {
    const creator = await makeUser("g-creator");
    const eventId = await makeEvent({ capacity: 5, creatorId: creator });
    const big = await makeUser("g-big");
    const extra = await makeUser("g-extra");

    // party = 1 + 4 = 5 → fills capacity exactly.
    const r1 = await handler.handleRsvp(eventId, rsvpReq("GOING", 4), session(big), env, ctx, TENANT_ID);
    expect(r1.status).toBe(201);
    expect((await r1.json()).status).toBe("GOING");

    // Next single RSVP has no room → waitlisted.
    const r2 = await handler.handleRsvp(eventId, rsvpReq("GOING", 0), session(extra), env, ctx, TENANT_ID);
    expect((await r2.json()).status).toBe("WAITLISTED");

    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.rsvpCount).toBe(5);
    expect(event.rsvpCount).toBeLessThanOrEqual(5);
  });
});

describe("RSVP withdrawal + waitlist promotion (real Postgres)", () => {
  it("frees a seat on withdrawal and promotes the oldest waitlisted user", async () => {
    const creator = await makeUser("p-creator");
    const eventId = await makeEvent({ capacity: 2, creatorId: creator });
    const a = await makeUser("p-a");
    const b = await makeUser("p-b");
    const c = await makeUser("p-c");

    await handler.handleRsvp(eventId, rsvpReq("GOING"), session(a), env, ctx, TENANT_ID);
    await handler.handleRsvp(eventId, rsvpReq("GOING"), session(b), env, ctx, TENANT_ID);
    const rc = await handler.handleRsvp(eventId, rsvpReq("GOING"), session(c), env, ctx, TENANT_ID);
    expect((await rc.json()).status).toBe("WAITLISTED");

    // A withdraws → C should be promoted.
    const w = await handler.handleWithdraw(eventId, delReq(), session(a), env, ctx, TENANT_ID);
    expect(w.status).toBe(204);

    const cRsvp = await prisma.rsvp.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId: c } },
    });
    expect(cRsvp.status).toBe("GOING");

    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.rsvpCount).toBe(2);
    expect(event.rsvpCount).toBeLessThanOrEqual(2);
    expect(event.waitlistCount).toBe(0);
    expect(await prisma.rsvp.count({ where: { eventId, status: "WAITLISTED" } })).toBe(0);
  });

  it("is idempotent: RSVPing twice never double-counts the seat", async () => {
    const creator = await makeUser("i-creator");
    const eventId = await makeEvent({ capacity: 10, creatorId: creator });
    const u = await makeUser("i-u");

    await handler.handleRsvp(eventId, rsvpReq("GOING", 1), session(u), env, ctx, TENANT_ID);
    await handler.handleRsvp(eventId, rsvpReq("GOING", 1), session(u), env, ctx, TENANT_ID);

    expect(await prisma.rsvp.count({ where: { eventId, userId: u } })).toBe(1);
    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    // party = 1 + 1 counted exactly once.
    expect(event.rsvpCount).toBe(2);
  });

  it("withdrawal is idempotent and never drives rsvpCount negative", async () => {
    const creator = await makeUser("n-creator");
    const eventId = await makeEvent({ capacity: 10, creatorId: creator });
    const u = await makeUser("n-u");

    await handler.handleRsvp(eventId, rsvpReq("GOING"), session(u), env, ctx, TENANT_ID);
    await handler.handleWithdraw(eventId, delReq(), session(u), env, ctx, TENANT_ID);
    // Second withdrawal is a no-op.
    await handler.handleWithdraw(eventId, delReq(), session(u), env, ctx, TENANT_ID);

    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.rsvpCount).toBe(0);
    expect(event.rsvpCount).toBeGreaterThanOrEqual(0);
  });
});

describe("RSVP tenant isolation (real Postgres, TENANT_SCOPE_MODE off)", () => {
  it("returns 404 for an event in another tenant", async () => {
    const creator = await makeUser("iso-creator");
    const eventId = await makeEvent({ capacity: 5, creatorId: creator });
    const u = await makeUser("iso-u");

    const res = await handler.handleRsvp(
      eventId,
      rsvpReq("GOING"),
      session(u),
      env,
      ctx,
      "some-other-tenant-id",
    );
    expect(res.status).toBe(404);
    // No RSVP leaked across the tenant boundary.
    expect(await prisma.rsvp.count({ where: { eventId } })).toBe(0);
  });

  // T-3: a withdraw carrying an eventId whose tenant differs from the caller's
  // active tenant must NOT delete the (legitimate) RSVP. The withdraw DELETE is
  // `WHERE ... AND tenant_id = ${activeTenantId}`, so a wrong tenant matches no
  // row → idempotent 204, and the real owner's RSVP survives untouched.
  it("does not delete an RSVP when withdrawing with a foreign tenant id", async () => {
    const creator = await makeUser("wiso-creator");
    const eventId = await makeEvent({ capacity: 5, creatorId: creator });
    const u = await makeUser("wiso-u");

    const created = await handler.handleRsvp(
      eventId,
      rsvpReq("GOING"),
      session(u),
      env,
      ctx,
      TENANT_ID,
    );
    expect(created.status).toBe(201);
    expect(await prisma.rsvp.count({ where: { eventId } })).toBe(1);

    // Attacker (or bug) withdraws with the correct eventId+user but a DIFFERENT
    // active tenant → must be a no-op deletion.
    const res = await handler.handleWithdraw(
      eventId,
      delReq(),
      session(u),
      env,
      ctx,
      "some-other-tenant-id",
    );
    expect(res.status).toBe(204);
    // The RSVP is still there — the tenant filter protected it.
    expect(await prisma.rsvp.count({ where: { eventId } })).toBe(1);
    const survivor = await prisma.rsvp.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId: u } },
    });
    expect(survivor.status).toBe("GOING");

    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.rsvpCount).toBe(1); // seat count untouched by the foreign withdraw
  });
});

describe("Shift signup capacity under concurrency (real Postgres)", () => {
  // The PROOF for review F-1: N parallel signups race for a capacity-1 shift via
  // the atomic conditional `UPDATE ... WHERE filled_count + 1 <= capacity`.
  // Exactly one may be CONFIRMED and filled_count can never exceed capacity —
  // a property only real row-lock serialisation can establish (the pre-fix
  // stale-`shift.capacity` `updateMany` could over-fill under contention).
  it("never confirms more than capacity when N signups race for 1 seat", async () => {
    const CAPACITY = 1;
    const N = 20;

    const creator = await makeUser("sc-creator");
    const eventId = await makeEvent({ capacity: null, creatorId: creator });
    const shiftId = await makeShift(eventId, CAPACITY);
    const users = await Promise.all(
      Array.from({ length: N }, (_, i) => makeUser(`sc-u${i}`)),
    );

    const shiftHandler = new ShiftHandler();
    const responses = await Promise.all(
      users.map((uid) => shiftHandler.handleSignup(eventId, shiftId, signupReq(), auth(uid), env)),
    );
    for (const r of responses) expect(r.status).toBe(201);

    const shift = await prisma.eventShift.findUniqueOrThrow({ where: { id: shiftId } });
    const confirmed = await prisma.shiftSignup.count({
      where: { shiftId, status: "CONFIRMED" },
    });
    const waitlisted = await prisma.shiftSignup.count({
      where: { shiftId, status: "WAITLISTED" },
    });

    // The core property: the seat is never oversubscribed.
    expect(shift.filledCount).toBeLessThanOrEqual(CAPACITY);
    expect(shift.filledCount).toBe(CAPACITY);
    // Exactly one CONFIRMED; everyone else waitlisted.
    expect(confirmed).toBe(CAPACITY);
    expect(waitlisted).toBe(N - CAPACITY);
  }, 30_000);
});
