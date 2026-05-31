# Circle Content Query Optimization

Design document for the five circle query endpoints — the most performance-critical query path in the system.

All queries use Cypher (compatible with Neo4j AuraDB and Neo4j Community). Parameters are always passed via `$paramName` — never string-concatenated.

---

## Prerequisites: Radius-to-Tier Mapping

PostRadius determines which tiers can see a post. The mapping is fixed (not user-configurable):

| PostRadius | Numeric value (stored on Post node) | Reaches tiers |
|------------|--------------------------------------|---------------|
| `WHISPER`  | 0 | 0 only |
| `NORMAL`   | 1 | 0, 1 |
| `LOUD`     | 2 | 0, 1, 2 |
| `SHOUT`    | 3 | 0, 1, 2, 3 |

A post is visible to a viewer at tier T if `post.radiusInt >= T`. This is stored as an integer property on the Post node (`radiusInt`) alongside the string `radius` for readability.

## Prerequisites: CircleConfig Threshold Mapping

CircleConfig (stored in Postgres) defines score thresholds per user:

```
tier 0 (inner):        score >= innerThreshold       (default 0.8)
tier 1 (closeFriends): score >= closeFriendThreshold  (default 0.5) AND score < innerThreshold
tier 2 (community):    score >= communityThreshold     (default 0.2) AND score < closeFriendThreshold
tier 3 (ambient):      score < communityThreshold      (i.e., score > 0 and < 0.2)
```

**SECURITY: Minimum threshold enforcement** — When a user updates their CircleConfig, the server enforces minimum values to prevent threshold manipulation (e.g., setting innerThreshold to 0.01 to make all WHISPER content visible):

| Threshold | Minimum | Default |
|-----------|---------|---------|
| `innerThreshold` | 0.50 | 0.80 |
| `closeFriendThreshold` | 0.20 | 0.50 |
| `communityThreshold` | 0.05 | 0.20 |

Additionally, threshold updates are rate-limited to 5 changes per day per user to prevent gaming through rapid threshold oscillation.

For circle queries, the thresholds are loaded from Postgres once at the start of the request and passed as query parameters.

Querying a specific tier means: `score >= $lowerThreshold AND score < $upperThreshold`.

Querying "tier N and all closer" (which is what radius checks need) means: `score >= $lowerThreshold` (no upper bound).

### Tier threshold resolution at query time

Before executing any circle query, the handler:

1. Loads `CircleConfig` from Postgres (or uses defaults if none exists)
2. Loads `CircleReadState` for the relevant tier(s) from Postgres
3. Computes the threshold parameters:

```typescript
function getTierBounds(config: CircleConfig, tier: CircleTier): { lower: number; upper: number } {
  switch (tier) {
    case 0: return { lower: config.innerThreshold, upper: Infinity };
    case 1: return { lower: config.closeFriendThreshold, upper: config.innerThreshold };
    case 2: return { lower: config.communityThreshold, upper: config.closeFriendThreshold };
    case 3: return { lower: 0.001, upper: config.communityThreshold }; // > 0 (has relationship)
  }
}

function getTierFloor(config: CircleConfig, tier: CircleTier): number {
  switch (tier) {
    case 0: return config.innerThreshold;
    case 1: return config.closeFriendThreshold;
    case 2: return config.communityThreshold;
    case 3: return 0.001;
  }
}
```

## Prerequisites: Owned Entities (Auto-Pinned at 1.0)

Entities the viewer owns are always inner circle (tier 0). The OWNS edge guarantees this: when `syncOwnership` is called, it creates both an OWNS edge and a RELATES_TO edge with `score: 1.0` and `manualScore: 1.0`. This score cannot decay.

Consequence: owned entities naturally appear in tier 0 queries (`score >= 0.8`). No special handling is needed in the queries themselves — the score ensures inclusion.

## Prerequisites: Memorial Entities

Memorial entities (deceased dogs) have a property `status: "MEMORIAL"` on the Entity node. They remain in circles at whatever score the viewer has. No new posts can be created about them (enforced at the API layer, not the graph layer). Existing posts remain visible. The queries below do not special-case memorials — they simply produce no new content since no new posts exist.

## Prerequisites: Indexes

The following indexes are required for the queries below to perform well:

```cypher
// Node lookups (unique constraint + index)
CREATE INDEX user_id FOR (u:User) ON (u.id);
CREATE INDEX entity_id FOR (e:Entity) ON (e.id);
CREATE INDEX post_id FOR (p:Post) ON (p.id);

// Post temporal ordering (critical for circle queries)
CREATE INDEX post_created FOR (p:Post) ON (p.createdAt);

// Post author lookup (for author-path visibility)
CREATE INDEX post_author FOR (p:Post) ON (p.authorId);
```

Edge properties (`score`, `tier`) are used in traversal filters. Neo4j applies these as inline filters during edge traversal, not via secondary indexes. The key performance factor is the fan-out from the viewer node — bounded by the number of RELATES_TO edges (typically < 200 per user).

---

## Query 1: getVisiblePostIds

**Signature**: `getVisiblePostIds(userId, tier, since, pagination) -> PaginatedResult<VisiblePostResult>`

This is the core dual-gated query. A post is visible if the viewer has a qualifying relationship with any subject entity OR the author.

### Approach: Two-path UNION

The query finds posts through two independent paths and merges them. For each post, it resolves the "best" (closest) tier through which the post is visible.

### Cypher Query

```cypher
// Path 1: Posts about entities the viewer has a relationship with in this tier
MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(entity:Entity)
WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold
WITH entity, r.score AS relScore

MATCH (post:Post)-[:ABOUT]->(entity)
WHERE post.createdAt > $since
  AND post.radiusInt >= $tierInt

WITH post, MIN(
  CASE
    WHEN relScore >= $innerThreshold THEN 0
    WHEN relScore >= $closeFriendThreshold THEN 1
    WHEN relScore >= $communityThreshold THEN 2
    ELSE 3
  END
) AS resolvedTier

RETURN post.id AS postId, post.createdAt AS createdAt, resolvedTier

UNION

// Path 2: Posts by users the viewer has a relationship with in this tier
MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(author:User)
WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold
WITH author, r.score AS relScore

MATCH (post:Post)
WHERE post.authorId = author.id
  AND post.createdAt > $since
  AND post.radiusInt >= $tierInt

WITH post, MIN(
  CASE
    WHEN relScore >= $innerThreshold THEN 0
    WHEN relScore >= $closeFriendThreshold THEN 1
    WHEN relScore >= $communityThreshold THEN 2
    ELSE 3
  END
) AS resolvedTier

RETURN post.id AS postId, post.createdAt AS createdAt, resolvedTier

ORDER BY createdAt DESC
SKIP $offset
LIMIT $limit
```

**Note on UNION deduplication**: Cypher `UNION` deduplicates by default. A post reachable through both entity and author paths appears only once. If the resolved tiers differ, the row from the path with the lower (closer) tier survives. If both paths yield the same tier, deduplication removes the duplicate.

### Multi-entity post resolution

A post about entities Bunsen (tier 0) and Beaker (tier 2) produces two matches in Path 1. The `MIN(...)` aggregation across the `WITH post` groups resolves to tier 0 — the closest relationship wins. This is correct: the viewer should see the post at the tier of their closest subject entity relationship.

### Parameters

| Parameter | Source | Type |
|-----------|--------|------|
| `$viewerId` | Session | String |
| `$lowerThreshold` | `getTierBounds(config, tier).lower` | Float |
| `$upperThreshold` | `getTierBounds(config, tier).upper` | Float |
| `$since` | `CircleReadState.lastReadAt` or explicit param | DateTime |
| `$tierInt` | Tier number (0-3) | Int |
| `$innerThreshold` | `config.innerThreshold` | Float |
| `$closeFriendThreshold` | `config.closeFriendThreshold` | Float |
| `$communityThreshold` | `config.communityThreshold` | Float |
| `$offset` | Cursor-decoded offset | Int |
| `$limit` | Pagination limit (max 50) | Int |

### Simplification: Querying "this tier and closer"

When a user opens the inner circle view, they want posts from tier 0. But the radius check `post.radiusInt >= $tierInt` is what controls whether a post reaches that tier. For tier 0, only WHISPER/NORMAL/LOUD/SHOUT reach (all of them). For tier 3, only SHOUT reaches. This is already encoded.

However, the relationship filter `r.score >= $lowerThreshold AND r.score < $upperThreshold` restricts to a single tier band. The viewer sees posts that are visible *at this tier* through relationships *in this tier*. A post about an entity in the viewer's inner circle that also happens to be SHOUT radius won't appear in the ambient tier view (unless the entity is also in the ambient tier through a different relationship — unlikely, since an entity can only have one relationship edge from a given viewer).

### Cursor-based pagination

The cursor encodes `(createdAt, postId)` for deterministic ordering:

```typescript
type CircleCursor = {
  createdAt: string;  // ISO timestamp
  postId: string;     // tie-breaker
};

// Encode: base64(JSON.stringify(cursor))
// Decode: JSON.parse(atob(cursor))
```

When a cursor is provided, the query adds:

```cypher
AND (post.createdAt < $cursorCreatedAt
     OR (post.createdAt = $cursorCreatedAt AND post.id < $cursorPostId))
```

This replaces `SKIP $offset` with a WHERE clause for stable pagination (no skipped/duplicated items when new posts arrive).

### Performance characteristics

| Factor | Behavior |
|--------|----------|
| Fan-out from viewer | Bounded by number of RELATES_TO edges in the tier (typically 5-30 for inner circle, up to ~100 for community) |
| Post scan per entity | Bounded by `$since` filter (only unseen posts). For active users checking regularly, this is hours to days of content. |
| Total posts scanned | `sum(posts per entity since lastReadAt)` across all entities in the tier. Worst case with 30 entities * 10 posts each = 300 scanned, 50 returned. |
| Scales linearly with | Number of entities in the queried tier * post rate per entity |
| Bounded by | The tier size (configurable) and the recency filter |

### Caching strategy

**What to cache**: The result set (list of `VisiblePostResult`) keyed by `(userId, tier, since, cursor)`.

**TTL**: 60 seconds. Circle views are not real-time — a one-minute delay for new posts is acceptable.

**Invalidation triggers**:
- User marks tier as read (invalidate this tier for this user)
- New post synced to graph about an entity in this user's tier (targeted invalidation via SQS fan-out, or rely on TTL)
- Relationship score changes causing tier movement (background job invalidates affected user caches)

**Cache key**: `circle:posts:{userId}:{tier}:{since_epoch}:{cursor_hash}`

**Storage**: DynamoDB with TTL (existing KV cache infrastructure).

---

## Query 2: getGlanceItems

**Signature**: `getGlanceItems(userId, tier, limit) -> GlanceItem[]`

Returns one recent item per entity/user in the tier, prioritized by recency. This is the "entity snapshot" view.

### Cypher Query

```cypher
// For each entity in the tier, find the most recent post about it
MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(target)
WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold

// Branch: target is an Entity — find posts ABOUT the entity
WITH target, r, labels(target)[0] AS targetLabel
WHERE targetLabel = 'Entity'

OPTIONAL MATCH (post:Post)-[:ABOUT]->(target)
WHERE post.radiusInt >= $tierInt

WITH target, post, 'entity' AS targetType
ORDER BY post.createdAt DESC

// Take only the most recent post per entity
WITH target,
     targetType,
     COLLECT(post)[0] AS latestPost

WHERE latestPost IS NOT NULL

RETURN target.id AS targetId,
       targetType,
       target.name AS targetName,
       latestPost.id AS postId,
       latestPost.createdAt AS postCreatedAt

UNION

// Branch: target is a User — find posts BY the user
MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(target:User)
WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold

OPTIONAL MATCH (post:Post)
WHERE post.authorId = target.id
  AND post.radiusInt >= $tierInt

WITH target, post, 'user' AS targetType
ORDER BY post.createdAt DESC

WITH target,
     targetType,
     COLLECT(post)[0] AS latestPost

WHERE latestPost IS NOT NULL

RETURN target.id AS targetId,
       targetType,
       target.name AS targetName,
       latestPost.id AS postId,
       latestPost.createdAt AS postCreatedAt

ORDER BY postCreatedAt DESC
LIMIT $limit
```

### Alternative: Application-side assembly

The Cypher query above is moderately complex. An alternative approach that may perform better and is easier to reason about:

1. **Step 1** (graph): Get all circle members in the tier (lightweight — just IDs and scores).
2. **Step 2** (graph): For each member, get their most recent post ID (batch query).
3. **Step 3** (application): Sort by recency, take top N.

This two-step approach is recommended if the single query proves slow in the graph DB. The round-trip cost of two queries (< 5ms each) is negligible compared to the query complexity savings.

#### Step 1: Get tier members

```cypher
MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(target)
WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold
RETURN target.id AS targetId,
       labels(target)[0] AS targetType,
       target.name AS targetName,
       r.score AS score
ORDER BY r.score DESC
```

#### Step 2: Batch most-recent-post lookup

```cypher
// For entities: most recent post about each entity
UNWIND $entityIds AS entityId
MATCH (entity:Entity {id: entityId})<-[:ABOUT]-(post:Post)
WHERE post.radiusInt >= $tierInt
WITH entityId, post
ORDER BY post.createdAt DESC
WITH entityId, COLLECT(post)[0] AS latestPost
WHERE latestPost IS NOT NULL
RETURN entityId AS targetId,
       latestPost.id AS postId,
       latestPost.createdAt AS postCreatedAt
```

```cypher
// For users: most recent post by each user
UNWIND $userIds AS userId
MATCH (post:Post)
WHERE post.authorId = userId
  AND post.radiusInt >= $tierInt
WITH userId, post
ORDER BY post.createdAt DESC
WITH userId, COLLECT(post)[0] AS latestPost
WHERE latestPost IS NOT NULL
RETURN userId AS targetId,
       latestPost.id AS postId,
       latestPost.createdAt AS postCreatedAt
```

### Parameters

| Parameter | Source | Type |
|-----------|--------|------|
| `$viewerId` | Session | String |
| `$lowerThreshold` | `getTierBounds(config, tier).lower` | Float |
| `$upperThreshold` | `getTierBounds(config, tier).upper` | Float |
| `$tierInt` | Tier number (0-3) | Int |
| `$limit` | `config.glanceLimit` (default 20) | Int |
| `$entityIds` | From step 1 (two-step variant) | String[] |
| `$userIds` | From step 1 (two-step variant) | String[] |

### Performance characteristics

| Factor | Behavior |
|--------|----------|
| Fan-out from viewer | Bounded by tier size (typically 5-30) |
| Per-member lookup | One post lookup per member — bounded by tier size |
| Total cost | O(tier_size) — each member contributes at most one post |
| No pagination needed | Result set is inherently bounded (one item per member, capped at glanceLimit) |

### Caching strategy

**What to cache**: The full `GlanceItem[]` result keyed by `(userId, tier)`.

**TTL**: 120 seconds. Glance mode is a snapshot — slightly stale data is fine because the user will tap into depth mode for real-time content.

**Invalidation triggers**:
- New post synced to graph about an entity in this user's tier
- Relationship tier changes (background job)

**Cache key**: `circle:glance:{userId}:{tier}`

---

## Query 3: getDepthPostIds

**Signature**: `getDepthPostIds(userId, targetType, targetId, since, limit) -> string[]`

All recent posts about a specific entity (or by a specific user), filtered by the viewer's relationship.

### Cypher Query (entity target)

```cypher
// Verify viewer has a relationship with this entity
MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(entity:Entity {id: $targetId})

// Find posts about this entity within the depth window
MATCH (post:Post)-[:ABOUT]->(entity)
WHERE post.createdAt > $since
  AND post.radiusInt >= CASE
    WHEN r.score >= $innerThreshold THEN 0
    WHEN r.score >= $closeFriendThreshold THEN 1
    WHEN r.score >= $communityThreshold THEN 2
    ELSE 3
  END

RETURN post.id AS postId
ORDER BY post.createdAt DESC
LIMIT $limit
```

### Cypher Query (user target)

```cypher
// Verify viewer has a relationship with this user
MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(author:User {id: $targetId})

// Find posts by this user within the depth window
MATCH (post:Post)
WHERE post.authorId = author.id
  AND post.createdAt > $since
  AND post.radiusInt >= CASE
    WHEN r.score >= $innerThreshold THEN 0
    WHEN r.score >= $closeFriendThreshold THEN 1
    WHEN r.score >= $communityThreshold THEN 2
    ELSE 3
  END

RETURN post.id AS postId
ORDER BY post.createdAt DESC
LIMIT $limit
```

### Radius check explanation

The radius check is dynamic per-viewer: the viewer's relationship score determines their tier with the target, and the post's radius must reach that tier. For example, if the viewer has the entity at score 0.6 (tier 1, close friends), only posts with radius NORMAL or higher (radiusInt >= 1) are visible.

This is computed inline via the `CASE` expression rather than pre-computing the tier, which avoids a round trip.

### Parameters

| Parameter | Source | Type |
|-----------|--------|------|
| `$viewerId` | Session | String |
| `$targetId` | Path parameter | String |
| `$since` | `now() - depthWindowDays` (from CircleConfig, default 7 days) | DateTime |
| `$limit` | Request parameter (max 50) | Int |
| `$innerThreshold` | `config.innerThreshold` | Float |
| `$closeFriendThreshold` | `config.closeFriendThreshold` | Float |
| `$communityThreshold` | `config.communityThreshold` | Float |

### Performance characteristics

| Factor | Behavior |
|--------|----------|
| Relationship lookup | O(1) — single edge traversal from viewer to target |
| Post scan | Bounded by `$since` (depth window, default 7 days) and `$limit` |
| Total cost | O(posts_about_entity_in_window). For most entities, this is < 50 posts. |
| Scales with | Post rate for the specific entity — independent of graph size |

### Caching strategy

**What to cache**: The `string[]` of post IDs keyed by `(userId, targetId, since)`.

**TTL**: 30 seconds. Depth mode is detailed viewing — users expect fresh content.

**Invalidation triggers**:
- New post about this entity
- Viewer's relationship score changes (tier change could affect radius filtering)

**Cache key**: `circle:depth:{userId}:{targetId}:{since_epoch}`

---

## Query 4: getCircleStatus

**Signature**: `getCircleStatus(userId) -> CircleTierStatus[]`

Returns per-tier unseen count and caught-up state. This is called on app open and after marking a tier as read.

### Approach: Postgres for lastReadAt + Graph for counts

This is a hybrid query — `lastReadAt` lives in Postgres (CircleReadState), and the post counts come from the graph.

**Step 1** (Postgres): Load all CircleReadState rows for the user (4 rows max).

**Step 2** (Graph): For each tier, count posts newer than lastReadAt.

### Cypher Query (single query for all tiers)

```cypher
MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(target)
WHERE r.score > 0

WITH target, r.score AS score

// Find posts reachable through this relationship
MATCH (post:Post)
WHERE (
  (target:Entity AND EXISTS {
    MATCH (post)-[:ABOUT]->(target)
  })
  OR
  (target:User AND post.authorId = target.id)
)

// For each post, compute the viewer's tier for this relationship
// and whether the post's radius reaches that tier
WITH post,
  CASE
    WHEN score >= $innerThreshold THEN 0
    WHEN score >= $closeFriendThreshold THEN 1
    WHEN score >= $communityThreshold THEN 2
    ELSE 3
  END AS viewerTier

WHERE post.radiusInt >= viewerTier

// Count unseen posts per tier
WITH post, viewerTier
WHERE (viewerTier = 0 AND post.createdAt > $lastReadTier0)
   OR (viewerTier = 1 AND post.createdAt > $lastReadTier1)
   OR (viewerTier = 2 AND post.createdAt > $lastReadTier2)
   OR (viewerTier = 3 AND post.createdAt > $lastReadTier3)

RETURN viewerTier AS tier, COUNT(DISTINCT post.id) AS unseenCount
ORDER BY tier
```

### Alternative: Four separate count queries

If the single query proves too complex for the graph DB's query planner, split into four simpler queries (one per tier):

```cypher
// Count unseen posts for tier N
MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(target)
WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold

MATCH (post:Post)
WHERE (
  (target:Entity AND EXISTS {
    MATCH (post)-[:ABOUT]->(target)
  })
  OR
  (target:User AND post.authorId = target.id)
)
AND post.radiusInt >= $tierInt
AND post.createdAt > $lastReadAt

RETURN COUNT(DISTINCT post.id) AS unseenCount
```

Run four of these in parallel (one per tier). Total latency = max(single query latency), not sum.

### Result assembly

```typescript
const tiers: CircleTierStatus[] = [
  { tier: 0, name: 'inner', caughtUp: counts[0] === 0, unseenCount: counts[0], lastReadAt: readStates[0]?.lastReadAt ?? null },
  { tier: 1, name: 'closeFriends', caughtUp: counts[1] === 0, unseenCount: counts[1], lastReadAt: readStates[1]?.lastReadAt ?? null },
  { tier: 2, name: 'community', caughtUp: counts[2] === 0, unseenCount: counts[2], lastReadAt: readStates[2]?.lastReadAt ?? null },
  { tier: 3, name: 'ambient', caughtUp: counts[3] === 0, unseenCount: counts[3], lastReadAt: readStates[3]?.lastReadAt ?? null },
];
```

### Parameters

| Parameter | Source | Type |
|-----------|--------|------|
| `$viewerId` | Session | String |
| `$lastReadTier0..3` | CircleReadState from Postgres | DateTime |
| `$innerThreshold` | `config.innerThreshold` | Float |
| `$closeFriendThreshold` | `config.closeFriendThreshold` | Float |
| `$communityThreshold` | `config.communityThreshold` | Float |
| `$lowerThreshold` / `$upperThreshold` | Per-tier bounds (four-query variant) | Float |
| `$tierInt` | Tier number (four-query variant) | Int |
| `$lastReadAt` | Per-tier from CircleReadState (four-query variant) | DateTime |

### Performance characteristics

| Factor | Behavior |
|--------|----------|
| Single-query variant | Full graph scan from viewer node — traverses all RELATES_TO edges and checks all reachable posts. Expensive for large graphs. |
| Four-query variant | Each query scans one tier's edges only. Parallelized, so latency = single tier. |
| Recommendation | Use the four-query variant. Each is bounded by tier size and unseen-post count. |
| Scales with | Total relationship count * unseen posts per relationship |

### Caching strategy

**What to cache**: The `CircleTierStatus[]` result keyed by `(userId)`.

**TTL**: 120 seconds. Status is an overview — slight staleness is acceptable.

**Invalidation triggers**:
- User marks any tier as read (immediate invalidation)
- New post synced that affects any of the user's tiers (targeted invalidation or rely on TTL)

**Cache key**: `circle:status:{userId}`

**Important**: After `markCircleRead`, the cache MUST be invalidated immediately (not TTL-based) to give the user instant feedback that their action took effect.

---

## Query 5: getCircleEntityStatus

**Signature**: `getCircleEntityStatus(userId, tier) -> CircleEntityStatus[]`

Per-entity unseen count within a tier. Shows which entities have new content.

### Cypher Query

```cypher
MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(entity:Entity)
WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold

// Find posts about this entity that are within radius and unseen
OPTIONAL MATCH (post:Post)-[:ABOUT]->(entity)
WHERE post.radiusInt >= $tierInt
  AND post.createdAt > $lastReadAt

WITH entity,
     COUNT(post) AS unseenCount,
     MAX(post.createdAt) AS latestPostAt

RETURN entity.id AS entityId,
       entity.name AS entityName,
       unseenCount = 0 AS caughtUp,
       unseenCount,
       latestPostAt

ORDER BY unseenCount DESC, latestPostAt DESC
```

### Note: Entity-only, not users

This query returns entity status only, not user status. The UI design in the analysis docs shows per-entity indicators ("Bunsen — 3 new posts"). If user-level status is also needed, a parallel query can be run:

```cypher
MATCH (viewer:User {id: $viewerId})-[r:RELATES_TO]->(author:User)
WHERE r.score >= $lowerThreshold AND r.score < $upperThreshold

OPTIONAL MATCH (post:Post)
WHERE post.authorId = author.id
  AND post.radiusInt >= $tierInt
  AND post.createdAt > $lastReadAt

WITH author,
     COUNT(post) AS unseenCount,
     MAX(post.createdAt) AS latestPostAt

RETURN author.id AS entityId,
       author.name AS entityName,
       unseenCount = 0 AS caughtUp,
       unseenCount,
       latestPostAt

ORDER BY unseenCount DESC, latestPostAt DESC
```

Results from both queries are merged and sorted application-side.

### Parameters

| Parameter | Source | Type |
|-----------|--------|------|
| `$viewerId` | Session | String |
| `$lowerThreshold` | `getTierBounds(config, tier).lower` | Float |
| `$upperThreshold` | `getTierBounds(config, tier).upper` | Float |
| `$tierInt` | Tier number (0-3) | Int |
| `$lastReadAt` | CircleReadState for this tier | DateTime |

### Performance characteristics

| Factor | Behavior |
|--------|----------|
| Entity fan-out | Bounded by tier size (entities in this tier) |
| Per-entity cost | One OPTIONAL MATCH per entity — bounded by unseen posts |
| Total cost | O(tier_size * avg_unseen_posts_per_entity) |
| Result set size | Equal to number of entities in the tier (typically 5-30 for inner, up to ~100 for community) |

### Caching strategy

**What to cache**: The `CircleEntityStatus[]` result keyed by `(userId, tier)`.

**TTL**: 60 seconds.

**Invalidation triggers**:
- New post about any entity in this user's tier (targeted invalidation)
- User marks tier as read (immediate invalidation)

**Cache key**: `circle:entity-status:{userId}:{tier}`

---

## Graph DB Unavailability: Fallback Strategy

When the graph DB is temporarily unavailable (network issue, maintenance, scaling event), the circle queries cannot execute. The system handles this gracefully:

### Circuit breaker pattern

The `GraphService` implementation wraps all queries in a circuit breaker:

```
States: CLOSED (normal) -> OPEN (failing) -> HALF_OPEN (probing)

CLOSED:  All queries go to the graph DB. If 3 consecutive failures within 30s, transition to OPEN.
OPEN:    All queries immediately return GraphConnectionError. After 15s, transition to HALF_OPEN.
HALF_OPEN: One probe query is allowed. If it succeeds, transition to CLOSED. If it fails, back to OPEN.
```

### Handler-level fallback

When a circle query throws `GraphConnectionError`:

1. **getVisiblePostIds**: Return HTTP 503 with `Retry-After: 30` header. The Flutter client shows "Circle temporarily unavailable" with a retry button. There is no Postgres-only fallback — the dual-gated visibility query is inherently a graph operation.

2. **getGlanceItems**: Same as above — 503. No meaningful degraded mode exists.

3. **getDepthPostIds**: Partial fallback possible. If the viewer has already loaded the entity profile (which comes from Postgres), the client can show cached post IDs from the previous depth-mode session. The server returns 503 and the client falls back to its local cache.

4. **getCircleStatus**: Return a degraded response with `caughtUp: null` and `unseenCount: -1` (sentinel values) for each tier. The client shows "status unavailable" instead of the caught-up indicator. The `lastReadAt` values are still available from Postgres.

5. **getCircleEntityStatus**: Same as getCircleStatus — degraded response with sentinel values.

### Why no Postgres-only fallback for visibility queries

The dual-gated visibility check requires traversing `RELATES_TO` edges, which live exclusively in the graph DB. A Postgres fallback would require either:
- Duplicating the entire relationship graph in Postgres (defeats the purpose)
- Returning an unfiltered feed (privacy violation — users see content they shouldn't)

Neither is acceptable. The correct approach is graceful degradation: 503 + client retry + cached previous results on the client side.

### Health check integration

The `/health` endpoint includes `graph: { healthy: boolean, latencyMs: number }`. ECS health checks use this. If the graph DB is unhealthy, the API remains running (other endpoints still work), but circle endpoints return 503. The ALB does NOT deregister the task — only Postgres unavailability triggers task replacement.

---

## Post Radius Storage on Graph Nodes

The Post node in the graph stores `radius` as a string (matching the Prisma enum) and `radiusInt` as an integer for comparison:

```cypher
// When syncing a post to the graph:
MERGE (p:Post {id: $postId})
SET p.authorId = $authorId,
    p.radius = $radius,
    p.radiusInt = CASE $radius
      WHEN 'WHISPER' THEN 0
      WHEN 'NORMAL' THEN 1
      WHEN 'LOUD' THEN 2
      WHEN 'SHOUT' THEN 3
    END,
    p.createdAt = datetime($createdAt)
```

The integer encoding enables the `post.radiusInt >= $tierInt` comparisons used in all five queries.

---

## Summary: Query Cost Model

| Query | Graph operations | Typical latency (AuraDB) | Scales with |
|-------|-----------------|---------------------------|-------------|
| getVisiblePostIds | 2 traversals (entity path + author path) + UNION | 10-50ms | tier_size * post_rate |
| getGlanceItems | 1 traversal + per-member post lookup | 5-20ms | tier_size |
| getDepthPostIds | 1 edge lookup + post scan | 2-10ms | single entity post rate |
| getCircleStatus | 4 parallel count queries | 5-15ms (parallel) | total_relationships * unseen_rate |
| getCircleEntityStatus | 1 traversal + per-entity count | 5-20ms | tier_size * unseen_rate |

All latencies assume AuraDB reachable over the Bolt protocol. Network latency depends on region proximity; expect 5-30ms RTT to AuraDB regions.

---

## Implementation Notes

### Cypher Compatibility

Local Docker Neo4j (`neo4j:5-community`) and AuraDB share the same Cypher dialect, so queries written for one run unchanged on the other. All queries above require Neo4j 5+ (for `EXISTS { MATCH ... }` and related features).

### Parameterization

All queries use `$paramName` syntax. The GraphService implementation passes parameters as a map alongside the query string:

```typescript
const result = await this.executeQuery(query, {
  viewerId: userId,
  lowerThreshold: bounds.lower,
  upperThreshold: bounds.upper,
  since: since.toISOString(),
  tierInt: tier,
  limit: pagination.limit,
  // ... etc
});
```

Never interpolate values into the query string. This prevents injection and enables query plan caching.

### Query timeouts

All circle queries have a 5-second timeout. If a query exceeds this, the GraphService throws `GraphTimeoutError` and the handler returns 504. The circuit breaker counts timeouts as failures.
