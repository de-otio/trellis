# Phase 2 — Graph Layer

> **COMPLETED — backend note (2026-06):** this plan was executed against the
> original Neo4j backend; the graph layer now runs on **Postgres**
> (`apps/api/src/lib/graph/postgres/`, graph-db revisit 2026-06). The task
> breakdown below remains the generic specification of the `GraphService`
> surface — read the `neo4j-graph-service.ts` output pointers as their
> `postgres/` per-group equivalents.

Implement the core graph operations. All tasks can run in parallel once Phase 1 is complete.

---

## P2.1 — Relationship CRUD

**Model**: Sonnet
**Dependencies**: P1.4 (GraphService skeleton)
**Repo**: Trellis

Implement relationship operations in GraphService:
- `createRelationship(userId, targetType, targetId, connectionMethod)` — creates `:RELATES_TO` edge with initial score based on connection method
- `removeRelationship(userId, targetType, targetId)` — deletes edge
- `updateRelationshipScore(userId, targetType, targetId, score | null)` (renamed from `updateManualScore` during implementation) — sets/clears manual override
- `getRelationship(userId, targetType, targetId)` — returns edge properties
- `getRelationships(userId, filters?)` — list relationships with optional tier/type filter
- `getRelationshipGraph(userId)` — full graph data for visualization

**Input docs**: the consuming vertical's scoring-without-reciprocity analysis (external), [`analysis/redesign/03-schema-design.md`](../../analysis/redesign/03-schema-design.md)
**Output**: Methods in `neo4j-graph-service.ts`, unit tests in `test/unit/graph/relationship-crud.test.ts`
**Verification**: All CRUD operations verified against local Neo4j, edge properties match schema

---

## P2.2 — Circle Resolution

**Model**: Opus
**Dependencies**: P0.3 (circle query optimization), P1.4 (GraphService skeleton)
**Repo**: Trellis

Implement circle resolution — the most critical query path:
- `getCircleMembers(userId, tier)` — entities and users in a specific tier
- `getVisiblePostIds(userId, tier, since, limit)` — dual-gated visibility query
- `getCircleStatus(userId)` — caught-up state per tier
- `getGlance(userId, tier, limit)` — per-entity snapshot for glance mode
- `markRead(userId, tier, lastReadPostId)` — update read state

Must handle dual-gating: post visible if viewer relates to subject entity OR author. Uses the optimized queries from P0.3.

**Input docs**: the consuming vertical's entity-centric-circles + graph-schema analyses (external)
**Output**: Methods in `neo4j-graph-service.ts`, unit tests with realistic graph data
**Verification**: Tests cover: single-entity post, multi-entity post, entity-path visibility, author-path visibility, radius filtering, caught-up computation

---

## P2.3 — Entity-to-Entity Relationships

**Model**: Sonnet
**Dependencies**: P1.4 (GraphService skeleton)
**Repo**: Trellis

Implement entity relationship operations. Relationship types are vertical-defined
(symmetric and asymmetric/complementary kinds); the examples below use neutral
placeholders:
- `createEntityRelationship(entityId, relatedId, type, initiatedByUserId)` — creates typed edge (e.g. a symmetric `PEER` type, an asymmetric `PARENT`/`CHILD` type, etc.)
- `confirmEntityRelationship(entityId, relatedId, type, confirmedByUserId)` — confirms pending relationship
- `removeEntityRelationship(entityId, relatedId, type)` — deletes edge
- `getEntityRelationships(entityId, type?)` — list entity's relationships
- Symmetry handling: a symmetric type creates bidirectional edges; an asymmetric type (PARENT/CHILD) creates a complementary pair
- Status tracking: PENDING → CONFIRMED / DECLINED

**Input docs**: the consuming vertical's entity-relationships analysis (external)
**Output**: Methods in `neo4j-graph-service.ts`, unit tests
**Verification**: Symmetry tested, confirmation flow tested, type-specific behavior verified

---

## P2.4 — Relationship Scoring Engine

**Model**: Opus
**Dependencies**: P2.1 (relationship CRUD)
**Repo**: Trellis

Implement the scoring computation:
- `recordInteraction(userId, targetType, targetId, interactionType)` — increment counters, update recency
- `recomputeScores(userId)` (renamed from `recomputeScore` + `recomputeAllScores` merged during implementation) — batch recompute all scores for background job
- Scoring formula implementation:
  - User→User: reciprocity-weighted (from [`analysis/redesign/02-new-core-primitives.md`](../../analysis/redesign/02-new-core-primitives.md))
  - User→Entity: engagement-depth-weighted (from the consuming vertical's scoring-without-reciprocity analysis, external)
- Auto-pin: owned entities always score 1.0
- Tier recomputation after score changes
- Decay: background-job-callable method to apply time decay

**Input docs**: the consuming vertical's scoring-without-reciprocity analysis (external), [`analysis/redesign/02-new-core-primitives.md`](../../analysis/redesign/02-new-core-primitives.md)
**Output**: `apps/api/src/lib/graph/scoring-engine.ts`, unit tests with time-based scenarios
**Verification**: Score formula matches analysis doc weights, decay tested with mocked time, auto-pin verified

---

## P2.5 — Entity Discovery Queries

**Model**: Sonnet
**Dependencies**: P1.4 (GraphService skeleton), P2.3 (entity relationships)
**Repo**: Trellis

Implement discovery queries in GraphService:
- `discoverByGraph(userId, hops, filters?)` (renamed from `discoverByRelationship` + `discoverByProperty` merged during implementation) — entities N hops from the user's entities, with metadata-property filtering (vertical-defined filter fields)
- `discoverNearby(lat, lng, radiusMeters, filters?)` — spatial query
- `getRecommendations(userId, limit)` — recommended entities based on graph patterns
- All discovery queries exclude entities already in the user's graph

**Input docs**: the consuming vertical's discovery-and-onboarding + graph-schema analyses (external)
**Output**: Methods in `neo4j-graph-service.ts`, unit tests
**Verification**: Multi-hop traversal tested, spatial queries tested with coordinate data, filters tested

---

## P2.6 — Graph Layer Integration Tests

**Model**: Sonnet
**Dependencies**: P2.1, P2.2, P2.3, P2.4, P2.5
**Repo**: Trellis

Integration tests that verify the graph layer works end-to-end against Neo4j:
- Seed a realistic graph (50 users, 200 entities, 2000 relationships, 500 posts)
- Test circle resolution with the seeded data
- Test discovery queries
- Test scoring recomputation
- Test dual-write consistency (create via Prisma, verify in Neo4j)
- Benchmark: circle view query should complete in <100ms on test data

**Output**: `apps/api/test/integration/graph/` directory with comprehensive test suite
**Verification**: All tests pass against Docker Neo4j, benchmark meets target
