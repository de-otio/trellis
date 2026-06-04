# Implementation Roadmap

How the gaps in files 03–07 become shippable work. The organizing principle:

> **Detection features are data-hungry.** Coordinated-behavior detection
> (03) can only see signals that were *recorded* — and today the schema
> either aggregates the temporal signal away or never captures it. The
> features themselves can wait; the **seams and data capture cannot**.
> Every month without them is a month of forensic history that can never be
> backfilled.

Trellis ships via npm and the consuming vertical applies migrations when it bumps the
dependency — so "now" means: in the next regular release(s), riding the
normal release train. Nothing here requires a special deploy.

## Phase 0 — enablers (do now, even though the features are post-MVP)

Small schema/docs changes whose absence makes later phases expensive or
impossible. None of them ship user-visible features.

> **Implementation plan:**
> [`plans/surveillance-hardening-phase0/`](../../../plans/surveillance-hardening-phase0/)
> breaks E1–E8 into 7 stages (P1 schema → P2–P7 independent), target
> release v0.9.0.

### E1. Raw interaction event log (enables 03)

**Why now:** the graph layer aggregates interactions into per-type counters
(`Relationship.signals` JSON + `interactionCount` + `lastInteractionAt`,
`prisma/schema.prisma` Relationship model;
`apps/api/src/lib/graph/postgres/scoring.ts`). Aggregation **destroys the
temporal signal** — synchronized cascades and correlated activity (the two
cheapest avatar signatures in 03) are invisible in counters. This is
irreversible: history not recorded cannot be reconstructed.

**What:** an append-only `InteractionEvent` table (actor, target, type,
`createdAt`, optional tenantId), written alongside the existing
`recordInteraction()` aggregation — not replacing it. **Retention-bound**
per the rule in [07](./07-data-minimization.md) (e.g. 90 days, pruned by the
existing hourly cron pattern, `apps/api/src/lib/security-event-cleaner.ts`
style): detection needs a window, not an archive — and an unbounded
interaction log would itself be a compellable surveillance asset.
Volume guard: sample or batch low-value event types (views) if write volume
warrants; the high-signal types (follows, DM requests, stranger comments)
are low-volume.

### E2. Signup metadata on User (enables 03 + 06)

**Why now:** the `User` model records only `createdAt` and
`emailVerified(At)`. No signup method, no invitation linkage, no client
signals. IP clustering and cohort detection — the "correlated account
clusters" signal in 03 — need data captured **at signup time**; it cannot be
backfilled.

**What:** additive nullable fields:

- `signupMethod` enum (cognito | invite | magic-link)
- `invitationId` FK (the `Invitation` model tracks redemption but is not
  linked back to the created User)
- signup client signals (IP/UA) — **not raw on User**: record a
  SecurityEvent-typed `signup` event, which already has IP/UA fields,
  `retentionUntil`, and cron cleanup. This satisfies the
  [07 client-metadata rule](./07-data-minimization.md) for free.

### E3. Generalized Report model (enables 04)

**Why now:** `LinkReport` (`prisma/schema.prisma`) is URL-specific. Account
reports (04) — and any future media/post reports — need either a parallel
table per type (proliferation + N moderation pipelines) or one polymorphic
model. Deciding the shape **before** a second report type exists avoids a
data migration later; LinkReport is small enough to fold in now.

**What:** a `Report` model with `reportType` discriminator
(LINK | ACCOUNT | …), `resourceType`/`resourceId`, reporter, reason,
`status`, and queue-ready fields (`assignee?`, `resolvedAt?`,
`resolution?`) — nullable now, used by Phase 1. Migrate LinkReport rows in,
or keep LinkReport as a view/alias during a deprecation window.

### E4. Per-tenant feature-toggle scoping (enables 06, and more)

**Why now:** the seam half-exists — `FeatureFlagsManager.getFeatureFlags()`
already accepts a `tenantId` parameter and **ignores it**
(`apps/api/src/lib/feature-flags.ts`); the `FeatureToggle` model is global
(`prisma/schema.prisma`). Per-tenant signup friction (06), per-tenant
detection thresholds (03), and per-tenant federation policy (05) all hang
off this one mechanism. Retrofitting scoping after more global toggles
accumulate only gets messier.

**What:** nullable `tenantId` on `FeatureToggle` (+ unique on
`[key, tenantId]`), service resolution: tenant-specific row → global row →
default. Existing rows stay global (tenantId NULL); no behavior change.

### E5. MODERATOR role (enables 03 + 04)

**Why now:** `UserRole` has no MODERATOR (only group-scoped
`GroupRole.MODERATOR`). Adding an enum value is a one-line migration now;
both the report queue (04) and detection-signal review (03) need a role to
authorize against. Adding it early means consuming verticals can start
assigning it before the queue ships.

### E6. ActivityPub enablement preconditions (enables 05)

**Why now:** federation is off by default and **no vertical has enabled
it** — so 05's controls cost nothing today, but become a breaking retrofit
the day after someone federates. The gate must exist before the flag is
flipped, and one technical unknown should be resolved while it's cheap.

**What:**
1. Copy the four preconditions from [05](./05-activitypub-exposure.md)
   (authorized fetch, follower-list visibility, instance deny/allow-list,
   distributed rate limiting) into
   [`architecture/07-activitypub.md`](../architecture/07-activitypub.md) as
   blocking enablement criteria.
2. **Research spike:** verify whether Fedify supports authorized fetch /
   signature-required-on-GET natively (the collections are served via
   Fedify dispatchers, `apps/api/src/lib/routes/activitypub/collections.ts`).
   If not, the cost of hand-rolled GET-signature middleware feeds into
   Phase 2 planning — better to know now.

### E7. Documentation guarantees

**Why now:** zero code, pure leverage. (a) The tracker-free extension-review
criterion from [02](./02-current-posture.md) goes into the extension docs
(`packages/extension-api/`). (b) The client-metadata storage rule from
[07](./07-data-minimization.md) goes into the development best practices.
Both prevent regressions in properties we already have.

### E8. Public-exposure hardening (enables [09](./09-public-project-exposure.md))

**Why now:** the npm tarballs are already public (compiled code + full
Prisma schema + migrations), so adversaries can inspect behavior today
regardless of repo visibility — and threat-actor orgs monitor public
projects as a matter of course.

**What:**

1. **Threshold-secrecy rule, effective immediately:** detection thresholds,
   velocity limits, and friction parameters are runtime config (E4 toggles /
   env), **never compiled-in constants**. Adopting this from the first line
   of Phase 1/2 code is free; refactoring constants out of a public package
   later is not — every published version that contained them stays
   readable forever.
2. **Supply-chain quick wins** ✅ *(done 2026-06-04)*: actions SHA-pinned in
   `ci.yml` + `publish.yml`; `.github/dependabot.yml` added (npm +
   github-actions ecosystems, weekly); vulnerability alerts + automated
   security fixes enabled on the repo. The org-shared reusable workflows
   (`de-otio/.github/...@main`) are deliberately *not* SHA-pinned —
   first-party, same-org, and meant to evolve centrally. The publish
   pipeline was already strong (Trusted Publishing OIDC, tag↔version
   check, least-privilege permissions).
3. **Go-public gate:** adopt the blocking checklist in
   [09](./09-public-project-exposure.md#the-go-public-gate) (SECURITY.md,
   CODEOWNERS, branch/tag protection, secret scanning, `--provenance`,
   history audit, maintainer 2FA) as a precondition for flipping repo
   visibility — same pattern as the federation preconditions (E6).

## Phase 1 — first features (next releases after Phase 0)

Builds directly on the seams; each item independently shippable.

| Item | Builds on | Notes |
|---|---|---|
| **Account reporting endpoint** ([04](./04-account-reporting.md)) | E3, E5 | Reuses link-report rate-limit + moderator-notification pipeline; no auto-suspend — threshold escalates to queue |
| **Minimal moderator queue** | E3, E5 | Admin routes over `Report` (list by status, assign, resolve); webhook/email notification stays (`MODERATOR_WEBHOOK_URL` / `MODERATOR_EMAILS`); in-app UI is the consuming vertical's concern |
| **Signup friction defaults** ([06](./06-registration-friction.md)) | E2, E4 | Email verification required (default on), CAPTCHA beyond invitations, signup velocity limits on the existing distributed token-bucket (`apps/api/src/lib/rate-limit.ts`) — all per-tenant-overridable via E4 |

## Phase 2 — detection & federation hardening

| Item | Builds on | Trigger |
|---|---|---|
| **Coordinated-behavior heuristics** ([03](./03-coordinated-inauthentic-behavior.md)) | E1 + E2 **with ≥ ~60–90 days of accumulated events**, E4 (thresholds), Phase 1 queue (output surface) | Schedule once event history exists — this is why E1/E2 are Phase 0 |
| **Graph-signal ⇄ report corroboration** | above + account reports | Moderator view shows both signals for a reported account |
| **ActivityPub hardening** ([05](./05-activitypub-exposure.md)): authorized fetch, follower-list visibility, instance deny/allow-list, distributed AP rate limiting — **estimate: M** (P6 spike, 2026-06-04) | E6 spike result: Fedify 1.10.6 supports authorized fetch natively (per-dispatcher `.authorize()`, since 0.7.0) but our actor/collection GETs are plain route handlers that bypass Fedify's dispatch pipeline, so it must be hand-rolled as middleware — the existing `HttpSignatureService.verifyRequest` is directly reusable, so no native drop-in (not S) yet no new crypto (not L). See [05 §Fedify authorized-fetch findings](./05-activitypub-exposure.md#fedify-authorized-fetch-findings-2026-06-04). | Only when a vertical actually wants federation — preconditions block the flag until then |

## Phase 3 — later

- **ML-based detection** — only if heuristics prove insufficient for a real
  vertical's abuse load.
- **Tenant data residency** ([07 §2](./07-data-minimization.md)) — rides the
  existing China-expansion/data-localisation roadmap; `Tenant.region`
  already exists as the seam. This threat model raises its priority but
  doesn't change its design home.

## Dependency picture

```
Phase 0 (now)          Phase 1                Phase 2
─────────────          ─────────              ─────────
E1 InteractionEvent ──────────────────────▶ 03 heuristics ──┐
E2 signup metadata  ──────────────────────▶ (need 60-90d    │
                                             of data!)      ▼
E3 Report model ────▶ account reports ────▶ corroboration view
E5 MODERATOR role ──▶ moderator queue ────▶      ▲
E4 tenant toggles ──▶ signup friction       per-tenant thresholds
E6 AP preconditions ──────────────────────▶ AP hardening (when federating)
E7 doc guarantees      (continuous review leverage)
E8 threshold-secrecy ─▶ (constrains how Phase 1/2 code is written)
   + supply chain       go-public gate (whenever visibility flips)
```

The arrows that matter most are E1/E2 → heuristics: **the Phase 2 detection
clock starts only when the Phase 0 schema lands.** Everything else can slip
without losing anything; those two lose history every day they wait.

## Out of scope for the core (any phase)

- In-app moderation **UI** — verticals own their admin frontends; the core
  ships the queue API.
- Identity verification at signup — deliberately rejected
  ([06](./06-registration-friction.md)): it harms pseudonymous at-risk users
  and creates a compellable identity trove
  ([01 §4](./01-threat-landscape.md#4-legal-compulsion)).
- Auto-suspension from reports or signals — moderator-mediated by design
  ([04](./04-account-reporting.md)).
