/**
 * Graph Seed Fixture — Type Definitions + Standard Test Graph
 *
 * Defines the shape of the test graph and the canonical seed data used by
 * both integration tests (loaded via Neo4j driver) and E2E tests (loaded via API).
 *
 * Design principles:
 *   - Deterministic: all IDs, scores, timestamps are fixed constants
 *   - Minimal: just enough to cover every visibility scenario in the test matrix
 *   - Documented: every entity explains its purpose in the test plan
 *
 * This file is TYPES + DATA ONLY — no database driver imports, no side effects.
 * Loaders (integration/graph-setup.ts, e2e utils) import the data and
 * translate it into Cypher statements or API calls.
 */

// ---------------------------------------------------------------------------
// Enums (mirror the application enums — keep in sync)
// ---------------------------------------------------------------------------

export type PostRadius = "WHISPER" | "NORMAL" | "LOUD" | "SHOUT";

export type OwnershipRole = "PRIMARY_OWNER" | "CO_OWNER" | "CARETAKER";

export type EntityRelationshipType =
  | "PACK_MATE"
  | "SIBLING"
  | "PLAYMATE"
  | "PARENT"
  | "OFFSPRING"
  | "WALK_BUDDY";

export type ConnectionMethod =
  | "discovery"
  | "code"
  | "search"
  | "friend"
  | "system";

export type UserRole = "END_USER" | "ADMIN";

/**
 * Circle tier — lower number = closer relationship.
 *   0 = inner circle
 *   1 = close friends
 *   2 = community
 *   3 = ambient
 */
export type CircleTier = 0 | 1 | 2 | 3;

/**
 * Radius reach — maps a PostRadius to the maximum tier it can reach.
 *   WHISPER  → 0  (inner circle only)
 *   NORMAL   → 1  (inner + close friends)
 *   LOUD     → 2  (+ community)
 *   SHOUT    → 3  (all tiers)
 */
export const RADIUS_MAX_TIER: Record<PostRadius, CircleTier> = {
  WHISPER: 0,
  NORMAL: 1,
  LOUD: 2,
  SHOUT: 3,
};

// ---------------------------------------------------------------------------
// Node shapes
// ---------------------------------------------------------------------------

export interface TestUser {
  /** Stable test ID — e.g. "user-alice" */
  id: string;
  /**
   * Email is NOT synced to the graph — it exists here only for
   * Postgres test data setup. Graph seed loaders must omit it.
   */
  email: string;
  role: UserRole;
  /** Human-readable label for test output */
  label: string;
}

export interface TestEntity {
  id: string;
  entityType: string;
  name: string;
  breed: string;
  lifeStage: string;
  /** Latitude for geo-discovery tests (nullable if no location) */
  lat: number | null;
  /** Longitude for geo-discovery tests (nullable if no location) */
  lng: number | null;
  label: string;
}

export interface TestPost {
  id: string;
  authorId: string;
  radius: PostRadius;
  /** ISO-8601 timestamp string */
  createdAt: string;
  /** Human-readable description for test output */
  label: string;
}

// ---------------------------------------------------------------------------
// Edge shapes
// ---------------------------------------------------------------------------

/** User→Entity or User→User scored relationship (RELATES_TO edge) */
export interface TestRelationship {
  userId: string;
  targetType: "entity" | "user";
  targetId: string;
  score: number;
  tier: CircleTier;
  interactionCount: number;
  connectionMethod: ConnectionMethod;
  label: string;
}

/** User→Entity ownership (OWNS edge) */
export interface TestOwnership {
  userId: string;
  entityId: string;
  role: OwnershipRole;
  label: string;
}

/** Entity→Entity typed relationship */
export interface TestEntityRelationship {
  entityId: string;
  relatedEntityId: string;
  type: EntityRelationshipType;
  label: string;
}

/** Post→Entity subject link (ABOUT edge) */
export interface TestPostSubject {
  postId: string;
  entityId: string;
  isPrimary: boolean;
  label: string;
}

// ---------------------------------------------------------------------------
// Complete graph shape
// ---------------------------------------------------------------------------

export interface TestGraphSeed {
  users: TestUser[];
  entities: TestEntity[];
  posts: TestPost[];
  relationships: TestRelationship[];
  ownerships: TestOwnership[];
  entityRelationships: TestEntityRelationship[];
  postSubjects: TestPostSubject[];
}

// ---------------------------------------------------------------------------
// Standard Test Graph — the canonical fixture
// ---------------------------------------------------------------------------

// --- Users ----------------------------------------------------------------

/** Alice: main content creator, owns Bunsen + Beaker */
const alice: TestUser = {
  id: "user-alice",
  email: "alice@test.com",
  role: "END_USER",
  label: "Alice — primary poster, owns Bunsen + Beaker",
};

/** Bob: engaged follower, owns Luna, inner-circle with Bunsen */
const bob: TestUser = {
  id: "user-bob",
  email: "bob@test.com",
  role: "END_USER",
  label: "Bob — owns Luna, follows Bunsen closely",
};

/** Carol: moderate engagement, follows Alice (human), owns Max */
const carol: TestUser = {
  id: "user-carol",
  email: "carol@test.com",
  role: "END_USER",
  label: "Carol — follows Alice (author path), owns Max",
};

/** Dave: distant observer, community-tier with Bunsen, owns Rocky */
const dave: TestUser = {
  id: "user-dave",
  email: "dave@test.com",
  role: "END_USER",
  label: "Dave — community/ambient tier, owns Rocky",
};

/** Eve: no relationships at all — tests zero-relationship edge case */
const eve: TestUser = {
  id: "user-eve",
  email: "eve@test.com",
  role: "END_USER",
  label: "Eve — no relationships (isolation test)",
};

/** Frank: admin user for admin-path testing */
const frank: TestUser = {
  id: "user-frank",
  email: "frank@test.com",
  role: "ADMIN",
  label: "Frank — admin user",
};

// --- Entities (Dogs) ------------------------------------------------------

/** Bunsen: Alice's primary dog, the main subject in visibility tests */
const bunsen: TestEntity = {
  id: "entity-bunsen",
  entityType: "dog",
  name: "Bunsen",
  breed: "Bernese Mountain Dog",
  lifeStage: "ADULT",
  lat: 48.2082,
  lng: 16.3738,
  label: "Bunsen — Alice's dog, primary visibility test subject",
};

/** Beaker: Alice's second dog, pack mate of Bunsen */
const beaker: TestEntity = {
  id: "entity-beaker",
  entityType: "dog",
  name: "Beaker",
  breed: "Bernese Mountain Dog",
  lifeStage: "ADULT",
  lat: 48.2082,
  lng: 16.3738,
  label: "Beaker — Alice's second dog, PACK_MATE with Bunsen",
};

/** Luna: Bob's dog, sibling of Max, used for multi-entity post tests */
const luna: TestEntity = {
  id: "entity-luna",
  entityType: "dog",
  name: "Luna",
  breed: "Golden Retriever",
  lifeStage: "PUPPY",
  lat: 48.1951,
  lng: 16.3671,
  label: "Luna — Bob's dog, SIBLING of Max",
};

/** Max: Carol's dog, sibling of Luna */
const max: TestEntity = {
  id: "entity-max",
  entityType: "dog",
  name: "Max",
  breed: "Golden Retriever",
  lifeStage: "PUPPY",
  lat: 48.2100,
  lng: 16.3600,
  label: "Max — Carol's dog, SIBLING of Luna",
};

/** Rocky: Dave's dog, PLAYMATE of Bunsen, used for discovery hop tests */
const rocky: TestEntity = {
  id: "entity-rocky",
  entityType: "dog",
  name: "Rocky",
  breed: "Labrador Retriever",
  lifeStage: "ADULT",
  lat: 48.2200,
  lng: 16.3900,
  label: "Rocky — Dave's dog, PLAYMATE of Bunsen (discovery hop target)",
};

// --- Ownerships -----------------------------------------------------------

const ownerships: TestOwnership[] = [
  {
    userId: "user-alice",
    entityId: "entity-bunsen",
    role: "PRIMARY_OWNER",
    label: "Alice owns Bunsen (primary)",
  },
  {
    userId: "user-alice",
    entityId: "entity-beaker",
    role: "PRIMARY_OWNER",
    label: "Alice owns Beaker (primary)",
  },
  {
    userId: "user-bob",
    entityId: "entity-luna",
    role: "PRIMARY_OWNER",
    label: "Bob owns Luna (primary)",
  },
  {
    userId: "user-carol",
    entityId: "entity-max",
    role: "PRIMARY_OWNER",
    label: "Carol owns Max (primary)",
  },
  {
    userId: "user-dave",
    entityId: "entity-rocky",
    role: "PRIMARY_OWNER",
    label: "Dave owns Rocky (primary)",
  },
];

// --- User→Entity and User→User Relationships -----------------------------

/**
 * Score thresholds for tiers (used in assertions):
 *   tier 0 (inner):   score >= 0.75
 *   tier 1 (close):   0.50 <= score < 0.75
 *   tier 2 (community): 0.25 <= score < 0.50
 *   tier 3 (ambient):  0.01 <= score < 0.25
 *
 * These thresholds are test assumptions. The real thresholds are configured
 * in CircleConfig (Prisma). The seed data scores are chosen to land in
 * specific tiers given these thresholds.
 */
const relationships: TestRelationship[] = [
  // --- Bob's relationships ---
  {
    userId: "user-bob",
    targetType: "entity",
    targetId: "entity-bunsen",
    score: 0.90,
    tier: 0,
    interactionCount: 42,
    connectionMethod: "discovery",
    label: "Bob→Bunsen: inner circle (tier 0) — visibility test case #1",
  },
  {
    userId: "user-bob",
    targetType: "entity",
    targetId: "entity-beaker",
    score: 0.30,
    tier: 2,
    interactionCount: 5,
    connectionMethod: "discovery",
    label: "Bob→Beaker: community (tier 2) — multi-entity best-wins test #7",
  },

  // --- Carol's relationships ---
  {
    userId: "user-carol",
    targetType: "user",
    targetId: "user-alice",
    score: 0.60,
    tier: 1,
    interactionCount: 15,
    connectionMethod: "code",
    label: "Carol→Alice: close friends (tier 1) — author-path test case #2",
  },

  // --- Dave's relationships ---
  {
    userId: "user-dave",
    targetType: "entity",
    targetId: "entity-bunsen",
    score: 0.35,
    tier: 2,
    interactionCount: 8,
    connectionMethod: "search",
    label: "Dave→Bunsen: community (tier 2) — too-far test #3, LOUD reach test #12",
  },

  // --- Alice's relationships (she also follows other entities) ---
  {
    userId: "user-alice",
    targetType: "entity",
    targetId: "entity-luna",
    score: 0.55,
    tier: 1,
    interactionCount: 10,
    connectionMethod: "friend",
    label: "Alice→Luna: close friends (tier 1) — owned-entity auto-pin test context",
  },

  // --- Frank's relationships (admin, ambient tier for SHOUT test) ---
  {
    userId: "user-frank",
    targetType: "entity",
    targetId: "entity-bunsen",
    score: 0.10,
    tier: 3,
    interactionCount: 2,
    connectionMethod: "search",
    label: "Frank→Bunsen: ambient (tier 3) — SHOUT reach test case #11",
  },
];

// --- Entity→Entity Relationships ------------------------------------------

const entityRelationships: TestEntityRelationship[] = [
  {
    entityId: "entity-bunsen",
    relatedEntityId: "entity-beaker",
    type: "PACK_MATE",
    label: "Bunsen↔Beaker: pack mates (same household, same owner)",
  },
  {
    entityId: "entity-luna",
    relatedEntityId: "entity-max",
    type: "SIBLING",
    label: "Luna↔Max: siblings (same litter, different owners)",
  },
  {
    entityId: "entity-bunsen",
    relatedEntityId: "entity-rocky",
    type: "PLAYMATE",
    label: "Bunsen↔Rocky: playmates (discovery hop test — 1 hop from Bunsen to Rocky)",
  },
];

// --- Posts ----------------------------------------------------------------

/** Base timestamp: 2026-04-01T12:00:00Z. Posts are offset from this. */
const BASE_TS = "2026-04-01T12:00:00.000Z";

function offsetHours(hours: number): string {
  const d = new Date(BASE_TS);
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

const posts: TestPost[] = [
  {
    id: "post-bunsen-normal",
    authorId: "user-alice",
    radius: "NORMAL",
    createdAt: offsetHours(1),
    label: "Alice posts about Bunsen, NORMAL radius — test cases #1, #2, #3",
  },
  {
    id: "post-bunsen-whisper",
    authorId: "user-alice",
    radius: "WHISPER",
    createdAt: offsetHours(2),
    label: "Alice posts about Bunsen, WHISPER radius — test cases #5, #6",
  },
  {
    id: "post-bunsen-beaker-normal",
    authorId: "user-alice",
    radius: "NORMAL",
    createdAt: offsetHours(3),
    label: "Alice posts about Bunsen+Beaker, NORMAL — multi-entity test case #7",
  },
  {
    id: "post-entityfree-normal",
    authorId: "user-alice",
    radius: "NORMAL",
    createdAt: offsetHours(4),
    label: "Alice posts without entity subject, NORMAL — test case #8",
  },
  {
    id: "post-entityfree-whisper",
    authorId: "user-alice",
    radius: "WHISPER",
    createdAt: offsetHours(5),
    label: "Alice posts without entity subject, WHISPER — test case #9",
  },
  {
    id: "post-luna-normal",
    authorId: "user-bob",
    radius: "NORMAL",
    createdAt: offsetHours(6),
    label: "Bob posts about Luna, NORMAL — owned-entity auto-pin test case #10",
  },
  {
    id: "post-bunsen-shout",
    authorId: "user-alice",
    radius: "SHOUT",
    createdAt: offsetHours(7),
    label: "Alice posts about Bunsen, SHOUT — ambient reach test case #11",
  },
  {
    id: "post-bunsen-loud",
    authorId: "user-alice",
    radius: "LOUD",
    createdAt: offsetHours(8),
    label: "Alice posts about Bunsen, LOUD — community reach test case #12",
  },
];

// --- Post Subjects --------------------------------------------------------

const postSubjects: TestPostSubject[] = [
  // post-bunsen-normal → about Bunsen
  {
    postId: "post-bunsen-normal",
    entityId: "entity-bunsen",
    isPrimary: true,
    label: "post-bunsen-normal is about Bunsen (primary)",
  },
  // post-bunsen-whisper → about Bunsen
  {
    postId: "post-bunsen-whisper",
    entityId: "entity-bunsen",
    isPrimary: true,
    label: "post-bunsen-whisper is about Bunsen (primary)",
  },
  // post-bunsen-beaker-normal → about Bunsen (primary) + Beaker
  {
    postId: "post-bunsen-beaker-normal",
    entityId: "entity-bunsen",
    isPrimary: true,
    label: "post-bunsen-beaker-normal is about Bunsen (primary)",
  },
  {
    postId: "post-bunsen-beaker-normal",
    entityId: "entity-beaker",
    isPrimary: false,
    label: "post-bunsen-beaker-normal is also about Beaker (secondary)",
  },
  // post-entityfree-normal → no subjects (entity-free post)
  // post-entityfree-whisper → no subjects (entity-free post)
  // post-luna-normal → about Luna
  {
    postId: "post-luna-normal",
    entityId: "entity-luna",
    isPrimary: true,
    label: "post-luna-normal is about Luna (primary) — owned entity test",
  },
  // post-bunsen-shout → about Bunsen
  {
    postId: "post-bunsen-shout",
    entityId: "entity-bunsen",
    isPrimary: true,
    label: "post-bunsen-shout is about Bunsen (primary)",
  },
  // post-bunsen-loud → about Bunsen
  {
    postId: "post-bunsen-loud",
    entityId: "entity-bunsen",
    isPrimary: true,
    label: "post-bunsen-loud is about Bunsen (primary)",
  },
];

// ---------------------------------------------------------------------------
// Exported seed
// ---------------------------------------------------------------------------

/**
 * The standard test graph. Import this in test setup files and translate
 * into Cypher (integration) or API calls (E2E).
 */
export const STANDARD_GRAPH_SEED: TestGraphSeed = {
  users: [alice, bob, carol, dave, eve, frank],
  entities: [bunsen, beaker, luna, max, rocky],
  posts,
  relationships,
  ownerships,
  entityRelationships,
  postSubjects,
};

/**
 * Tier score thresholds used by the standard test graph.
 * Tests should assert against these to verify circle resolution.
 */
export const TIER_THRESHOLDS = {
  /** Inner circle: score >= 0.75 */
  INNER: 0.75,
  /** Close friends: score >= 0.50 */
  CLOSE: 0.50,
  /** Community: score >= 0.25 */
  COMMUNITY: 0.25,
  /** Ambient: score >= 0.01 (anything above zero) */
  AMBIENT: 0.01,
} as const;

// ---------------------------------------------------------------------------
// Visibility test expectations
//
// Derived from TEST_STRATEGY.md Section 3.2 — the circle visibility matrix.
// Tests can import these and assert against them directly.
// ---------------------------------------------------------------------------

export interface VisibilityExpectation {
  /** Test case number from the matrix */
  caseNumber: number;
  postId: string;
  viewerId: string;
  /** Why this viewer does/doesn't see the post */
  reason: string;
  expected: "visible" | "not_visible";
}

export const VISIBILITY_EXPECTATIONS: VisibilityExpectation[] = [
  {
    caseNumber: 1,
    postId: "post-bunsen-normal",
    viewerId: "user-bob",
    reason: "Bob has Bunsen in tier 0; NORMAL reaches tier 0-1",
    expected: "visible",
  },
  {
    caseNumber: 2,
    postId: "post-bunsen-normal",
    viewerId: "user-carol",
    reason: "Carol has Alice in tier 1 (author path); NORMAL reaches tier 0-1",
    expected: "visible",
  },
  {
    caseNumber: 3,
    postId: "post-bunsen-normal",
    viewerId: "user-dave",
    reason: "Dave has Bunsen in tier 2; NORMAL only reaches tier 0-1",
    expected: "not_visible",
  },
  {
    caseNumber: 4,
    postId: "post-bunsen-shout",
    viewerId: "user-eve",
    reason: "Eve has no relationships at all",
    expected: "not_visible",
  },
  {
    caseNumber: 5,
    postId: "post-bunsen-whisper",
    viewerId: "user-bob",
    reason: "Bob has Bunsen in tier 0; WHISPER reaches tier 0 only",
    expected: "visible",
  },
  {
    caseNumber: 6,
    postId: "post-bunsen-whisper",
    viewerId: "user-carol",
    reason: "Carol has Alice in tier 1; WHISPER reaches tier 0 only",
    expected: "not_visible",
  },
  {
    caseNumber: 7,
    postId: "post-bunsen-beaker-normal",
    viewerId: "user-bob",
    reason: "Bob has Bunsen tier 0, Beaker tier 2; best relationship (tier 0) wins; NORMAL reaches 0-1",
    expected: "visible",
  },
  {
    caseNumber: 8,
    postId: "post-entityfree-normal",
    viewerId: "user-carol",
    reason: "Entity-free post; Carol has Alice in tier 1; NORMAL reaches 0-1",
    expected: "visible",
  },
  {
    caseNumber: 9,
    postId: "post-entityfree-whisper",
    viewerId: "user-carol",
    reason: "Entity-free post; Carol has Alice in tier 1; WHISPER reaches tier 0 only",
    expected: "not_visible",
  },
  {
    caseNumber: 10,
    postId: "post-luna-normal",
    viewerId: "user-alice",
    reason: "Alice follows Luna (tier 1); NORMAL reaches 0-1. Also: Alice auto-pin would give owned entities tier 0, but Alice doesn't own Luna — Bob does",
    expected: "visible",
  },
  {
    caseNumber: 11,
    postId: "post-bunsen-shout",
    viewerId: "user-frank",
    reason: "Frank has Bunsen in tier 3 (ambient); SHOUT reaches 0-3",
    expected: "visible",
  },
  {
    caseNumber: 12,
    postId: "post-bunsen-loud",
    viewerId: "user-dave",
    reason: "Dave has Bunsen in tier 2 (community); LOUD reaches 0-2",
    expected: "visible",
  },
];
