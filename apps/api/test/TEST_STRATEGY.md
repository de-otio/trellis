# Test Strategy for the Circles/Graph Redesign

Comprehensive testing plan for the entity-centric circles model with the Neo4j (AuraDB / local Docker) graph database.

**Goal**: 80%+ coverage on all new code. Tests are the safety net for a single-developer project -- debugging sessions that last days are unacceptable.

---

## 1. Unit Tests

### 1.1 What to Mock

The primary mock boundary is the **GraphService interface**. Handler unit tests mock `GraphService` the same way they currently mock Prisma -- with `vi.fn()` implementations that return controlled data.

| Dependency | Mock Strategy | Rationale |
|-----------|---------------|-----------|
| `GraphService` | Full mock (all methods are `vi.fn()`) | Handlers should never touch the graph directly |
| `PrismaClient` | Full mock (existing pattern) | Same as current approach |
| `SessionManager` | Mock `getSession` returning a test session | Same as current approach |
| `SecurityHeaders` | Pass-through mock (same as current) | Same as current approach |
| `RateLimiter` | Mock `checkRateLimitKV` returning `{ allowed: true }` | Same as current approach |
| `Neo4j Driver` | **Never mocked in unit tests** -- unit tests use GraphService mock, not the driver | GraphService integration tests test the driver |

### 1.2 New Handler Unit Tests

Each new handler gets a test file in `test/unit/`:

| Handler | Test File | Key Test Cases |
|---------|-----------|---------------|
| `RelationshipHandler` | `relationship-handler.test.ts` | Create/remove relationship, score update, rate limiting, already-exists error, self-relationship rejection |
| `CircleHandler` | `circle-handler.test.ts` | Get tier members, get visible posts, glance mode (one per entity), depth mode (entity filter), caught-up state, empty circle |
| `EntityDiscoveryHandler` | `entity-discovery-handler.test.ts` | Hop-based discovery, nearby discovery, filter application, empty results, pagination |
| `ConnectionCodeHandler` | `connection-code-handler.test.ts` | Code generation, code redemption, expired code, already-used code |
| `PostHandler` (updated) | `post-handler-circles.test.ts` | Post with PostSubject, radius enforcement, dual-write call verification, entity-free post fallback |
| `EntityHandler` (updated) | `entity-handler-ownership.test.ts` | Co-ownership CRUD, ownership transfer, caretaker permissions, primary owner constraints |
| `EntityRelationshipHandler` | `entity-relationship-handler.test.ts` | Create/confirm/reject typed relationships, confirmation required check, self-relationship rejection |
| `ScoringEngine` (pure logic) | `scoring-engine.test.ts` | Entity scoring formula, user scoring formula, decay calculation, owned-entity auto-pin, weight application, clamp bounds |

### 1.3 Unit Test Pattern (GraphService Mock)

Follow the existing vi.mock pattern. Example skeleton:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../src/lib/session-manager";

// Mock GraphService
const mockGraphService = {
  getCircleMembers: vi.fn(),
  getVisiblePostIds: vi.fn(),
  createRelationship: vi.fn(),
  removeRelationship: vi.fn(),
  updateScore: vi.fn(),
  getRelationships: vi.fn(),
  recordInteraction: vi.fn(),
  syncUser: vi.fn(),
  syncEntity: vi.fn(),
  syncPost: vi.fn(),
  syncPostSubjects: vi.fn(),
  syncOwnership: vi.fn(),
  discoverEntities: vi.fn(),
  discoverNearby: vi.fn(),
};

vi.mock("../../src/lib/graph/graph-service", () => ({
  GraphService: vi.fn(() => mockGraphService),
  createGraphService: vi.fn(() => mockGraphService),
}));

// Mock Prisma (existing pattern)
const mockPrisma = {
  post: { findMany: vi.fn(), create: vi.fn() },
  entity: { findUnique: vi.fn() },
  postSubject: { createMany: vi.fn() },
  entityOwnership: { findMany: vi.fn() },
  circleReadState: { findUnique: vi.fn(), upsert: vi.fn() },
};

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

describe("CircleHandler", () => {
  let mockSession: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = {
      userId: "user-alice",
      email: "alice@test.com",
      role: "END_USER",
      expiresAt: Date.now() + 3600000,
    };
  });

  // tests...
});
```

### 1.4 Coverage Targets

| Category | Target | Notes |
|----------|--------|-------|
| New handlers | 90%+ | These are the critical safety net |
| GraphService implementation | 85%+ | Cypher query paths, error handling, retry logic |
| Scoring engine | 95%+ | Pure computation, no excuses for low coverage |
| Dual-write middleware | 85%+ | All failure modes tested |
| Circle query logic | 90%+ | This is the most complex new code |

Overall new-code target: 80%+ as stated in CLAUDE.md, with the above per-component targets as aspirational.

---

## 2. Integration Tests

### 2.1 Neo4j Test Container Setup

Integration tests run against a real Neo4j instance (the Docker Compose `neo4j` service). The test setup:

1. **Before all tests**: Connect to Neo4j at `bolt://localhost:7687`, verify connectivity
2. **Before each test**: Clear the graph (`MATCH (n) DETACH DELETE n`) and re-seed with the standard test graph (see Section 5)
3. **After all tests**: Close the Neo4j driver connection

**Test setup file**: `test/integration/graph-setup.ts`

```typescript
// Skeleton -- actual implementation in Phase 1
import neo4j from "neo4j-driver";

let driver: neo4j.Driver;

export async function setupGraphTests() {
  driver = neo4j.driver(
    process.env.NEO4J_URI || "bolt://localhost:7687",
    neo4j.auth.basic("neo4j", process.env.NEO4J_PASSWORD || "test-password"),
  );
  await driver.verifyConnectivity();
}

export async function resetGraph() {
  const session = driver.session();
  try {
    await session.run("MATCH (n) DETACH DELETE n");
    // Re-seed from graph-seed.ts fixture
  } finally {
    await session.close();
  }
}

export async function teardownGraphTests() {
  await driver.close();
}

export function getDriver() {
  return driver;
}
```

### 2.2 Postgres Test Setup

Postgres integration tests use the existing Docker Compose `postgres` service. The setup follows the existing pattern: Prisma client connected to `postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev`.

For dual-write tests, both databases must be running.

### 2.3 GraphService Integration Tests

Located in `test/integration/graph/`. These test the actual GraphService against a real Neo4j instance.

| Test File | What It Tests |
|-----------|--------------|
| `graph-service-relationships.integration.test.ts` | CRUD on RELATES_TO edges, score updates, tier recalculation |
| `graph-service-circles.integration.test.ts` | Circle member queries, visible post ID queries, tier thresholds |
| `graph-service-discovery.integration.test.ts` | Hop-based discovery, nearby discovery, filter combinations |
| `graph-service-scoring.integration.test.ts` | Interaction recording, score recomputation, decay |
| `graph-service-sync.integration.test.ts` | Node sync (user, entity, post), edge sync (PostSubject, ownership) |
| `graph-service-entity-relationships.integration.test.ts` | Typed entity-entity edges (PACK_MATE, SIBLING, etc.) |

### 2.4 Dual-Write Integration Tests

These verify that Postgres and Neo4j stay in sync. Located in `test/integration/dual-write/`.

| Test Case | Scenario |
|-----------|----------|
| Post creation | Create post in Postgres, verify Post node + ABOUT edges exist in Neo4j |
| Entity creation | Create entity in Postgres, verify Entity node exists in Neo4j with correct properties |
| EntityOwnership creation | Create ownership in Postgres, verify OWNS edge exists in Neo4j |
| PostSubject creation | Create PostSubject in Postgres, verify ABOUT edge exists in Neo4j |
| Neo4j failure + retry | Postgres write succeeds, Neo4j write fails, verify retry mechanism enqueues sync |
| Neo4j recovery | After simulated failure, verify sync catches up |
| Consistency check | Seed both databases, verify node/edge counts match |

### 2.5 Integration Test Environment Guard

Integration tests that need Neo4j or Postgres should skip gracefully if the service is unavailable, matching the existing pattern in `test/utils/test-environment-guard.ts`:

```typescript
export async function requireNeo4j(): Promise<boolean> {
  try {
    const driver = neo4j.driver("bolt://localhost:7687", neo4j.auth.basic("neo4j", "test-password"));
    await driver.verifyConnectivity();
    await driver.close();
    return true;
  } catch {
    console.warn("[test] Neo4j not available -- skipping graph integration tests");
    return false;
  }
}
```

---

## 3. E2E Tests

### 3.1 Key User Journeys

E2E tests run against a deployed API (local or remote). Located in `test/e2e/`. These test the full HTTP flow including auth, handlers, database, and graph.

| Journey | Test File | Description |
|---------|-----------|------------|
| **Relationship lifecycle** | `relationships.test.ts` | Create relationship, verify circle membership, remove relationship, verify removal |
| **Circle view** | `circle-view.test.ts` | Create posts with subjects, query circle view, verify correct posts appear per tier |
| **Posting radius** | `posting-radius.test.ts` | Post with WHISPER/NORMAL/LOUD/SHOUT radius, verify visibility boundaries |
| **Entity ownership** | `entity-ownership.test.ts` | Create entity, add co-owner, verify both see entity in inner circle, transfer primary |
| **Discovery** | `entity-discovery.test.ts` | Create entity relationships, discover via hops, discover nearby |
| **Connection codes** | `connection-codes.test.ts` | Generate code for entity, other user redeems code, verify relationship created |
| **Glance mode** | `glance-mode.test.ts` | Multiple entities with posts, verify one-per-entity summary |
| **Depth mode** | `depth-mode.test.ts` | Enter depth mode for entity, verify only that entity's posts |
| **Entity relationships** | `entity-relationships.test.ts` | Create PACK_MATE/SIBLING, confirm from other user, verify in graph |
| **Caught-up state** | `caught-up.test.ts` | Read circle, verify caught-up, new post appears, verify no longer caught-up |

### 3.2 Circle Visibility Test Matrix

The most critical E2E test is the **circle visibility matrix**. This tests the dual-gated filtering logic from `analysis/redesign/06-entities-over-people/03-entity-centric-circles.md`.

**Setup**: 4 users (Alice, Bob, Carol, Dave), 3 entities (Bunsen, Beaker, Luna).

| # | Scenario | Post | Radius | Viewer | Viewer's Best Relationship | Expected |
|---|----------|------|--------|--------|---------------------------|----------|
| 1 | Entity path, inner circle | Alice posts about Bunsen | NORMAL (0-1) | Bob (Bunsen in tier 0) | tier 0 via Bunsen | **Visible** |
| 2 | Author path, close friends | Alice posts about Bunsen | NORMAL (0-1) | Carol (Alice in tier 1, no rel with Bunsen) | tier 1 via Alice | **Visible** |
| 3 | Entity path, too far | Alice posts about Bunsen | NORMAL (0-1) | Dave (Bunsen in tier 2) | tier 2 via Bunsen | **Not visible** |
| 4 | No relationship | Alice posts about Bunsen | SHOUT (0-3) | Eve (no relationships) | none | **Not visible** |
| 5 | Whisper, inner only | Alice posts about Bunsen | WHISPER (0 only) | Bob (Bunsen in tier 0) | tier 0 via Bunsen | **Visible** |
| 6 | Whisper, close friend excluded | Alice posts about Bunsen | WHISPER (0 only) | Carol (Alice in tier 1) | tier 1 via Alice | **Not visible** |
| 7 | Multi-entity, best wins | Alice posts about Bunsen + Beaker | NORMAL (0-1) | Bob (Bunsen tier 0, Beaker tier 2) | tier 0 via Bunsen | **Visible** (best relationship) |
| 8 | Entity-free post | Alice posts (no entity) | NORMAL (0-1) | Carol (Alice in tier 1) | tier 1 via Alice | **Visible** |
| 9 | Entity-free, too far | Alice posts (no entity) | WHISPER (0 only) | Carol (Alice in tier 1) | tier 1 via Alice | **Not visible** |
| 10 | Owned entity auto-pin | Alice owns Luna, Bob posts about Luna | NORMAL (0-1) | Alice (owns Luna, tier 0) | tier 0 via Luna (owned) | **Visible** |
| 11 | Shout reaches ambient | Alice posts about Bunsen | SHOUT (0-3) | Frank (Bunsen in tier 3) | tier 3 via Bunsen | **Visible** |
| 12 | Loud reaches community | Alice posts about Bunsen | LOUD (0-2) | Dave (Bunsen in tier 2) | tier 2 via Bunsen | **Visible** |

### 3.3 Radius Mapping

For reference, the radius-to-tier reach mapping tested above:

| Radius | Reaches Tiers |
|--------|--------------|
| WHISPER | 0 only (inner circle) |
| NORMAL | 0-1 (inner + close friends) |
| LOUD | 0-2 (inner + close + community) |
| SHOUT | 0-3 (all tiers including ambient) |

---

## 4. Regression Protection

### 4.1 Tests to Keep (Unmodified)

These tests cover functionality unaffected by the redesign:

- All auth tests (`session-manager.test.ts`, `oauth.test.ts`, etc.)
- All media tests (`media-handler.test.ts`, `media-metadata-extractor.test.ts`)
- All moderation/safety tests (`link-security-handler.test.ts`, `recaptcha.test.ts`, `border-safety-mode.*`)
- All taxonomy tests (`entity-tagging-validator.test.ts`, `product-taxonomy-tags.test.ts`)
- All encryption/crypto tests (`encryption-key-service.test.ts`, `crypto/voting/*`)
- All DM/notification tests
- All admin/GDPR tests
- All middleware tests (`rate-limit.test.ts`, `csrf.test.ts`, `cors.test.ts`)
- Infrastructure tests (`dynamodb-kv.test.ts`, `database-connection-manager*.test.ts`)
- B2B tests (badges, brands, campaigns)

### 4.2 Tests to Modify

These tests use Follow/Friendship concepts that are being replaced:

| Current Test | Change |
|-------------|--------|
| `followers-handler.test.ts` | **Replace** with `relationship-handler.test.ts` |
| `followers-handler-performance.test.ts` | **Replace** with scoring/relationship perf tests |
| `followers-events.test.ts` | **Replace** with relationship event tests |
| `followers/count-updates.test.ts` | **Remove** (no follower counts in new model) |
| `friends-handler.test.ts` | **Remove** (friends concept removed) |
| `feed-handler.test.ts` | **Modify** to use circle-based content delivery |
| `feed-pagination.test.ts` | **Modify** to use circle cursor pagination |
| `feed-query-structure.test.ts` | **Replace** with circle query structure tests |
| `feed-rate-limit.test.ts` | **Keep** (rate limiting still applies) |
| `post-handler.test.ts` | **Modify** to include PostSubject + radius + dual-write |
| `post-handler-extended.test.ts` | **Modify** same as above |
| `entity-handler.test.ts` | **Modify** to include ownership model |
| `entity-handler-extended.test.ts` | **Modify** same as above |

### 4.3 E2E Tests to Modify/Replace

| Current E2E Test | Change |
|-----------------|--------|
| `friends-followers.test.ts` | **Replace** with `relationships.test.ts` + `circle-view.test.ts` |
| `feed.test.ts` | **Modify** to test circle-based feed delivery |
| `entity-crud.test.ts` | **Modify** to include ownership fields |
| `content-discovery.test.ts` | **Modify** to use graph-based discovery |

### 4.4 Regression Gate

Before any PR is merged, the following must pass:

1. All unit tests (`npm test -- test/unit/`)
2. All kept/modified integration tests
3. TypeScript compilation (`npx tsc --noEmit`)
4. Vitest coverage threshold (80% overall)

---

## 5. Test Data Fixtures

### 5.1 Standard Test Graph

The canonical test graph is defined in `test/fixtures/graph-seed.ts`. It contains:

- **6 users**: Alice, Bob, Carol, Dave, Eve, Frank (with varied roles)
- **5 entities (dogs)**: Bunsen, Beaker, Luna, Max, Rocky
- **Ownership**: Alice owns Bunsen + Beaker; Bob owns Luna; Carol owns Max; Dave owns Rocky
- **User-entity relationships**: At varied scores/tiers to cover all visibility scenarios
- **User-user relationships**: A few human connections for author-path testing
- **Entity-entity relationships**: PACK_MATE (Bunsen-Beaker), SIBLING (Luna-Max), PLAYMATE (Bunsen-Rocky)
- **Posts**: At various radii (WHISPER, NORMAL, LOUD, SHOUT) with PostSubject links
- **Edge cases**: Entity with no relationships, user with no relationships, post with no entity subject

See `test/fixtures/graph-seed.ts` for the full TypeScript interface definition.

### 5.2 Fixture Design Principles

1. **Deterministic**: No random data. All IDs, scores, and timestamps are fixed.
2. **Minimal**: Just enough data to cover all test matrix scenarios. Not a load test dataset.
3. **Documented**: Every fixture entity has a comment explaining its purpose in the test matrix.
4. **Reusable**: Both integration and E2E tests reference the same fixture definitions.
5. **Layered**: Base fixtures (nodes) can be loaded independently of relationship fixtures (edges).

### 5.3 Fixture Loading

Two loading paths:

- **Integration tests (direct)**: Load fixtures via the Neo4j driver directly (`session.run(cypher)`)
- **E2E tests (API)**: Load fixtures via API calls (create users, create entities, create relationships)

Both paths produce the same logical graph. The integration path is faster; the E2E path validates the API.

---

## 6. Performance Benchmarks

### 6.1 Queries to Benchmark

| Query | Target Latency (p95) | Condition |
|-------|---------------------|-----------|
| Circle view (tier 0, 50 posts) | < 100ms | Standard test graph (~50 nodes, ~200 edges) |
| Circle view (tier 0, 50 posts) | < 500ms | Load test graph (~10k nodes, ~50k edges) |
| Circle members (single tier) | < 50ms | Standard test graph |
| Discovery (2-hop) | < 200ms | Standard test graph |
| Nearby discovery (geo) | < 150ms | Standard test graph |
| Score recomputation (single user) | < 100ms | Standard test graph |
| Dual-write (post creation) | < 200ms | Total: Postgres + Neo4j |
| Relationship creation | < 100ms | Single edge write |

### 6.2 How to Run Benchmarks

Benchmarks are **not** part of the standard test suite. They run on-demand:

```bash
# Run performance benchmarks (requires Docker Compose running)
npm run test:perf
```

This maps to a vitest config that includes only `test/performance/*.bench.ts` files.

### 6.3 Benchmark Implementation

Use vitest's built-in `bench` function:

```typescript
import { bench, describe } from "vitest";

describe("Circle Query Performance", () => {
  bench("tier 0 view, 50 posts", async () => {
    await graphService.getVisiblePostIds("user-alice", 0, new Date(0), 50);
  }, { iterations: 100 });
});
```

### 6.4 Load Test Graph

For realistic benchmarks, a separate fixture generates a larger graph:

- 1,000 users
- 5,000 entities
- 50,000 relationships (varied scores/tiers)
- 20,000 posts with PostSubject links
- Realistic score distribution (power-law: most relationships low-score, few high-score)

This fixture is defined in `test/fixtures/graph-load-seed.ts` and is only used by performance benchmarks. It is **not** loaded in standard tests.

### 6.5 When to Run

- Before merging any PR that changes GraphService query logic
- Before merging any PR that changes circle query Cypher
- Weekly during active development (via CI schedule, optional)
- After any Neo4j version upgrade (local or AuraDB)

---

## 7. Test Execution Constraints

### 7.1 Memory

Tests run in foreground only (never background). Each vitest worker can consume 4GB+ RAM with Prisma + Neo4j driver. The vitest config limits workers:

```typescript
poolOptions: {
  threads: {
    minThreads: 1,
    maxThreads: 2,
  },
},
```

Graph integration tests should run with `maxThreads: 1` to avoid Neo4j connection pool exhaustion.

### 7.2 Docker Dependencies

| Test Category | Requires |
|--------------|----------|
| Unit tests | Nothing (all mocked) |
| Graph integration tests | Neo4j (`docker compose up neo4j`) |
| Dual-write integration tests | Neo4j + Postgres (`docker compose up neo4j postgres`) |
| E2E tests | Full stack (`docker compose up`) + running API |
| Performance benchmarks | Neo4j (`docker compose up neo4j`) |

### 7.3 CI Pipeline

```
1. npm install
2. docker compose up -d postgres neo4j dynamodb
3. Wait for health checks
4. npx prisma migrate deploy
5. npm test                          # Unit + included integration
6. npm run test:integration:graph    # Graph integration (separate config)
7. npm run test:coverage             # Coverage report + threshold check
```

E2E tests and performance benchmarks run post-deployment, not in CI pre-merge.

### 7.4 Neo4j Test Isolation

Each integration test file gets a clean graph state. Between test files:

```typescript
beforeAll(async () => {
  await setupGraphTests();
  await resetGraph();    // MATCH (n) DETACH DELETE n + re-seed
});

afterAll(async () => {
  await teardownGraphTests();
});
```

Within a test file, tests that modify the graph should either:
- Use `beforeEach(() => resetGraph())` if they need clean state per test
- Or explicitly clean up their modifications in `afterEach`

The `MATCH (n) DETACH DELETE n` approach is acceptable at test scale (<100 nodes). For performance benchmarks with the load test graph, use a separate database or skip cleanup.

---

## 8. Vitest Configuration Updates

### 8.1 Main Config (`vitest.config.ts`)

Add graph integration test exclusions (they get their own config):

```typescript
exclude: [
  "test/e2e/**/*.test.ts",
  "test/integration/postdeployment/**/*.test.ts",
  "test/integration/graph/**/*.test.ts",       // NEW: separate config
  "test/performance/**/*.bench.ts",             // NEW: benchmarks
  // ... existing exclusions
],
```

### 8.2 Graph Integration Config (`vitest.config.graph.ts`)

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/integration/graph/**/*.test.ts"],
    setupFiles: ["test/setup.ts", "test/integration/graph-setup.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: "threads",
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 1,   // Single-threaded for Neo4j
      },
    },
  },
});
```

### 8.3 Performance Config (`vitest.config.perf.ts`)

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/performance/**/*.bench.ts"],
    setupFiles: ["test/setup.ts", "test/integration/graph-setup.ts"],
    testTimeout: 120000,
    pool: "threads",
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 1,
      },
    },
  },
});
```

---

## 9. Directory Structure (New Files)

```
test/
  fixtures/
    graph-seed.ts                    # Standard test graph definition
    graph-load-seed.ts               # Load test graph (benchmarks only)
  integration/
    graph-setup.ts                   # Neo4j connection setup/teardown
    graph/
      graph-service-relationships.integration.test.ts
      graph-service-circles.integration.test.ts
      graph-service-discovery.integration.test.ts
      graph-service-scoring.integration.test.ts
      graph-service-sync.integration.test.ts
      graph-service-entity-relationships.integration.test.ts
    dual-write/
      post-dual-write.integration.test.ts
      entity-dual-write.integration.test.ts
      ownership-dual-write.integration.test.ts
      failure-recovery.integration.test.ts
  unit/
    relationship-handler.test.ts
    circle-handler.test.ts
    entity-discovery-handler.test.ts
    connection-code-handler.test.ts
    post-handler-circles.test.ts
    entity-handler-ownership.test.ts
    entity-relationship-handler.test.ts
    scoring-engine.test.ts
    dual-write-middleware.test.ts
    graph-service-mock.test.ts        # Tests for the mock itself (sanity)
  e2e/
    relationships.test.ts
    circle-view.test.ts
    posting-radius.test.ts
    entity-ownership.test.ts
    entity-discovery.test.ts
    connection-codes.test.ts
    glance-mode.test.ts
    depth-mode.test.ts
    entity-relationships.test.ts
    caught-up.test.ts
  performance/
    circle-query.bench.ts
    discovery-query.bench.ts
    scoring-computation.bench.ts
    dual-write-throughput.bench.ts
```
