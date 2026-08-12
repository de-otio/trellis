---
title: Entity Graph & Circles
description: How Trellis models the social graph as an entity-centric graph, and how the circle visibility system works.
sidebar: Graph & Circles
order: 16
---

# Entity Graph & Circles

## Entity-Centric Social Model

Trellis uses an **entity-centric** social graph. Entities (the domain object a vertical models — a pet, a vehicle, a property, or any other concept) are first-class social nodes, not profile attributes on a user. The social graph primarily connects users to entities and entities to each other. Content is about entities.

| Traditional model | Trellis model |
|--------|-------|
| A user follows other users. An entity is metadata on a user profile. | A user has relationships with entities. Entities may have relationships with other entities (related, sibling, peer). Humans are secondary. |
| `Follow` + `Friendship` tables, `PostVisibilityLevel` enum. | `EntityOwnership`, `EntityRelationship`, `PostRadius` enum, `PostSubject` (post→entity). |
| Feed = reverse-chronological posts from followed users. | Circle views = posts routed through entity relationships, dual-gated by radius. |

A typical graph is 70–90% entities, 10–30% humans. Owned entities auto-pin to tier 0 (inner circle) with an immutable score of 1.0.

## Circles: Tiers & Dual-Gated Visibility

Every scored relationship (user→entity or user→user) has a `tier` derived from its score:

| Tier | Name | Typical contents |
|------|------|------------------|
| 0 | Inner circle | Own entities, partner's entities, closest friends' entities |
| 1 | Close friends | Entities the user interacts with regularly |
| 2 | Community | Local regulars, same-category peers, event contacts |
| 3 | Ambient | Discovery results, category community edges |

Tier thresholds come from `CircleConfig` (per-user, with defaults). Owned entities don't count toward the tier-0 cap.

### Dual-Gated Visibility

A post has a `PostRadius` (`WHISPER` → tier 0 only, `NORMAL` → 0–1, `LOUD` → 0–2, `SHOUT` → 0–3) and zero or more `PostSubject` edges to entities, one of which may be `isPrimary`.

```
Post p is visible to viewer v iff:

  (∃ entity e:  about(p, e)  AND  relates(v, e, tier)  AND  tier ≤ radius(p))
  OR
  (relates(v, author(p), tier)  AND  tier ≤ radius(p))
```

where `about(p, e)` is a row in `post_subjects` and `relates(v, x, tier)` is a row in `relationships`. The visibility query is a SQL join across `relationships`, `post_subjects`, and `posts` (see `getVisiblePostIds` in `postgres/circles.ts`).

On a multi-subject post the **closest relationship wins** — a post tagged with both a tier-0 entity and a tier-2 entity appears in the inner-circle view. The entity path is primary; the author path is the fallback for posts without an entity subject.

### Glance & Depth Modes

- **Glance mode** — one most-recent item per entity in a tier, prioritized by recency. Built as a two-step query (entities in tier → latest post per entity).
- **Depth mode** — per-entity drill-in (`/circles/depth/:entityId`), returns all that entity's recent posts for marking caught-up.
- **Circle status** — unseen counts per entity within a tier, computed from the relationship/post tables and stored in `circle_read_states` on mark-as-read.

### Filtering by organization category

Circle tier answers "how close is this author to me" and deliberately has
nothing to do with what *kind* of author it is. A second, independent filter
predicate — the author's organization category, denormalized onto
`Post.authorOrgRootCategoryCode` — lets a circle view additionally exclude or
isolate posts by organization type (e.g. "no business posts," "non-profits
only"), combinable with tier but not derived from it. See
[Organization Classification & Directory](./org-classification-and-directory.md).

## One Database: the Graph Lives in Postgres

The social graph is **not** a separate graph database. It is served from the same PostgreSQL instance that holds everything else, through a `GraphService` interface implemented by `PostgresGraphService`. The "edges" are ordinary relational tables; traversals are SQL joins and recursive CTEs.

| Concept | Postgres table | Notes |
|---------|----------------|-------|
| User accounts, auth, profiles | `users` | source of truth |
| Entity profiles, metadata, media | `entities` | source of truth |
| Posts, comments, sentiments | `posts`, … | source of truth |
| Owns edge | `entity_ownerships` | `userId` / `entityId` / `role` |
| About edge (post→entity) | `post_subjects` | `postId` / `entityId` / `isPrimary` |
| Scored relationship (user→user / user→entity) | `relationships` | `computedScore`, `manualScore`, `tier`, `connectionMethod`, `interactionCount`, `lastInteractionAt`, `reciprocated`, `signals` |
| Typed entity→entity relationship | `entity_relationships` | `type`, `status` (`PENDING`/`CONFIRMED`/`REJECTED`) |
| Circle config / read state | `circle_configs`, `circle_read_states` | per-user tier thresholds + mark-read |
| Behavioral signals (retention-bound) | `interaction_events` | append-only, `expiresAt`-pruned |

There is **no** dual-write, no second store to mirror, and no reconciliation between stores — there is one transactional database. (A dedicated graph backend was prototyped and removed; `GRAPH_BACKEND=neo4j` now throws `"no longer supported"`. The `GraphService` interface is retained so a dedicated backend could be reintroduced behind it, but the only shipped implementation is Postgres.)

The geo side is handled by **PostGIS** in the same database: entity locations live in `entity_location`, written through `syncEntity`, and proximity discovery uses spatial SQL.

### Write Path

Handlers write the relational rows directly through `PostgresGraphService`. There is one transaction boundary, so there is no eventual-consistency window between a "primary" graph store and a Postgres mirror:

```
1. Handler writes the domain row (user / entity / post) via Prisma.
2. Handler calls the GraphService edge method (e.g. syncOwnership,
   syncPostSubjects, createRelationship), which writes the edge table
   in the same Postgres database.
```

The `sync*` method names survive from the earlier two-store design, but they now write Postgres edge tables directly. Node syncs (`syncUser` / `syncEntity` / `syncPost`) are largely no-ops because those rows already exist in their own tables; `syncEntity` additionally maintains the PostGIS `entity_location` row. Node removals (`removeUser` / `removeEntity` / `removePost`) delete the non-cascading edge rows (`relationships`, `entity_relationships`) in application code to reproduce the old detach-delete scope.

## Relational Schema

### Edge tables

The graph "edges" are these Postgres tables (see `prisma/schema.prisma`):

- **`relationships`** — a scored user→target edge. `targetType` is polymorphic (`"user"` | `"entity"`); columns: `computedScore`, `manualScore` (nullable override), `tier` (0–3), `interactionCount`, `lastInteractionAt`, `connectionMethod`, `reciprocated`, and a JSON `signals` breakdown. Unique on `(userId, targetType, targetId)`.
- **`entity_relationships`** — a typed, unscored entity→entity edge with `type` (`EntityRelationshipType`, e.g. `PACK_MATE`, `SIBLING`) and `status` (`PENDING` | `CONFIRMED` | `REJECTED`). Unique on `(entityId, relatedEntityId, type)`.
- **`entity_ownerships`** — the owns edge: `userId` / `entityId` / `role` / `status`.
- **`post_subjects`** — the about edge: `postId` / `entityId` / `isPrimary`.

Node data (users, entities, posts) lives in its own tables; the graph layer references these by id rather than duplicating them.

### Indexes

The edge tables are indexed for both forward and reverse traversal, for example on `relationships`:

- `(userId, targetType, targetId)` — the composite unique; its `userId` prefix serves forward "a user's relationships" reads
- `(targetType, targetId)` — who relates to X (reverse: friends-of-friends, recompute; reverse lookups are always type-qualified)
- `(userId, tier)` — circle-tier membership

`entity_relationships` is indexed on `(entityId, type, status)` and `(relatedEntityId, type, status)` for list-by-entity and pending-by-owner queries. All edge tables carry a `tenantId` index for tenant scoping.

Entity-relationship type names are core-defined; there is no extension-side
registration for them today.

## Scoring Engine

Relationship score is a blend of manual and computed components:

```
score = manualScore ?? computedScore
computedScore = base(connectionMethod)
              + interaction_signal(interactionCount, lastInteractionAt)
              − decay(age_since_last_interaction)
```

- **Connection method** — seeded score based on how the edge was created. The four methods and their base contributions are `code` (0.7), `import` (0.5), `suggestion` (0.3), and `discovery` (0.3).
- **Interaction signals** — posts viewed, comments, reactions, shares, DMs. Accumulated on the `relationships` row (counts plus a JSON `signals` breakdown).
- **Decay** — exponential decay by half-life: 60 days for user→user edges, 120 days for user→entity edges. Owned-entity edges are exempt — they stay pinned at score 1.0 in tier 0.

Tier is derived from score using fixed thresholds (tier 0 ≥ 0.7, tier 1 ≥ 0.4, tier 2 ≥ 0.15, tier 3 ≥ 0.0). The scoring engine is pure (`scoring-engine.ts`); recompute and decay run as background passes over a user's relationships (`recomputeScores` / `applyDecay`), not inline per request.

## How Extensions Reach the Graph

Extensions **read** the graph; they do not currently plug behavior into it.
There is no extension hook into scoring, discovery faceting, or
relationship-type registration — earlier versions of this document described
three such hooks that the contract declared but core never invoked; they were
removed from the published contract before 1.0.

Extensions access the graph through `ExtensionGraphService` — a **read-only** proxy over `GraphService`. They can query visibility and traverse the graph but cannot write edges; all writes go through core handlers so invariants (ownership checks, confirmation, rate limits) are enforced in one place.

## API Surface

| Handler | Paths |
|---------|-------|
| `relationship-handler` | `POST/GET/DELETE /api/relationships` |
| `circle-handler` | `GET /api/circles/:tier`, `/api/circles/:tier/glance`, `/api/circles/:tier/depth/:entityId`, `/api/circles/:tier/status`, `POST /api/circles/:tier/mark-read` |
| `discovery-handler` | `GET /api/discovery`, `/api/discovery/recommendations`, `/api/discovery/nearby` |
| `entity-relationship-handler` | `POST/PUT/DELETE/GET /api/entity-relationships` (includes confirm/reject) |
| `connection-code-handler` | `POST/GET/DELETE /api/connection-codes` |

**Edge write points** (each writes the relevant Postgres edge table through `PostgresGraphService`, in the same database as the domain row):
- `POST /api/posts` → write the post row, then write `post_subjects` rows (`syncPostSubjects`).
- `POST/DELETE /api/entity-ownerships` → write the ownership, then `entity_ownerships` (`syncOwnership` / `removeOwnership`); `syncOwnership` also auto-pins the owner→entity relationship at score 1.0.
- `PUT /api/entity-relationships/:id/confirm` → update the `entity_relationships` status to `CONFIRMED`.

## Implementation Notes

The graph layer is one component of the Trellis API package; the consuming deployment provisions only PostgreSQL (no separate graph database). Trellis provides:

- `GraphService` — the interface over which all graph reads and writes flow
- `PostgresGraphService` — the only shipped implementation, serving the graph over the existing PostgreSQL via SQL joins and recursive CTEs; method groups live under `apps/api/src/lib/graph/postgres/` (`relationships`, `circles`, `entity-relationships`, `discovery`, `scoring`, `sync`)
- `createGraphServiceFromEnv()` — builds and memoizes the service from the same `DATABASE_URL`/Prisma client used by the rest of the API

Because the graph IS the relational data, there is no separate store to back up or reconcile. Relationship scores are derived data: if dropped, they are recomputable from interaction history (`recomputeScores`), while the structural edges (ownership, post-subject, typed entity relationships) are durable Postgres rows like any other.
