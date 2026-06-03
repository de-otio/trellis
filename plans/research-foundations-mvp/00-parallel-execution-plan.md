# Parallel execution plan — research foundations during the MVP

Implements [`analysis/research-platform/08-foundations-to-lay-during-mvp.md`](../../analysis/research-platform/08-foundations-to-lay-during-mvp.md).

> **Scope discipline.** This lays the 8 "one-way-door" *foundations* only. It does
> **not** build the query API, DP engine, CohortService, ExperimentService, or any
> research UI — those are explicitly deferred (doc 08, "Deliberately deferred").
> Every change here must be cheap-now / expensive-later and leave MVP behaviour
> unchanged.

## Decisions locked (one-way doors)

- **#3 Age signal:** add a separate `ageVerified Boolean @default(false)` flag.
  Keep `ageTier @default(ADULT)` for the feed/feature experience untouched (none
  of the 17 feature-access call sites change). Research includability requires
  `ageVerified = true` — a documented convention, fail-closed.
- **#4 Pseudonym base:** define the base as `HMAC-SHA256(key, user.id)` — a keyed
  hash of the immutable PK, **never** of PII. Populate `anonymousId` at account
  creation (no backfill). Key storage hardened per the security review below.
- **Execution:** three agents in isolated git worktrees, merged on completion.

## Why three agents (file-ownership map)

The conflict surface dictates the split. Two files are touched by multiple
foundations, so those foundations must share an owner:

| File | Items that touch it | Owner |
|------|--------------------|-------|
| `prisma/schema.prisma` + `prisma/migrations/` | 1, 3, 4 | **Agent A** (migration ordering is serial; one file) |
| `apps/api/src/lambda/post-confirmation.ts` | 3, 4 | **Agent A** |
| `apps/api/src/lib/data-router.ts` | 1 | **Agent A** |
| `apps/api/src/lib/routes/admin.ts` | 2, 5 | **Agent B** |
| `apps/api/src/lib/feature-toggle-service.ts` | 2, 5 | **Agent B** |
| `apps/api/src/lib/audit-actions.ts` | 2 | **Agent B** |
| `apps/api/src/lib/feed-pagination.ts`, `extension-api/src/extension.ts`, `graph/scoring-engine.ts` | 6, 7, 8 | **Agent C** |

Agents A/B/C touch **disjoint file sets**, so worktrees merge without conflict.
None of the three depends on another's output (B/C have no dependency on A's
schema changes — they touch the already-existing `AuditEvent`/`FeatureToggle`
models and non-schema code).

## Model assignment

| Agent | Model | Rationale |
|-------|-------|-----------|
| **A — Schema & migration** | **Opus** | Irreversible migration, a uniqueness-constraint reshape with a real NULL-distinctness pitfall, and crypto (keyed hashing). Highest blast radius; the work most likely to be subtly wrong. |
| **B — Audit & toggles** | **Sonnet** | Additive constants + one audit-emission site following the existing `audit-composer` pattern, plus a naming convention. Well-scoped, pattern-following — but see the regex pitfall it must handle. |
| **C — Invariants & docs** | **Sonnet** | Doc-comments, an invariant test, a version-discipline note, and a codebook markdown. Low blast radius, no schema/crypto. |

Orchestration, the security review, and the final integration/merge are done by
the **Opus** main agent.

---

## Agent A — Schema & migration (items 1, 3, 4) · Opus · worktree

> **Security review folded in.** A grew after review (consent history, crypto
> hardening, two missed call sites). It stays **Opus**.

### A1. Purpose-tagged consent (item 1)

Generalise `CrossRegionConsent` (`prisma/schema.prisma:394-414`) → `Consent`:

```prisma
enum ConsentPurpose { CROSS_REGION RESEARCH_OBSERVATION RESEARCH_PARTICIPATION }

model Consent {
  id           String         @id @default(cuid())
  userId       String         @map("user_id")
  purpose      ConsentPurpose @default(CROSS_REGION)
  studyId      String?        @map("study_id")        // null for CROSS_REGION
  dataRegion   String?        @map("data_region")     // now nullable; only CROSS_REGION rows set it
  accessRegion String?        @map("access_region")
  consented    Boolean        @default(false)
  consentedAt  DateTime?      @map("consented_at")
  withdrawnAt  DateTime?      @map("withdrawn_at")
  ipAddress    String?        @map("ip_address")
  userAgent    String?        @map("user_agent")
  createdAt    DateTime       @default(now()) @map("created_at")
  updatedAt    DateTime       @updatedAt @map("updated_at")
  user         User           @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([consented])
  @@map("consent")
}
```

**PITFALL — uniqueness must be preserved (this is why A is Opus).** The doc
suggests `@@unique([userId, purpose, studyId])`, but for `CROSS_REGION` rows
`studyId` is NULL, and Postgres treats NULLs as *distinct* — so that constraint
would **silently fail to prevent duplicate cross-region consents**, a regression
on today's `@@unique([userId, dataRegion, accessRegion])`. Required handling:

- Keep a **partial unique index** preserving today's semantics for cross-region,
  added as raw SQL in the migration:
  `CREATE UNIQUE INDEX consent_cross_region_key ON consent (user_id, data_region, access_region) WHERE purpose = 'CROSS_REGION';`
- Add `@@unique([userId, purpose, studyId])` for research rows (where `studyId`
  is non-null, so NULL-distinctness is not in play).
- Verify the generated migration contains **both** and that the rename is an
  `ALTER TABLE ... RENAME` (data-preserving), not drop+create.

**Call-site updates** (rename `crossRegionConsent` → `consent` everywhere — these
all change in lockstep with the schema, which is why A owns every consent file):
- `data-router.ts:84-110` (`checkCrossRegionConsent`) — change
  `db.crossRegionConsent.findUnique({ where: { userId_dataRegion_accessRegion }})`
  to query the partial-unique path with `purpose: "CROSS_REGION"`.
- `tenant-scope.ts:101` — rename in the `UNSCOPED_MODELS` map.
- **`services/user-data-deletion.ts:125`** — `db.crossRegionConsent.deleteMany(...)`
  (**found by review — the plan's original "only two references" was wrong**;
  missing this breaks account deletion at runtime).
- `routes/user.ts` consent upsert handler (~`:350-380`) — see the audit-trail fix
  below. Run a case-insensitive repo-wide grep for `crossRegionConsent` before
  closing the agent.

**Security fix — consent withdrawal must not destroy its own trail (review F2, HIGH).**
The existing upsert (`routes/user.ts:367-376`) sets `consentedAt = consented ? now : null`,
so a withdrawal **nulls the original grant timestamp** — a GDPR Art. 7(1)/5(2) and
IRB failure (cannot prove when consent was validly held). Required change, in A's
scope:
- On withdrawal, set `withdrawnAt` + `consented = false` but **preserve
  `consentedAt`**; never null it.
- Treat consent as **append-only**: create a new `Consent` row per grant/withdraw
  event rather than mutating in place (the partial-unique index must therefore key
  only the *active* row — encode an `active`/`supersededAt` discriminator, or keep a
  sibling `ConsentHistory` rows pattern; pick the simplest that preserves history).
- **Emit an `AuditEvent` on every consent grant/withdraw (review F7, MEDIUM)** via
  the `audit-composer` facade, `action: "consent.changed"` (string literal — the
  named `CONSENT_CHANGED` constant is added by Agent B in `audit-actions.ts`; the
  open `AuditAction` union makes the literal typecheck without a cross-worktree
  dependency), metadata `{ purpose, studyId, consented, previousConsented }` with
  **userId, not email**. Consent change is the single most audit-critical operation.
- **Verify CSRF (review F9, LOW):** the consent endpoint (`routes/user.ts:271`)
  must carry `csrfMiddleware()` (the admin toggle routes do; confirm parity).

### A2. Fail-closed age signal (item 3)

`User` model — add alongside the existing `ageTier`:

```prisma
ageVerified Boolean @default(false) @map("age_verified")
```

- **Do not** change `ageTier @default(ADULT)` or touch the 17 feature-access call
  sites — the feed experience stays as-is (doc 08 explicitly permits this).
- In `post-confirmation.ts`, set `ageVerified: false` explicitly at creation
  (self-asserted DOB is not verification).
- Document the invariant (sibling note or schema doc-comment): **any future
  research/cohort query MUST filter `ageVerified = true`; `ageTier` is never an
  includability signal.** This is the fail-closed seam.
- **Residual risk to document, not fix (review F4, MEDIUM).** `ageTier @default(ADULT)`
  with the `age-gate-middleware.ts:28` `?? "ADULT"` fallback means a user who never
  supplies a DOB gets full *product* adult access — a COPPA / UK AADC / DSA exposure
  the locked decision deliberately leaves unchanged. A must add an explicit note that
  this product-side fail-open is a **known, accepted** minor-safety risk owned by the
  product team (optional cheap-now follow-up: an `UNKNOWN` `AgeTier` that initially
  maps to adult access but gives a no-migration path to restrict later). Do **not**
  silently leave it unflagged.

### A3. Pseudonym base + populate `anonymousId` (item 4)

- Define and document the base with **domain separation (review F1)**:
  `anonymousId = HMAC-SHA256(key, "trellis.user.pseudonym:" || user.id)` — a keyed
  MAC of the immutable PK, namespaced so the same key can never link this pseudonym
  to a future one. **Never hash PII** (`email`/`cognitoSub`/`handle`).
- **Key management — use AWS KMS HMAC keys, grounded in the AWS-knowledge consult:**
  generate the MAC with KMS `GenerateMac` (`HMAC_SHA_256`), not an app-held salt.
  The key lives in a FIPS 140-3 HSM and **never leaves KMS unencrypted**, so a
  compromised Lambda cannot exfiltrate it — strictly better than SSM SecureString
  (`user.id` is ≪ the 4 KB `GenerateMac` message limit). Grant the API task
  `kms:GenerateMac` only. (SSM SecureString is the documented fallback *if* KMS HMAC
  is unavailable in the target account — note this, don't default to it.)
- KMS HMAC keys **do not auto-rotate** (AWS docs). Document a **rotation protocol
  stub** in the sibling markdown: rotating the key requires re-deriving every
  `anonymousId` in a migration and re-keying or sealing any research dataset that
  referenced the old pseudonyms.
- Populate in `post-confirmation.ts` at account creation. `anonymousId` is already
  `String? @unique` (`:285`) and currently dead (zero reads/writes) — now always
  written at creation; **no backfill (review F10): pre-change users stay null and are
  excluded from pseudonymised datasets; acceptable pre-launch, document the bias.**
- **State the limitation plainly (review F1):** `anonymousId` is *separation-based*
  pseudonymisation — it protects datasets exported with the pseudonym **but not the
  PK**. It is **not** a row-level control: anyone with `users`-table read access sees
  PK + pseudonym together. Future per-study export should re-key:
  `study_pseudonym = HMAC(study_key, anonymousId)`.
- **Flag the pre-existing `emailHash` (review F1, HIGH-adjacent).** `email-privacy.ts:16-27`
  stores `SHA-256(email)` — an **unkeyed hash of PII**, dictionary-reversible. Out of
  this plan's edit scope, but A must record it as a tracked re-identification risk
  (re-key it with the same KMS MAC, or deprecate if unused) so it isn't mistaken for a
  privacy control.
- Preserve the invariant: no PII leaks into any join identifier.

### A verification
`npm run prisma:generate`; inspect the generated migration SQL by hand (rename +
both unique indexes + new columns); `npm test -- <consent/age tests>`; typecheck.
**Do not** run migrations against any shared DB — Skybber owns the live env
(CLAUDE.md "Deployment Status"); this lands via npm.

---

## Agent B — Audit & toggles (items 2, 5) · Sonnet · worktree

### B1. Research audit actions + audited toggle history (item 2)

- `audit-actions.ts` — add open-`action` constants following the existing dotted
  pattern (no foundation change; `AuditAction` is an open union):
  `RESEARCH_QUERY = "research.query"`, `RESEARCH_EXTRACT = "research.extract"`,
  `EXPERIMENT_ASSIGN = "experiment.assign"`, `FEATURE_TOGGLE_CHANGED = "feature_toggle.changed"`,
  and **`CONSENT_CHANGED = "consent.changed"`** (the canonical name for the literal
  Agent A emits — B owns this file so the constant lives here).
- **Do not** add a `researcher` actor kind — `AuditActor.kind` is a *closed*
  foundation union; a researcher is already `kind: "user"` with `idp`.
- Emit `feature_toggle.changed` **centrally in `feature-toggle-service.ts`'s
  `setToggle`** (not in each of the 3 `routes/admin.ts` call sites) via the
  `audit-composer` facade. The foundation `store.set` returns `{ previous, current }`
  but `setToggle` currently discards `previous` (`feature-toggle-service.ts:80`) —
  **capture it** so the event records old→new (review F3).
- **Metadata discipline (review F5/F8).** Specify the exact keys and never leak PII
  through the open `metadata`:
  - `feature_toggle.changed`: `{ key, oldEnabled, newEnabled, changedBy }` where
    **`changedBy` is the admin `userId`, not their email** (email is PII; today the
    call sites pass `user.email` — use the session `userId` for the audit metadata).
    Add `key`, `oldEnabled`, `newEnabled` to the `pii-filter.ts` allowlist explicitly.
  - For future `research.query`: **never store raw query text** (may contain PII like
    `WHERE email = …`); store a query hash/template with parameters redacted. State
    this rule in the convention doc now.
- **Audit failures must be observable, not silent (review F3, MEDIUM).** Keep emission
  off the critical path, but on `.catch(...)` increment a CloudWatch metric
  (`audit.emit.failure`) and log the payload to stderr so a compliance-grade event is
  recoverable. (Full durable at-least-once delivery via SQS is the documented
  follow-up — not built now, but the silent-swallow is replaced by observable failure.)
- Establish (as a short markdown convention + doc-comment on `audit-composer`)
  that **security-sensitive reads** (bulk, cross-user, export) emit an
  `AuditEvent`. Add one worked example; do **not** retrofit every read path (that
  is deferred). Rationale to capture: an audit trail cannot be backfilled.

### B2. Toggle distinguishability by naming convention (item 5)

- **PITFALL (this is why B is flagged):** the doc proposes dotted `ux.*` keys, but
  trellis's `FeatureToggleKeySchema` (`validation/feature-toggle-schemas.ts:45-61`)
  is `regex(/^[a-z0-9_]+$/)` — **dots are rejected.** Two valid resolutions; pick
  the underscore path by default:
  - **Preferred:** underscore prefixes `ux_*` / `infra_*` / `ops_*` (fits the
    existing validator, no schema/regex change).
  - *Only if* dotted keys are explicitly wanted: relax the regex to allow a single
    `<namespace>.` prefix — larger surface, weigh first.
- Document the convention (which prefix = treatment-eligible) in a markdown note;
  the future experiment registry filters by the `ux_` prefix and the treatment
  allow-list is enforced over it.
- **Do not rename existing persisted keys** (`posts_enabled`, `comments_enabled`,
  `global_public_posting_enabled`, etc.) — that is a data migration touching
  seeds and live toggle rows. Instead document a classification mapping (existing
  user-facing toggles are `ux`-class going forward) and apply the convention to
  *new* keys only.
- **Do not** add a `category` column to the foundation toggle schema (coordinated
  multi-consumer change) unless the convention proves insufficient.

### B verification
Unit-test the `setToggle` audit emission (asserts an `AuditEvent` row with
`action = "feature_toggle.changed"` and metadata); typecheck; existing toggle
tests stay green.

---

## Agent C — Invariants & docs (items 6, 7, 8) · Sonnet · worktree

### C1. Protect the stationary feed + immutable timestamps (item 6)

- `feed-pagination.ts:61` — add a doc-comment marking `ALLOWED_SORT_FIELDS` a
  **reproducibility invariant**; introduce `FEED_RANKING_VERSION = 1` so a future
  ranking change is a *versioned, audited* fact (doc 07's provenance manifest
  depends on this). Strengthen the existing `feed-pagination.test.ts` with an
  explicit test pinning "only `createdAt` is allowed" as the invariant.
- Add a short markdown note: event/audit `createdAt` is append-only and means
  "when it happened" forever; the `createdAt`/`editedAt` separation (present on
  `Post`, `PostComment`) must be preserved in any new model. (Documentation only —
  no schema change.)

### C2. Stable extension-hook contract (item 7)

- `extension-api/src/extension.ts` — add a doc-comment to `ExtensionHooks`
  (`onPostCreated` / `onRelationshipCreated` / `onScoreRecompute` /
  `onEntityDeleted`) declaring them a **versioned contract**: signature changes
  require an `extension-api` semver bump (currently `0.2.0`). Introduce an
  exported `EXTENSION_API_VERSION` constant mirroring `package.json`. Do **not**
  change any hook signature now (that would be the breaking change we're guarding
  against).

### C3. Codebook-as-you-build (item 8)

- Add a sibling `graph/SCORING-CODEBOOK.md` documenting every scoring constant and
  its meaning/rationale, versioned alongside the code: `USER_WEIGHTS`,
  `ENTITY_WEIGHTS`, `USER/ENTITY_DECAY_HALF_LIFE_DAYS`, `ENGAGEMENT_SCORES`,
  `CONNECTION_BONUSES`, `TIER_THRESHOLDS` (`scoring-engine.ts:31-83`). State
  exactly how an edge weight is computed so the research codebook is later
  *assembled, not reverse-engineered*.

### C verification
`npm test -- feed-pagination`; typecheck the extension-api package; markdown lints
clean.

---

## Sequencing & merge

1. Launch A, B, C concurrently in separate worktrees (`isolation: worktree`).
2. Each agent self-verifies (typecheck + its own tests) inside its worktree.
3. Merge order **A → B → C** (any order is conflict-free; A first so the Prisma
   client is regenerated before the integration typecheck).
4. **Integration gate (Opus main agent):** `npm run prisma:generate`, full
   `npm test` (foreground — never background; 4GB+/proc per CLAUDE.md), full
   typecheck, and a marker grep for the global confidentiality rule.
5. Do not commit/push unless asked.

## Security & best-practices review

A `security-reviewer` pass over this plan + the real code, plus an `aws-knowledge`
consult on the pseudonymisation primitive. All findings are folded into the agent
sections above; this is the ledger.

**AWS-grounded crypto decision (#4).** AWS KMS **HMAC keys** (`GenerateMac`/`VerifyMac`,
RFC 2104) are generated in **FIPS 140-3 HSMs and never leave KMS unencrypted** — AWS
documents them specifically for "tokenizing or signing data such as PII." This beats an
app-held salt in SSM SecureString: the key can't be exfiltrated from a compromised task.
Caveat from the docs: KMS HMAC keys **don't auto-rotate**, so a manual rotation protocol
is required (folded into A3). SSM SecureString remains the documented fallback only if
KMS HMAC is unavailable in the account.

| # | Sev | Finding | Folded into |
|---|-----|---------|-------------|
| 1 | **HIGH** | Pseudonym keyed-hash is right, but: no domain separation, no key-rotation story, sits next to PII (separation-only control), and a pre-existing **unkeyed `emailHash`** is dictionary-reversible | A3 (domain sep, KMS, rotation stub, limitation stated, `emailHash` flagged) |
| 2 | **HIGH** | Consent withdrawal nulls `consentedAt` → destroys its own GDPR/IRB trail; mutate-in-place has no history | A1 (preserve `consentedAt`, append-only rows) |
| 3 | MED | Best-effort audit silently swallows compliance-grade events; `previous` toggle state discarded | B1 (observable failure + CW metric; capture `previous`; SQS deferred) |
| 4 | MED | `ageTier @default(ADULT)` stays product-side fail-open (minor without DOB → adult access) | A2 (documented accepted risk + optional `UNKNOWN` path) |
| 5 | MED | PII can enter open audit `metadata`; research-query text especially | B1 (explicit key lists, query-text rule, allowlist edits) |
| 6 | LOW | Consent rename missed a third call site (`user-data-deletion.ts:125`) | A1 (call-site list + grep gate) |
| 7 | MED | Consent grant/withdraw emits **no** audit event today | A1 (`consent.changed` emission) |
| 8 | LOW | `changedBy` in toggle audit metadata is an email (PII) | B1 (use `userId`) |
| 9 | LOW | CSRF middleware parity unverified on consent endpoint | A1 (verify `csrfMiddleware()`) |
| 10 | LOW | No `anonymousId` backfill → research-population bias | A3 (documented, acceptable pre-launch) |

**Not changed by review:** the three locked decisions stand; HMAC-SHA256 is the correct
primitive; the NULL-distinctness partial-index analysis is correct; allowlist-based PII
filtering is sound as defence-in-depth.

## Deliberately deferred (do NOT build)

Query API, DP engine, `CohortService`, `ExperimentService`, de-identifying read
facet, researcher credentialing/console/dashboard/register, sealed enclave,
graph perturbation, research opt-out UI. (Doc 08.)
