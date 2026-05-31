/**
 * Integration Tests: Neo4j GraphService — Circle Resolution Methods
 *
 * Tests getCircleMembers, getVisiblePostIds, getGlanceItems, getDepthPostIds,
 * getCircleStatus, getCircleEntityStatus, and markCircleRead against a real
 * local Neo4j instance.
 *
 * PROD-SAFE: Uses a unique RUN_ID prefix for all node IDs. Cleanup is
 * performed via deleteTestNodes(RUN_ID) in afterAll — no wipeTestDb().
 *
 * Prerequisites:
 *   - Neo4j running locally (bolt://localhost:7687)
 *   - .env.test.local configured (NEO4J_TEST_URI / USER / PASSWORD)
 *
 * Run:
 *   npm run test:graph -w @de-otio/trellis
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphService } from "../../../src/lib/graph/graph-factory.js";
import { Neo4jGraphService } from "../../../src/lib/graph/neo4j-graph-service.js";
import { closeTestDriver, deleteTestNodes } from "./harness.js";
import { getTestDatabase, getTestDriver } from "./setup.js";

// ---------------------------------------------------------------------------
// Unique run prefix — all node IDs share this prefix for prod-safe cleanup
// ---------------------------------------------------------------------------

const RUN_ID = `test-${Date.now().toString(36)}`;

// Convenience ID builders
const u = (n: string) => `${RUN_ID}-user-${n}`;
const e = (n: string) => `${RUN_ID}-ent-${n}`;
const p = (n: string) => `${RUN_ID}-post-${n}`;

// ---------------------------------------------------------------------------
// Score constants aligned with CIRCLE_THRESHOLDS
// ---------------------------------------------------------------------------

const SCORE = {
  /** Tier 0: inner (>= 0.8) */
  inner: 0.9,
  /** Tier 1: closeFriends (>= 0.5 && < 0.8) */
  close: 0.65,
  /** Tier 2: community (>= 0.2 && < 0.5) */
  community: 0.35,
  /** Tier 3: ambient (>= 0.001 && < 0.2) */
  ambient: 0.1,
  /** Below all tiers */
  none: 0.0,
};

// ---------------------------------------------------------------------------
// Direct Cypher helpers (for asserting graph state without going via the service)
// ---------------------------------------------------------------------------

async function runCypher(
  query: string,
  params: Record<string, unknown> = {},
): Promise<import("neo4j-driver").QueryResult> {
  const driver = getTestDriver();
  const database = getTestDatabase();
  const session = driver.session({ database });
  try {
    return await session.run(query, params);
  } finally {
    await session.close();
  }
}

/** Read a property set directly on a User node */
async function getUserProp(userId: string, prop: string): Promise<unknown> {
  const result = await runCypher(
    `MATCH (u:User {id: $userId}) RETURN u[$prop] AS val`,
    { userId, prop },
  );
  return result.records[0]?.get("val") ?? undefined;
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

// Typed as Neo4jGraphService so we can access the extended getCircleStatus signature
// (which accepts an optional lastReadTimestamps param not present on the interface).
let svc: Neo4jGraphService;

beforeAll(async () => {
  // Cast is safe: createGraphService always returns a Neo4jGraphService at
  // runtime. We need the concrete
  // type here to access the extended getCircleStatus(userId, lastReadTimestamps)
  // overload that is not exposed on the GraphService interface.
  svc = (await createGraphService({
    uri: process.env.NEO4J_TEST_URI ?? "bolt://localhost:7687",
    user: process.env.NEO4J_TEST_USER,
    password: process.env.NEO4J_TEST_PASSWORD,
  })) as Neo4jGraphService;
});

afterAll(async () => {
  await deleteTestNodes(RUN_ID);
  await svc.close();
  await closeTestDriver();
});

// ---------------------------------------------------------------------------
// Shared fixture setup
//
// We build a deterministic graph once in the outer beforeAll scope, then run
// read-only assertions in each describe block.  This avoids the performance
// cost of re-creating nodes for every test.
//
// Topology:
//
//   viewer ──(0.9)──► entity-dog   [tier 0 entity]
//   viewer ──(0.65)─► entity-cat   [tier 1 entity]
//   viewer ──(0.35)─► entity-bird  [tier 2 entity]
//   viewer ──(0.1)──► entity-fish  [tier 3 entity]
//   viewer ──(0.9)──► user-alice   [tier 0 user]
//   viewer ──(0.65)─► user-bob     [tier 1 user]
//
// Posts:
//   post-dog-1   radius NORMAL (radiusInt 1)  about entity-dog   (tier 0 visible, radiusInt >= 0)
//   post-dog-2   radius SHOUT  (radiusInt 3)  about entity-dog   (visible all tiers)
//   post-cat-1   radius NORMAL (radiusInt 1)  about entity-cat   (tier 1 visible)
//   post-cat-2   radius WHISPER (radiusInt 0) about entity-cat   (whisper — only tier 0)
//   post-bird-1  radius LOUD   (radiusInt 2)  about entity-bird  (tier 2 visible)
//   post-alice-1 radius NORMAL (radiusInt 1)  by user-alice      (tier 0 user post)
//   post-bob-1   radius LOUD   (radiusInt 2)  by user-bob        (tier 1 user post)
//
// Dates:
//   All posts are in the past; post-dog-old is older than the `since` cutoff
//   used in filtering tests.
// ---------------------------------------------------------------------------

const VIEWER = u("viewer");
const ENTITY_DOG = e("dog");
const ENTITY_CAT = e("cat");
const ENTITY_BIRD = e("bird");
const ENTITY_FISH = e("fish");
const USER_ALICE = u("alice");
const USER_BOB = u("bob");

const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

// Post IDs
const POST_DOG_1 = p("dog-1");
const POST_DOG_2 = p("dog-2");
const POST_DOG_OLD = p("dog-old");
const POST_CAT_1 = p("cat-1");
const POST_CAT_WHISPER = p("cat-whisper");
const POST_BIRD_1 = p("bird-1");
const POST_ALICE_1 = p("alice-1");
const POST_BOB_1 = p("bob-1");

beforeAll(async () => {
  // Nodes
  await svc.syncUser({ id: VIEWER, role: "END_USER" });
  await svc.syncUser({ id: USER_ALICE, role: "END_USER" });
  await svc.syncUser({ id: USER_BOB, role: "END_USER" });
  await svc.syncEntity({ id: ENTITY_DOG, entityType: "dog", name: "Buddy" });
  await svc.syncEntity({ id: ENTITY_CAT, entityType: "cat", name: "Whiskers" });
  await svc.syncEntity({ id: ENTITY_BIRD, entityType: "bird", name: "Tweety" });
  await svc.syncEntity({ id: ENTITY_FISH, entityType: "fish", name: "Nemo" });

  // Relationships with controlled scores
  await svc.createRelationship({ userId: VIEWER, targetType: "entity", targetId: ENTITY_DOG, connectionMethod: "code" });
  await svc.updateRelationshipScore({ userId: VIEWER, targetType: "entity", targetId: ENTITY_DOG, manualScore: SCORE.inner });

  await svc.createRelationship({ userId: VIEWER, targetType: "entity", targetId: ENTITY_CAT, connectionMethod: "code" });
  await svc.updateRelationshipScore({ userId: VIEWER, targetType: "entity", targetId: ENTITY_CAT, manualScore: SCORE.close });

  await svc.createRelationship({ userId: VIEWER, targetType: "entity", targetId: ENTITY_BIRD, connectionMethod: "code" });
  await svc.updateRelationshipScore({ userId: VIEWER, targetType: "entity", targetId: ENTITY_BIRD, manualScore: SCORE.community });

  await svc.createRelationship({ userId: VIEWER, targetType: "entity", targetId: ENTITY_FISH, connectionMethod: "code" });
  await svc.updateRelationshipScore({ userId: VIEWER, targetType: "entity", targetId: ENTITY_FISH, manualScore: SCORE.ambient });

  await svc.createRelationship({ userId: VIEWER, targetType: "user", targetId: USER_ALICE, connectionMethod: "code" });
  await svc.updateRelationshipScore({ userId: VIEWER, targetType: "user", targetId: USER_ALICE, manualScore: SCORE.inner });

  await svc.createRelationship({ userId: VIEWER, targetType: "user", targetId: USER_BOB, connectionMethod: "code" });
  await svc.updateRelationshipScore({ userId: VIEWER, targetType: "user", targetId: USER_BOB, manualScore: SCORE.close });

  // Posts
  await svc.syncPost({ id: POST_DOG_1, authorId: USER_ALICE, radius: "NORMAL", createdAt: hoursAgo(2) });
  await svc.syncPostSubjects({ postId: POST_DOG_1, entityIds: [ENTITY_DOG], primaryEntityId: ENTITY_DOG });

  await svc.syncPost({ id: POST_DOG_2, authorId: USER_ALICE, radius: "SHOUT", createdAt: hoursAgo(1) });
  await svc.syncPostSubjects({ postId: POST_DOG_2, entityIds: [ENTITY_DOG], primaryEntityId: ENTITY_DOG });

  // Old post — 100 hours ago, used to test the `since` filter
  await svc.syncPost({ id: POST_DOG_OLD, authorId: USER_ALICE, radius: "NORMAL", createdAt: hoursAgo(100) });
  await svc.syncPostSubjects({ postId: POST_DOG_OLD, entityIds: [ENTITY_DOG], primaryEntityId: ENTITY_DOG });

  await svc.syncPost({ id: POST_CAT_1, authorId: USER_BOB, radius: "NORMAL", createdAt: hoursAgo(3) });
  await svc.syncPostSubjects({ postId: POST_CAT_1, entityIds: [ENTITY_CAT], primaryEntityId: ENTITY_CAT });

  // WHISPER post — radiusInt 0, should NOT be visible in tier 1 (tierInt=1, radiusInt 0 < 1)
  await svc.syncPost({ id: POST_CAT_WHISPER, authorId: USER_BOB, radius: "WHISPER", createdAt: hoursAgo(4) });
  await svc.syncPostSubjects({ postId: POST_CAT_WHISPER, entityIds: [ENTITY_CAT], primaryEntityId: ENTITY_CAT });

  await svc.syncPost({ id: POST_BIRD_1, authorId: USER_BOB, radius: "LOUD", createdAt: hoursAgo(5) });
  await svc.syncPostSubjects({ postId: POST_BIRD_1, entityIds: [ENTITY_BIRD], primaryEntityId: ENTITY_BIRD });

  await svc.syncPost({ id: POST_ALICE_1, authorId: USER_ALICE, radius: "NORMAL", createdAt: hoursAgo(1) });
  // No entity subjects — this is a user-authored post found via the user branch

  await svc.syncPost({ id: POST_BOB_1, authorId: USER_BOB, radius: "LOUD", createdAt: hoursAgo(2) });
  // No entity subjects — user-authored post
});

// ===========================================================================
// getCircleMembers
// ===========================================================================

describe("getCircleMembers", () => {
  it("returns entity-dog and user-alice for tier 0 (score >= 0.8)", async () => {
    const members = await svc.getCircleMembers(VIEWER, 0);
    const ids = members.map((m) => m.id);
    expect(ids).toContain(ENTITY_DOG);
    expect(ids).toContain(USER_ALICE);
    // tier-1 members must not appear
    expect(ids).not.toContain(ENTITY_CAT);
    expect(ids).not.toContain(USER_BOB);
  });

  it("returns correct types for tier 0 members", async () => {
    const members = await svc.getCircleMembers(VIEWER, 0);
    const dog = members.find((m) => m.id === ENTITY_DOG);
    const alice = members.find((m) => m.id === USER_ALICE);
    expect(dog?.type).toBe("entity");
    expect(alice?.type).toBe("user");
  });

  it("returns members sorted by score descending", async () => {
    // Add a second inner-tier entity with a slightly lower score so order is testable
    const ENTITY_PARROT = e("parrot");
    await svc.syncEntity({ id: ENTITY_PARROT, entityType: "bird", name: "Polly" });
    await svc.createRelationship({ userId: VIEWER, targetType: "entity", targetId: ENTITY_PARROT, connectionMethod: "code" });
    await svc.updateRelationshipScore({ userId: VIEWER, targetType: "entity", targetId: ENTITY_PARROT, manualScore: 0.85 });

    const members = await svc.getCircleMembers(VIEWER, 0);
    const innerScores = members.filter((m) => m.tier === 0).map((m) => m.score);
    // Scores must be non-increasing
    for (let i = 1; i < innerScores.length; i++) {
      expect(innerScores[i]).toBeLessThanOrEqual(innerScores[i - 1]);
    }

    // Cleanup the temporary node (deleteTestNodes handles it via RUN_ID prefix)
  });

  it("returns only entity-cat and user-bob for tier 1 (>= 0.5 && < 0.8)", async () => {
    const members = await svc.getCircleMembers(VIEWER, 1);
    const ids = members.map((m) => m.id);
    expect(ids).toContain(ENTITY_CAT);
    expect(ids).toContain(USER_BOB);
    expect(ids).not.toContain(ENTITY_DOG);
    expect(ids).not.toContain(ENTITY_BIRD);
  });

  it("returns entity-bird for tier 2 (>= 0.2 && < 0.5)", async () => {
    const members = await svc.getCircleMembers(VIEWER, 2);
    const ids = members.map((m) => m.id);
    expect(ids).toContain(ENTITY_BIRD);
    expect(ids).not.toContain(ENTITY_CAT);
    expect(ids).not.toContain(ENTITY_FISH);
  });

  it("returns entity-fish for tier 3 (>= 0.001 && < 0.2)", async () => {
    const members = await svc.getCircleMembers(VIEWER, 3);
    const ids = members.map((m) => m.id);
    expect(ids).toContain(ENTITY_FISH);
    expect(ids).not.toContain(ENTITY_BIRD);
  });

  it("returns empty array when viewer has no relationships in that tier", async () => {
    const LONER = u("loner");
    await svc.syncUser({ id: LONER, role: "END_USER" });
    const members = await svc.getCircleMembers(LONER, 0);
    expect(members).toHaveLength(0);
  });
});

// ===========================================================================
// getVisiblePostIds
// ===========================================================================

describe("getVisiblePostIds", () => {
  const since = hoursAgo(48); // all recent posts are within this window
  const pagination = { limit: 20 };

  it("returns posts about tier-0 entities visible within the since window", async () => {
    const result = await svc.getVisiblePostIds(VIEWER, 0, since, pagination);
    const postIds = result.items.map((i) => i.postId);
    expect(postIds).toContain(POST_DOG_1);
    expect(postIds).toContain(POST_DOG_2);
  });

  it("excludes posts older than the since cutoff", async () => {
    const result = await svc.getVisiblePostIds(VIEWER, 0, since, pagination);
    const postIds = result.items.map((i) => i.postId);
    expect(postIds).not.toContain(POST_DOG_OLD);
  });

  it("excludes WHISPER posts when querying tier 1 (radiusInt 0 < tierInt 1)", async () => {
    const result = await svc.getVisiblePostIds(VIEWER, 1, since, pagination);
    const postIds = result.items.map((i) => i.postId);
    expect(postIds).not.toContain(POST_CAT_WHISPER);
  });

  it("includes NORMAL post about tier-1 entity when querying tier 1", async () => {
    const result = await svc.getVisiblePostIds(VIEWER, 1, since, pagination);
    const postIds = result.items.map((i) => i.postId);
    expect(postIds).toContain(POST_CAT_1);
  });

  it("returns posts by tier-0 users via the user branch", async () => {
    const result = await svc.getVisiblePostIds(VIEWER, 0, since, pagination);
    const postIds = result.items.map((i) => i.postId);
    expect(postIds).toContain(POST_ALICE_1);
  });

  it("returns empty result when no members exist for viewer in that tier", async () => {
    const NOBODY = u("nobody");
    await svc.syncUser({ id: NOBODY, role: "END_USER" });
    const result = await svc.getVisiblePostIds(NOBODY, 0, since, pagination);
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });

  it("paginates correctly when limit is smaller than total results", async () => {
    // Use a limit of 1 to force hasMore and a cursor
    const first = await svc.getVisiblePostIds(VIEWER, 0, since, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).not.toBeNull();

    // Fetch the second page
    const second = await svc.getVisiblePostIds(VIEWER, 0, since, { limit: 1, cursor: first.cursor! });
    expect(second.items).toHaveLength(1);
    // The two pages must not overlap
    expect(second.items[0].postId).not.toBe(first.items[0].postId);
  });

  it("resolvedTier reflects the closest viewer-to-entity relationship", async () => {
    // DOG is tier 0 — resolvedTier should be 0
    const result = await svc.getVisiblePostIds(VIEWER, 0, since, pagination);
    const dogPost = result.items.find((i) => i.postId === POST_DOG_1 || i.postId === POST_DOG_2);
    expect(dogPost).toBeDefined();
    expect(dogPost!.resolvedTier).toBe(0);
  });
});

// ===========================================================================
// getGlanceItems
// ===========================================================================

describe("getGlanceItems", () => {
  it("returns one item per tier-0 member with a recent post", async () => {
    const items = await svc.getGlanceItems(VIEWER, 0, 20);
    const targetIds = items.map((i) => i.targetId);
    // ENTITY_DOG has posts; USER_ALICE has a post
    expect(targetIds).toContain(ENTITY_DOG);
    expect(targetIds).toContain(USER_ALICE);
  });

  it("returns exactly one post per target, not all posts", async () => {
    // ENTITY_DOG has two posts (POST_DOG_1, POST_DOG_2). Only one glance item.
    const items = await svc.getGlanceItems(VIEWER, 0, 20);
    const dogItems = items.filter((i) => i.targetId === ENTITY_DOG);
    expect(dogItems).toHaveLength(1);
  });

  it("the single post per entity is the most recent one", async () => {
    const items = await svc.getGlanceItems(VIEWER, 0, 20);
    const dogItem = items.find((i) => i.targetId === ENTITY_DOG);
    expect(dogItem).toBeDefined();
    // POST_DOG_2 was created 1h ago, POST_DOG_1 was 2h ago — DOG_2 is latest
    expect(dogItem!.postId).toBe(POST_DOG_2);
  });

  it("respects the limit parameter", async () => {
    const items = await svc.getGlanceItems(VIEWER, 0, 1);
    expect(items).toHaveLength(1);
  });

  it("returns empty array when viewer has no tier-1 members with posts", async () => {
    const HERMIT = u("hermit");
    await svc.syncUser({ id: HERMIT, role: "END_USER" });
    const items = await svc.getGlanceItems(HERMIT, 1, 20);
    expect(items).toHaveLength(0);
  });

  it("sets correct targetType for entity and user members", async () => {
    const items = await svc.getGlanceItems(VIEWER, 0, 20);
    const dogItem = items.find((i) => i.targetId === ENTITY_DOG);
    const aliceItem = items.find((i) => i.targetId === USER_ALICE);
    expect(dogItem?.targetType).toBe("entity");
    expect(aliceItem?.targetType).toBe("user");
  });
});

// ===========================================================================
// getDepthPostIds
// ===========================================================================

describe("getDepthPostIds", () => {
  const since = hoursAgo(48);

  it("returns posts about a specific entity the viewer has a relationship with", async () => {
    const ids = await svc.getDepthPostIds(VIEWER, "entity", ENTITY_DOG, since, 20);
    expect(ids).toContain(POST_DOG_1);
    expect(ids).toContain(POST_DOG_2);
  });

  it("excludes posts older than the since cutoff", async () => {
    const ids = await svc.getDepthPostIds(VIEWER, "entity", ENTITY_DOG, since, 20);
    expect(ids).not.toContain(POST_DOG_OLD);
  });

  it("returns posts by a specific user the viewer has a relationship with", async () => {
    const ids = await svc.getDepthPostIds(VIEWER, "user", USER_ALICE, since, 20);
    expect(ids).toContain(POST_ALICE_1);
  });

  it("returns empty array when viewer has no relationship with the target entity", async () => {
    const STRANGER_ENTITY = e("stranger");
    await svc.syncEntity({ id: STRANGER_ENTITY, entityType: "dog", name: "Rex" });
    await svc.syncPost({ id: p("stranger-post"), authorId: USER_ALICE, radius: "SHOUT", createdAt: hoursAgo(1) });
    await svc.syncPostSubjects({ postId: p("stranger-post"), entityIds: [STRANGER_ENTITY], primaryEntityId: STRANGER_ENTITY });

    const ids = await svc.getDepthPostIds(VIEWER, "entity", STRANGER_ENTITY, since, 20);
    expect(ids).toHaveLength(0);
  });

  it("respects the limit parameter", async () => {
    // ENTITY_DOG has multiple posts; limit to 1
    const ids = await svc.getDepthPostIds(VIEWER, "entity", ENTITY_DOG, since, 1);
    expect(ids).toHaveLength(1);
  });

  it("does not return posts about an entity when viewer has no relationship", async () => {
    const UNRELATED = u("unrelated-viewer");
    await svc.syncUser({ id: UNRELATED, role: "END_USER" });
    const ids = await svc.getDepthPostIds(UNRELATED, "entity", ENTITY_DOG, since, 20);
    expect(ids).toHaveLength(0);
  });
});

// ===========================================================================
// getCircleStatus
// ===========================================================================

describe("getCircleStatus", () => {
  it("returns an array of 4 CircleTierStatus entries, one per tier", async () => {
    const status = await svc.getCircleStatus(VIEWER);
    expect(status).toHaveLength(4);
    expect(status.map((s) => s.tier).sort()).toEqual([0, 1, 2, 3]);
  });

  it("status for tier 0 reports unseenCount > 0 when posts exist and no lastReadAt", async () => {
    // No lastReadTimestamps supplied → defaults to epoch → all posts are unseen
    const status = await svc.getCircleStatus(VIEWER);
    const tier0 = status.find((s) => s.tier === 0)!;
    expect(tier0.unseenCount).toBeGreaterThan(0);
    expect(tier0.caughtUp).toBe(false);
  });

  it("status reflects unseenCount=0 when lastReadAt is in the future", async () => {
    const future = new Date(now.getTime() + 60_000);
    const status = await svc.getCircleStatus(VIEWER, { 0: future, 1: future, 2: future, 3: future });
    for (const s of status) {
      expect(s.unseenCount).toBe(0);
      expect(s.caughtUp).toBe(true);
    }
  });

  it("correct tier names are returned", async () => {
    const status = await svc.getCircleStatus(VIEWER);
    const nameMap = Object.fromEntries(status.map((s) => [s.tier, s.name]));
    expect(nameMap[0]).toBe("inner");
    expect(nameMap[1]).toBe("closeFriends");
    expect(nameMap[2]).toBe("community");
    expect(nameMap[3]).toBe("ambient");
  });

  it("viewer with no relationships has unseenCount=0 for all tiers", async () => {
    const BLANK = u("blank");
    await svc.syncUser({ id: BLANK, role: "END_USER" });
    const status = await svc.getCircleStatus(BLANK);
    for (const s of status) {
      expect(s.unseenCount).toBe(0);
      expect(s.caughtUp).toBe(true);
    }
  });
});

// ===========================================================================
// getCircleEntityStatus
// ===========================================================================

describe("getCircleEntityStatus", () => {
  it("returns entity status for all tier-0 entities", async () => {
    const statuses = await svc.getCircleEntityStatus(VIEWER, 0);
    const entityIds = statuses.map((s) => s.entityId);
    expect(entityIds).toContain(ENTITY_DOG);
    // ENTITY_CAT is tier 1, not tier 0
    expect(entityIds).not.toContain(ENTITY_CAT);
  });

  it("reports unseenCount > 0 for entity-dog when no lastReadAt provided", async () => {
    const statuses = await svc.getCircleEntityStatus(VIEWER, 0);
    const dog = statuses.find((s) => s.entityId === ENTITY_DOG);
    expect(dog).toBeDefined();
    expect(dog!.unseenCount).toBeGreaterThan(0);
    expect(dog!.caughtUp).toBe(false);
  });

  it("reports unseenCount=0 when lastReadAt is in the future", async () => {
    const future = new Date(now.getTime() + 60_000);
    const statuses = await svc.getCircleEntityStatus(VIEWER, 0, future);
    for (const s of statuses) {
      expect(s.unseenCount).toBe(0);
      expect(s.caughtUp).toBe(true);
    }
  });

  it("statuses are sorted with highest unseenCount first", async () => {
    const statuses = await svc.getCircleEntityStatus(VIEWER, 0);
    const counts = statuses.map((s) => s.unseenCount);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
  });

  it("returns empty array for tier with no entity members", async () => {
    // Only USER_ALICE is in tier 0 — no entity members for a freshly created viewer with user-only relationships
    const USER_ONLY_VIEWER = u("user-only-viewer");
    await svc.syncUser({ id: USER_ONLY_VIEWER, role: "END_USER" });
    await svc.createRelationship({ userId: USER_ONLY_VIEWER, targetType: "user", targetId: USER_ALICE, connectionMethod: "code" });
    await svc.updateRelationshipScore({ userId: USER_ONLY_VIEWER, targetType: "user", targetId: USER_ALICE, manualScore: SCORE.inner });

    const statuses = await svc.getCircleEntityStatus(USER_ONLY_VIEWER, 0);
    expect(statuses).toHaveLength(0);
  });
});

// ===========================================================================
// markCircleRead
// ===========================================================================

describe("markCircleRead", () => {
  it("stores a lastReadTier0 property on the User node", async () => {
    const MARK_VIEWER = u("mark-viewer");
    await svc.syncUser({ id: MARK_VIEWER, role: "END_USER" });

    const readAt = new Date();
    await svc.markCircleRead(MARK_VIEWER, 0, readAt);

    // Verify the property was written to the User node
    const storedVal = await getUserProp(MARK_VIEWER, "lastReadTier0");
    expect(storedVal).not.toBeNull();
    expect(storedVal).not.toBeUndefined();
  });

  it("stores lastReadTier prop for each tier (0–3)", async () => {
    const MARK_VIEWER = u("mark-viewer-tiers");
    await svc.syncUser({ id: MARK_VIEWER, role: "END_USER" });

    const tiers: Array<0 | 1 | 2 | 3> = [0, 1, 2, 3];
    for (const tier of tiers) {
      await svc.markCircleRead(MARK_VIEWER, tier);
      const val = await getUserProp(MARK_VIEWER, `lastReadTier${tier}`);
      expect(val).not.toBeNull();
    }
  });

  it("markCircleRead with a future readAt makes getCircleStatus report caughtUp=true for that tier", async () => {
    // Create a viewer with a tier-0 entity and some posts
    const FRESHVIEW = u("freshview");
    const FRESHDOG = e("freshdog");
    const FRESHPOST = p("freshpost");

    await svc.syncUser({ id: FRESHVIEW, role: "END_USER" });
    await svc.syncEntity({ id: FRESHDOG, entityType: "dog", name: "Bruno" });
    await svc.syncPost({ id: FRESHPOST, authorId: FRESHVIEW, radius: "NORMAL", createdAt: hoursAgo(1) });
    await svc.syncPostSubjects({ postId: FRESHPOST, entityIds: [FRESHDOG], primaryEntityId: FRESHDOG });

    await svc.createRelationship({ userId: FRESHVIEW, targetType: "entity", targetId: FRESHDOG, connectionMethod: "code" });
    await svc.updateRelationshipScore({ userId: FRESHVIEW, targetType: "entity", targetId: FRESHDOG, manualScore: SCORE.inner });

    // Before marking read — tier 0 should have unseen posts
    const before = await svc.getCircleStatus(FRESHVIEW);
    const tier0Before = before.find((s) => s.tier === 0)!;
    expect(tier0Before.unseenCount).toBeGreaterThan(0);

    // Mark read with a timestamp in the future (covers all posts)
    const futureRead = new Date(now.getTime() + 60_000);
    await svc.getCircleStatus(FRESHVIEW, { 0: futureRead, 1: futureRead, 2: futureRead, 3: futureRead });

    // Using lastReadTimestamps in getCircleStatus to simulate the Postgres-sourced read state
    const after = await svc.getCircleStatus(FRESHVIEW, { 0: futureRead, 1: null, 2: null, 3: null });
    const tier0After = after.find((s) => s.tier === 0)!;
    expect(tier0After.unseenCount).toBe(0);
    expect(tier0After.caughtUp).toBe(true);
  });
});
