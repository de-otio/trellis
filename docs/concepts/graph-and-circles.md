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

  (∃ entity e:  p -[:ABOUT]-> e  AND  v -[:RELATES_TO {tier}]-> e  AND  tier ≤ radius(p))
  OR
  (v -[:RELATES_TO {tier}]-> author(p)  AND  tier ≤ radius(p))
```

On a multi-subject post the **closest relationship wins** — a post tagged with both a tier-0 entity and a tier-2 entity appears in the inner-circle view. The entity path is primary; the author path is the fallback for posts without an entity subject.

### Glance & Depth Modes

- **Glance mode** — one most-recent item per entity in a tier, prioritized by recency. Built as a two-step query (entities in tier → latest post per entity).
- **Depth mode** — per-entity drill-in (`/circles/depth/:entityId`), returns all that entity's recent posts for marking caught-up.
- **Circle status** — unseen counts per entity within a tier, computed by parallel graph queries and stored in `CircleReadState` on mark-as-read.

## Hybrid Data Layer

Neither database is a strict subset of the other. Each stores what it's best at.

| Data | Postgres | Graph DB (Neo4j AuraDB) |
|------|----------|--------------|
| User accounts, auth, profiles | source of truth | — |
| Entity profiles, metadata, media | source of truth | `:Entity` node (id, entityType, category, lifeStage, lat, lng) |
| Posts, comments, sentiments | source of truth | `:Post` reference node (id, authorId, radius, createdAt) |
| Taxonomy, DMs, notifications, groups, B2B | source of truth | — |
| `EntityOwnership` | source of truth | dual-written as `:User-[:OWNS {role}]->:Entity` |
| `PostSubject` | source of truth | dual-written as `:Post-[:ABOUT {isPrimary}]->:Entity` |
| User→User / User→Entity relationships (scored) | relationship mirror (scoring history) | **primary** — all tier / visibility queries |
| Entity→Entity relationships (typed) | relationship mirror | **primary** — discovery traversals |
| Circle membership, scoring signals | — | **derived** (computed from edge score) |

### Dual-Write Contract

Postgres is always written first. The graph is updated immediately after, best-effort.

```
1. Write Postgres row (source of truth, transactional)
2. Call GraphService to sync the edge(s)
3. On graph-write failure: enqueue a retry message to SQS (graph-sync-retry)
4. Reconciliation service rebuilds the graph from Postgres if needed
```

Consistency is **eventually consistent** with seconds of acceptable staleness for circle views. Critical ownership changes block on both writes succeeding. The graph is derivable from Postgres — a wipe is recoverable.

## Graph Schema (Cypher)

### Nodes

```cypher
(:User   {id, role})                    // no PII
(:Entity {id, entityType, name, category, lifeStage, lat, lng})
(:Post   {id, authorId, radius, createdAt})
```

### Edges

```cypher
(:User)-[:RELATES_TO   {score, computedScore, manualScore, tier,
                        interactionCount, lastInteractionAt,
                        connectionMethod}]->(:User|:Entity)
(:User)-[:OWNS         {role, since}]->(:Entity)
(:Post)-[:ABOUT        {isPrimary}]->(:Entity)

// Entity↔entity (typed, unscored — types shown are illustrative; a domain
// extension registers the set appropriate to its vertical)
(:Entity)-[:RELATED]->(:Entity)
(:Entity)-[:SIBLING]->(:Entity)
(:Entity)-[:PEER      {since}]->(:Entity)
(:Entity)-[:COMPANION {since}]->(:Entity)
(:Entity)-[:PARENT]->(:Entity)
(:Entity)-[:OFFSPRING]->(:Entity)
```

Extensions can register additional entity-relationship types via `entityRelationshipTypes` (see Extension Hooks below).

### Indexes

```cypher
CREATE INDEX user_id   FOR (u:User)   ON (u.id);
CREATE INDEX entity_id FOR (e:Entity) ON (e.id);
CREATE INDEX post_id   FOR (p:Post)   ON (p.id);
CREATE INDEX entity_type_category  FOR (e:Entity) ON (e.entityType, e.category);
CREATE INDEX entity_type_lifestage FOR (e:Entity) ON (e.entityType, e.lifeStage);
CREATE POINT INDEX entity_location FOR (e:Entity) ON (e.location);
CREATE INDEX post_created FOR (p:Post) ON (p.createdAt);
```

## Scoring Engine

Relationship score is a blend of manual and computed components:

```
score = manualScore ?? computedScore
computedScore = base(connectionMethod)
              + interaction_signal(interactionCount, lastInteractionAt)
              + extension_signals(...)
              − decay(age_since_last_interaction)
```

- **Connection method** — seeded score based on how the edge was created (`code`, `discovery`, `imported`, `inferred`).
- **Interaction signals** — posts viewed, comments, reactions, DMs. Accumulated on the edge.
- **Extension signals** — extensions register `RelationshipSignalProvider`s (e.g. category match, shared activities). Capped per provider to bound influence.
- **Decay** — linear decay over inactivity window; owned-entity edges don't decay.

The scoring engine runs as a background job (recompute on signal, batched), not inline per request. Tier is derived from score at query time using `CircleConfig` thresholds.

## Extension Hooks

Extensions plug into the graph via the `@de-otio/trellis-extension-api` interface:

| Hook | Purpose |
|------|---------|
| `entityRelationshipTypes: string[]` | Register typed entity-entity edges (`RELATED`, `SIBLING`, …). Core handles CRUD and confirmation flow. |
| `discoveryFacets: DiscoveryFacet[]` | Register searchable facets (category, life-stage, location, activity). Handlers wire these into `/api/discovery`. |
| `relationshipSignalProvider: { computeSignal(userId, targetId, targetType, context) }` | Contribute a bounded signal into the scoring engine. |

Extensions access the graph through `ExtensionGraphService` — a **read-only** proxy over `GraphService`. They can query visibility and traverse the graph but cannot write edges; all writes go through core handlers so invariants (ownership checks, confirmation, rate limits) are enforced in one place.

## API Surface

| Handler | Paths |
|---------|-------|
| `relationship-handler` | `POST/GET/DELETE /api/relationships` |
| `circle-handler` | `GET /api/circles/:tier`, `/api/circles/:tier/glance`, `/api/circles/:tier/depth/:entityId`, `/api/circles/:tier/status`, `POST /api/circles/:tier/mark-read` |
| `discovery-handler` | `GET /api/discovery`, `/api/discovery/recommendations`, `/api/discovery/nearby` |
| `entity-relationship-handler` | `POST/PUT/DELETE/GET /api/entity-relationships` (includes confirm/reject) |
| `connection-code-handler` | `POST/GET/DELETE /api/connection-codes` |

**Dual-write sync points:**
- `POST /api/posts` → write Postgres row, sync `PostSubject` edges to the graph.
- `POST/DELETE /api/entity-ownerships` → write Postgres, sync `:User-[:OWNS]->:Entity` edges.
- `PUT /api/entity-relationships/:id/confirm` → update Postgres status, create the typed entity-entity edge.

## Infrastructure Notes

Trellis is consumed as an npm dependency; the consuming deployment provisions the graph database. Trellis provides:

- `GraphService` — the interface over which all graph reads and writes flow
- `Neo4jGraphService` — the default implementation using the official `neo4j-driver` over Bolt
- `createGraphServiceFromEnv()` — fetches credentials from SSM at startup and constructs the driver

The same driver and Cypher dialect are used in all environments (local Docker, CI, and production AuraDB), so there is no dialect gap between environments.

If the graph database instance were wiped, reconciliation rebuilds the graph from Postgres (ownership, post-subject) plus replayed scoring signals. Relationship scores would be lost but are recomputable from interaction history.
