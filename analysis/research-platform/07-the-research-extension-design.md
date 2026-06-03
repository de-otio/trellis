# 07 — The research extension: concrete design

*Synthesis. Turns docs 03–06 into a buildable shape.*

This document sketches what a `research` extension would actually register,
which changes the **extension API** needs to support it, the **new data models**
required, and the **reproducibility / provenance** layer that makes the output
scientifically usable. It is a design sketch, not an implementation plan — the
goal is to show the pieces fit the existing seams.

## Why an extension, not a fork

Research capability is a *vertical concern* layered on the generic core — exactly
what the extension system exists for. Keeping it in a `TrellisExtension` means:

- The core stays research-agnostic; an operator who wants no research surface
  simply doesn't register the extension, and none of the read paths,
  credentials, or experiment toggles exist.
- The capability ships and versions independently of the core
  (`@de-otio/trellis-extension-*` cadence).
- The extension API's **read-only, allow-listed** posture (`ExtensionDb`,
  `ExtensionGraphService` expose no write methods) is the right default for
  something whose job is overwhelmingly to *observe*.

## What the research extension registers

Mapping onto the `TrellisExtension` interface in
`packages/extension-api/src/extension.ts`:

```text
id:           "research"
terminology:  { study / cohort / participant / instrument }

routes:       researcher-facing query API (Tier 0/1, doc 03)
              participant study dashboard (doc 06)
              oversight-board approval/halt console (doc 06)
              extract-job endpoints (reusing the export skeleton)

hooks:        onPostCreated      -> instrument: record an observation event
              onRelationshipCreated -> instrument: tie-formation event
              onScoreRecompute   -> instrument: edge-weight change event
              onEntityDeleted    -> withdrawal/exclusion handling

metadataSchema: per-study instrument config (Zod)
configSchema:   DP budget defaults, k-anonymity threshold, enclave endpoints
```

The hooks already defined (`onPostCreated`, `onEntityCreated`,
`onRelationshipCreated`, `onScoreRecompute`, `onEntityDeleted`) are, almost
exactly, the **instrumentation points** a longitudinal study needs — they fire
on the events researchers want to observe, *for consented participants only*.

## Required extension-API changes

The current surface is read-only-identity-bearing and population-global. Three
additions:

1. **A de-identifying read facet.** `ExtensionDb`/`ExtensionGraphService` return
   identity-bearing rows. Add a sibling — `ResearchDataService` — that exposes
   *only* the Tier-0/1 aggregate + de-identified read paths from docs 03 and 05
   (k-anonymised cells, DP-noised statistics, perturbed/synthetic subgraphs).
   The raw services remain unavailable to the research extension.

2. **A cohort primitive.** Add a `CohortService` to the extension context:
   define a cohort by consent (`research_participation` for study X), resolve
   membership, and scope both reads and toggle assignment to it. Cohort
   membership is *derived from consent records*, never hand-edited — so it can't
   drift away from what people agreed to. **`ageTier` filtering is enforced
   inside this primitive and fails closed** (doc 06).

3. **An experiment registry, not raw toggles.** The extension must not be handed
   `setToggle`. Instead expose an `ExperimentService` whose `assign(studyId,
   participant)` does seeded, deterministic, balanced arm assignment (doc 04)
   over a registered experiment whose treatment is drawn from an
   **allow-listed catalogue**. Treatments outside the catalogue (engagement
   ranking, infinite scroll, dark patterns) are unrepresentable. Assignment
   flips the underlying guarded toggle; the extension never touches the toggle
   directly.

These keep the **principal of least privilege** the extension API already
embodies: the research extension gets observation + consented-cohort
intervention, and *cannot* reach identities, raw graph writes, or the abandoned
behaviours.

## New data models (Prisma)

Sketch only — names indicative:

```prisma
// Generalise the existing CrossRegionConsent (doc 06)
model Consent {
  id          String   @id @default(cuid())
  userId      String
  purpose     ConsentPurpose   // CROSS_REGION | RESEARCH_OBSERVATION | RESEARCH_PARTICIPATION
  studyId     String?          // null for cross-region
  consented   Boolean
  consentedAt DateTime?
  withdrawnAt DateTime?
  ipAddress   String?
  userAgent   String?
  @@index([userId, purpose])
  @@index([studyId])
}

model Study {
  id              String   @id @default(cuid())
  title           String
  question        String
  ethicsRef       String        // IRB / oversight reference
  status          StudyStatus   // PROPOSED | APPROVED | RUNNING | HALTED | COMPLETED
  accessTier      Int           // 0..3 (doc 03)
  preregHash      String?       // pre-registration commitment (doc 04)
  approvedBy      String?
  approvedAt      DateTime?
  startsAt        DateTime?
  endsAt          DateTime?     // hard teardown (doc 04)
  registerPublic  Boolean  @default(true)  // public research register (doc 06)
}

model Experiment {
  id           String   @id @default(cuid())
  studyId      String
  treatmentKey String        // must be in the allow-listed catalogue
  toggleKey    String        // the guarded FeatureToggle it drives
  arms         Json          // arm definitions + ratios
  assignSalt   String        // seeded deterministic assignment
}

model ResearchAccessLog {   // or reuse AuditEvent with actorKind="researcher"
  id          String   @id @default(cuid())
  researcher  String
  studyId     String
  action      String        // query | extract | assign | halt
  metadata    Json          // query text, cells, suppression, epsilon spent
  at          DateTime @default(now())
}
```

The **research opt-out** is a `User` boolean alongside `analyticsOptOut`
(doc 06), checked by every Tier-0/1 aggregation.

## Reproducibility and provenance (FAIR)

A dataset or experiment is only a research contribution if someone else can
*understand and re-run* it. Reusing the export-job skeleton
(`routes/export.ts`), every research extract emits a **provenance manifest**:

- **Findable / Accessible** — stable dataset ID + DOI-style identifier; access
  terms (tier, DUA) recorded.
- **Interoperable** — documented schema; the graph **codebook** publishes the
  exact `scoring-engine.ts` edge-weight formula and `TIER_THRESHOLDS` (doc 05),
  so a weight is interpretable.
- **Reproducible** — the manifest pins: the **schema version**, the **commit
  SHA** of the platform and the research extension, the **de-identification
  transform parameters** (k, ε, generalisation levels), the **arm-assignment
  salt**, the **pre-registration hash**, and the **extract timestamp**. Given
  the manifest and a clone at that SHA, the extract is regenerable.

This is where the platform's stationary feed pays off most: "the feed behaved
as reverse-chronological per commit SHA X" is a reproducible fact, not a
disclaimer about a model that has since changed.

## A worked example

> A team studies whether a bedtime quiet-hours default reduces late-night
> posting. They submit a study; the oversight board approves it as
> minimal-risk, opt-in, adults-only, Tier-1 outcomes. A participant cohort forms
> from `research_participation` consents. The `ExperimentService` assigns arms
> (default-on vs. default-off quiet hours) by seeded hash, flipping a guarded
> `quiet_hours_default` toggle — `ageTier=TEEN/CHILD` filtered out at the cohort
> primitive. Outcome = late-night post counts, read via the DP-noised Tier-1
> aggregate API; the researcher never sees an individual's posts. The experiment
> has a hard end date; participants can withdraw from their dashboard, reverting
> their arm. On completion, an extract job emits a provenance manifest (commit
> SHAs, ε spent, assignment salt, prereg hash); a plain-language debrief lands in
> participants' dashboards; the study appears in the public register with its
> result.

Every step rides an existing seam: federation-based vetting, generalised consent,
guarded toggles, read-only de-identified facets, the export pipeline, the
deletion path, audit logging.

## Build sequence (rough)

1. Generalise `CrossRegionConsent` → `Consent` with `purpose`; add the
   research opt-out flag. *(Smallest, unblocks everything.)*
2. `Study` model + oversight approval flow + researcher credential via identity
   federation; public register read endpoint.
3. `ResearchDataService` Tier-0/1 aggregate API with k-anonymity + DP budget;
   `AuditEvent` on every query.
4. `CohortService` (consent-derived, `ageTier`-fail-closed).
5. `ExperimentService` with allow-listed treatment catalogue + seeded
   assignment, driving guarded toggles; participant dashboard + withdrawal.
6. Extract-job + provenance manifest (Tier-2 de-identified microdata; graph
   perturbation/synthesis); enclave integration last.

Each step is independently useful and independently reviewable — the
small-changes default. The ethics invariants (doc 06) are implemented *in the
credential, consent, and cohort code from step 1 onward*, not deferred to the
end.

## Open questions to resolve before building

- **Who constitutes the oversight board** for an OSS platform with multiple
  operators? Per-operator? A shared external board? This is a governance design,
  not a code one, and it gates legitimacy more than any model above.
- **DP budget accounting across studies** — is ε per-study, per-researcher, or
  global per participant? Cross-study composition is where privacy quietly
  leaks.
- **Federated populations** — the standalone-only recommendation (doc 05) needs
  validating against real research demand for cross-instance studies.
- **Does this stay a single extension** or split (observation vs.
  experimentation vs. governance console)? The governance console arguably
  belongs in core, since it constrains the extension rather than extending the
  product.

## Sources

- M. Wilkinson et al., "The FAIR Guiding Principles for scientific data
  management and stewardship", *Scientific Data*, 2016.
- Docs 03–06 of this folder; the extension interface in
  `packages/extension-api/src/extension.ts`; the export/deletion/feature-toggle
  machinery cited in [02](02-what-trellis-already-provides.md).
