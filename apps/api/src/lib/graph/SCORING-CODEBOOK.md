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

## 10. Keeping the Codebook in Sync

The source of truth for all values above is
`apps/api/src/lib/graph/scoring-engine.ts`.  A pointer comment at the top
of that file links here.

Whenever a constant changes in the source file, this document must be
updated in the same PR/commit.  Reviewers should check both files together.
If the rationale for a change is non-obvious, expand the relevant row in
this document before merging.
