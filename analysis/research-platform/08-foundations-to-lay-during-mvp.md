# 08 — Foundations to lay during the MVP

> **Status (2026-06-02):** Forward-looking. Research support is **not** in the
> MVP and should not be built now. This document identifies the small set of
> decisions that are *cheap to make now and pervasive to retrofit later* — the
> one-way doors. Everything else is deliberately deferred (see the bottom).
>
> **Update (2026-06-03) — foundations 1–8 now implemented.** All eight one-way
> doors were laid (no deferred research subsystem was built). Landed on `main`
> via the parallel plan in
> [`plans/research-foundations-mvp/`](../../plans/research-foundations-mvp/00-parallel-execution-plan.md),
> following a security review whose 10 findings were folded in (some changes
> below diverge from the original sketch as a result). Each section is annotated
> with a ✅ callout describing exactly what shipped; verified by `prisma validate`,
> a clean `tsc` on `apps/api` + `extension-api`, and 150 changed-area tests.

## The test for "do it now"

Trellis is pre-launch, so the schema, the audit conventions, and the toggle
model are still soft. That window closes at launch. A change belongs in this
document only if it passes both:

1. **Cheap now** — an added column, an open enum, a logging convention, a
   documented invariant. Not a subsystem.
2. **Expensive (or impossible) later** — retrofitting touches every row, breaks
   a uniqueness constraint, requires re-consenting users who have left, or
   needs a historical trail that was never recorded.

Things that are *expensive now and also expensive later* (the query API, the
DP engine, the cohort/experiment services) are **not** here — they wait for the
build sequence in [doc 07](07-the-research-extension-design.md). The point of
laying foundations is that when those are built, step 1 is already done.

This is the repo's recurring frame: convert a *reversible default* into a
*structural seam* while it is still cheap, before the pressure to cut a corner
arrives. (See [`enshittification-resistance/07`](../enshittification-resistance/07-binding-your-own-hands.md).)

---

## The one-way doors

### 1. Make consent a purpose-tagged record, not a residency-specific one

> **✅ Implemented (2026-06-03).** `CrossRegionConsent` generalised to an
> **append-only** `Consent` model (`ConsentPurpose` enum, `purpose`/`studyId`,
> nullable region cols). Uniqueness preserved via a **partial unique index** on
> active `CROSS_REGION` rows — a plain `@@unique([userId, purpose, studyId])`
> would *not* prevent duplicate cross-region consents because Postgres treats the
> NULL `studyId` as distinct (security-review catch). Withdrawal now **preserves
> `consentedAt`** (was being nulled, destroying the grant trail) and emits a
> `consent.changed` audit event. Migration `20260602162901_research_foundations`;
> call sites updated incl. the easily-missed `user-data-deletion.ts`.

**Highest-value change.** `CrossRegionConsent` (`prisma/schema.prisma:394`)
already models the exact shape research needs — a person granting a specific
data use, timestamped, withdrawable, with decision context — but it is welded to
data-residency: `@@unique([userId, dataRegion, accessRegion])` (`:409`) and
fields named `dataRegion`/`accessRegion`.

**Why now:** adding a `purpose` discriminator later means a data migration that
*also reshapes a uniqueness index*, plus — the part you can't fix — you cannot
retroactively obtain research consent from users who have already left. The
consent seam has to predate the users.

**Concrete change (now):** introduce the discriminator from day one, even if the
MVP only ever writes one value.

```prisma
enum ConsentPurpose { CROSS_REGION RESEARCH_OBSERVATION RESEARCH_PARTICIPATION }

model Consent {                  // generalises CrossRegionConsent
  id          String @id @default(cuid())
  userId      String
  purpose     ConsentPurpose @default(CROSS_REGION)
  studyId     String?          // null for CROSS_REGION
  // ...existing consented / consentedAt / withdrawnAt / ip / ua fields...
  @@unique([userId, purpose, studyId])   // replaces the residency-only key
}
```

The MVP keeps using it exactly as today (`purpose = CROSS_REGION`, the
residency detail moving into `metadata` or kept as columns). Nothing about MVP
behaviour changes; the door stays open.

### 2. Audit sensitive *reads* via the open `action` union (no frozen-shape change)

> **✅ Implemented (2026-06-03).** Added open `AuditAction` constants
> `research.query`, `research.extract`, `experiment.assign`,
> `feature_toggle.changed`, `consent.changed` — no foundation change, `user`
> actor reused (no `researcher` kind). `setToggle` now emits
> `feature_toggle.changed` centrally with `{ key, oldEnabled, newEnabled,
> changedBy }` where **`changedBy` is the userId, not the email** (PII), and the
> toggle key/booleans are on the PII allowlist. Audit-emit failures are now
> **observable** (stderr + metric) instead of silently swallowed; durable SQS
> delivery is deferred. The sensitive-read convention is documented with a worked
> example (full read-path retrofit deferred).

The audit vocabulary is **owned and frozen by saas-foundation**
(`packages/foundation/src/types/frozen/audit.ts`), not by trellis. The trellis
`AuditEvent` model (`prisma/schema.prisma:816`) is just the *persistence mirror*
of that frozen type. This sharpens the recommendation and corrects a tempting
mistake:

- **Do not** try to add a `"researcher"` actor. `AuditActor.kind` is a **closed**
  union (`user | service | system | anonymous`) — extending it needs a foundation
  RFC + version bump across all consumers. A researcher authenticates through an
  institutional IdP, so they are already an `actor.kind: "user"` with the
  `idp` sub-field foundation models — no new kind required.
- **Do** extend the **open** `action` union. Trellis already does this in
  `apps/api/src/lib/audit-actions.ts` (dotted `AuditAction` constants, no
  enum, no foundation change). Research actions (`research.query`,
  `research.extract`, `experiment.assign`) follow the identical pattern.
- Research-specific detail (ε spent, k threshold, query text) goes in the
  **open `metadata`** extension point — never a new frozen field.

So the *frozen shape needs no change*; foundation deliberately left `action`,
`resource.kind`, and `metadata` open precisely so consumers don't fork it.

**Why now:** an audit trail cannot be backfilled. If MVP only audits mutations,
then the day a research read path exists there is *no historical record* of who
read what before that day — and Article 40 / any IRB will ask for exactly that
trail.

**Concrete changes (now, trellis-side conventions only):**
- Establish the convention that **security-sensitive reads** (bulk reads,
  cross-user reads, export) emit an `AuditEvent` via the trellis
  `audit-composer` facade, not only writes.
- Route **feature-toggle changes through `AuditEvent`.** Today the foundation
  `FeatureToggle` records only `changedBy`/`changedAt` — the *current* state, no
  history. A future experiment registry needs the *history* of when a behaviour
  flipped. Emit a `feature_toggle.changed` `AuditEvent` on every `setToggle`
  call from the trellis service; the history is then free, with no foundation
  change.

### 3. Fix the fail-open age default

> **✅ Implemented (2026-06-03).** Added `User.ageVerified Boolean
> @default(false)`; chose the **separate flag** over an `UNKNOWN` tier so the 17
> feature-access call sites and `ageTier @default(ADULT)` stay untouched.
> Convention recorded: research/cohort queries gate on `ageVerified = true`;
> `ageTier` is never an includability signal. The product-side `ageTier`
> fail-open (a DOB-less user reads as adult) is documented as a **known, accepted
> minor-safety risk** rather than silently left.

`User.ageTier` is `AgeTier @default(ADULT)` (`:299`). For research this is a
fail-**open** default: a user whose age is unknown is treated as an adult, and a
future cohort query that filters `ageTier != ADULT` would *include* unverified
users as adults. The minor-protection invariant in [doc 06](06-ethics-consent-and-governance.md)
and [`safer-social-design/05`](../safer-social-design/05-age-verification-and-minor-safety.md)
requires the opposite.

**Why now:** the default is read into every account created before it changes;
fixing it post-launch leaves a cohort of mis-defaulted users that no later query
can safely distinguish from genuine adults.

**Concrete change (now):** make "age unknown" distinguishable from "verified
adult" — either an explicit `UNKNOWN` tier, or a separate `ageVerified` flag —
and treat unknown as **non-includable** in any future cohort. This is also a
safety win independent of research. (If product reasons require defaulting the
*feed experience* to adult, that is fine — the point is that the *research
includability* signal must fail closed, so keep the two concepts separate.)

### 4. Settle the pseudonymisation base and keep PII cleanly separable

> **✅ Implemented (2026-06-03).** `anonymousId` is now populated at account
> creation as a **KMS-keyed HMAC** (`GenerateMac`, `HMAC_SHA_256`) over
> `"trellis.user.pseudonym:" + id` — domain-separated, keyed hash of the
> immutable PK, **fail-safe** (no unkeyed fallback). KMS over an app-held salt
> per the AWS-docs consult: the key lives in a FIPS HSM and never leaves KMS.
> Documented in `apps/api/src/lib/PSEUDONYM.md` incl. a rotation-protocol stub
> (KMS HMAC keys don't auto-rotate) and the *separation-only* limitation
> (pseudonym sits beside PII in `users`; it protects exported datasets, not the
> row). No backfill (acceptable pre-launch). The pre-existing **unkeyed
> `emailHash`** (SHA-256 of email, dictionary-reversible) is flagged as a tracked
> re-identification risk to re-key or drop.

De-identification (docs 03, 05) depends on a **stable, opaque, non-PII**
per-person identifier that can be consistently salted-and-hashed. The primary
key (`@default(cuid())`) already is opaque and non-PII, and PII is separable
(`email`, `cognitoSub`, `handle`, `actorUri` are distinct fields).
`anonymousId String? @unique` (`:285`) exists but is **nullable** and not
guaranteed populated.

**Why now:** if `anonymousId` is meant to be the analytics/research handle,
populating it lazily means a future backfill and a window of null handles;
deciding the pseudonym base after launch risks ad-hoc code hashing PII directly.

**Concrete changes (now):**
- Decide the pseudonymisation base explicitly: **salted hash of the immutable
  PK**, never of PII. Document it.
- Either populate `anonymousId` at account creation (no backfill later) or drop
  it in favour of the PK-hash approach — but don't leave it as a half-built
  nullable column whose semantics are undecided.
- Keep the invariant that **no PII leaks into any identifier** used for joins
  across content (it currently doesn't — preserve that as new models are added).

### 5. Make behaviour-altering toggles distinguishable — by convention first

> **✅ Implemented (2026-06-03), with one adjustment.** Adopted **underscore**
> prefixes `ux_*` / `infra_*` / `ops_*` instead of the doc's dotted `ux.*` — the
> trellis toggle-key validator is `^[a-z0-9_]+$` and rejects dots, so dotted keys
> were infeasible without a regex change. Convention documented; existing keys
> classified, **not renamed** (that's a data migration). No foundation change.

The experiment registry (doc 07) rides on the toggle system, and the
"allowed-treatment catalogue" invariant (doc 04) depends on
behaviour-altering toggles being *distinguishable* from ops/infra flags. The
toggle store is **foundation-owned** (`packages/foundation/src/feature-toggles/`);
its `SetToggleInputSchema` is `{ key, enabled, changedBy, description }` — no
category field, and `key` is a free string.

**Why now:** once dozens of bare-boolean toggles exist with no categorisation,
sorting them into "this changes what a user sees" vs. "this enables a queue"
retroactively is error-prone — and the treatment allow-list can't be enforced
on a category that doesn't exist.

**Concrete change (now) — prefer the no-foundation-change path:**
- **Adopt a key-naming convention** in trellis: `ux.*` for user-experience /
  treatment-eligible toggles vs. `infra.*` / `ops.*` for the rest. Because
  `key` is already free-form, this needs **no foundation change** and mirrors how
  audit uses dotted `action` names. The future experiment registry filters by
  the `ux.` prefix, and the treatment allow-list is enforced over it.
- **Only if** the convention proves insufficient, propose adding an optional
  `category` (and toggle-level metadata) to the foundation toggle schema — a
  *coordinated, multi-consumer* change (see "Where each change lands" below), so
  weigh it against the naming convention first.

Do **not** build cohort targeting or arm assignment now — that's deferred. Just
make the future catalogue *expressible*, ideally without touching foundation.

### 6. Protect the reproducibility assets you already have

> **✅ Implemented (2026-06-03).** `ALLOWED_SORT_FIELDS` annotated as a
> reproducibility invariant + exported `FEED_RANKING_VERSION = 1`; a new
> invariant test pins "only `createdAt` is allowed". The append-only-timestamp
> and `createdAt`-vs-`editedAt` rules are written up in
> `apps/api/src/lib/REPRODUCIBILITY.md`. Documentation/guardrail only — no
> behaviour change.

Two existing properties are worth more to research than anything you'd add, and
the only "work" now is *not breaking them*:

- **The stationary feed.** `ALLOWED_SORT_FIELDS = ["createdAt"]` +
  `validateSortField` (`feed-pagination.ts:61`) make the feed a known, fixed
  treatment. Keep it an invariant; if ranking ever changes, make it a
  *versioned, audited* change so "the feed at commit SHA X behaved thus" stays a
  reproducible fact (doc 07's provenance manifest depends on this).
- **Immutable event timestamps.** Reproducibility needs `createdAt` to mean
  "when it happened" forever. Treat audit/event timestamps as append-only; never
  overwrite them on edit (the schema already separates `editedAt` from
  `createdAt` — preserve that separation in new models).

### 7. Treat the extension hooks as a stable contract

> **✅ Implemented (2026-06-03).** `ExtensionHooks` documented as a **versioned
> contract** (signature change ⇒ semver bump); exported `EXTENSION_API_VERSION`
> (`0.2.0`) to keep runtime/`package.json` in sync. No hook signatures changed.

A future research extension instruments via the existing
`onPostCreated` / `onRelationshipCreated` / `onScoreRecompute` /
`onEntityDeleted` hooks (`packages/extension-api/src/extension.ts`). These are
also the safety/observation instrumentation points.

**Why now:** churning hook signatures pre-1.0 is cheap, but each one that an
extension comes to depend on becomes a breaking change. **Concrete (now):** when
adding or changing these hooks during MVP, do it deliberately and version it —
don't let the instrumentation surface drift by accident.

### 8. Write the codebook as you build, not after

> **✅ Implemented (2026-06-03).** Added
> `apps/api/src/lib/graph/SCORING-CODEBOOK.md` documenting every scoring constant
> (user/entity weights, decay half-lives, engagement & connection scores,
> `TIER_THRESHOLDS`) with value + meaning + rationale and the end-to-end
> edge-weight formula; the `scoring-engine.ts` header links to it and notes the
> two must be versioned together.

Edge semantics live in `scoring-engine.ts` (reciprocity / frequency / decay
weights, `TIER_THRESHOLDS`). A research codebook (doc 05/07) must state exactly
how an edge weight is computed.

**Why now:** the rationale for each weight is in someone's head *today* and will
be archaeology in two years. **Concrete (now):** keep the scoring constants and
their meaning documented and versioned alongside the code (a short
`scoring-engine` doc-comment or sibling markdown), so the codebook is later
assembled, not reverse-engineered.

---

## Where each change lands (trellis vs. saas-foundation)

Two of the systems these foundations touch — the **audit vocabulary** and the
**feature-toggle store** — are owned by `@de-otio/saas-foundation`, a
*published, multi-consumer* package (trellis, vestibulum, and any other
vertical). That matters for the cost model: a genuine foundation change is a
coordinated version bump across **every** consumer, which is *more* expensive
than a trellis-local migration, not less. The good news is that foundation was
deliberately designed with **open extension points** (open `action` union, open
`resource.kind`, `metadata`, free-form toggle `key`) so consumers can extend
*without* touching the frozen contracts.

| # | Foundation | Primary repo | Needs a foundation change? |
|---|------------|--------------|----------------------------|
| 1 | Purpose-tagged consent | **trellis** | No — `CrossRegionConsent` is trellis-local; no consent module in foundation |
| 2 | Audit research reads | **trellis** | No — extend the open `AuditAction` union (as `audit-actions.ts` already does) + use existing `user` actor + `metadata`. A new actor *kind* would need a foundation RFC — so don't go that way |
| 3 | Age default fails closed | **trellis** | No — `User.ageTier` is trellis-local |
| 4 | Pseudonym base + PII separation | **trellis** | No — trellis-local (`User`) |
| 5 | Toggle distinguishability | **trellis** (convention) | No, if done by `ux.*` key convention. *Only* a `category` column would touch foundation |
| 6 | Stationary feed / timestamps | **trellis** | No |
| 7 | Stable hook contract | **extension-api** | No (trellis monorepo package) |
| 8 | Codebook-as-you-build | **trellis** | No |

**Bottom line:** none of the eight *requires* a saas-foundation change if you
take the open-extension-point path each time. The only place a foundation change
is even on the table is #5's optional `category` column — and the key-naming
convention is the cheaper alternative. If foundation work later proves
warranted, treat it as a coordinated RFC + multi-consumer version bump, not a
trellis-local edit.

## Cost-to-retrofit summary

| # | Foundation | Change type | Retrofit cost if skipped | Status |
|---|------------|-------------|--------------------------|--------|
| 1 | Purpose-tagged consent | Schema (enum + key) | **Severe** — migration + can't re-consent departed users | ✅ done (2026-06-03) |
| 2 | Audit research reads (open `action` + `metadata`) | Convention | **Severe** — no historical trail can be backfilled | ✅ done |
| 3 | Age default fails closed | Schema (tier/flag) | **High** — mis-defaulted cohort is indistinguishable later | ✅ done (`ageVerified`) |
| 4 | Pseudonym base + PII separation | Decision + small schema | **Medium** — backfill + risk of PII-derived IDs | ✅ done (KMS HMAC) |
| 5 | Toggle distinguishability | Convention (key prefix) | **Medium** — re-classifying flat toggles is error-prone | ✅ done (`ux_/infra_/ops_`) |
| 6 | Don't break stationary feed / timestamps | Invariant | **Low effort now, high value** | ✅ done |
| 7 | Stable hook contract | Discipline | **Low–medium** — becomes breaking changes post-1.0 | ✅ done |
| 8 | Codebook-as-you-build | Docs | **Low effort now, archaeology later** | ✅ done |

---

## Deliberately deferred (do NOT build now)

To keep the MVP honest, these are explicitly *out* — they are expensive now and
no cheaper now than later, so they wait:

- The Tier-0/1 **aggregate query API** and the **differential-privacy** engine.
- The **`CohortService`** and **`ExperimentService`** (registry, seeded arm
  assignment, allow-listed treatment catalogue).
- The **de-identifying / aggregating read facet** over `ExtensionDb` /
  `ExtensionGraphService`.
- **Researcher credentialing**, the **oversight-board console**, the
  **participant study dashboard**, and the **public research register**.
- The **sealed analysis enclave** and graph **perturbation/synthesis** pipeline.
- Any **research opt-out** UI (though note: the *flag* could piggyback on
  `analyticsOptOut` semantics later without a migration, so it is genuinely
  deferrable).

Laying foundations 1–8 means none of the deferred work requires re-touching
existing rows, re-consenting users, or reconstructing a history that was never
recorded — which is the entire reason to do them during the MVP rather than
after.
