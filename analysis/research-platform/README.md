# Trellis as a Research Instrument — Analysis

> **Status (2026-06-02):** Design exploration. Asks whether Trellis could become
> a useful platform for *academic research on social media* — and what a future
> `research` extension would need. No code written yet. The proposals are
> deltas against the architecture that already exists, not a verdict on it.

## What this is

Academic research on social media is in a supply crisis. The instruments that
computational social scientists relied on for a decade have been withdrawn or
priced out:

- **CrowdTangle** — Meta's public-content research tool — was shut down on
  14 August 2024 and replaced by the Meta Content Library, access to which is
  gated behind institutional vetting and a narrow API.
- **Twitter/X** ended free and academic API tiers in early 2023; the
  enterprise tier that replaced them put systematic collection out of reach for
  most university budgets.
- The **US 2020 Facebook & Instagram Election Study** (Guess, Nyhan et al.,
  *Science*/*Nature* 2023) showed what platform–academic collaboration *can*
  produce — and also how much the findings' credibility depended on Meta
  controlling the data, the instrumentation, and the analysis environment.

At the same time, the **EU Digital Services Act, Article 40** now obliges very
large platforms to give *vetted researchers* access to data for studying
systemic risks — a legal regime whose data-access delegated act was adopted on
2 July 2025, that
assumes a platform can expose research data **safely, reproducibly, and under
independent ethics review.** Most platforms were not built to do that. The
interesting question for this repo is: *what would a platform that was built to
do it look like?*

## The thesis

Trellis is, almost by accident, an unusually clean research instrument. The
design choices made for **safety** and **enshittification-resistance** are the
same choices that make a platform legible to science:

| Design choice (already in the codebase) | Why it matters for research |
|---|---|
| **Chronological-only feed**, engagement ranking blocked at the type level (`feed-pagination.ts:61`, `validateSortField`) | The feed is a *known, stationary treatment*. You can study behaviour without confounding it with an opaque, drifting ranking model. |
| **No behavioural surplus collected** (data-minimization is a stated invariant) | Less observational data, but what exists is *intentional and documented* — no dark telemetry to reverse-engineer. |
| **Scored social graph in Neo4j/Neptune** (`lib/graph/`) | The object of network science is a first-class, queryable artefact, not a derived guess. |
| **First-class consent + audit records** (`CrossRegionConsent`, `AuditEvent`, `SecurityEvent`) | The bones of participant consent and provenance tracking already exist. |
| **Export & deletion pipelines** (`routes/export.ts`, `routes/deletion.ts`) | Data egress and right-to-withdraw are solved problems, not bolt-ons. |
| **Feature toggles** (`feature-toggle-service.ts`) | Randomised field experiments need exactly this: a switch that flips a defined intervention for a defined cohort. |
| **Multi-tenancy + identity federation** | A "research cohort" or a partner institution maps cleanly onto a tenant boundary. |

So this analysis does **not** propose bolting a research product onto a
consumer app. It asks which of these latent affordances to make explicit, and
where the sharp edges are — because the sharpest edges in research-platform
design are *ethical*, not technical.

## The reframe: observation vs. intervention vs. governance

Research on a social platform splits into three regimes, each with a different
risk profile:

1. **Observation** — give researchers access to data that already exists
   (posts, graph structure, aggregate behaviour). Risk is *re-identification*.
2. **Intervention** — change something for a cohort and measure the effect
   (a feed variant, a notification rule). Risk is *harm without consent* — the
   Kramer et al. emotional-contagion lesson (PNAS 2014).
3. **Governance** — who is allowed to do 1 and 2, under what review, with what
   participant rights. Risk is *legitimacy* — a platform that experiments on
   people without independent oversight is the problem social-media research
   exists to study.

The documents are ordered to move through these regimes and end at the concrete
extension design.

## Documents

| # | Document | Regime |
|---|----------|--------|
| 01 | [The research-access crisis and the opportunity](01-the-research-access-crisis.md) | Context |
| 02 | [What Trellis already provides](02-what-trellis-already-provides.md) | Audit |
| 03 | [Researcher data access: tiers, de-identification, query APIs](03-researcher-data-access.md) | Observation |
| 04 | [Experimentation and field studies](04-experimentation-and-field-studies.md) | Intervention |
| 05 | [The social graph as a research object](05-the-social-graph-as-research-object.md) | Observation |
| 06 | [Ethics, consent, and governance](06-ethics-consent-and-governance.md) | Governance |
| 07 | [The research extension — concrete design](07-the-research-extension-design.md) | Synthesis |
| 08 | [Foundations to lay during the MVP](08-foundations-to-lay-during-mvp.md) | Now / pre-launch |

## The one tension to watch

Every affordance that makes Trellis good for research also widens the
**data-egress surface** — the thing the safety and enshittification analyses
worked hardest to keep narrow. A "research mode" that quietly relaxes
data-minimization, or an experiment framework that can change a minor's feed
without consent, would reverse the platform's best properties under the cover of
a respectable word. The defence is the same as everywhere else in this repo:
make the research capabilities **structural invariants** — opt-in, consented,
logged, ethics-gated, and visible to the participant — *before* the first
research partnership creates pressure to cut a corner. See doc 06.

## Sources

- Cory Doctorow's enshittification framing and the platform invariants are
  developed in [`analysis/enshittification-resistance/`](../enshittification-resistance/).
- Adolescent-harm research and the safety affordances cited throughout are in
  [`analysis/safer-social-design/`](../safer-social-design/).
- External references (CrowdTangle shutdown, X API changes, DSA Article 40,
  US 2020 study, Kramer et al. 2014, Salganik *Bit by Bit*, Narayanan &
  Shmatikov, FAIR principles, the Menlo Report) are cited per-document. Exact
  dates and figures should be re-verified against primary sources before any
  of this is quoted externally — see
  [`analysis/bibliography-and-credits/`](../bibliography-and-credits/) for the
  citation workflow.
