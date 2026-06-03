# 03 — Researcher data access: tiers, de-identification, query APIs

*Regime: observation. Primary risk: re-identification.*

This document covers giving researchers access to data that already exists. The
central design tension is between **utility** (researchers want granular,
record-level data) and **disclosure risk** (granular social data re-identifies
people, even when names are stripped). The answer is not one access mode but a
**tiered ladder**, where each rung trades utility for protection and is gated by
a correspondingly stronger vetting + ethics review.

## The access ladder

| Tier | What's exposed | Disclosure risk | Gate |
|---|---|---|---|
| **0 — Public aggregates** | Pre-computed counts, distributions, time series (e.g. posts/day by content category) | Low | Open / light registration |
| **1 — Query API (no export)** | Aggregate queries over a defined schema; results capped to k-anonymous cells; no row egress | Low–medium | Vetted researcher, approved question |
| **2 — De-identified microdata** | Row-level records with identifiers removed/transformed, in a sealed enclave | Medium–high | Vetted + IRB approval + DUA |
| **3 — Consented identified data** | Record-level data on *participants who consented to this specific study* | High but consented | IRB + explicit per-study consent (doc 06) |

Tiers 0–2 are *observational* over the general population and lean on
**de-identification**; tier 3 is *consented* and leans on **informed consent**.
They are different legal and ethical bases and must not be conflated.

## Tier 1: the query API as the default

The safest useful product is a **query API that never returns rows** — only
aggregates over a fixed schema, with each output cell suppressed unless it
covers at least *k* people (k-anonymity at the output, e.g. k≥20). This is the
Meta-Content-Library / Social-Science-One model, and it has three virtues:

1. **No data leaves the platform.** Egress surface stays near zero — the thing
   doc 06 and the enshittification analysis care most about.
2. **It composes with the existing graph/SQL layer.** The aggregates can be
   computed by a read-only service over the same Neo4j/Postgres the
   `ExtensionGraphService` and `ExtensionDb` already read.
3. **It's auditable.** Every query is an `AuditEvent` (`actorKind:
   "researcher"`, `action: "query"`, `metadata: {query, cells, suppressed}`).

The hard part is **query auditing for differencing attacks**: a researcher who
runs "count of users with property A" and "count of users with property A and
B" can infer the B-status of the difference set. Defences, in increasing
strength:

- **Cell suppression** (drop cells below k) — necessary but not sufficient.
- **Query logging + rate limits** per researcher, with anomalous-query review.
- **Differential privacy on the output** — add calibrated noise to each
  released statistic under a per-researcher (or per-study) privacy budget ε.
  Social Science One released the Facebook URLs dataset this way (King &
  Persily's "differential privacy for social science" design). DP is the
  principled answer; it costs accuracy and needs careful budget accounting.

**Recommendation:** Tier 1 should be DP-by-default for any query touching
person-level attributes, with a published, per-study ε budget. Pure
content-volume time series (no person attributes) can use plain suppression.

## Tier 2: de-identified microdata in an enclave

Some research genuinely needs row-level data (sequence models of conversation,
network rewiring over time). For these, the data must be *transformed*, not just
have names dropped — naive de-identification of social data fails badly:

- **Re-identification by structure.** Narayanan & Shmatikov (2008) re-identified
  Netflix users from anonymised ratings using sparse auxiliary information;
  Backstrom, Dwork & Kleinberg (2007) showed graph structure alone can
  de-anonymise social networks. Stripping names does almost nothing if the
  *graph neighbourhood* or a few rare attributes are unique. Doc 05 treats the
  graph case specifically.

A serviceable Tier-2 transform pipeline for Trellis microdata:

1. **Drop direct identifiers** — email, handle, `cognitoSub`, `actorUri`,
   IP/UA, exact `dateOfBirth`, raw geo (`Post.geoData`). The schema already
   separates many of these (`User.emailHash`, `User.anonymousId`,
   `locationAnonymizationLevel`), which helps.
2. **Pseudonymise** stable IDs with a per-release salted hash so the same person
   is linkable *within* a release but not *across* releases (limits linkage
   attacks).
3. **Generalise quasi-identifiers** — age → age tier (the `ageTier` enum already
   does this), geo → the existing anonymization levels (100m / 1km / city),
   timestamps → coarsened buckets.
4. **Suppress rare cells** to a k-anonymity / l-diversity threshold.
5. **Optionally perturb free text** — full post text is itself an identifier
   (stylometry, quoted facts). For most studies, release *features* of text
   (length, sentiment label, topic, language) rather than raw text; release raw
   text only under Tier 3 consent.

The transformed extract lives in a **sealed analysis enclave** (a separate,
network-restricted environment; no copy-out), governed by a **Data Use
Agreement**. This is the heaviest tier and should be the exception.

## Build on what exists

- The **export job machinery** (`routes/export.ts`) is the right skeleton for
  the extract pipeline — generalise it from "one user's data" to "an
  approved, transformed cohort extract," with the de-identification transform as
  a pipeline stage and the manifest (doc 07) as an output.
- `ExtensionDb`'s **allow-list + identity-table block** is the right instinct,
  but it returns identity-bearing rows. The research read path needs a
  *de-identifying view* layered on top, not direct table access.
- Every access at every tier is an **`AuditEvent`**; tier ≥1 access requires a
  **research credential** (doc 06) distinct from a user session.

## What not to do

- **No "research mode" flag that relaxes data minimization for everyone.**
  Access is per-researcher, per-study, per-tier — never a global loosening.
- **No raw-text or raw-graph dumps** outside a consented Tier-3 study or a
  sealed Tier-2 enclave. A downloadable corpus of real users' posts is a
  re-identification incident waiting to happen, regardless of intent.
- **No silent population.** People whose data appears even in de-identified
  aggregates should be able to learn that research access exists and opt out of
  Tier ≥2 inclusion (doc 06) — analogous to `analyticsOptOut`.

## Sources

- A. Narayanan & V. Shmatikov, "Robust De-anonymization of Large Sparse
  Datasets" (Netflix Prize), *IEEE S&P*, 2008.
- L. Backstrom, C. Dwork, J. Kleinberg, "Wherefore Art Thou R3579X?
  Anonymized Social Networks…", *WWW*, 2007.
- G. King & N. Persily, "A New Model for Industry–Academic Partnerships",
  *PS: Political Science & Politics* 53(4):703–709, 2020 (the Social Science
  One / differentially private Facebook URLs dataset).
- C. Dwork & A. Roth, *The Algorithmic Foundations of Differential Privacy*,
  2014.
- L. Sweeney, "k-Anonymity", *IJUFKS*, 2002.
