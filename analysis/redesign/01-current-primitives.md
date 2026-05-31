# 01 — Current Social Primitives

What Trellis's social model looks like today, and what a circles-based redesign affects.

## Current Model Summary

Trellis uses a conventional social media model: **users follow targets, posts are filtered by visibility, feeds are chronological.**

### Core Social Tables

| Model | Role | Key Fields |
|-------|------|------------|
| `Follow` | Binary directional relationship | `followerId`, `targetType`, `targetId` |
| `Friendship` | Mutual follow pairs (ActivityPub) | `requesterId`, `addresseeId`, `status` (PENDING/ACCEPTED/BLOCKED) |
| `Post` | Authored content | `authorId`, `visibility` (PUBLIC/PRIVATE/FRIENDS/FOLLOWERS), `groupId` |
| `PostVisibilityLevel` | Enum controlling who sees a post | PUBLIC, PRIVATE, FRIENDS, FOLLOWERS |
| `Group` | Thematic collection with members | `privacy` (PUBLIC/PRIVATE/FRIENDS_ONLY), members with roles |
| `CustomAudience` | User-created distribution lists | Manual member management |
| `Privacy` | Enum for follow/profile visibility | PUBLIC, FOLLOWERS, PRIVATE |

### Denormalized State

- `User.followingCount`, `User.followersCount`
- `Entity.followersCount`
- These are maintained by follow/unfollow operations

### Feed Architecture

- `GET /api/feeds/home` — all posts from followed users/entities, chronological, cursor-paginated
- `GET /api/feeds/{entityType}/{entityId}` — posts tagged with specific entity
- `FeedStrategy` interface in extension API allows verticals to customize ranking
- Currently: pure chronological ordering

### Audience Controls

- `PostVisibilityLevel` enum: PUBLIC, PRIVATE, FRIENDS, FOLLOWERS
- `CustomAudience` + `CustomAudienceMember`: manual lists for targeted distribution
- `Group`: thematic rooms (public/private/friends-only) with member roles

---

## What Changes

### Replace: `Follow` → `Relationship`

**Current**: Binary, directional. You follow someone or you don't. No concept of closeness.

**New**: Scored, potentially bidirectional. Every relationship has a distance/strength that determines circle placement. Driven by:
- Interaction frequency (messages, reactions, comments)
- Reciprocity (mutual engagement)
- Explicit user calibration (drag someone closer/farther)
- Time decay (inactive relationships drift outward)

**Impact**: ~15+ queries throughout the codebase filter by `Follow.targetType`/`Follow.targetId`. All need to become distance-aware.

### Replace: `PostVisibilityLevel` → Posting Radius

**Current**: Author picks from an enum (PUBLIC, PRIVATE, FRIENDS, FOLLOWERS).

**New**: Author picks a radius — how far outward the post radiates. Could be discrete tiers (whisper/normal/shout) or a numeric distance threshold. The post reaches anyone within that radius on the author's social graph.

**Impact**: Post creation, post visibility filtering, feed queries, API contracts.

### Replace: Chronological Feed → Circle Views

**Current**: One feed, all followed content, newest first.

**New**: Content organized by relationship tier. Each tier is finite with a "you're caught up" endpoint. Two interaction modes:
- **Glance mode**: inner circle snapshot, ~2 minutes
- **Depth mode**: engage meaningfully with one person's or one topic's content

**Impact**: Feed endpoints, feed strategy interface, all feed-related tests.

### Absorb: `CustomAudience` → Circles

**Current**: Manual lists ("close friends," "family").

**New**: Circles are the system-level equivalent. Custom audiences may still exist for fine-grained targeting, but the primary mechanism is the relationship distance model.

### Reposition: `Group` → Coexists

Groups are thematic (a topic, an interest). Circles are relational (how close someone is to you). These are orthogonal and can coexist. A post in a group still has a posting radius within that group.

### Reposition: `Friendship` → Subsume into Relationship

The `Friendship` model (mutual follow with status) becomes a special case of `Relationship` where both parties have high reciprocity scores.

---

## What Stays

These are independent of the social graph model and survive the redesign unchanged:

| Layer | Models/Systems |
|-------|---------------|
| Identity | `User`, `Entity`, auth, sessions, MFA |
| Content | `Post` (structure), `PostComment`, `PostMedia`, `MediaFile` |
| Engagement | `PostSentiment`, `CommentSentiment` (11 emotion types) |
| Taxonomy | `TaxonomyDimension`, `TaxonomyCategory`, `TaxonomyTaxon`, tag junctions |
| Messaging | `DirectMessage` |
| Safety | `ParentalLink`, `AgeTier`, age-gating middleware, link security |
| Moderation | Content warnings, `sensitivityLevel`, deletion/audit |
| Media | Upload sessions, content-addressed storage, metadata extraction |
| Infrastructure | Feature toggles, invitations, notifications (model), admin |
| Compliance | GDPR deletion, `SecurityEvent`, `CrossRegionConsent` |

The extension architecture (TrellisExtension interface, hooks, route wrapping) also survives structurally, though some interface changes are needed (see [05-extension-impact.md](05-extension-impact.md)).

---

## Affected API Routes

### Must Redesign

| Current Endpoint | Change |
|-----------------|--------|
| `POST /api/followers/follow` | Becomes "add relationship" with initial distance |
| `POST /api/followers/unfollow` | Becomes "remove relationship" |
| `GET /api/followers/followers` | Becomes "list relationships at distance" |
| `GET /api/followers/following` | Becomes "list relationships at distance" |
| `GET /api/followers/count` | Becomes circle membership counts |
| `GET /api/feeds/home` | Replaced by circle-based views |
| `POST /api/posts` | Gains posting radius field |
| `POST /api/friends/*` | Folded into relationship model |

### Unchanged

All other routes (auth, users, comments, sentiments, media, taxonomy, notifications, admin, health, entity CRUD, DMs, groups, moderation) are unaffected.
