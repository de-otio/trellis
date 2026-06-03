# 04 — Experimentation and field studies

*Regime: intervention. Primary risk: harm without consent.*

The most valuable — and most dangerous — thing a platform can offer research is
the ability to **run randomised field experiments**: change something for a
randomly assigned cohort and measure the causal effect. This is how the US 2020
study produced its feed-effect estimates, and it is also the regime that
produced the field's worst ethical failure (Kramer et al. 2014). Trellis has the
mechanical pieces; the design work is almost entirely about *constraining* them.

## Why Trellis is unusually well-suited

A field experiment needs three things, and the codebase has draft versions of
all three:

1. **A defined, switchable treatment.** Feature toggles
   (`feature-toggle-service.ts`) already gate named behaviours, with
   `changedBy`/`changedAt` recorded. `activitypub/standalone-mode.ts` shows a
   whole behavioural mode gated by one toggle with graceful degradation — the
   template for an experiment arm.
2. **A stationary baseline.** Because the control feed is chronological and
   *cannot* be silently re-ranked (`feed-pagination.ts:61`), the control
   condition is genuinely fixed. On an engagement-optimised platform the
   "control" is a moving target; here it is a constant. This sharply improves
   internal validity.
3. **A cohort boundary.** Multi-tenancy + the (proposed) cohort abstraction
   (doc 07) gives a clean unit to assign arms over.

The reproducibility dividend is real: an experiment is a *named treatment flag +
an arm-assignment rule + a stationary baseline*, all version-controlled. "Re-run
study X" becomes a tractable request, not an archaeology project.

## The intervention catalogue (what's safe to vary)

Trellis's safety design also bounds *what kinds of interventions are even
expressible*, which is a feature. Reasonable, low-harm treatments map onto
existing knobs:

- **Feed regime** — finite vs. unbounded pagination, page size
  (`getPaginationConfig`); reverse-chron vs. a *declared* alternative ordering.
  (Note: introducing an engagement-ranked arm would require deliberately
  building the thing the platform refuses to build — see the constraint below.)
- **Notification policy** — quiet-hours behaviour, like/reaction notification
  suppression (the safer-social design already studies these effects:
  [`04-sentiment-and-notification-safeguards.md`](../safer-social-design/04-sentiment-and-notification-safeguards.md)).
- **Visibility / radius** — the `Post.radius` (WHISPER/NORMAL/LOUD/SHOUT)
  default offered at compose time.
- **Discovery** — whether graph-based recommendations are shown
  (`discoverByGraph`, `getRecommendations`).
- **Prosocial nudges** — content warnings, "you're caught up," friction before
  resharing (the reshare-removal arm of the US 2020 study).

**Hard constraint:** an experiment must not be a back door for building the
abandoned behaviours. An engagement-maximising-feed arm, an
infinite-scroll-for-minors arm, or a dark-pattern arm should be *unrepresentable
in the experiment registry by policy*, not merely discouraged. The registry's
allowed-treatment list is itself an enshittification invariant (doc 07).

## The consent question — the Kramer lesson

Kramer, Guillory & Hancock (PNAS 2014) manipulated the emotional valence of
~689,000 users' News Feeds without specific informed consent, relying on the
blanket Terms of Service. The backlash was severe and reshaped research ethics
for industry studies. The lesson is not "never experiment" — it is **the basis
for experimenting on someone must be appropriate to the risk.**

A workable consent model for Trellis, by intervention risk:

| Intervention class | Example | Consent basis |
|---|---|---|
| **Minimal-risk, reversible UI defaults** | Default post radius; "caught up" copy | Platform-wide A/B governance + debrief-on-request; *never* on minors |
| **Behavioural / psychological** | Notification timing, emotional-content exposure | **Prospective informed consent**, IRB-approved, opt-in cohort |
| **Anything touching minors** | Any arm affecting a CHILD/TEEN `ageTier` | **Excluded by default**; only with IRB + verified parental consent + a compelling minor-benefit rationale (see [`safer-social-design/05`](../safer-social-design/05-age-verification-and-minor-safety.md)) |

**Default stance:** experiments are **opt-in** via a consented research cohort
(doc 06), not opt-out over the whole user base. The platform's whole identity is
"we don't experiment on people to extract value"; the research framework must
not quietly create an exception. Opt-in is slower and recruits a less
representative sample — that cost is accepted on purpose.

## Pre-registration and analysis integrity

To make the experiments *credible* (not just *possible*):

- **Pre-register** the hypothesis, arms, assignment rule, primary outcome, and
  analysis plan before the toggle flips — store the registration hash in the
  experiment record so the analysis can't be silently changed post hoc (the
  garden-of-forking-paths problem).
- **Deterministic, seeded arm assignment** keyed on a per-experiment salt +
  participant pseudonym, so assignment is reproducible and balanced — and so the
  same person isn't unknowingly enrolled in conflicting concurrent arms.
- **Outcome measurement** uses the same de-identified/aggregate read paths as
  doc 03; the experimenter sees arm-level aggregates, not individual behaviour,
  unless the study is Tier-3 consented.
- **Guaranteed teardown.** Like `standalone-mode`'s graceful degradation, an
  experiment must fail *into the control behaviour*, and must have a hard end
  date after which the toggle reverts and the cohort is dissolved.

## Debriefing and participant rights

- Consented participants can see, in a study dashboard (doc 06), which
  experiments they are/were enrolled in, and **withdraw** — withdrawal reverts
  their arm immediately and excludes their data (the deletion machinery,
  `routes/deletion.ts`, scoped to the cohort).
- For minimal-risk default-level A/B tests run platform-wide, publish a public
  **experiment log** (which defaults were tested, when) — turning "we sometimes
  A/B test UI copy" from a hidden practice into a transparent, auditable one.

## Sources

- A. Kramer, J. Guillory, J. Hancock, "Experimental evidence of massive-scale
  emotional contagion through social networks", *PNAS*, 2014; and the
  subsequent editorial expression of concern.
- US 2020 Facebook & Instagram Election Study (feed and reshare interventions),
  *Science*/*Nature*, 2023.
- A. Gelman & E. Loken, "The garden of forking paths" (researcher degrees of
  freedom / pre-registration rationale), Columbia working paper, 2013; the
  peer-reviewed version is "The Statistical Crisis in Science", *American
  Scientist* 102(6):460, 2014.
- Common Rule (45 CFR 46) on minimal-risk determinations and informed consent;
  the Menlo Report (2012) for ICT-research ethics (see doc 06).
