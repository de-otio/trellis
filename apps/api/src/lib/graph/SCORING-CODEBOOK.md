# Scoring Codebook

This file documents every scoring constant in `scoring-engine.ts` and
explains how an edge weight is computed end-to-end.  It is the authoritative
reference for research codebook assembly.  **The codebook and the source file
must be kept in sync — change one, change the other.**

Design rationale traces back to:

- `analysis/redesign/06-entities-over-people/09-scoring-without-reciprocity.md`
- `analysis/redesign/02-new-core-primitives.md`

---

## 1. Overview

Trellis maintains a weighted directed graph of relationships.  Every edge
`(viewer → target)` carries a **score** in `[0, 1]` that represents how
close/relevant the target is to the viewer.  Scores drive circle-tier
assignment (Sections 7–8), feed visibility, and discovery ranking.

Two distinct scoring formulas exist, selected by `targetType`:

| Target type | Formula name          | Key distinguishing signal |
|-------------|----------------------|--------------------------|
| `user`      | User→User (reciprocity-weighted) | Whether the relationship is mutual |
| `entity`    | User→Entity (engagement-depth-weighted) | Depth of engagement interactions |

---

## 2. Scoring Weights

### 2a. `USER_WEIGHTS` — User→User relationships

| Weight key        | Value | Meaning |
|-------------------|-------|---------|
| `reciprocity`     | 0.25  | Mutual follow/connection bonus.  Rationale: symmetric relationships are qualitatively stronger; a large weight signals that one-sided connections are meaningfully discounted. |
| `frequency`       | 0.20  | Interaction frequency signal (saturating).  Rationale: regular contact is a reliable proxy for closeness, but should not dominate — a high-frequency casual acquaintance should not outrank a low-frequency close friend. |
| `connection`      | 0.10  | Initial connection-method bonus (how the relationship was bootstrapped).  Lower weight than engagement/reciprocity because it is a one-time signal. |
| `decay`           | 0.10  | Subtracted penalty for elapsed time without interaction.  Rationale: relationships that go quiet should drift toward ambient, not stay pinned. |
| `engagement`      | 0.00  | Not used for user→user. |
| `ownerProximity`  | 0.00  | Not applicable for user targets. |
| `contentCreation` | 0.00  | Not applicable for user targets. |

**Implicit weight (0.35):** reserved for the manual calibration override.
When `manualScore` is set, the full computed formula is bypassed, so
the remaining 0.35 is "spent" on explicit user intent.

### 2b. `ENTITY_WEIGHTS` — User→Entity relationships

| Weight key        | Value | Meaning |
|-------------------|-------|---------|
| `engagement`      | 0.35  | Depth of engagement (type-weighted interaction score, saturating).  Rationale: for entities (dogs, interests, places …) depth of engagement is the primary signal of affinity — more weight than any other single factor. |
| `frequency`       | 0.25  | Raw interaction count, saturating.  Separate from engagement depth to capture volume independent of type. |
| `ownerProximity`  | 0.15  | Viewer's score with the entity's owner(s).  Rationale: "inherited closeness" — content owned by a close friend should be more prominent even with limited direct interaction. |
| `contentCreation` | 0.10  | Posts/content the viewer has created about this entity.  Strong signal of interest when not already an owner. |
| `connection`      | 0.10  | Connection-method bootstrap bonus (same semantics as user→user). |
| `decay`           | 0.05  | Elapsed-time penalty.  Lower than user→user (0.05 vs 0.10) because entity relationships are expected to be more durable (interest in a breed lasts longer than a casual acquaintance). |
| `reciprocity`     | 0.00  | Not applicable for entity targets. |

---

## 3. Decay Constants

### `USER_DECAY_HALF_LIFE_DAYS = 60`

A user→user relationship loses 50 % of its decay credit after 60 days of
inactivity.  Rationale: 60 days (≈ 2 months) is a reasonable "lapsed but not
gone" threshold for interpersonal contact; relationships with no interaction
for ~6 months approach full decay (≈ 97 %).

### `ENTITY_DECAY_HALF_LIFE_DAYS = 120`

A user→entity relationship loses 50 % of its decay credit after 120 days.
Rationale: entity affinities (breeds, hobbies, locations) are more durable
than personal contact patterns; 4 months without engagement is still
consistent with ongoing interest.

**Decay formula** (used in `computeDecay`):

```
decay_penalty = 1 - 2^(−daysSinceInteraction / halfLifeDays)
```

- At `t = 0`:  penalty = 0 (no decay)
- At `t = halfLifeDays`:  penalty = 0.5
- As `t → ∞`:  penalty → 1.0

When `lastInteractionAt` is null (never interacted), the penalty is set to
1.0 (maximum decay) — the relationship was bootstrapped but never engaged.

---

## 4. Engagement Scores (`ENGAGEMENT_SCORES`)

Per-interaction-type contribution used in `computeEngagementDepth`.
Values represent how much a single interaction of each type adds to the raw
engagement score before the saturating normalization is applied.

| Interaction type    | Score | Rationale |
|---------------------|-------|-----------|
| `view`              | 0.01  | Passive exposure; lowest signal. |
| `react`             | 0.05  | Light active engagement (likes, emoji reactions). |
| `comment`           | 0.10  | Moderate engagement requiring deliberate effort. |
| `share`             | 0.10  | Same weight as comment — sharing implies endorsement but not necessarily depth. |
| `depth_mode`        | 0.08  | "Depth mode" read (expanded/long-form view); between react and comment. |
| `profile_visit`     | 0.03  | Intentional but lightweight visit; stronger than a passive view. |
| `content_creation`  | 0.15  | Highest single-event signal — creating content about an entity or user is the strongest expression of interest. |

**Normalization** (`computeEngagementDepth`):

Raw score = Σ (engagement_score[type] × count[type])

Normalized = raw / (raw + k),   k = 5

With k = 5:

- raw = 5  → normalized ≈ 0.50
- raw = 25 → normalized ≈ 0.83

The saturation constant k = 5 ensures diminishing returns kick in after
approximately 50 equivalent-view interactions, preventing power users from
saturating every entity score.

---

## 5. Connection Bonuses (`CONNECTION_BONUSES`)

One-time additive bonus applied at relationship creation based on how the
connection was initiated.  Applied as the `connectionBonus` signal in both
scoring formulas.

| Connection method | Bonus | Rationale |
|-------------------|-------|-----------|
| `code`            | 0.7   | Scanned/entered a physical connection code — strong in-person signal. |
| `import`          | 0.5   | Imported from contacts or existing social graph — pre-existing real-world link. |
| `suggestion`      | 0.3   | Algorithmically suggested and accepted — weaker prior, relationship must be earned. |
| `discovery`       | 0.3   | Discovered through the platform (e.g. search, nearby) — same baseline as suggestion. |

---

## 6. Frequency Signal (`computeFrequencySignal`)

Saturating curve for total interaction count:

```
frequency = interactionCount / (interactionCount + k),   k = 20
```

- At 20 interactions: frequency ≈ 0.50
- At 100 interactions: frequency ≈ 0.83

k = 20 was chosen so that a moderate-use relationship (a few interactions
per month over a year) reaches mid-range without saturating, leaving room
for high-frequency relationships to differentiate.

---

## 7. Content Creation Signal (`computeContentCreationSignal`)

Saturating curve for the number of posts/content items the viewer has
created referencing this entity:

```
signal = contentCreationCount / (contentCreationCount + k),   k = 3
```

- At 3 posts: signal ≈ 0.50
- At 10 posts: signal ≈ 0.77

k = 3 was chosen because even a handful of posts about an entity is a
strong affinity signal.

---

## 8. Tier Thresholds (`TIER_THRESHOLDS`)

Scores are bucketed into four circle tiers.  The first matching threshold
(highest score first) determines the tier.

| Tier | Name         | Min score | Meaning |
|------|--------------|-----------|---------|
| 0    | Inner circle | 0.70      | Closest relationships; highest feed visibility. |
| 1    | Close friends| 0.40      | Strong relationships. |
| 2    | Community    | 0.15      | Moderate relationships; default social graph. |
| 3    | Ambient      | 0.00      | Weakest / nascent relationships; background awareness. |

Rationale for thresholds: 0.70 / 0.40 / 0.15 were calibrated to keep
inner-circle sizes small (most users have few tier-0 relationships) while
allowing community (tier-2) to be broadly inclusive.  The ambient floor at
0.0 means every connected edge is visible somewhere.

---

## 9. End-to-End Edge Weight Computation

### User→User edge

```
score = clamp(
    USER_WEIGHTS.reciprocity  * (reciprocated ? 1.0 : 0.0)
  + USER_WEIGHTS.frequency    * frequencySignal(interactionCount)
  + USER_WEIGHTS.connection   * CONNECTION_BONUSES[connectionMethod]
  - USER_WEIGHTS.decay        * decayPenalty(lastInteractionAt, now, USER_DECAY_HALF_LIFE_DAYS)
)
```

`clamp` constrains output to `[0, 1]`.

**Override:** if `manualScore` is set, it replaces the formula output
entirely (after clamp).  Owned entities (entity target only) auto-pin at 1.0
before any formula runs.

### User→Entity edge

```
score = clamp(
    ENTITY_WEIGHTS.engagement      * engagementDepth(interactionsByType)
  + ENTITY_WEIGHTS.frequency       * frequencySignal(interactionCount)
  + ENTITY_WEIGHTS.ownerProximity  * ownerProximitySignal(ownerScore)
  + ENTITY_WEIGHTS.contentCreation * contentCreationSignal(content_creation_count)
  + ENTITY_WEIGHTS.connection      * CONNECTION_BONUSES[connectionMethod]
  - ENTITY_WEIGHTS.decay           * decayPenalty(lastInteractionAt, now, ENTITY_DECAY_HALF_LIFE_DAYS)
)
```

**Tier assignment** (both formula types):

```
tier = first tier T in TIER_THRESHOLDS where score >= T.minScore
```

---

## 10. Discovery Recommendation Signals

`getRecommendations` (`apps/api/src/lib/graph/postgres/discovery.ts`) is a
**separate** scoring path from the edge-weight engine above. It does not read
`scoring-engine.ts` constants; it computes its own per-candidate signal scores,
merges them, and applies a diversity cap. This section is the authoritative
reference for those constants. Source of truth:
`apps/api/src/lib/graph/postgres/discovery.ts`.

### 10a. Signal scores

| Signal | Formula | Value range | Meaning & rationale |
|--------|---------|-------------|---------------------|
| `shared_connections` | `sharedCount / 10` | unbounded ≥ 0, clamped to 1 at the end | `sharedCount` = number of distinct seed entities (the viewer's owned + related entities) from which the candidate is reachable within a ≤ 2-hop CONFIRMED-edge traversal. Dividing by 10 means 10 shared connections saturate the signal; this keeps a single shared connection (0.1) well below the same-breed baseline while letting genuine hubs dominate. |
| `same_breed` | `0.6` (fixed) | 0.6 | Flat score for any candidate whose breed matches a breed the viewer already owns. Fixed (not graduated) because breed match is a binary affinity prior, not a strength signal — 0.6 places it above a weak shared connection but below a strong one (≥ 6 shared). |
| `nearby` | `(1 − d / 10 000) × 0.5` | (0, 0.5] within the 5 km radius | `d` = metres to the nearest of the viewer's owned entities, from PostGIS. Radius capped at `NEARBY_RECO_RADIUS_METERS = 5000` (5 km), so `d ≤ 5000` ⇒ score ∈ [0.25, 0.5]. The `× 0.5` ceiling keeps proximity strictly weaker than a strong shared-connection signal: location is a soft prior, not a strong tie. The `/10 000` denominator (not `/5000`) means even an at-the-boundary candidate retains half its weight, avoiding a hard cliff at 5 km. |
| `owner_proximity` | (pass-through) | — | Conceptually, "inherited closeness" — a candidate owned by someone the viewer is close to. In the current implementation this is **not a separately computed signal row**; it is folded into `shared_connections` (the owner relationship is one of the graph edges the shared-connection traversal already walks). It is documented here as a pass-through concept, not a query. |

### 10b. `owner_proximity` client-side mapping (security)

The `RecommendationReason` union exposed to clients is
`shared_connections | same_breed | nearby | popular_in_circle`. It deliberately
**excludes** `owner_proximity`: surfacing it would let a viewer infer that they
have a close relationship with an entity's owner even when that relationship is
not otherwise visible (graph-topology leak). Any internal `owner_proximity`
reason is therefore mapped to `shared_connections` in the response. See the
`RecommendationReason` doc comment in `graph/types.ts`.

### 10c. Merge & dedup semantics

`mergeRecommendations(signals, limit)` is a **pure function** (no I/O) so the
ordering logic is verifiable in isolation. It runs three bounded steps:

1. **Dedup by entity, keep the highest score.** An entity surfaced by multiple
   signals appears once, with the highest-scoring reason (e.g. an entity that is
   both same-breed `0.6` and a single shared connection `0.1` keeps the
   `same_breed` reason). This preserves the pre-cap semantics.
2. **Capped round-robin fill.** Sources are filled in a fixed order —
   `shared_connections → same_breed → nearby` — each pre-sorted by score
   descending. A candidate is admitted only if **every** active owner of the
   candidate is below the cap; on admit, all its owners' counts increment.
   One full cycle over all candidates.
3. **Relaxation pass.** If the page is still under `limit` after the capped
   pass, **one** relaxation pass admits the remaining skipped candidates by
   global score descending, ignoring the cap (**fill beats starve**).

Hard bound: exactly two passes, no loop on external state (the
infinite-loop-prevention rule's degenerate case — one owner owning every
candidate — is covered by unit + integration tests).

### 10d. `MAX_RECOMMENDATIONS_PER_OWNER = 2`

The per-**owner** diversity cap. Meaning: a single owner contributes at most two
recommendations to one page during the capped pass. Rationale: a hub owner
(someone who owns many discoverable entities) would otherwise fill the entire
recommendations page, narrowing the viewer's exposure to a single account — the
algorithmic-norm-misperception risk this change addresses (Brady et al., *Nature*
2026). The cap is **per-owner, not per-entity** (entity dedup is handled in step
1). A multi-owner entity counts against **every** active owner and is admitted
only if all are under the cap. Ownerless candidates (empty `ownerIds`) are
**exempt** — they cannot concentrate exposure on any account. Owner sets are
aggregated in SQL with `ARRAY_AGG(DISTINCT user_id)` over `entity_ownerships`
filtered to `status = 'ACTIVE'` and the ambient tenant (an unscoped ownership
join would be a cross-tenant read).

### 10e. `DISCOVERY_RANKING_VERSION = 1`

Mirrors `FEED_RANKING_VERSION` (`feed-pagination.ts`). Increment on any change to
the discovery signals, their weights, the merge/dedup semantics, or the cap.
A version change is a new experimental condition for
`/api/discovery/recommendations` and must be audited accordingly. **Version 1
includes the diversity cap** — it is the first version ever served, so the cap
is part of the definition of version 1, not a bump from an uncapped predecessor
(no recommendation has been served without it).

---

## 11. Exposure Pathways

This section names where engagement-derived scores actually influence what a
user sees. It exists because the platform's central invariant —
**engagement signals never order the feed covertly** — is easy to misread as
"engagement never affects exposure". It does, through one specific mechanism.
Documentation only; no behaviour change.

### 11a. The feed is never covertly engagement-ordered

`ALLOWED_SORT_FIELDS = ["createdAt"]` (`feed-pagination.ts`). The feed is
strictly chronological under ranking version 1 — the permanent default and
today the only implemented ordering. The scoring engine's heaviest entity
weights — `engagement` (0.35, depth of engagement) and `frequency` (0.25,
interaction count) — **never** appear in a sort key. No amount of engagement
reorders the timeline. `FEED_RANKING_VERSION` pins this; changing it is a new
experimental condition (Section on feed ranking in `feed-pagination.ts`).
Since the 2026-08-20 doctrine revision (`plans/pluggable-ranking/`), the
invariant is scoped precisely: declared, versioned, user-chosen alternative
rankers are permitted in principle; what stays prohibited is any ordering the
user did not choose or cannot see, and any engagement input a ranker has not
declared.

### 11b. The one engagement-driven exposure mechanism: tier assignment gates composition

Those same engagement/frequency weights **do** feed the edge score, and the edge
score assigns a **circle tier** (Section 8, `TIER_THRESHOLDS`). Tiers then gate
**feed composition** — which relationships' content is eligible to appear, and a
post's broadcast radius (`WHISPER`/`NORMAL`/`LOUD`/`SHOUT`) is matched against the
viewer's tier for the subject. So engagement does not *order* the feed, but it
*selects membership* of the candidate set via tier. This tier-assignment pathway
is the platform's single engagement-driven exposure mechanism, and naming it
keeps the "engagement never affects exposure" misreading from hiding it.

### 11c. `owner_proximity` compounds hub effects

`ENTITY_WEIGHTS.ownerProximity = 0.15` (Section 2b) is a pass-through of the
viewer's score with an entity's owner(s): content owned by a close account
inherits closeness and so reaches a higher tier. For a **hub** account (many
owned entities, many viewers close to it) this compounds — its entities are
systematically tier-promoted across many viewers. The discovery-surface
`MAX_RECOMMENDATIONS_PER_OWNER` cap (Section 10d) is the counterweight on the
*recommendation* path; the feed path's counterweight is the chronological-floor
invariant (11a). Both are deliberate limits on a single account's exposure
concentration.

---

## 12. Keeping the Codebook in Sync

The source of truth for all values above is
`apps/api/src/lib/graph/scoring-engine.ts`.  A pointer comment at the top
of that file links here.

Whenever a constant changes in the source file, this document must be
updated in the same PR/commit.  Reviewers should check both files together.
If the rationale for a change is non-obvious, expand the relevant row in
this document before merging.
