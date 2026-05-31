# 03 — Schema Design

> **Status (2026-04-12):** graph DB choice is now Neo4j AuraDB, not Neptune. See trellis `memory/project_graph_db_decision.md`.

Schema changes for the circles-based redesign. Since nothing is live, these are direct replacements, not migrations.

> **NOTE — Hybrid architecture**: The Relationship model and EntityRelationship model live in **Neptune Serverless** (graph database) as `:RELATES_TO` edges and typed entity edges, not in Postgres/Prisma. The Prisma definitions below document the data shape; the actual implementation uses openCypher queries via a `GraphService` abstraction. PostSubject and EntityOwnership are dual-written to both databases. See [Trellis graph database analysis](../../trellis/analysis/redesign/07-graph-database/).

---

## New Models

### `Relationship` (replaces `Follow`) — **Lives in Neptune**

```prisma
model Relationship {
  id        String   @id @default(cuid())
  userId    String   @map("user_id")        // The user whose graph this belongs to
  targetType String  @map("target_type")    // 'user' or entity type ('dog', 'plant', etc.)
  targetId  String   @map("target_id")      // ID of the related user or entity

  // Relationship scoring
  score         Float    @default(0.5)       // 0.0 = farthest, 1.0 = closest
  manualScore   Float?   @map("manual_score") // Explicit user calibration (overrides computed)
  computedScore Float    @default(0.5) @map("computed_score") // Algorithm-derived score

  // Score inputs (denormalized for query performance)
  interactionCount  Int      @default(0) @map("interaction_count")
  lastInteractionAt DateTime? @map("last_interaction_at")
  reciprocated      Boolean  @default(false) // Does the target have a Relationship back?

  // Connection metadata
  connectionMethod String   @default("discovery") @map("connection_method") // 'code', 'discovery', 'import', 'suggestion'
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  user User @relation("UserRelationships", fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, targetType, targetId])
  @@index([userId, score])                         // Core query: "my relationships by closeness"
  @@index([userId, targetType, score])              // "my user/entity relationships by closeness"
  @@index([targetType, targetId])                   // "who has a relationship with this target?"
  @@index([userId, lastInteractionAt])              // For decay calculations
  @@index([userId, connectionMethod])               // For filtering by how they connected
  @@map("relationships")
}
```

**Key design decisions:**

- `score` is the effective score used for circle placement. It equals `manualScore` when set, otherwise `computedScore`.
- `computedScore` is recalculated periodically (batch job or on-read with caching). It's stored, not computed on every query.
- `score` range is 0.0–1.0 where 1.0 = closest. This makes "top N closest" queries natural: `ORDER BY score DESC`.
- `reciprocated` is denormalized for fast queries. Updated when the other party creates/deletes their Relationship.
- Polymorphic via `targetType`/`targetId` (same pattern as current `Follow`). Allows relationships with both users and entities.

### `CircleConfig` (user's tier thresholds)

```prisma
model CircleConfig {
  id     String @id @default(cuid())
  userId String @unique @map("user_id")

  // Tier thresholds (score >= threshold = in this tier)
  innerThreshold     Float @default(0.8) @map("inner_threshold")      // tier 0
  closeFriendThreshold Float @default(0.5) @map("close_friend_threshold") // tier 1
  communityThreshold Float @default(0.2) @map("community_threshold")  // tier 2
  // Below communityThreshold = ambient (tier 3)

  // View preferences
  dailyDeckSize    Int?    @map("daily_deck_size")    // null = no daily limit
  glanceLimit      Int     @default(20) @map("glance_limit") // Max items in glance mode
  depthWindowDays  Int     @default(7) @map("depth_window_days") // How far back depth mode goes

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("circle_configs")
}
```

### `CircleReadState` (per-user, per-tier read tracking)

```prisma
model CircleReadState {
  id     String @id @default(cuid())
  userId String @map("user_id")
  tier   Int                         // 0 = inner, 1 = close friends, 2 = community, 3 = ambient

  lastReadAt    DateTime @map("last_read_at")    // Timestamp of most recent seen content
  lastReadPostId String? @map("last_read_post_id") // Cursor for pagination
  caughtUp      Boolean  @default(true) @map("caught_up") // Server-computed "you're caught up" state

  updatedAt DateTime @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, tier])
  @@index([userId])
  @@map("circle_read_states")
}
```

---

## Modified Models

### `Post` — Add posting radius, keep existing fields

```prisma
// ADD to Post model:
  radius PostRadius @default(NORMAL)

// ADD enum:
enum PostRadius {
  WHISPER   // Inner circle only (tier 0)
  NORMAL    // Close friends + inner circle (tiers 0-1)
  LOUD      // Community and closer (tiers 0-2)
  SHOUT     // Everyone (all tiers)
}
```

**What happens to existing fields:**

| Field | Action | Reason |
|-------|--------|--------|
| `visibility` (`PostVisibilityLevel`) | **Remove** | Replaced by `radius`. The radius model is strictly more expressive. |
| `geoData` | **Keep** | Map view needs location data. Orthogonal to circles. |
| `groupId` | **Keep** | Groups and circles coexist. |
| ActivityPub fields (`uri`, `activityId`, `objectId`, `to`, `cc`, `bto`, `bcc`, `published`) | **Keep** | Federation still needs these. `to`/`cc` fields are computed from radius at creation time. |
| All other fields | **Keep** | Content structure, safety, moderation, media — unchanged. |

**Index changes:**

```prisma
// REMOVE:
  @@index([authorId, visibility, createdAt])  // visibility is gone

// ADD:
  @@index([authorId, radius, createdAt])      // For "posts by author at radius"
  @@index([radius, createdAt])                // For feed queries filtered by radius
```

### `User` — Update relation fields

```prisma
// REMOVE from User:
  following       Follow[]    @relation("UserFollows")
  followingCount  Int         @default(0) @map("following_count")
  followersCount  Int         @default(0) @map("followers_count")

// ADD to User:
  circleConfig     CircleConfig?
  circleReadStates CircleReadState[]
  ownedEntities    EntityOwnership[]
  // Relationships live in Neptune, not Prisma
```

### `Entity` — Update follow-related fields, add co-ownership

```prisma
// REMOVE from Entity:
  ownerId         String  @map("owner_id")  // Single owner FK — replaced by EntityOwnership
  followersCount  Int @default(0) @map("followers_count")
  followPrivacy   Privacy @default(PUBLIC) @map("follow_privacy")

// ADD to Entity:
  owners EntityOwnership[]
  // Relationships and follower counts live in Neptune, not Prisma
```

### `EntityOwnership` — Co-ownership support (new)

Replaces the single `Entity.ownerId` FK. Dual-written to Neptune for graph-side proximity scoring.

```prisma
model EntityOwnership {
  id       String          @id @default(cuid())
  entityId String          @map("entity_id")
  userId   String          @map("user_id")
  role     OwnershipRole   @default(CO_OWNER)

  addedByUserId String   @map("added_by_user_id")
  addedAt       DateTime @default(now()) @map("added_at")
  status        OwnershipStatus @default(ACTIVE)
  removedAt     DateTime?       @map("removed_at")

  entity  Entity @relation(fields: [entityId], references: [id], onDelete: Cascade)
  user    User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([entityId, userId])
  @@index([entityId])
  @@index([userId])
  @@index([entityId, role])
  @@map("entity_ownerships")
}

enum OwnershipRole {
  PRIMARY_OWNER   // Full control, can transfer primary
  CO_OWNER        // Post and manage, cannot delete entity
  CARETAKER       // Can post about entity, cannot modify profile
}

enum OwnershipStatus {
  ACTIVE
  REMOVED
  LEFT
}
```

See [Trellis co-ownership analysis](../../trellis/analysis/redesign/06-entities-over-people/08-co-ownership.md) for the full design.

### `CustomAudience` — Keep for now, reassess later

Custom audiences provide manual targeting that's more specific than radius tiers. Keep the model but it becomes secondary to the radius system. Most users will never create a custom audience — the circles handle the common case.

---

## Removed Models

| Model | Reason |
|-------|--------|
| `Follow` | Replaced by `Relationship` |
| `Friendship` | Subsumed by `Relationship` with high reciprocated scores |
| `PostVisibilityLevel` enum | Replaced by `PostRadius` |

---

## Feed Query Pattern

The core feed query changes from:

```sql
-- OLD: Get home feed (all followed content, chronological)
SELECT p.* FROM posts p
  JOIN follows f ON f.target_id = p.author_id AND f.target_type = 'user'
  WHERE f.follower_id = :userId
    AND p.visibility IN ('PUBLIC', 'FRIENDS', 'FOLLOWERS')
  ORDER BY p.created_at DESC
  LIMIT :limit;
```

To:

```sql
-- NEW: Get circle view (tier-filtered, radius-aware)
SELECT p.* FROM posts p
  JOIN relationships r ON r.target_id = p.author_id AND r.target_type = 'user'
  WHERE r.user_id = :userId
    AND r.score >= :tierThreshold        -- only relationships in this tier or closer
    AND r.score < :upperThreshold        -- (if viewing a specific tier, not "this tier and above")
    AND p.radius_tier <= :viewerTier     -- post's radius reaches this far
    AND p.created_at > :lastReadAt       -- only unseen content (for "caught up" tracking)
    AND p.deleted_at IS NULL
  ORDER BY p.created_at DESC
  LIMIT :limit;
```

**Performance notes:**
- The `relationships` table replaces `follows` with the same cardinality
- Adding `score` to the query adds an inequality filter but the `(userId, score)` index handles this efficiently
- The `radius` filter on posts is a simple enum comparison
- `lastReadAt` filter reduces result set size (only unseen content)
- At the scale Trellis is targeting (pre-launch → early growth), this is well within Postgres capabilities

---

## Score Computation

The `computedScore` is recalculated by a background job (SQS worker or cron). Inputs:

```
computedScore = clamp(0, 1,
  w_interaction * interactionSignal(interactionCount, lastInteractionAt)
  + w_reciprocity * reciprocitySignal(reciprocated, theirScore)
  + w_connection * connectionBonus(connectionMethod)
  - w_decay * decayPenalty(lastInteractionAt, now)
)
```

Where:
- `interactionSignal`: logarithmic — diminishing returns on high interaction counts
- `reciprocitySignal`: bonus if the other party also has a relationship, scaled by their score for you
- `connectionBonus`: initial boost based on connection method (code > import > suggestion > discovery)
- `decayPenalty`: linear or exponential decay based on time since last interaction

**Weights are configurable at the platform level** (not per-user). They're tuning knobs, not user-facing settings.

The effective `score` is:
```
score = manualScore ?? computedScore
```

Manual calibration always wins. This ensures the user's explicit "I want this person in my inner circle" is respected regardless of interaction patterns.
