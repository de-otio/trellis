# 02 — New Core Primitives

The redesign replaces Trellis's feed/follow model with four new core primitives: **Relationships** (scored, not binary), **Circles** (relationship-depth tiers), **Posting Radius** (content radiates outward), and **Finite Views** (every content set has an endpoint).

---

## Primitive 1: Relationships

### What it replaces

`Follow` (binary, directional) and `Friendship` (mutual follow with status).

### What it is

A **scored, bidirectional relationship** between two users. The score represents social distance — how close this person is to you. Low distance = inner circle. High distance = outer circle.

### Inputs to the score

| Signal | Weight | Direction |
|--------|--------|-----------|
| **Explicit calibration** | Highest | User drags someone closer or farther in the graph view |
| **Reciprocity** | High | Both parties engage with each other, not one-sided |
| **Interaction frequency** | Medium | Messages, comments on each other's posts, reactions |
| **Interaction recency** | Medium | Recent interaction pulls closer, inactivity decays |
| **Connection method** | Initial | How the relationship started (connection code = close, discovery = far) |

### Score properties

- **Asymmetric**: Alice may consider Bob inner-circle while Bob considers Alice middle-ring. Each party has their own score for the relationship.
- **Continuous**: The score is a number, not a tier. Tiers (inner/middle/outer) are derived from configurable thresholds.
- **Decaying**: Scores drift toward a neutral baseline over time without interaction. The decay rate is slow — weeks/months, not days.
- **Bounded**: Minimum 0 (strangest stranger), maximum 1.0 (closest possible). Or inverse: 0 = closest, 1.0 = farthest. TBD — depends on what's more intuitive for queries.
- **User-visible**: Users can see and adjust their relationship graph. Transparency is a design value.

### Bootstrap problem

New users have no relationships and no score data. Options:
- Start with explicit connection codes (like current Friendship model) — anyone you connect with via code starts at a configurable default distance
- Import from contacts (with consent) to seed initial relationships
- First N interactions with any user rapidly calibrate the score (learning rate is higher for new relationships)

---

## Primitive 2: Circles

### What it replaces

The undifferentiated feed. There is no single "home feed" anymore.

### What it is

**Concentric tiers** derived from relationship scores. Each circle is a named, finite content view.

### Default tiers

| Tier | Name | Typical size | Content density | Interaction mode |
|------|------|-------------|-----------------|-----------------|
| 0 | **Inner circle** | 5–15 people | Full posts, photos, long-form | Glance + Depth |
| 1 | **Close friends** | 15–50 people | Compressed view | Glance + Depth |
| 2 | **Community** | 50–200 people | Summaries, highlights | Glance only |
| 3 | **Ambient** | 200+ people | Activity indicators, no content pulled in | Explore only |

### Properties

- **Finite**: Each circle has a definitive "you're caught up" state. This is the single most important anti-addiction feature.
- **Tier thresholds are user-configurable**: The default breakpoints between tiers can be adjusted. Some users want an inner circle of 3; others want 20.
- **Content within a tier is chronological**: No algorithmic ranking within a circle. Newest first, with cursor pagination.
- **Cross-tier content doesn't leak**: The app won't show community-tier content when you're browsing your inner circle. Deliberate friction to move outward.

### Interaction modes

**Glance mode**: A snapshot of a circle. Finite, designed for ~2 minutes. Shows the most recent N items (configurable per tier). When you've seen them all, you're done.

**Depth mode**: Engage with one person's or one topic's content meaningfully. Only available for inner circle and close friends. The app won't let you sink hours into acquaintances' content.

**Explore mode**: Consciously browse outward into community and ambient tiers. Requires an explicit action to enter. Content is sparser (summaries, not full posts).

### The "you're caught up" signal

Each circle tracks per-user read state. When all content in a circle since your last visit has been seen, the circle signals completion. This is not a suggestion — it's the UI state. There is nothing more to scroll to.

---

## Primitive 3: Posting Radius

### What it replaces

`PostVisibilityLevel` (PUBLIC, PRIVATE, FRIENDS, FOLLOWERS).

### What it is

When creating content, the author chooses **how far the post radiates** on their social graph. The metaphor is speaking at a volume:

| Radius | Metaphor | Reaches |
|--------|----------|---------|
| **Whisper** | Speaking softly | Inner circle only (tier 0) |
| **Normal** | Conversational | Close friends and inner circle (tiers 0–1) |
| **Loud** | Announcing | Community and closer (tiers 0–2) |
| **Shout** | Broadcasting | Everyone, including ambient (all tiers) |

### Properties

- **Default is Normal**, not Shout. This reverses the incentive structure of most social media, where the default is maximum visibility.
- **Radius is set at creation time** and cannot be widened after posting (can only be narrowed). This prevents "I'll post it quietly and then boost it" gaming.
- **Radius is relative to the author's graph**: A whisper from Alice reaches Alice's inner circle. Bob's inner circle may be completely different people.
- **Radius interacts with groups**: A post in a group still has a radius, but it's scoped to group members. A whisper in a group reaches only group members who are also in the author's inner circle.

### How it changes content incentives

On a feed-based platform, the rational strategy is to maximize reach — engagement-bait, controversy, emotional manipulation. With posting radius:
- Most content is naturally directed at people who care about the author
- "Going viral" isn't structurally possible for a whisper or normal post
- Shout-level posts are a deliberate choice with clear intent, not the default

---

## Primitive 4: Finite Views

### What it replaces

Infinite scroll.

### What it is

Every content view in the application has a **defined endpoint**. There is no structural possibility of zombie-scrolling.

### Mechanisms

- **Circle completion**: Each circle tracks read state and shows "you're caught up" when exhausted
- **Daily deck** (optional, per user): A configurable cap on total content items per day. When you've seen your deck, you're done. Not a time limit — a content limit.
- **Depth mode boundaries**: When engaging with one person's content in depth mode, you see their recent posts (configurable window, e.g., last 7 days). There is no "scroll back to their first post."
- **Explore mode pacing**: Community and ambient tiers show summaries, not full content. Expanding a summary counts against your daily deck if enabled.

### What this means technically

- Every content query has a mandatory `limit` and returns a `hasMore` boolean plus a `caughtUp` boolean
- The API never returns an unbounded result set
- Read state is tracked per-user, per-circle (not per-post — that doesn't scale)
- The "you're caught up" state is computed server-side, not client-side, to prevent client modifications that re-enable infinite scroll

---

## How the primitives interact

### Author-centric (basic)

```
User A creates a post with radius = Normal
  → Post is visible to User A's tiers 0 and 1

User B is in User A's tier 1 (close friends)
  → User B sees the post in their circle view
  → BUT: User B sees it in whichever tier User A falls into on User B's graph
  → If User A is in User B's tier 0 (inner circle), the post appears in B's inner circle view
  → If User A is in User B's tier 2 (community), the post appears in B's community view

The post's radius gates who CAN see it.
The viewer's relationship score with the author gates WHERE they see it.
```

### Entity-centric (for verticals like dogs, plants, cars)

For entity-centric verticals, visibility is **dual-gated** — a post can reach a viewer through a relationship with the *subject entity*, not just the author:

```
User A creates a post about Entity E (e.g., a dog) with radius = Normal

Post visible if:
  viewer has relationship with Entity E (or any subject entity)
  OR viewer has relationship with User A (the author)
  AND the closest matching relationship falls within the post's radius

User B has Entity E in inner circle (tier 0) but barely knows User A
  → User B sees the post because of their relationship with E
```

The entity path is primary in verticals where entities are the main social objects. See [Trellis entity-centric circles analysis](../../trellis/analysis/redesign/06-entities-over-people/03-entity-centric-circles.md).

### Both models share these properties:
- Authors control how far their voice carries
- Viewers see content organized by their own relationship priorities
- No one's inner circle is cluttered by someone else's shout-level broadcast (unless they're actually close)

---

## Resolved Questions

1. **Score direction**: 0.0 = farthest, 1.0 = closest. "Higher score = better relationship" is more natural in UI and queries (`ORDER BY score DESC` for "closest first").

2. **Entity relationships**: **RESOLVED.** Yes — users have scored relationships with entities. In entity-centric verticals, entity relationships are the *primary* graph axis. Scoring uses engagement depth instead of reciprocity (entities can't reciprocate). Entity-to-entity relationships (pack mates, siblings, playmates) are typed, unscored, and a separate graph layer. See [Trellis entity-over-people analysis](../../trellis/analysis/redesign/06-entities-over-people/).

3. **Co-ownership**: **RESOLVED.** Entities can have multiple owners via an EntityOwnership junction table with roles (PRIMARY_OWNER, CO_OWNER, CARETAKER). See [Trellis co-ownership analysis](../../trellis/analysis/redesign/06-entities-over-people/08-co-ownership.md).

## Open Questions

1. **Tier count**: Four tiers are proposed. Is three enough? Is five too many? The tier count affects both UI complexity and the granularity of posting radius.

2. **Group × circle interaction**: If a post is in a group AND has a radius, which wins? Current proposal: intersection (must be in the group AND within the radius). Could also be union.

3. **New user experience**: How does the app feel with 0 relationships? The bootstrap problem needs a concrete design. For entity-centric verticals, entity-first onboarding helps — see [Trellis discovery and onboarding](../../trellis/analysis/redesign/06-entities-over-people/06-discovery-and-onboarding.md).
