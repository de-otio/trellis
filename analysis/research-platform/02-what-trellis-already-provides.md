# 02 — What Trellis already provides

This is an audit, not a wishlist. The point is to show how much of a research
instrument already exists in the codebase, so the later proposals read as small
deltas. Each item is grounded in a real file.

## Observation affordances

### A stationary, documented feed

`apps/api/src/lib/feed-pagination.ts:61` defines `ALLOWED_SORT_FIELDS =
["createdAt"]` and `validateSortField` (`:67`) enforces it as a type guard.
Engagement-based ranking is not a config option that's switched off — it is
*absent at the type level*. For a researcher this is the difference between
"the feed is some function of an opaque model we changed last Tuesday" and "the
feed is reverse-chronological, full stop." The treatment is known.

Age-tiered pagination (`getPaginationConfig`, `feed-pagination.ts:28`) is itself
a documented, structural behaviour (CHILD: 5 pages × 10; TEEN: 20 × 15; ADULT:
unbounded × 20) — a known finite-scroll regime rather than infinite scroll.

### A first-class social graph

`apps/api/src/lib/graph/` holds the graph layer behind the `GraphService`
interface (`graph-service.ts`), with Neo4j/Neptune backends selected by
`graph-factory.ts`. Edges are **scored and typed**, not inferred at read time:
`scoring-engine.ts` computes user→user scores (reciprocity, frequency,
connection, decay) and user→entity scores (engagement, frequency, proximity,
…). For network science this means the graph is a queryable artefact with
documented edge semantics — see doc 05.

### Intentional, documented data — and the absence of dark telemetry

Data minimization is a stated invariant (see
[`analysis/enshittification-resistance/04-data-minimization.md`](../enshittification-resistance/04-data-minimization.md)).
`User.analyticsOptOut` (`prisma/schema.prisma`) is respected by the event path.
The research consequence is double-edged and worth stating plainly: there is
**less** behavioural exhaust to mine than on a surveillance platform — but what
exists is *intentional and documented*, so a dataset drawn from Trellis comes
with a knowable provenance instead of a reverse-engineered guess.

### Export pipelines

`apps/api/src/lib/routes/export.ts` already implements asynchronous,
job-based export (`POST /api/user/export`, status polling, signed download)
in JSON and AT-Protocol formats. The machinery for *producing a documented data
bundle* — the core mechanical task of a research-data pipeline — exists; it is
currently scoped to a single user's own data.

## Consent and provenance affordances

### Consent records

`CrossRegionConsent` (`prisma/schema.prisma`) already models a consent decision
as a first-class, timestamped, withdrawable record (userId, scope, `consented`,
`consentedAt`, `withdrawnAt`, plus the IP/UA captured at decision time). It was
built for GDPR cross-region access, but its shape — *a person granted a specific
data use at a specific time and can withdraw it* — is exactly a research-consent
record. Doc 06 proposes generalising it rather than inventing a new one.

### Audit and provenance

Two audit tables exist: `SecurityEvent` and the foundation-backed `AuditEvent`
(`actorKind`, `actorId`, `action`, `resourceKind`, `resourceId`, `outcome`,
`metadata`, `retentionUntil`). Every research data access can be an `AuditEvent`,
giving the provenance trail Article 40 and any IRB will ask for, with retention
already modelled.

### Deletion and the right to withdraw

`apps/api/src/lib/routes/deletion.ts` implements a multi-step, rate-limited
account-deletion flow, and `DeletionAuditLog` keeps a tombstone after the user's
rows are gone. "A participant withdraws and their data is removed from the study"
is, mechanically, the deletion flow scoped to a cohort.

## Intervention affordances

### Feature toggles

`apps/api/src/lib/feature-toggle-service.ts` wraps the saas-foundation
`PrismaFeatureToggleStore`: `isEnabled(key)`, `setToggle(key, enabled,
changedBy, …)`, with a `FeatureToggle` model that records `changedBy`/`changedAt`.
A randomised intervention is, at bottom, "flip a named, version-controlled
behaviour for an assigned cohort and record who changed it when." The toggle is
global today; doc 04 covers what cohort-scoped assignment needs.

`activitypub/standalone-mode.ts` shows the pattern in use: a toggle
(`activitypub_standalone_mode_enabled`) gating a whole behavioural mode, with
timeout-protected graceful degradation. That is the template for a guarded
experiment arm.

## Boundary affordances

### Multi-tenancy maps onto cohorts and partners

Every content model carries `tenantId` (`Entity`, `Post`, `PostComment`,
`PostSentiment`, …) and tenants come in `PERSONAL` and `B2B` kinds with
identity federation, members, and (in Postgres) row-level security. A research
cohort, or a partner institution's enclave, maps cleanly onto a tenant boundary
— the isolation primitive already exists and is enforced at the database.

### Federation is opt-in and off by default

ActivityPub (`apps/api/src/lib/activitypub/`) is fully modelled but disabled by
default, with standalone mode available. For research this matters: a study can
run on a **non-federated** instance where the population is bounded and
consent-tracked, without leaking participant content to the fediverse mid-study.

### The extension API already has the hooks

`packages/extension-api/src/extension.ts` defines `TrellisExtension` with:

- `ExtensionDb` — *read-only*, allow-listed table access (entity, post, follow,
  taxonomy) that explicitly **blocks** user/session/encryptionKey/featureToggle.
- `ExtensionGraphService` — read-only graph queries (relationships, circles,
  discovery), no write methods.
- `ExtensionHooks` — `onPostCreated`, `onEntityCreated`,
  `onRelationshipCreated`, `onScoreRecompute`, `onEntityDeleted`.

A research extension is a natural fit for this surface: it overwhelmingly *reads
and observes*, and the hooks are exactly the instrumentation points a study
needs. The gaps (cohort scoping, consent-gated reads, experiment registration)
are enumerated in doc 07.

## The honest gaps

What does **not** exist yet, and is the subject of docs 03–07:

1. No notion of a **researcher** as a principal distinct from a user or tenant
   admin — no vetting, no scoped research credential.
2. No **de-identified / aggregated** read path; `ExtensionDb` is row-level and
   identity-bearing.
3. No **cohort** abstraction — no way to define "the consenting participants of
   study X" and scope reads/toggles to them.
4. No **experiment registry** — toggles are global booleans, not
   randomised-arm assignments with pre-registration.
5. No **research-consent** flow distinct from `CrossRegionConsent`'s
   data-residency purpose, and no participant-facing study dashboard.
6. No **dataset versioning / codebook / provenance manifest** for reproducible
   release.

The rest of the analysis takes these one regime at a time.
