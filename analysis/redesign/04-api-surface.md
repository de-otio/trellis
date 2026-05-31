# 04 — API Surface

> **Status (2026-04-12):** graph DB choice is now Neo4j AuraDB, not Neptune. See trellis `memory/project_graph_db_decision.md`.

New endpoints, deprecated endpoints, and how the API contract changes.

> **NOTE — Implementation**: Relationship and circle endpoints are backed by a `GraphService` abstraction that executes openCypher queries against Neptune Serverless. Content endpoints (posts, comments, media) remain Prisma/Postgres. The typical request pattern: GraphService resolves IDs from the graph → Prisma fetches content by those IDs. See [Trellis graph database architecture](../../trellis/analysis/redesign/07-graph-database/02-hybrid-architecture.md).
>
> For entity-centric verticals, circle content filtering is dual-gated (by subject entity relationship OR author relationship). See [Trellis entity-centric circles](../../trellis/analysis/redesign/06-entities-over-people/03-entity-centric-circles.md).

---

## New Endpoints

### Relationships

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/relationships` | Create a relationship (with optional initial score) |
| `DELETE` | `/api/relationships/:targetType/:targetId` | Remove a relationship |
| `PATCH` | `/api/relationships/:targetType/:targetId` | Adjust manual score (user drags someone closer/farther) |
| `GET` | `/api/relationships` | List all relationships, filterable by tier/targetType |
| `GET` | `/api/relationships/:targetType/:targetId` | Get specific relationship details + score |
| `GET` | `/api/relationships/graph` | Full graph data for the user-facing visualization |

#### `POST /api/relationships`

```json
// Request
{
  "targetType": "user",
  "targetId": "clx...",
  "connectionMethod": "code"   // optional, defaults to "discovery"
}

// Response (201)
{
  "id": "clx...",
  "targetType": "user",
  "targetId": "clx...",
  "score": 0.7,
  "tier": 1,
  "connectionMethod": "code",
  "createdAt": "2026-04-11T..."
}
```

Connection method determines initial score:
- `code`: 0.7 (close friends tier)
- `import`: 0.5 (close friends tier)
- `suggestion`: 0.3 (community tier)
- `discovery`: 0.3 (community tier)

#### `PATCH /api/relationships/:targetType/:targetId`

```json
// Request
{
  "manualScore": 0.9   // null to clear manual override and revert to computed
}

// Response (200)
{
  "id": "clx...",
  "score": 0.9,
  "manualScore": 0.9,
  "computedScore": 0.45,
  "tier": 0
}
```

#### `GET /api/relationships`

```json
// Query params: ?tier=0&targetType=user&limit=20&cursor=...

// Response (200)
{
  "relationships": [
    {
      "id": "clx...",
      "targetType": "user",
      "targetId": "clx...",
      "target": { "id": "clx...", "displayName": "Alice", "avatarUrl": "..." },
      "score": 0.92,
      "tier": 0,
      "reciprocated": true,
      "lastInteractionAt": "2026-04-10T..."
    }
  ],
  "cursor": "...",
  "hasMore": false
}
```

#### `GET /api/relationships/graph`

Returns the full relationship graph for visualization. This is a heavier endpoint — not for feed queries, but for the graph view UI.

**Security requirements:**
- Requires recent authentication (session age < 15 minutes). If session is older, client must re-authenticate before this endpoint returns data.
- Raw relationship scores are NOT exposed. Only `closeness` (0-100 integer, bucketed to nearest 10) and `tier` are returned.
- All access is audit-logged.
- Rate limit: 10 requests/minute.

```json
// Response (200)
{
  "nodes": [
    { "id": "clx...", "type": "user", "displayName": "Alice", "closeness": 90, "tier": 0 },
    { "id": "clx...", "type": "dog", "displayName": "Rex", "closeness": 80, "tier": 0 }
  ],
  "tiers": {
    "inner": { "threshold": 0.8, "count": 8 },
    "closeFriends": { "threshold": 0.5, "count": 23 },
    "community": { "threshold": 0.2, "count": 87 },
    "ambient": { "threshold": 0, "count": 412 }
  }
}
```

### Circles (Content Views)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/circles/:tier` | Content for a specific circle tier |
| `GET` | `/api/circles/:tier/glance` | Glance mode — finite snapshot |
| `GET` | `/api/circles/:tier/depth/:authorId` | Depth mode — one author's recent content |
| `GET` | `/api/circles/status` | Read state for all tiers (caught up?) |
| `POST` | `/api/circles/:tier/mark-read` | Update read state |

#### `GET /api/circles/:tier`

```json
// Query params: ?limit=20&cursor=...

// Response (200)
{
  "tier": 0,
  "tierName": "inner",
  "posts": [ /* standard post objects */ ],
  "cursor": "...",
  "hasMore": true,
  "caughtUp": false     // true when all content since last visit has been seen
}
```

#### `GET /api/circles/:tier/glance`

Returns a fixed-size snapshot. No pagination — this IS the complete glance view.

```json
// Response (200)
{
  "tier": 0,
  "tierName": "inner",
  "posts": [ /* up to glanceLimit posts */ ],
  "caughtUp": true,     // always reflects whether there's more beyond the glance
  "totalUnseen": 3       // how many unseen posts exist (even if glance shows fewer)
}
```

#### `GET /api/circles/:tier/depth/:authorId`

```json
// Response (200)
{
  "author": { "id": "clx...", "displayName": "Alice", ... },
  "relationship": { "score": 0.92, "tier": 0 },
  "posts": [ /* posts from this author within depthWindowDays */ ],
  "hasMore": false
}
```

#### `GET /api/circles/status`

```json
// Response (200)
{
  "tiers": [
    { "tier": 0, "name": "inner", "caughtUp": true, "unseenCount": 0, "lastReadAt": "..." },
    { "tier": 1, "name": "closeFriends", "caughtUp": false, "unseenCount": 12, "lastReadAt": "..." },
    { "tier": 2, "name": "community", "caughtUp": false, "unseenCount": 47, "lastReadAt": "..." },
    { "tier": 3, "name": "ambient", "caughtUp": true, "unseenCount": 0, "lastReadAt": "..." }
  ]
}
```

### Circle Configuration

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/circles/config` | Get user's circle configuration |
| `PATCH` | `/api/circles/config` | Update tier thresholds or view preferences |

### Posts (Modified)

| Method | Path | Change |
|--------|------|--------|
| `POST` | `/api/posts` | Add `radius` field (WHISPER/NORMAL/LOUD/SHOUT). Default: NORMAL |
| `PATCH` | `/api/posts/:id` | Allow narrowing radius (SHOUT → NORMAL ok, WHISPER → SHOUT blocked) |

```json
// POST /api/posts - Request
{
  "text": "Beautiful walk at the park today",
  "radius": "NORMAL",
  "media": [...],
  "geoData": { "lat": 48.2, "lng": 16.3 }
}
```

### Connection Codes (Modified from Friends)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/connections/code` | Generate a connection code |
| `POST` | `/api/connections/connect` | Use a connection code — creates mutual Relationships at high initial score |

#### Connection Code Security Requirements

Connection codes grant high-trust access (initial score 0.7, close-friends tier), so they require strong security controls:

| Property | Requirement |
|----------|-------------|
| **Format** | UUID v4 (128-bit entropy, cryptographically random) |
| **Expiration** | 24 hours from creation. Expired codes return 410 Gone. |
| **Usage** | Single-use by default. Code is invalidated after successful redemption. |
| **Multi-use option** | Owner can create a multi-use code with explicit `maxUses` (max 10) and same 24h expiry. |
| **Brute-force protection** | Max 5 failed redemption attempts per code per 15 minutes. After 5 failures, code is locked for 15 minutes. |
| **IP rate limiting** | Max 20 redemption attempts per IP per hour (across all codes). |
| **Self-connect prevention** | Attempting to redeem your own code returns 400. |
| **Storage** | Codes stored as SHA-256 hash in database. Raw code only returned once at creation time. |

```json
// POST /api/connections/code — Request
{
  "maxUses": 1       // optional, default 1, max 10
}

// POST /api/connections/code — Response (201)
{
  "code": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "expiresAt": "2026-04-12T14:30:00Z",
  "maxUses": 1
}

// POST /api/connections/connect — Request
{
  "code": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
}

// POST /api/connections/connect — Error responses
// 404: Code not found (or already exhausted / expired — same response to prevent enumeration)
// 410: Code expired
// 429: Too many failed attempts
```

### Shares (New)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/posts/:postId/share` | Share/repost an existing post |

#### `POST /api/posts/:postId/share`

Creates a new post that references the original. The sharer's radius is enforced server-side to never exceed the original post's radius.

```json
// Request
{
  "text": "Look at this!",           // optional — sharer's commentary
  "radius": "NORMAL"                  // must be <= original post's radius
}

// Response (201)
{
  "id": "clx...",                     // new post ID
  "sharedFromPostId": "clx...",       // original post reference
  "radius": "NORMAL",
  "createdAt": "2026-04-11T..."
}

// Error responses
// 400: radius exceeds original (e.g., original is NORMAL, request is SHOUT)
// 404: original post not found or not visible to sharer
```

**Server-side enforcement:**
- `share.radius <= original.radius` — validated before write. A WHISPER post cannot be shared at NORMAL or above.
- Radius ordering: WHISPER < NORMAL < LOUD < SHOUT.
- The shared post is a new post with `sharedFromPostId` FK. It flows through the sharer's circles independently.
- Shares always reference the original post, never intermediate shares (no chain amplification).

**Schema addition** (to Post model):
```prisma
  sharedFromPostId String? @map("shared_from_post_id")
  sharedFromPost   Post?   @relation("SharedPosts", fields: [sharedFromPostId], references: [id])
```

---

## Deprecated Endpoints

These are removed entirely (not versioned, since nothing is live):

| Endpoint | Replacement |
|----------|-------------|
| `POST /api/followers/follow` | `POST /api/relationships` |
| `POST /api/followers/unfollow` | `DELETE /api/relationships/:targetType/:targetId` |
| `GET /api/followers/followers` | `GET /api/relationships` (with `targetType` filter) |
| `GET /api/followers/following` | `GET /api/relationships` |
| `GET /api/followers/count` | `GET /api/circles/status` |
| `GET /api/feeds/home` | `GET /api/circles/:tier` |
| `GET /api/feeds/:entityType/:entityId` | Unchanged — entity feeds are orthogonal to circles |
| `POST /api/friends/connection-code` | `POST /api/connections/code` |
| `POST /api/friends/connect` | `POST /api/connections/connect` |
| `GET /api/friends` | `GET /api/relationships?tier=0` (inner circle ≈ close friends) |

---

## Entity Feeds

`GET /api/feeds/:entityType/:entityId` survives. This is "show me all posts about this dog" — it's content-centric, not relationship-centric. It doesn't need circles. However, posts returned are still filtered by the viewer's relationship with the author + the post's radius. You won't see a whisper-radius post about a dog unless the author considers you inner circle.

---

## Rate Limiting Considerations

- `GET /api/circles/:tier` — standard rate limiting, same as current feed
- `GET /api/relationships/graph` — heavier endpoint, stricter rate limit (e.g., 10/minute)
- `PATCH /api/relationships/:targetType/:targetId` — rate limit manual score changes to prevent gaming (e.g., 60/hour)
- `POST /api/connections/code` — rate limit code generation to prevent spam (e.g., 20/hour)

---

## Server-Side "Caught Up" Enforcement

The `caughtUp` state MUST be computed server-side. If the client could compute it, a modified client could suppress the "you're caught up" signal and re-enable infinite scroll. The server:

1. Tracks `CircleReadState.lastReadAt` per user per tier
2. On `GET /api/circles/:tier`, counts posts newer than `lastReadAt` from relationships in that tier
3. Returns `caughtUp: true` when `unseenCount == 0`
4. The client renders the "you're caught up" UI based on this flag

The client cannot request "more" content once `caughtUp` is true for a tier (the API returns an empty list).
