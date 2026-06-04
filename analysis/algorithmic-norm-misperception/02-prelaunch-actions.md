# Norm-Misperception Findings — Changes to Make Before Go-Live

> **Status (2026-06-04):** Proposed, not implemented. Derived from
> [`01-insights.md`](01-insights.md)
> (Brady et al., *Nature* 2026, DOI
> [10.1038/s41586-026-10536-1](https://doi.org/10.1038/s41586-026-10536-1)).
> Same admission test as
> [`research-platform/08`](../research-platform/08-foundations-to-lay-during-mvp.md):
> a change belongs here only if it is **cheap now** (a small function, a
> constant, a documented invariant — not a subsystem) and **expensive or
> impossible later** (skew baked into data, a baseline that can't be
> backfilled, a pre-commitment that must predate the pressure to break it).

Trellis is pre-launch: the graph is empty, no recommendation has ever been
served, and no tenant has habituated to any ordering. Every item below
exploits exactly that window.

---

## 1. Per-source diversity cap in the recommendation merge

**The change.** `getRecommendations`
([apps/api/src/lib/graph/postgres/discovery.ts:268–282](../../apps/api/src/lib/graph/postgres/discovery.ts))
merges its three signals, dedups by entity, and sorts by global score
descending. Add a distributional constraint at that merge seam:

- cap results attributable to a single **owner** (not just entity — the three
  signals can independently surface several entities of one hyper-connected
  owner), e.g. max 2 of `limit` per owner;
- fill remaining slots by interleaving signal sources (round-robin across
  shared/breed/nearby) rather than pure score order, so one saturated signal
  cannot monopolise the page.

This is the paper's "diversified extremity" fix translated to entity
recommendations, and it is the same seam where the "10% affinity floor" from
[`structural-echo-chambers.md`](../structural-echo-chambers.md) Tier 1 would
land — implement them as one composable post-merge step, not two patches.

**Why now, not later.** This is the only item where the retrofit cost lives in
the *data*, not the code. Recommendations drive edge creation; edges drive
future recommendations (shared-connections counts seeds, owner-proximity
passes hub scores through). Launching without a cap means early hub
entities/owners compound advantage from day one, and **no later code change
removes the accumulated skew from the graph** — you can fix the ranker but not
un-create the edges it created. Pre-launch, the cap costs one function and a
test; post-launch it costs the same function plus a permanently skewed graph
and a visible re-ordering that tenants will experience as a regression.

**Scope guard.** The saturating curves in
[scoring-engine.ts](../../apps/api/src/lib/graph/scoring-engine.ts) (k=5
engagement, k=20 frequency) stay as-is — they dampen per-edge scores but
cannot constrain the *distribution* of the final page; both mechanisms are
needed.

## 2. Version the discovery ranking and extend the codebook to it

**The change.** The feed got this treatment in research-platform/08 §6/§8;
the discovery surface — the only *ranked* surface Trellis has — did not:

- export a `DISCOVERY_RANKING_VERSION = 1` next to the signal constants in
  `discovery.ts`, bumped on any change to signals, weights, or merge
  semantics (mirror of `FEED_RANKING_VERSION`,
  [feed-pagination.ts:89](../../apps/api/src/lib/feed-pagination.ts));
- extend
  [SCORING-CODEBOOK.md](../../apps/api/src/lib/graph/SCORING-CODEBOOK.md) —
  which currently documents only the relationship scoring engine — with the
  three recommendation signals and their formulas (shared = count/10, breed
  = 0.6 fixed, nearby = (1 − d/10 000) × 0.5), the merge/dedup semantics,
  and the diversity cap from item 1 once it exists.

**Why now.** Same archaeology argument as 08 §8: the rationale for `/10`,
`0.6`, and the 5 km radius is in someone's head today. And reproducibility
("recommendations at version N behaved thus") requires the version constant to
exist **before** the first served recommendation — there is no version 0 to
point at retroactively.

## 3. An exposure-distribution baseline that cannot be backfilled

**The change.** Define and start recording the *aggregate* exposure metric
before launch:

- a per-entity (or per-owner) **served-recommendation counter** — aggregate
  count only, no viewer identity, consistent with the data-minimization
  invariant
  ([`enshittification-resistance/04`](../enshittification-resistance/04-data-minimization.md));
- a documented derived metric: share of recommendation impressions going to
  the top 1% / 10% of sources (or Gini over the counters), computed from the
  aggregates.

A DynamoDB counter increment in the recommendation path plus a paragraph
defining the metric is the entire MVP scope. **No per-viewer impression logs**
— that would be the behavioural-surplus collection the platform's invariants
exist to refuse.

**Why now.** The paper's core finding is that this class of harm is invisible
to engagement metrics — only exposure distribution detects it. A baseline is
the thing that can never be backfilled: if concentration drifts post-launch,
the question "drifted from what?" has no answer unless recording predates
launch. (Identical logic to the audit-reads foundation, 08 §2.)

## 4. Write the ranking-policy floor down before anyone asks to break it

**The change.** A short addition to the tenant-policy-floor /
binding-your-own-hands docs
([`enshittification-resistance/05`](../enshittification-resistance/05-tenant-policy-floor.md),
[`07`](../enshittification-resistance/07-binding-your-own-hands.md)) stating, as
a pre-commitment:

1. **Chronological is the floor.** No tenant, extension, or experiment can
   make an engagement-ranked feed the *default* surface; ranked surfaces are
   tributaries (per the Törnberg tenet in
   [`structural-echo-chambers.md`](../structural-echo-chambers.md)).
2. Any future ranked surface must be **(a)** versioned (items above),
   **(b)** auditable (`feature_toggle.changed` history already lands this),
   **(c)** per-tenant opt-in via the reserved `ux_feed_ranking_*` toggle
   namespace, and **(d)** diversity-constrained by default — a distributional
   cap is part of the definition of a ranked surface here, not an option.
3. Cite Brady et al. as the evidence that this costs no measured
   satisfaction — the pre-commitment is cheap *because* the
   retention-pressure argument is now empirically weakened.

Reserving the `ux_feed_ranking_*` key prefix is one line in the toggle
conventions; no dispatch code is built (deliberately — see Deferred).

**Why now.** This is the repo's recurring frame verbatim: the pre-commitment
must predate the pressure. Post-launch, the first growth conversation arrives
with revenue attached; pre-launch, writing the invariant costs a paragraph and
binds nothing that currently exists.

## 5. Name the tier-assignment exposure pathway in the codebook

**The change.** One section in
[SCORING-CODEBOOK.md](../../apps/api/src/lib/graph/SCORING-CODEBOOK.md): the
scoring engine's engagement weights (0.35 depth / 0.25 frequency) do not order
the feed, but they assign circle tiers, and **tiers gate feed composition** —
this is the platform's one engagement-driven exposure mechanism. Note that
`owner_proximity` (0.15 pass-through) compounds hub effects across the graph.
No behaviour change; the point is that the pathway is a *named, deliberate*
decision a future reader can find, not an emergent one discovered in an
incident review.

**Why now.** Pure 08 §8 logic — documentation written while the rationale is
live, archaeology if deferred. Zero code.

---

## Cost-to-retrofit summary

| # | Change | Type | Retrofit cost if skipped |
|---|--------|------|--------------------------|
| 1 | Diversity cap in recommendation merge | Small code + test | **Severe** — rich-get-richer skew accumulates in graph *data*; un-removable later |
| 2 | `DISCOVERY_RANKING_VERSION` + codebook coverage | Constant + docs | **Medium** — no version 0 exists retroactively; constants become archaeology |
| 3 | Aggregate exposure baseline | Counter + metric definition | **Severe** — baseline can never be backfilled |
| 4 | Ranking-policy floor pre-commitment | Docs + reserved toggle prefix | **High** — pre-commitment after pressure arrives isn't one |
| 5 | Tier-assignment pathway named | Docs | **Low effort now, archaeology later** |

## Deliberately deferred (do NOT build now)

- **Ranking-strategy dispatch** (toggle-conditional feed ordering) — the seam
  is reserved by naming convention; building dispatch with one strategy is
  dead code.
- **Bridging score / cross-circle ranking signals**
  ([`structural-echo-chambers.md`](../structural-echo-chambers.md) Tier 1) — a
  new signal, not a constraint on existing ones; no cheaper now than later.
- **Cohort/experiment services** — already deferred in research-platform/08;
  unchanged.
- **Per-viewer impression logging** — not deferred, *refused*: it violates
  data-minimization, and item 3's aggregates provide the detection power the
  paper says is needed.
- **Re-tuning scoring-engine weights** — no evidence the current weights are
  wrong; item 5 makes them visible, which is the pre-launch obligation.

Items 1–5 together mean that if a ranked surface, a research partnership, or a
growth push arrives post-launch, the diversity constraint, the version trail,
the exposure baseline, and the policy floor are already standing — which is
the entire point of doing them while the graph is empty.
