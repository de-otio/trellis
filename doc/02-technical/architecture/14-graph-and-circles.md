> **Updated 2026-05 for redesign:** Renamed `@trellis/extension-api` references to `@de-otio/trellis-extension-api` to match the current npmjs.org package name.

# Entity Graph & Circles

The redesign (planned through 2026-04) shifts the platform from a human-centric social graph to an **entity-centric** one, with circles and visibility computed in a graph database (Neo4j AuraDB) alongside the existing Postgres content store.

This document is the architectural reference for that model. For the underlying analysis, see the consuming application's redesign analysis (entities-over-people and graph-database notes).

---

## Entity-Centric Social Model

Entities (e.g. the domain object a vertical models, such as a pet, a vehicle, or a property) are first-class social nodes, not profile attributes on a user. The social graph primarily connects users to entities and entities to entities. Content is about entities.

| Before | After |
|--------|-------|
| A user follows other users. An entity is metadata on a user profile. | A user has relationships with entities. Entities may have relationships with other entities (related, sibling, peer). Humans are secondary. |
| `Follow` + `Friendship` tables, `PostVisibilityLevel` enum. | `EntityOwnership`, `EntityRelationship`, `PostRadius` enum, `PostSubject` (post→entity). |
| Feed = reverse-chronological posts from followed users. | Circle views = posts routed through entity relationships, dual-gated by radius. |

A typical graph is 70–90% entities, 10–30% humans. Owned entities auto-pin to tier 0 (inner circle) with an immutable score of 1.0.

---

## Circles: Tiers & Dual-Gated Visibility

Every scored relationship (user→entity or user→user) has a `tier` derived from its score:

| Tier | Name | Typical contents |
|------|------|------------------|
| 0 | Inner circle | Own entities, partner's entities, closest friends' entities |
| 1 | Close friends | Entities the user interacts with regularly |
| 2 | Community | Local regulars, same-category peers, event contacts |
| 3 | Ambient | Discovery results, category community edges |

Tier thresholds come from `CircleConfig` (per-user, defaults: t0≤10, t1≤30, t2≤100, t3 unbounded). Owned entities don't count toward the tier-0 cap.

### Dual-gated visibility

A post has a `PostRadius` (`WHISPER` → tier 0 only, `NORMAL` → 0–1, `LOUD` → 0–2, `SHOUT` → 0–3) and zero or more `PostSubject` edges to entities, one of which may be `isPrimary`.

```
Post p is visible to viewer v iff:

  (∃ entity e:  p -[:ABOUT]-> e  AND  v -[:RELATES_TO {tier}]-> e  AND  tier ≤ radius(p))
  OR
  (v -[:RELATES_TO {tier}]-> author(p)  AND  tier ≤ radius(p))
```

On a multi-subject post the **closest relationship wins** — a post tagged with both a tier-0 entity and a tier-2 entity appears in the inner-circle view. The entity path is primary; the author path is the fallback for posts without an entity subject.

### Glance & Depth modes

- **Glance mode** — one most-recent item per entity in a tier, prioritized by recency. Built as a two-step query (entities in tier → latest post per entity).
- **Depth mode** — per-entity drill-in (`/circles/depth/:entityId`), returns all that entity's recent posts for marking caught-up.
- **Circle status** — unseen counts per entity within a tier, computed by 4-way parallel graph queries and stored in `CircleReadState` on mark-as-read.

---

## Hybrid Data Layer

Neither database is a strict subset of the other. Each stores what it's best at.

| Data | Postgres | Neo4j AuraDB |
|------|----------|--------------|
| User accounts, auth, profiles | ✓ source of truth | — |
| Entity profiles, metadata, media | ✓ source of truth | `:Entity` node with query-only properties (id, entityType, category, lifeStage, lat, lng) |
| Posts, comments, sentiments | ✓ source of truth | `:Post` reference node (id, authorId, radius, createdAt) |
| Taxonomy, DMs, notifications, groups, B2B | ✓ source of truth | — |
| `EntityOwnership` | ✓ source of truth | dual-written as `:User-[:OWNS {role}]->:Entity` |
| `PostSubject` | ✓ source of truth | dual-written as `:Post-[:ABOUT {isPrimary}]->:Entity` |
| User→User / User→Entity relationships (scored) | relationship mirror (scoring history) | **primary** — all tier / visibility queries |
| Entity→Entity relationships (typed) | relationship mirror | **primary** — discovery traversals |
| Circle membership, scoring signals | — | **derived here** (computed from edge score) |

### Dual-write contract

Postgres is always written first. The graph is updated immediately after, best-effort.

```
1. Write Postgres row (source of truth, transactional)
2. Call GraphService to sync the edge(s)
3. On graph-write failure: enqueue a retry message to SQS (graph-sync-retry)
4. Reconciliation service rebuilds the graph from Postgres if needed
```

Consistency is **eventually consistent** with seconds of acceptable staleness for circle views. Critical ownership changes block on both writes succeeding. The graph is derivable from Postgres — a wipe is recoverable.

See `apps/api/src/lib/graph/dual-write-strategy.md` for the full failure matrix.

---

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

Extensions can register additional entity-relationship types via `entityRelationshipTypes` (see below).

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

Full query catalogue (tier view, glance, depth, status, circle members, owner-proximity scoring, discovery): `apps/api/src/lib/graph/circle-queries.md`.

---

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

---

## Extension Hooks

Extensions plug into the graph via the `@de-otio/trellis-extension-api` interface. The three redesign-specific hooks:

| Hook | Purpose |
|------|---------|
| `entityRelationshipTypes: string[]` | Register typed entity-entity edges (`RELATED`, `SIBLING`, …). Core handles CRUD + confirmation flow. |
| `discoveryFacets: DiscoveryFacet[]` | Register searchable facets (category, life-stage, location, activity). Handlers wire these into `/api/discovery`. |
| `relationshipSignalProvider: { computeSignal(userId, targetId, targetType, context) }` | Contribute a bounded signal into the scoring engine. |

Extensions access the graph through `ExtensionGraphService` — a **read-only** proxy over `GraphService`. They can query visibility and traverse the graph but cannot write edges; all writes go through core handlers so invariants (ownership checks, confirmation, rate limits) are enforced in one place.

A domain extension (e.g. the consuming application's vertical extension at `extensions/<vertical>/src/index.ts`) is the reference implementation.

---

## API Surface

New handlers and routes (all in `apps/api/src/lib/`):

| Handler | Paths |
|---------|-------|
| `relationship-handler` | `POST/GET/DELETE /api/relationships` |
| `circle-handler` | `GET /api/circles/:tier`, `/api/circles/:tier/glance`, `/api/circles/:tier/depth/:entityId`, `/api/circles/:tier/status`, `POST /api/circles/:tier/mark-read` |
| `discovery-handler` | `GET /api/discovery`, `/api/discovery/recommendations`, `/api/discovery/nearby` |
| `entity-relationship-handler` | `POST/PUT/DELETE/GET /api/entity-relationships` (includes confirm/reject) |
| `connection-code-handler` | `POST/GET/DELETE /api/connection-codes` |

Sync points (where dual-writes fan out):
- `POST /api/posts` → write Postgres row, sync `PostSubject` edges to the graph.
- `POST/DELETE /api/entity-ownerships` → write Postgres, sync `:User-[:OWNS]->:Entity` edges.
- `PUT /api/entity-relationships/:id/confirm` → update Postgres status, create the typed entity-entity edge.

---

## Infrastructure

Trellis is consumed as an npm dependency and is not deployed standalone — the **consuming deployment** (a vertical product embedding Trellis) owns all infrastructure provisioning below. Trellis provides the client code; the deploying application wires up the managed services.

- **No CDK stack in Trellis.** Neo4j AuraDB is a managed Neo4j-as-a-service; instances are provisioned manually through the Neo4j Aura console (not through AWS CDK) by the consuming deployment. A typical setup is an AuraDB Professional prod instance in `eu-central-1` and an AuraDB Free dev / CI/E2E instance (separate Neo4j account, $0, 200k-node / 400k-relationship cap).
- **Access**: the API connects over the **Bolt** protocol (`bolt+s://...`) using Basic auth. The consuming deployment stores credentials in a single SSM SecureString at `/{appName}/{stage}/neo4j/auradb/credentials` — a JSON blob with `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD`. The ECS task receives the parameter name via the `GRAPH_DB_CREDENTIALS_SSM_PARAM` env var; `createGraphServiceFromEnv()` fetches and decrypts the blob at startup without mutating `process.env`, and passes the bolt password directly to the Neo4j driver. The task role needs `ssm:GetParameter` + `kms:Decrypt` on the parameter's KMS key.
- **Network**: AuraDB is reached over the public internet from the Fargate task. Outbound Bolt traffic (TCP 7687) egresses via the deployment's NAT. AuraDB enforces TLS; IP allow-lists are available on Professional tier and should be configured to the deployment's NAT Elastic IP for prod.
- **Client**: `GraphService` is implemented by `Neo4jGraphService` (`apps/api/src/lib/graph/neo4j-graph-service.ts`), using the official `neo4j-driver`. The same class is used in all environments — local Docker, CI, dev AuraDB, prod AuraDB — so there is zero Cypher-dialect gap between environments.
- **Local dev, unit and integration tests**: Docker `neo4j:5-community` in `docker-compose.yml` — same Cypher syntax and driver as AuraDB, no code changes between environments.

---

## Why Neo4j AuraDB (vs. staying on Postgres, vs. self-hosting Neo4j, vs. Amazon Neptune)

The dual-gated circle query is the hot path: multi-hop traversal with per-edge tier resolution, joined against post subjects and author edges. In SQL it becomes a pile of self-joins and UNIONs; in Cypher it's a few dozen lines.

AuraDB won on three axes relevant to a small operator:

1. **True scale-to-low.** AuraDB Free is $0 for dev and CI/E2E; AuraDB Professional starts around $65/mo for the smallest production instance. Neptune Serverless has a 1 NCU minimum (~$130/mo idle floor — it does not actually scale to zero), and self-hosting on EC2 means managing backups, patching, and TLS ourselves.
2. **Same engine everywhere.** Local Docker `neo4j:5-community`, CI, dev AuraDB, and prod AuraDB all run the same Neo4j engine and Cypher dialect. There is no translation layer and no "works locally, fails in prod" class of bug.
3. **Managed ops.** Backups, upgrades, TLS, and monitoring are Neo4j's problem, not ours. We lose AWS-native IAM and CloudWatch integration; we replace them with a Secrets Manager secret for the bolt password and the Aura console's built-in metrics.

Full analysis lives in the consuming application's redesign plan (graph-db hosting decision and graph-database technology-choice notes).

---

## Migration & Rollout

Nothing is live, so this is a clean-slate schema change:

1. Apply the Prisma migration (removes `Follow`/`Friendship`, adds `EntityOwnership`, `CircleConfig`, `CircleReadState`, `PostSubject`, `ConnectionCode`; adds `PostRadius`, `OwnershipRole`, `OwnershipStatus`, `EntityStatus` enums).
2. The consuming deployment provisions the AuraDB instance in the Neo4j Aura console (Free for dev/CI, Professional for prod), then stores credentials as a single SSM SecureString JSON blob at `/{appName}/{stage}/neo4j/auradb/credentials` — see the consuming application's graph-db bootstrap runbook for the exact payload shape and aws-cli commands.
3. Initialize indexes via `graph-schema-init` on first boot.
4. Extensions upgrade to `@de-otio/trellis-extension-api` ≥ 1.0 (breaking change: adds `entityRelationshipTypes`, `discoveryFacets`).

If the AuraDB instance were wiped in prod, reconciliation rebuilds the graph from Postgres (ownership, post-subject) plus replayed scoring signals. Relationship scores would be lost but are recomputable from interaction history.
