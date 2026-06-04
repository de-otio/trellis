# Algorithmic Norm Misperception: What Brady et al. (2026) Means for Trellis

> **Status (2026-06-04):** Insights note. Companion document
> [`02-prelaunch-actions.md`](02-prelaunch-actions.md)
> identifies the concrete pre-launch changes. Pattern follows
> [`structural-echo-chambers.md`](../structural-echo-chambers.md) (single paper →
> architecture mapping).

## Source

Brady, W. J., Doyle, M., Elnakouri, A., Finkel, E. J., Jackson, J. C.,
Kteily, N., Parker, V., Puryear, C., Spelman, T., Teeny, J., & Torres, M.
(2026). **Redesigning algorithms to intervene on social norm misperceptions
during a national election.** *Nature*. DOI:
[10.1038/s41586-026-10536-1](https://doi.org/10.1038/s41586-026-10536-1).
Published 27 May 2026. Materials on OSF/GitHub per the article.

> ⚠️ Summarised from the abstract only. Re-verify findings against the full
> text before quoting externally — see
> [`bibliography-and-credits/`](../bibliography-and-credits/) for the citation
> workflow.

## Headline findings

Randomised field experiment: ~2,000 participants assigned to custom feed
algorithms for 8 weeks around the 2024 US presidential election.

1. **Engagement-based ranking amplified intergroup, moralized, and emotional
   content** and skewed users' perception of what normal political discourse
   looks like (norm misperception).
2. **The harm operated through exposure, not behaviour.** Users *saw* more
   extreme content but did not post more extremely themselves. The damage is
   to perceived norms — invisible to engagement metrics.
3. **A "diversified extremity" algorithm** — reducing the over-representation
   of a small set of extreme users — corrected norm perceptions **without
   reducing user satisfaction or platform enjoyment**.

Finding 3 is the commercially important one: it is peer-reviewed evidence
against the standard claim that engagement ranking is required for retention.

## Mapping to Trellis architecture

### Trellis's feed is the paper's control condition — and that is now an evidence-backed asset

The feed is reverse-chronological only, enforced at the type level
(`ALLOWED_SORT_FIELDS = ["createdAt"]`, `FEED_RANKING_VERSION = 1` —
[apps/api/src/lib/feed-pagination.ts:75](../../apps/api/src/lib/feed-pagination.ts)).
This paper upgrades that choice from "design preference" to "documented
harm-avoidance with no demonstrated retention cost." It strengthens:

- the **twiddling invariant**
  ([`enshittification-resistance/03`](../enshittification-resistance/03-twiddling-invariant.md)),
- the **stationary-feed reproducibility foundation**
  ([`research-platform/08 §6`](../research-platform/08-foundations-to-lay-during-mvp.md)),
- the **feed/scroll safety work**
  ([`safer-social-design/03`](../safer-social-design/03-feed-and-scroll-improvements.md)).

When a vertical asks for an engagement-ranked feed, this is the citation to
reach for.

### The discovery surface is the one engagement-weighted ranking Trellis has

`getRecommendations`
([apps/api/src/lib/graph/postgres/discovery.ts:258](../../apps/api/src/lib/graph/postgres/discovery.ts))
merges three signals (shared connections, same-breed, nearby), dedups **by
entity only**, and sorts by score descending — **no per-source diversity
constraint**. The relationship scoring beneath it weights engagement depth at
0.35 and frequency at 0.25
([apps/api/src/lib/graph/scoring-engine.ts](../../apps/api/src/lib/graph/scoring-engine.ts)).

Honest framing: this ranks *entities to connect with*, not posts, so the
paper's mechanism (extreme-content amplification) does not transfer directly.
The structural analogue is **rich-get-richer graph growth**: a hyper-connected
entity/owner cluster dominates everyone's recommendations, accumulates more
edges, and dominates harder. The paper's "diversified extremity" fix — cap the
over-representation of the most-connected sources — translates directly to the
merge step. (This converges with the "10% affinity floor" from
[`structural-echo-chambers.md`](../structural-echo-chambers.md) Tier 1: both are
distributional constraints on the same candidate-mixing seam.)

Mitigating factor already present: the saturating curves on engagement (k=5)
and frequency (k=20) in the scoring engine dampen raw hyper-activity — Trellis
is closer to "diversified" than a linear engagement ranker. But the final merge
still has no distributional constraint, and saturation does not prevent a
saturated hub from outranking everything else everywhere.

### Exposure shaping happens through tier assignment, not feed order

Even with a chronological feed, engagement-weighted scoring shapes **feed
composition**: scores determine circle tiers, and tiers gate what enters the
feed. The paper's exposure-not-behaviour finding means this pathway matters
even though no ordering is touched. It is not a problem today; it is the one
place where engagement signals decide what users see, and it should be named
in the scoring codebook so it stays a deliberate decision.

### Measure exposure, not engagement

The paper's harm was invisible to behavioural metrics — users' own posting
didn't change. Any future feed-quality instrumentation that only counts
engagement would miss the entire effect class. The metrics that detect it are
**exposure-distribution** metrics: share of impressions from the top-N% of
sources, Gini of impressions per source. These must be designed as
*aggregates* to stay inside the data-minimization invariant
([`enshittification-resistance/04`](../enshittification-resistance/04-data-minimization.md))
— no per-viewer impression logs.

### Ranking strategy is a per-tenant policy decision, and Trellis can host the experiment

The paper was only possible because the researchers could swap feed algorithms
under randomised assignment — exactly the seam
[`research-platform/04`](../research-platform/04-experimentation-and-field-studies.md)
designs for. Two implications:

1. **Per-tenant policy:** for a multi-tenant platform, ranking choice is a
   values/safety decision a B2B tenant may legitimately want to make
   (chronological-only), not a global tuning knob. The toggle infrastructure
   (`ux_*` prefix convention, `feature_toggle.changed` audit events — both laid
   in [`research-platform/08`](../research-platform/08-foundations-to-lay-during-mvp.md))
   is ready; no dispatch is wired, deliberately.
2. **Research instrument:** a platform that can assign feed variants per
   cohort, with consent and audit, is the instrument this paper needed. That
   is the research-platform thesis, now with a concrete *Nature* paper as the
   use-case.

## Honest caveats

- Abstract-only summary; effect sizes, the precise "diversified extremity"
  construction, and the satisfaction measures need the full text.
- The study is US political discourse during an election on a custom platform
  with ~2,000 participants; generalisation to small vertical communities is
  plausible but not shown.
- Trellis has **no engagement-ranked content feed today** — the direct
  mechanism the paper studies does not currently exist here. The insights are
  about (a) keeping it that way deliberately, (b) the discovery surface's
  rich-get-richer analogue, and (c) what to instrument before launch.
