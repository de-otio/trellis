# 02 · S2 — Ranking transparency ("why am I seeing this")

## Goal

Let a user see *why* a post is in a given circle / why a person sits in a given
tier — the one place the brief (rec 5.2) asks for more than Trellis does today.
Cheap, because the data already exists.

## Current state

- `apps/api/src/lib/graph/scoring-engine.ts` `computeScore(input)` (`:153-169`)
  returns **only a number**. The component functions exist but their outputs are
  discarded:
  - `computeDecay()` (`:210-230`), `computeEngagementDepth()` (`:241-255`),
    `computeFrequencySignal()` (`:265-271`), `connectionBonus()` (`:278-280`,
    `CONNECTION_BONUSES`: code=0.7/import=0.5/suggestion=0.3/discovery=0.3),
    `computeOwnerProximity()` (`:309-313`).
  - Weights are inline in `computeUserScore` (`:330-349`: reciprocity .25,
    frequency .20, connection .10, decay .10) and `computeEntityScore`
    (`:361-386`).
- Tier thresholds live in `scoring-engine.ts` (`:78-83`: t0≥0.7, t1≥0.4,
  t2≥0.15, t3≥0.0).
- `neo4j-graph-service.ts` `getRelationship()` (`:331-352`) returns
  `score`/`computedScore`/`manualScore`/`interactionCount`/`tier` — **no
  per-component breakdown.**

## Design

Make the breakdown a **first-class return of the scorer**, recomputed on demand
(no new stored columns):

```ts
export interface ScoreBreakdown {
  score: number;            // effective (manual override or computed)
  computedScore: number;
  manualScore: number | null;
  tier: CircleTier;
  tierThreshold: number;    // the cutoff this score cleared
  components: Array<{
    key: "reciprocity" | "frequency" | "connection" | "decay"
       | "engagementDepth" | "ownerProximity" | "contentCreation";
    weight: number;         // the inline weight, now named
    signal: number;         // the component's raw 0..1 value
    contribution: number;   // weight * signal (decay is negative)
  }>;
  ownedEntity: boolean;     // short-circuit reason (auto 1.0)
}
```

- Refactor `computeUserScore` / `computeEntityScore` to build and return a
  `ScoreBreakdown` internally; `computeScore()` keeps its `number` return for
  hot paths by reading `.score` (no caller churn), and a new
  `computeScoreBreakdown(input): ScoreBreakdown` exposes the full object. Weights
  move to a named const so they appear in the breakdown.
- `getRelationship()` gains an optional `{ explain?: boolean }`; when set it
  attaches the breakdown (recompute from the same `ScoringInput` the edge already
  carries — no extra graph round-trips beyond what scoring needs).

### API

`GET /api/relationships/:targetType/:targetId/explanation` →
`{ breakdown: ScoreBreakdown, narrative: string }` where `narrative` is a short
templated, non-PII string ("In your inner circle (tier 0): high reciprocity and
recent interaction; connected via code"). Auth: the requesting user only, for
their own relationships. Reuse the route/handler patterns in
`routes/circles.ts` + `entity-relationship-handler.ts`.

Optionally surface a per-post `whyTier` on circle-feed items (the subject
entity/author's tier + top contributing component) — additive field, behind the
same explanation builder.

## Changes

| File | Change |
|---|---|
| `apps/api/src/lib/graph/scoring-engine.ts` | extract named weights; add `computeScoreBreakdown`; `computeScore` reads `.score` |
| `apps/api/src/lib/graph/neo4j-graph-service.ts` | `getRelationship(..., {explain})` attaches breakdown |
| `apps/api/src/lib/graph/types.ts` | add `ScoreBreakdown` |
| `apps/api/src/lib/relationship-explanation-handler.ts` | **new** — narrative builder + handler |
| `apps/api/src/lib/routes/...` | register the explanation route |

## Tests

- `computeScoreBreakdown`: `sum(contribution) + base === computeScore(input)` for
  user and entity inputs (the breakdown must reconcile to the number).
- Owned-entity short-circuit ⇒ `ownedEntity:true`, score 1.0, tier 0.
- Manual override ⇒ breakdown shows `manualScore` and that it supersedes.
- Boundary: a score exactly on a tier threshold reports the correct tier +
  `tierThreshold`.
- Handler: 200 for own relationship; 403/404 for another user's; no PII in
  `narrative`.

## Effort / priority

Low. **Priority: high** — closes the single identified gap with data that already
exists; the only real work is plumbing the breakdown out without churning the
hot-path `number` return.
