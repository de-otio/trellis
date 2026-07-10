/**
 * Integration tests for the Events primitive's CRUD lifecycle, visibility
 * matrix, notifications, cancellation, quota, authorization, and the
 * shift/RSVP status-semantics complement — against a real Postgres.
 *
 * This suite is the CRUD + visibility + notifications + shift-lifecycle
 * complement to `test/integration/events.integration.test.ts`, which owns the
 * concurrency proofs (N-parallel-RSVP / N-parallel-signup no-over-capacity).
 * Nothing here duplicates that file's concurrency assertions.
 *
 * `EventHandler`'s two cross-cutting seams (`FeedAnnouncer`,
 * `NotificationProducer`, `seams.ts`) are exercised through deterministic fake
 * implementations that record their calls — the real `PostFeedAnnouncer` /
 * notification producer are DI-wired in Phase 2 and are out of scope here;
 * this suite only proves the HANDLER calls the seams correctly (which input,
 * how many times), not what the seams do internally.
 *
 * Runs setup-free against an explicit DATABASE_URL, same approach as the
 * other curated Phase-0 integration lanes; registered in
 * `vitest.integration-ci.config.ts` (PHASE0_INTEGRATION).
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import type { Session } from "../../src/lib/session-cookie.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { AuthContext } from "../../src/lib/auth/auth-context.js";
import type { TenantRole, UserRole } from "@prisma/client";
import { EventHandler } from "../../src/lib/events/event-handler.js";
import { RsvpHandler } from "../../src/lib/events/rsvp-handler.js";
import { ShiftHandler } from "../../src/lib/events/shift-handler.js";
import {
  planCompanionPost,
  type EventAnnouncementInput,
  type EventNotificationContext,
  type EventUpdatedNotification,
  type FeedAnnouncer,
  type NotificationProducer,
} from "../../src/lib/events/seams.js";

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const RUN = `evt-lifecycle-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// Dedicated tenants so different describe blocks never contaminate each
// other's counts: TENANT_ID hosts most CRUD/visibility/auth/shift/RSVP tests
// (none of which aggregate over "all events in the tenant"); TENANT_ID_2 is
// only ever used as a CROSS-tenant caller; LIST_TENANT_ID and QUOTA_TENANT_ID
// are isolated so pagination and quota counts are exact and deterministic.
const TENANT_ID = `${RUN}-tenant`;
const TENANT_ID_2 = `${RUN}-tenant-2`;
const LIST_TENANT_ID = `${RUN}-tenant-list`;
const QUOTA_TENANT_ID = `${RUN}-tenant-quota`;
const ALL_TENANT_IDS = [TENANT_ID, TENANT_ID_2, LIST_TENANT_ID, QUOTA_TENANT_ID];

const ctx = {} as TrellisRequestContext;

let prisma: PrismaClient;
let env: Env;

// ============================================================================
// Fixture builders
// ============================================================================

function session(userId: string): Session {
  return {
    userId,
    email: `${userId}@test.example.com`,
    expiresAt: Date.now() + 3_600_000,
    dataRegion: "EU",
    profileContext: "primary",
  } as Session;
}

function auth(
  userId: string,
  opts: { tenantId?: string; tenantRole?: TenantRole } = {},
): AuthContext {
  const tenantId = opts.tenantId ?? TENANT_ID;
  return {
    cognitoSub: `sub-${userId}`,
    userId,
    globalRole: "END_USER" as UserRole,
    activeTenantId: tenantId,
    tenantSlug: tenantId,
    tenantRole: opts.tenantRole ?? ("MEMBER" as TenantRole),
    handle: userId,
    membershipsLoader: async () => [],
  } as unknown as AuthContext;
}

async function makeUser(tag: string, actorUri?: string): Promise<string> {
  const u = await prisma.user.create({
    data: {
      email: `${RUN}-${tag}@test.example.com`,
      handle: `${RUN}-${tag}`,
      role: "END_USER",
      ...(actorUri ? { actorUri } : {}),
    },
  });
  return u.id;
}

async function makeGroup(tag: string, tenantId: string): Promise<string> {
  const g = await prisma.group.create({
    data: {
      tenantId,
      name: `${RUN}-group-${tag}`,
      actorUri: `https://example.test/${RUN}/groups/${tag}`,
      inboxUrl: `https://example.test/${RUN}/groups/${tag}/inbox`,
      outboxUrl: `https://example.test/${RUN}/groups/${tag}/outbox`,
      followersUrl: `https://example.test/${RUN}/groups/${tag}/followers`,
      publicKey: "dummy-public-key",
      privateKey: "dummy-private-key",
      privacy: "PRIVATE",
    },
  });
  return g.id;
}

async function addGroupMember(groupId: string, tenantId: string, actorUri: string): Promise<void> {
  await prisma.groupMember.create({ data: { tenantId, groupId, actorUri, role: "MEMBER" } });
}

/** A PUBLISHED event created directly via Prisma (bypasses the seams — used
 * where a test only needs a live event to hang shifts/RSVPs off, not the
 * create->publish handler flow itself). */
async function makePublishedEvent(opts: {
  creatorId: string;
  tenantId: string;
  daysOut: number;
  visibility?: "TENANT_ONLY" | "PUBLIC" | "GROUP_ONLY";
  groupId?: string | null;
  capacity?: number | null;
}): Promise<string> {
  const e = await prisma.event.create({
    data: {
      tenantId: opts.tenantId,
      groupId: opts.groupId ?? null,
      creatorId: opts.creatorId,
      title: "Published helper event",
      status: "PUBLISHED",
      visibility: opts.visibility ?? "TENANT_ONLY",
      startsAt: new Date(Date.now() + opts.daysOut * 86_400_000),
      capacity: opts.capacity ?? null,
    },
  });
  return e.id;
}

function futureIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

// ---- EventHandler + fake seams ---------------------------------------------

class FakeFeedAnnouncer implements FeedAnnouncer {
  readonly announceCalls: EventAnnouncementInput[] = [];
  readonly updateCalls: EventAnnouncementInput[] = [];
  readonly retractCalls: EventAnnouncementInput[] = [];

  async announce(input: EventAnnouncementInput): Promise<string | null> {
    this.announceCalls.push(input);
    // Mirror the real PostFeedAnnouncer's GROUP_ONLY->no-companion-post rule
    // (planCompanionPost is the shared pure helper both sides use) so this
    // fake is a faithful stand-in for the production seam's return contract.
    return planCompanionPost(input.visibility).kind === "post"
      ? `post-${input.eventId}`
      : null;
  }

  async update(input: EventAnnouncementInput): Promise<void> {
    this.updateCalls.push(input);
  }

  async retract(input: EventAnnouncementInput): Promise<void> {
    this.retractCalls.push(input);
  }
}

class FakeNotificationProducer implements NotificationProducer {
  readonly updatedCalls: EventUpdatedNotification[] = [];
  readonly cancelledCalls: EventNotificationContext[] = [];

  async notifyEventUpdated(input: EventUpdatedNotification): Promise<void> {
    this.updatedCalls.push(input);
  }

  async notifyEventCancelled(input: EventNotificationContext): Promise<void> {
    this.cancelledCalls.push(input);
  }
}

function makeEventHandler(): {
  handler: EventHandler;
  feed: FakeFeedAnnouncer;
  notify: FakeNotificationProducer;
} {
  const feed = new FakeFeedAnnouncer();
  const notify = new FakeNotificationProducer();
  return { handler: new EventHandler(notify, feed), feed, notify };
}

/** Create + publish an event through the real handler (seams exercised),
 * returning the id and the fakes so callers can assert on subsequent calls. */
async function setupPublishedEvent(
  tag: string,
  opts: { visibility?: "TENANT_ONLY" | "PUBLIC" | "GROUP_ONLY"; groupId?: string } = {},
): Promise<{
  handler: EventHandler;
  feed: FakeFeedAnnouncer;
  notify: FakeNotificationProducer;
  eventId: string;
  creator: string;
}> {
  const creator = await makeUser(tag);
  const { handler, feed, notify } = makeEventHandler();
  const createRes = await handler.handleCreate(
    createReq({
      title: `Event ${tag}`,
      startsAt: futureIso(20),
      visibility: opts.visibility ?? "TENANT_ONLY",
      ...(opts.groupId ? { groupId: opts.groupId } : {}),
    }),
    auth(creator),
    env,
  );
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { id: string };
  const publishRes = await handler.handleUpdate(
    created.id,
    updateReq({ status: "PUBLISHED" }),
    auth(creator),
    env,
  );
  expect(publishRes.status).toBe(200);
  return { handler, feed, notify, eventId: created.id, creator };
}

// ---- Request builders -------------------------------------------------------

function createReq(body: unknown): Request {
  return new Request("https://api.test.example.com/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function updateReq(body: unknown): Request {
  return new Request("https://api.test.example.com/api/events/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function listReq(qs = ""): Request {
  return new Request(`https://api.test.example.com/api/events${qs}`);
}

function listMineReq(qs = ""): Request {
  return new Request(`https://api.test.example.com/api/events/mine${qs}`);
}

function shiftCreateReq(body: unknown): Request {
  return new Request("https://api.test.example.com/api/events/x/shifts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function shiftUpdateReq(body: unknown): Request {
  return new Request("https://api.test.example.com/api/events/x/shifts/y", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function shiftSignupReq(): Request {
  return new Request("https://api.test.example.com/api/events/x/shifts/y/signup", {
    method: "POST",
  });
}

function rsvpBody(status: "GOING" | "MAYBE" | "NOT_GOING", guests = 0): Request {
  return new Request("https://api.test.example.com/api/events/x/rsvp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, guests }),
  });
}

function attendeesReq(params: Record<string, string> = {}): Request {
  const url = new URL("https://api.test.example.com/api/events/x/attendees");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

// ============================================================================
// Suite setup
// ============================================================================

let createdFeatureToggle = false;

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DB_URL }) });
  await prisma.$connect();

  for (const tenantId of ALL_TENANT_IDS) {
    await prisma.tenant.create({
      data: { id: tenantId, slug: tenantId, displayName: tenantId, type: "ORGANIZATION" },
    });
  }

  // Global feature toggle: EventHandler 404s every method unless this is on.
  // Clear any stale row from a previous failed run first so this is re-runnable.
  await prisma.featureToggle.deleteMany({ where: { key: "events_enabled", tenantId: null } });
  await prisma.featureToggle.create({
    data: { key: "events_enabled", enabled: true, tenantId: null },
  });
  createdFeatureToggle = true;

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
});

afterAll(async () => {
  if (createdFeatureToggle) {
    await prisma.featureToggle.deleteMany({ where: { key: "events_enabled", tenantId: null } });
  }
  await prisma.shiftSignup.deleteMany({ where: { tenantId: { in: ALL_TENANT_IDS } } });
  await prisma.eventShift.deleteMany({ where: { tenantId: { in: ALL_TENANT_IDS } } });
  await prisma.rsvp.deleteMany({ where: { tenantId: { in: ALL_TENANT_IDS } } });
  await prisma.event.deleteMany({ where: { tenantId: { in: ALL_TENANT_IDS } } });
  await prisma.groupMember.deleteMany({ where: { tenantId: { in: ALL_TENANT_IDS } } });
  await prisma.group.deleteMany({ where: { tenantId: { in: ALL_TENANT_IDS } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANT_IDS } } });
  await prisma.$disconnect();
});

// ============================================================================
// 1. Create -> publish -> announce
// ============================================================================

describe("Create -> publish -> announce (real Postgres)", () => {
  it("creates a DRAFT visible only to the creator, then publishes and announces", async () => {
    const creator = await makeUser("cp-creator");
    const other = await makeUser("cp-other");
    const { handler, feed } = makeEventHandler();

    const createRes = await handler.handleCreate(
      createReq({ title: "Launch party", startsAt: futureIso(1) }),
      auth(creator),
      env,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; status: string };
    expect(created.status).toBe("DRAFT");
    expect(feed.announceCalls).toHaveLength(0);

    const getAsCreator = await handler.handleGet(created.id, auth(creator), env);
    expect(getAsCreator.status).toBe(200);
    expect(((await getAsCreator.json()) as { status: string }).status).toBe("DRAFT");

    // Draft is invisible to a same-tenant non-creator, non-moderator.
    const getAsOther = await handler.handleGet(created.id, auth(other), env);
    expect(getAsOther.status).toBe(404);

    const publishRes = await handler.handleUpdate(
      created.id,
      updateReq({ status: "PUBLISHED" }),
      auth(creator),
      env,
    );
    expect(publishRes.status).toBe(200);
    const published = (await publishRes.json()) as { status: string; announcePostId: string };
    expect(published.status).toBe("PUBLISHED");
    expect(published.announcePostId).toBe(`post-${created.id}`);
    expect(feed.announceCalls).toHaveLength(1);
    expect(feed.announceCalls[0]?.eventId).toBe(created.id);

    // Now visible to the same-tenant non-creator.
    const getAfterPublish = await handler.handleGet(created.id, auth(other), env);
    expect(getAfterPublish.status).toBe(200);
  });
});

// ============================================================================
// 2. Visibility matrix
// ============================================================================

describe("Visibility matrix on published events (real Postgres)", () => {
  it("TENANT_ONLY: same-tenant reader gets 200, cross-tenant reader gets 404", async () => {
    const { handler, eventId } = await setupPublishedEvent("vis-tenant", {
      visibility: "TENANT_ONLY",
    });
    const sameTenantUser = await makeUser("vis-tenant-same");
    const crossTenantUser = await makeUser("vis-tenant-cross");

    const sameRes = await handler.handleGet(eventId, auth(sameTenantUser), env);
    expect(sameRes.status).toBe(200);

    const crossRes = await handler.handleGet(
      eventId,
      auth(crossTenantUser, { tenantId: TENANT_ID_2 }),
      env,
    );
    expect(crossRes.status).toBe(404);
  });

  it("PUBLIC: any authenticated caller in any tenant gets 200", async () => {
    const { handler, eventId } = await setupPublishedEvent("vis-public", { visibility: "PUBLIC" });
    const crossTenantUser = await makeUser("vis-public-cross");

    const crossRes = await handler.handleGet(
      eventId,
      auth(crossTenantUser, { tenantId: TENANT_ID_2 }),
      env,
    );
    expect(crossRes.status).toBe(200);
  });

  it("GROUP_ONLY: members can read, non-members cannot, and no companion post is created", async () => {
    const creatorActor = `https://example.test/${RUN}/actors/vg-creator`;
    const memberActor = `https://example.test/${RUN}/actors/vg-member`;
    const creator = await makeUser("vg-creator", creatorActor);
    const member = await makeUser("vg-member", memberActor);
    const nonMember = await makeUser("vg-nonmember");
    const groupId = await makeGroup("vg", TENANT_ID);
    await addGroupMember(groupId, TENANT_ID, memberActor);

    const { handler, feed } = makeEventHandler();
    const createRes = await handler.handleCreate(
      createReq({
        title: "Board meeting",
        startsAt: futureIso(4),
        visibility: "GROUP_ONLY",
        groupId,
      }),
      auth(creator),
      env,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const publishRes = await handler.handleUpdate(
      created.id,
      updateReq({ status: "PUBLISHED" }),
      auth(creator),
      env,
    );
    expect(publishRes.status).toBe(200);
    const published = (await publishRes.json()) as { announcePostId: string | null };
    // GROUP_ONLY has no safe feed radius (§4.6 SEC-2): announce is CALLED but
    // returns null, so no companion post id is stored.
    expect(feed.announceCalls).toHaveLength(1);
    expect(published.announcePostId).toBeNull();

    const memberRes = await handler.handleGet(created.id, auth(member), env);
    expect(memberRes.status).toBe(200);

    const nonMemberRes = await handler.handleGet(created.id, auth(nonMember), env);
    expect(nonMemberRes.status).toBe(404);
  });
});

// ============================================================================
// 3. List + keyset pagination
// ============================================================================

describe("List + keyset pagination (real Postgres)", () => {
  it("paginates events in (startsAt, id) order with no overlap or gap across pages", async () => {
    const { handler } = makeEventHandler();
    const creator = await makeUser("list-creator");
    const other = await makeUser("list-other");

    const N = 5;
    const expectedIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const e = await prisma.event.create({
        data: {
          tenantId: LIST_TENANT_ID,
          creatorId: creator,
          title: `List event ${i}`,
          status: "PUBLISHED",
          visibility: "TENANT_ONLY",
          startsAt: new Date(Date.now() + (40 + i) * 86_400_000),
        },
      });
      expectedIds.push(e.id);
    }
    const otherEvent = await prisma.event.create({
      data: {
        tenantId: LIST_TENANT_ID,
        creatorId: other,
        title: "Other's event",
        status: "PUBLISHED",
        visibility: "TENANT_ONLY",
        startsAt: new Date(Date.now() + 45 * 86_400_000),
      },
    });
    expectedIds.push(otherEvent.id);

    const seenIds: string[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    let guard = 0;
    while (hasMore && guard++ < 10) {
      const qs = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const res = await handler.handleList(
        listReq(qs),
        auth(creator, { tenantId: LIST_TENANT_ID }),
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        cursor?: string;
        hasMore: boolean;
      };
      expect(body.items.length).toBeLessThanOrEqual(2);
      seenIds.push(...body.items.map((it) => it.id));
      hasMore = body.hasMore;
      cursor = body.cursor;
    }

    // No overlap, no gap, no duplicates — exactly the events we created.
    expect(seenIds).toHaveLength(expectedIds.length);
    expect(new Set(seenIds).size).toBe(expectedIds.length);
    expect(seenIds).toEqual(expectedIds); // ascending startsAt order preserved
  });

  it("handleListMine returns only the caller's own events", async () => {
    const { handler } = makeEventHandler();
    const mine = await makeUser("mine-creator");
    const notMine = await makeUser("mine-other");

    const mineIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await prisma.event.create({
        data: {
          tenantId: LIST_TENANT_ID,
          creatorId: mine,
          title: `Mine ${i}`,
          status: "PUBLISHED",
          visibility: "TENANT_ONLY",
          startsAt: new Date(Date.now() + (60 + i) * 86_400_000),
        },
      });
      mineIds.push(e.id);
    }
    const notMineEvent = await prisma.event.create({
      data: {
        tenantId: LIST_TENANT_ID,
        creatorId: notMine,
        title: "Not mine",
        status: "PUBLISHED",
        visibility: "TENANT_ONLY",
        startsAt: new Date(Date.now() + 63 * 86_400_000),
      },
    });

    const res = await handler.handleListMine(
      listMineReq("?limit=50"),
      auth(mine, { tenantId: LIST_TENANT_ID }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; hasMore: boolean };
    const ids = body.items.map((it) => it.id);
    expect(ids.sort()).toEqual([...mineIds].sort());
    expect(ids).not.toContain(notMineEvent.id);
    expect(body.hasMore).toBe(false);
  });
});

// ============================================================================
// 4. Update notifications
// ============================================================================

describe("Update notifications (real Postgres)", () => {
  it("notifies GOING attendees on a material change (startsAt) with changedFields", async () => {
    const { handler, feed, notify, eventId, creator } = await setupPublishedEvent("upd-material");

    // Seed a real GOING attendee so the setup is realistic — the fake
    // producer itself does not resolve recipients (that is the real
    // producer's job), so this does not change the assertions below, only
    // the fixture's fidelity.
    const attendee = await makeUser("upd-material-attendee");
    const rsvpHandler = new RsvpHandler(prisma);
    const rsvpRes = await rsvpHandler.handleRsvp(
      eventId,
      rsvpBody("GOING"),
      session(attendee),
      env,
      ctx,
      TENANT_ID,
    );
    expect(rsvpRes.status).toBe(201);

    const updateRes = await handler.handleUpdate(
      eventId,
      updateReq({ startsAt: futureIso(21) }),
      auth(creator),
      env,
    );
    expect(updateRes.status).toBe(200);

    expect(notify.updatedCalls).toHaveLength(1);
    expect(notify.updatedCalls[0]?.changedFields).toContain("startsAt");
    expect(notify.updatedCalls[0]?.eventId).toBe(eventId);
    // announcePostId was set on publish, so a material change also updates
    // the companion post.
    expect(feed.updateCalls).toHaveLength(1);
  });

  it("does not notify on a non-material change (title only)", async () => {
    const { handler, feed, notify, eventId, creator } = await setupPublishedEvent("upd-nonmaterial");

    const updateRes = await handler.handleUpdate(
      eventId,
      updateReq({ title: "Renamed, not rescheduled" }),
      auth(creator),
      env,
    );
    expect(updateRes.status).toBe(200);
    expect(((await updateRes.json()) as { title: string }).title).toBe(
      "Renamed, not rescheduled",
    );

    expect(notify.updatedCalls).toHaveLength(0);
    expect(feed.updateCalls).toHaveLength(0);
  });

  it("calls notifyEventUpdated again on a second material change (no handler-level debounce)", async () => {
    // NOTE / adaptation: the `updateNotifyCooldownSeconds` debounce is
    // documented on `NotificationProducer.notifyEventUpdated` (seams.ts) as
    // the REAL producer's responsibility (SEC-5), not something
    // `EventHandler` itself enforces. With the fake producer injected here,
    // every material change triggers a call — which is exactly the contract
    // this test pins: the handler must call the seam on every material
    // change and trust the producer to debounce/batch. We did not find (and
    // did not need to touch) the real cooldown implementation to verify this.
    const { handler, notify, eventId, creator } = await setupPublishedEvent("upd-cooldown");

    const first = await handler.handleUpdate(
      eventId,
      updateReq({ startsAt: futureIso(22) }),
      auth(creator),
      env,
    );
    expect(first.status).toBe(200);
    expect(notify.updatedCalls).toHaveLength(1);

    const second = await handler.handleUpdate(
      eventId,
      updateReq({ startsAt: futureIso(23) }),
      auth(creator),
      env,
    );
    expect(second.status).toBe(200);
    expect(notify.updatedCalls).toHaveLength(2);
  });
});

// ============================================================================
// 5. Cancel path
// ============================================================================

describe("Cancel path (real Postgres)", () => {
  it("cancels via DELETE: retracts + notifies once, and a repeat delete is idempotent", async () => {
    const { handler, feed, notify, eventId, creator } = await setupPublishedEvent("cancel-delete");

    const delRes1 = await handler.handleDelete(eventId, auth(creator), env);
    expect(delRes1.status).toBe(200);
    expect(((await delRes1.json()) as { status: string }).status).toBe("CANCELLED");
    expect(feed.retractCalls).toHaveLength(1);
    expect(notify.cancelledCalls).toHaveLength(1);

    const delRes2 = await handler.handleDelete(eventId, auth(creator), env);
    expect(delRes2.status).toBe(200);
    expect(((await delRes2.json()) as { status: string }).status).toBe("CANCELLED");
    // Idempotent: no additional retract/notify on the second delete.
    expect(feed.retractCalls).toHaveLength(1);
    expect(notify.cancelledCalls).toHaveLength(1);
  });

  it("cancels via update(status=CANCELLED): retracts + notifies, and a cancelled event cannot be edited further", async () => {
    const { handler, feed, notify, eventId, creator } = await setupPublishedEvent("cancel-update");

    const cancelRes = await handler.handleUpdate(
      eventId,
      updateReq({ status: "CANCELLED" }),
      auth(creator),
      env,
    );
    expect(cancelRes.status).toBe(200);
    expect(((await cancelRes.json()) as { status: string }).status).toBe("CANCELLED");
    expect(feed.retractCalls).toHaveLength(1);
    expect(notify.cancelledCalls).toHaveLength(1);

    const secondEdit = await handler.handleUpdate(
      eventId,
      updateReq({ title: "no-op" }),
      auth(creator),
      env,
    );
    expect(secondEdit.status).toBe(409);
  });
});

// ============================================================================
// 6. Quota enforcement
// ============================================================================

describe("Tenant quota (real Postgres)", () => {
  it("enforces maxPerTenant with 409, and cancelling an event frees the slot", async () => {
    const quotaEnv: Env = { ...env, event: { ...env.event, maxPerTenant: 2 } } as Env;
    const creator = await makeUser("quota-creator");
    const { handler } = makeEventHandler();
    const quotaAuth = auth(creator, { tenantId: QUOTA_TENANT_ID });

    const r1 = await handler.handleCreate(
      createReq({ title: "Q1", startsAt: futureIso(9) }),
      quotaAuth,
      quotaEnv,
    );
    expect(r1.status).toBe(201);
    const e1 = (await r1.json()) as { id: string };

    const r2 = await handler.handleCreate(
      createReq({ title: "Q2", startsAt: futureIso(9) }),
      quotaAuth,
      quotaEnv,
    );
    expect(r2.status).toBe(201);

    const r3 = await handler.handleCreate(
      createReq({ title: "Q3 rejected", startsAt: futureIso(9) }),
      quotaAuth,
      quotaEnv,
    );
    expect(r3.status).toBe(409);

    const cancelRes = await handler.handleDelete(e1.id, quotaAuth, quotaEnv);
    expect(cancelRes.status).toBe(200);

    const r4 = await handler.handleCreate(
      createReq({ title: "Q4 after free", startsAt: futureIso(9) }),
      quotaAuth,
      quotaEnv,
    );
    expect(r4.status).toBe(201);
  });
});

// ============================================================================
// 7. Authorization
// ============================================================================

describe("Authorization (real Postgres)", () => {
  it("blocks a non-owner MEMBER but allows an EventModerate (ADMIN) holder to moderate", async () => {
    const creator = await makeUser("auth-creator");
    const otherMember = await makeUser("auth-other-member");
    const moderator = await makeUser("auth-moderator");
    const { handler } = makeEventHandler();

    const createRes = await handler.handleCreate(
      createReq({ title: "Owner-only edit", startsAt: futureIso(10) }),
      auth(creator),
      env,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const updateDenied = await handler.handleUpdate(
      created.id,
      updateReq({ title: "Hijack" }),
      auth(otherMember),
      env,
    );
    expect(updateDenied.status).toBe(403);

    const deleteDenied = await handler.handleDelete(created.id, auth(otherMember), env);
    expect(deleteDenied.status).toBe(403);

    const modUpdate = await handler.handleUpdate(
      created.id,
      updateReq({ title: "Moderated title" }),
      auth(moderator, { tenantRole: "ADMIN" }),
      env,
    );
    expect(modUpdate.status).toBe(200);
    expect(((await modUpdate.json()) as { title: string }).title).toBe("Moderated title");

    const modDelete = await handler.handleDelete(
      created.id,
      auth(moderator, { tenantRole: "ADMIN" }),
      env,
    );
    expect(modDelete.status).toBe(200);
    expect(((await modDelete.json()) as { status: string }).status).toBe("CANCELLED");
  });

  it("rejects GROUP_ONLY visibility without a groupId on create and on update (400)", async () => {
    const creator = await makeUser("auth-novalid-creator");
    const { handler } = makeEventHandler();

    const badCreate = await handler.handleCreate(
      createReq({ title: "Bad group event", startsAt: futureIso(11), visibility: "GROUP_ONLY" }),
      auth(creator),
      env,
    );
    expect(badCreate.status).toBe(400);

    const createRes = await handler.handleCreate(
      createReq({ title: "Tenant only event", startsAt: futureIso(12) }),
      auth(creator),
      env,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const badUpdate = await handler.handleUpdate(
      created.id,
      updateReq({ visibility: "GROUP_ONLY" }),
      auth(creator),
      env,
    );
    expect(badUpdate.status).toBe(400);
  });
});

// ============================================================================
// 8. Shift lifecycle (ShiftHandler)
// ============================================================================

describe("Shift lifecycle (real Postgres)", () => {
  it("creates/lists/updates shifts and enforces maxShiftsPerEvent", async () => {
    const creator = await makeUser("shift-creator");
    const eventId = await makePublishedEvent({ creatorId: creator, tenantId: TENANT_ID, daysOut: 25 });
    const shiftHandler = new ShiftHandler();
    const smallEnv: Env = { ...env, event: { ...env.event, maxShiftsPerEvent: 1 } } as Env;

    const createRes = await shiftHandler.handleCreate(
      eventId,
      shiftCreateReq({ title: "Setup", capacity: 3 }),
      auth(creator),
      smallEnv,
    );
    expect(createRes.status).toBe(201);
    const shift = (await createRes.json()) as { id: string };

    const overflowRes = await shiftHandler.handleCreate(
      eventId,
      shiftCreateReq({ title: "Overflow", capacity: 1 }),
      auth(creator),
      smallEnv,
    );
    expect(overflowRes.status).toBe(409);

    const listRes = await shiftHandler.handleList(eventId, auth(creator), env);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { shifts: Array<{ id: string }> };
    expect(list.shifts).toHaveLength(1);

    const updateRes = await shiftHandler.handleUpdate(
      eventId,
      shift.id,
      shiftUpdateReq({ title: "Setup crew" }),
      auth(creator),
      env,
    );
    expect(updateRes.status).toBe(200);
    expect(((await updateRes.json()) as { title: string }).title).toBe("Setup crew");
  });

  it("signs up and withdraws from a shift", async () => {
    const creator = await makeUser("shift-su-creator");
    const member = await makeUser("shift-su-member");
    const eventId = await makePublishedEvent({ creatorId: creator, tenantId: TENANT_ID, daysOut: 26 });
    const shiftHandler = new ShiftHandler();

    const createRes = await shiftHandler.handleCreate(
      eventId,
      shiftCreateReq({ title: "Crew", capacity: 5 }),
      auth(creator),
      env,
    );
    expect(createRes.status).toBe(201);
    const shift = (await createRes.json()) as { id: string };

    const signupRes = await shiftHandler.handleSignup(
      eventId,
      shift.id,
      shiftSignupReq(),
      auth(member),
      env,
    );
    expect(signupRes.status).toBe(201);
    expect(((await signupRes.json()) as { status: string }).status).toBe("CONFIRMED");

    // Idempotent while still confirmed.
    const idempotentSignup = await shiftHandler.handleSignup(
      eventId,
      shift.id,
      shiftSignupReq(),
      auth(member),
      env,
    );
    expect(idempotentSignup.status).toBe(200);

    const withdrawRes = await shiftHandler.handleWithdraw(eventId, shift.id, auth(member), env);
    expect(withdrawRes.status).toBe(204);

    // ADAPTATION: unlike RSVP withdrawal (which is idempotent -> 204 on a
    // repeat), ShiftHandler.handleWithdraw treats an already-CANCELLED
    // signup as "not found" (see shift-handler.ts's
    // `!existing || existing.status === "CANCELLED"` guard) -> 404, not 204.
    const secondWithdraw = await shiftHandler.handleWithdraw(eventId, shift.id, auth(member), env);
    expect(secondWithdraw.status).toBe(404);
  });

  it("blocks a non-member from signing up for a shift on a GROUP_ONLY event (F-3 visibility gate)", async () => {
    const creatorActor = `https://example.test/${RUN}/actors/shift-vis-creator`;
    const memberActor = `https://example.test/${RUN}/actors/shift-vis-member`;
    const creator = await makeUser("shift-vis-creator", creatorActor);
    const member = await makeUser("shift-vis-member", memberActor);
    const nonMember = await makeUser("shift-vis-nonmember");
    const groupId = await makeGroup("shift-vis", TENANT_ID);
    await addGroupMember(groupId, TENANT_ID, memberActor);

    const eventId = await makePublishedEvent({
      creatorId: creator,
      tenantId: TENANT_ID,
      daysOut: 27,
      visibility: "GROUP_ONLY",
      groupId,
    });
    const shiftHandler = new ShiftHandler();

    const createRes = await shiftHandler.handleCreate(
      eventId,
      shiftCreateReq({ title: "Volunteer slot", capacity: 2 }),
      auth(creator),
      env,
    );
    expect(createRes.status).toBe(201);
    const shift = (await createRes.json()) as { id: string };

    const nonMemberSignup = await shiftHandler.handleSignup(
      eventId,
      shift.id,
      shiftSignupReq(),
      auth(nonMember),
      env,
    );
    expect(nonMemberSignup.status).toBe(404);

    const memberSignup = await shiftHandler.handleSignup(
      eventId,
      shift.id,
      shiftSignupReq(),
      auth(member),
      env,
    );
    expect(memberSignup.status).toBe(201);
  });
});

// ============================================================================
// 9. RSVP status semantics (RsvpHandler)
// ============================================================================

describe("RSVP status semantics (real Postgres)", () => {
  it("MAYBE and NOT_GOING RSVPs do not consume a seat", async () => {
    const creator = await makeUser("rsvp-sem-creator");
    const maybeUser = await makeUser("rsvp-sem-maybe");
    const notGoingUser = await makeUser("rsvp-sem-notgoing");
    const eventId = await makePublishedEvent({
      creatorId: creator,
      tenantId: TENANT_ID,
      daysOut: 28,
      capacity: 5,
    });
    const rsvpHandler = new RsvpHandler(prisma);

    const maybeRes = await rsvpHandler.handleRsvp(
      eventId,
      rsvpBody("MAYBE"),
      session(maybeUser),
      env,
      ctx,
      TENANT_ID,
    );
    expect(maybeRes.status).toBe(201);
    expect(((await maybeRes.json()) as { status: string }).status).toBe("MAYBE");

    const notGoingRes = await rsvpHandler.handleRsvp(
      eventId,
      rsvpBody("NOT_GOING"),
      session(notGoingUser),
      env,
      ctx,
      TENANT_ID,
    );
    expect(notGoingRes.status).toBe(201);
    expect(((await notGoingRes.json()) as { status: string }).status).toBe("NOT_GOING");

    const refreshed = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(refreshed.rsvpCount).toBe(0);
    expect(refreshed.waitlistCount).toBe(0);
  });

  it("attendee listing filters by status and paginates with no overlap", async () => {
    const creator = await makeUser("rsvp-att-creator");
    const eventId = await makePublishedEvent({
      creatorId: creator,
      tenantId: TENANT_ID,
      daysOut: 29,
      capacity: 10,
    });
    const rsvpHandler = new RsvpHandler(prisma);
    const goingUsers = await Promise.all(
      Array.from({ length: 3 }, (_, i) => makeUser(`rsvp-att-going-${i}`)),
    );
    const maybeUser = await makeUser("rsvp-att-maybe");

    for (const u of goingUsers) {
      const r = await rsvpHandler.handleRsvp(
        eventId,
        rsvpBody("GOING"),
        session(u),
        env,
        ctx,
        TENANT_ID,
      );
      expect(r.status).toBe(201);
    }
    await rsvpHandler.handleRsvp(eventId, rsvpBody("MAYBE"), session(maybeUser), env, ctx, TENANT_ID);

    // Default (no status filter) includes GOING + WAITLISTED + MAYBE.
    const defaultRes = await rsvpHandler.handleAttendees(
      eventId,
      attendeesReq(),
      session(creator),
      env,
      ctx,
      TENANT_ID,
    );
    expect(defaultRes.status).toBe(200);
    const defaultBody = (await defaultRes.json()) as { items: Array<{ userId: string }> };
    expect(defaultBody.items).toHaveLength(4);

    // status=GOING filter + small-page pagination roundtrip.
    const page1Res = await rsvpHandler.handleAttendees(
      eventId,
      attendeesReq({ status: "GOING", limit: "2" }),
      session(creator),
      env,
      ctx,
      TENANT_ID,
    );
    const page1 = (await page1Res.json()) as {
      items: Array<{ userId: string }>;
      cursor?: string;
      hasMore: boolean;
    };
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).toBeDefined();

    const page2Res = await rsvpHandler.handleAttendees(
      eventId,
      attendeesReq({ status: "GOING", limit: "2", cursor: page1.cursor! }),
      session(creator),
      env,
      ctx,
      TENANT_ID,
    );
    const page2 = (await page2Res.json()) as { items: Array<{ userId: string }>; hasMore: boolean };
    expect(page2.items).toHaveLength(1);
    expect(page2.hasMore).toBe(false);

    const allGoingIds = new Set(
      [...page1.items, ...page2.items].map((it) => it.userId),
    );
    expect(allGoingIds.size).toBe(3);
    for (const u of goingUsers) expect(allGoingIds.has(u)).toBe(true);
  });
});
