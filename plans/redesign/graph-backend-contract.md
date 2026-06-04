# Graph backend contract

What the trellis core requires of *any* graph backend. This is the
backend-neutral specification: it defines the surface the core consumes and
the capability profile a backend must satisfy, so that **Postgres (recursive
CTEs or Apache AGE), Neptune, or Neo4j can all qualify**. It deliberately
states no vendor preference and no hosting/cost opinion — those are the
consuming deployment's decision (see `graph-backend-hosting-template.md` for
the generic selection/provisioning guide; the concrete decision for a
specific deployment lives in that deployment's own repo).

## Deployment boundary (why this doc is backend-neutral)

**Trellis is not deployed standalone.** The consuming deployment owns the
graph database — provisioning, credentials, cost, HA, backups — and the
trellis core only ever sees a **connection configuration via environment**.
At startup `createGraphServiceFromEnv()`
(`apps/api/src/lib/graph/graph-factory.ts`) resolves the connection config
(today: a credentials blob fetched from SSM by parameter name, never placed
in `process.env`) and hands it to a `GraphService` implementation. Handlers
**never** execute raw graph queries — they call `GraphService` methods that
return IDs, and content is then fetched from Postgres via Prisma.

Consequence: swapping the backend is an implementation detail behind
`GraphService`/`GraphConnection`. No handler, route, or test that consumes
the interface should need to change. The contract below is what a new
implementation must honour.

## The consumed surface

Source of truth: `apps/api/src/lib/graph/graph-service.ts` (the
`GraphService` + `GraphConnection` interfaces) and `./types.ts`. An
implementation must provide every method; the groups are:

| Group | Methods | Shape |
|---|---|---|
| Connection / health | `connect`, `close`, `isConnected`, `healthCheck` | lifecycle + `RETURN 1`-style probe |
| Relationships (user → user\|entity, scored) | `create/remove/update/get/getRelationships`, `getRelationshipGraph` | single-hop edge CRUD + per-user edge list |
| Circles (content views) | `getCircleMembers`, `getVisiblePostIds`, `getGlanceItems`, `getDepthPostIds`, `getCircleStatus`, `getCircleEntityStatus`, `markCircleRead` | single-hop edge filters + counts; dual-gated visibility |
| Entity relationships (entity → entity, typed) | `create/confirm/reject/remove/get/getPending` | single-hop typed-edge CRUD with status |
| Discovery | `discoverByGraph`, `discoverNearby`, `getRecommendations` | **the only multi-hop surface** (see profile) + PostGIS-backed proximity |
| Scoring | `recordInteraction`, `recomputeScores`, `applyDecay` | edge-property updates, batch |
| Sync (dual-write from Postgres) | `syncUser/Entity/Post/PostSubjects/Ownership`, `removeUser/Entity/Post/Ownership` | node/edge upserts + cascading deletes |

Note: the sync group exists **only because the graph is a second store**
that must mirror Postgres. A Postgres-native backend collapses this group to
no-ops or deletes it entirely — see the hosting revisit.

## Capability profile (what the workload actually needs)

Audited against the live query layer (`neo4j-graph-service.ts`). The
workload is **shallow**, which is what makes it backend-portable:

- **Traversal depth: ≤ 2 hops.** ~90% of methods are single-hop edge
  lookups (expressible as SQL joins). The *only* variable-length traversal
  is `discoverByGraph` and the `getRecommendations` shared-connections
  signal — both **hard-capped at 2 hops** (`neo4j-graph-service.ts:1217`),
  undirected, over a fixed set of typed entity-edge labels, with a
  `NOT (me)-[:RELATES_TO]->(discovered)` anti-join and `DISTINCT … LIMIT`.
- **No `shortestPath()` / `allShortestPaths()`** anywhere.
- **No APOC, no GDS, no graph algorithms.**
- **No multi-valued / list node properties** in the data model.
- **Anti-joins** (`EXISTS { … }` / `NOT EXISTS`) are used (~8 sites) and
  must be expressible (trivially: `LEFT JOIN … IS NULL` / `WHERE NOT
  EXISTS`).
- **Spatial proximity is NOT a graph capability** — `discoverNearby` ranks
  via Postgres/PostGIS and uses the graph only to supply fields + the
  not-already-related filter.

**Any backend that supports indexed edge lookups, anti-joins, and bounded
(≤2-hop) traversal satisfies this contract.** That explicitly includes
PostgreSQL via recursive CTEs. A dedicated graph engine is therefore a
performance/ergonomics choice, not a capability requirement — which is the
premise the hosting revisit builds on.

## Reference: the one multi-hop query

`discoverByGraph` (`neo4j-graph-service.ts:1233`) is the high-water mark for
traversal complexity. Any candidate backend should be validated against it:

```cypher
MATCH (me:User {id: $userId})-[:OWNS]->(myEntity:Entity),
      (myEntity)-[:<EDGE_TYPES>*1..2]-(discovered:Entity)
WHERE NOT (me)-[:RELATES_TO]->(discovered)
  AND (discovered.discoverable IS NULL OR discovered.discoverable = true)
  -- optional equality filters on discovered.<prop>
RETURN DISTINCT discovered.id, discovered.name, …
ORDER BY discovered.name ASC
LIMIT $limit
```

Bounded depth (≤2), fixed label set, equality filters, anti-join, distinct,
order, limit — all expressible in SQL. The hosting revisit includes the
recursive-CTE equivalent.

## Backend portability disciplines

These rules keep the backend swappable regardless of which one a deployment
picks — so a deployment can start on the cheapest viable backend and move
later at interface-bounded cost (weeks, not a rewrite). Hold all three:

1. **All graph access stays behind `GraphService`.** No raw graph queries
   (Cypher, SQL CTEs, window functions, spatial joins) in handlers or routes
   — a new graph need gets a `GraphService` method. This is what keeps the
   query surface portable across backends.
2. **Keep edge data in clean, graph-shaped storage** — an edge is
   `(source, target, type, status, score, …)`, not denormalized into
   node/content rows. Graph-shaped storage maps 1:1 to nodes/edges in any
   backend and exports trivially to an offline graph-analytics engine.
3. **Archive, don't delete, an outgoing backend implementation.** Retiring a
   backend should be reversible by restoring an archived adapter, not by
   reconstructing it.

A consuming deployment's concrete backend choice + reversibility notes live
in that deployment's own repo.

## What changes this contract

**Landed (2026-06):** the core now ships `PostgresGraphService`
(`apps/api/src/lib/graph/postgres/`) as the only implementation — the graph
runs in the primary relational store (joins + recursive CTEs), and
`GraphConnection` wraps the existing Postgres client rather than a separate
driver. The dual-write/reconciliation machinery was removed (no second store
to mirror). The **Sync group remains on the interface** with reduced duties:
node syncs are no-ops (the rows already live in their own tables) except
`syncEntity`'s geo side-effect; the removes implement the explicit edge
cascades; `syncPostSubjects`/`syncOwnership` are the edge writers.

Whole-graph **analytics** (centrality, community detection, network
analysis) remain out of scope for this OLTP contract — they belong to a
separate, offline analytics capability fed from the edge tables, not to the
request-path `GraphService`.
