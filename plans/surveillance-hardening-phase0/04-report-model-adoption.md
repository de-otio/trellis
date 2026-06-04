# P4 — Report Model Adoption (LinkReport fold-in)

**Recommended model:** **Opus** (data migration is irreversible once a release ships; behavior preservation is the spec)
**Effort:** ~2 days
**Blocks:** Phase 1 account reporting + moderator queue
**Branch:** `feat/P4-report-model-adoption` off `main` (requires P1 merged)

## Goal

Switch link reporting to the generalized `Report` model (P1), migrate
existing `LinkReport` rows, and drop the old table — with **zero change to
the external API behavior**. After this stage, Phase 1's account reporting
is a new `reportType`, not a new subsystem.

## Design reference

- [`08-implementation-roadmap.md §E3`](../../doc/02-technical/surveillance-threat-model/08-implementation-roadmap.md)
- [`04-account-reporting.md`](../../doc/02-technical/surveillance-threat-model/04-account-reporting.md) — the table mapping link → account reports

## Scope

### In scope

1. **Code switch**: `apps/api/src/lib/routes/link-reports.ts` (and any
   handler it delegates to) reads/writes `Report` with
   `reportType: LINK`, `resourceType: "url"`, `resourceId: <url>`;
   `domain` and other link-specific data go in the existing fields'
   equivalents (decide in-stage: dedicated nullable column vs. derived at
   query time — domain has an index today and powers
   `DomainReputationService`, so it likely stays a real column on `Report`;
   surface to P1 owner if so, per the schema-ownership rule).
2. **Data migration** (this stage's own migration, P1-owner sign-off):
   `INSERT INTO reports (...) SELECT ... FROM link_reports;` then drop
   `link_reports`. Code switch and migration land in the **same PR** so no
   release writes to a dropped table.
3. **Behavior preservation**: response shapes, status codes, rate limits
   (10/h per user), domain-reputation updates, auto-block thresholds, and
   moderator notifications (`MODERATOR_WEBHOOK_URL` / `MODERATOR_EMAILS`)
   all unchanged — **with two deliberate exceptions** (security fixes, not
   behavior drift; list them in the PR as deviations):
   - **`reason` validation**: max length (1000 chars) enforced at the Zod
     boundary. Today `reason` is stored unvalidated from `request.json()`.
   - **Notification escaping**: HTML-escape every interpolated value in
     the moderator email template (`notifyModeratorsOfAutoBlock`
     interpolates `domain` into HTML unescaped — a stored-XSS vector that
     Phase 1's attacker-authored ACCOUNT-report `reason` text would widen
     into the primary report-content path). Webhook JSON path unchanged.
4. **Reported-user erasure (GDPR Art. 17)**: extend `deleteUserData()`
   (`apps/api/src/lib/services/user-data-deletion.ts`) to **pseudonymize**
   `Report.resourceId` for ACCOUNT reports about the deleted user (replace
   with a deterministic tombstone hash). Aggregate pattern analysis
   survives; the plaintext user ID does not — "pattern analysis" is not an
   Art. 17(3) exemption. Reporter-side erasure is the P1 cascade. No
   ACCOUNT reports exist until Phase 1, but the erasure path ships with
   the model so Phase 1 can't forget it.
5. Remove the `LinkReport` Prisma model.

### Out of scope

- Account reporting endpoints (Phase 1).
- Moderator queue routes, `assignee`/`resolution` usage (Phase 1) — the
  fields exist (P1) but stay unused.
- Changing report categories, thresholds, or notification content.

## Acceptance criteria

- [ ] Full existing link-report test suite passes **unmodified** except for
      mock-model renames and the two declared exceptions (the tests are
      the behavior spec; any further semantic change is a deviation to
      flag in the PR).
- [ ] `reason` over 1000 chars rejected with a 400; notification email
      renders `<script>`-bearing `reason`/`domain` inert (escaping test).
- [ ] After `deleteUserData()` for a reported user, no Report row carries
      their plaintext ID in `resourceId`; reports filed *by* a deleted
      user are gone (cascade).
- [ ] Migration verified on a dev DB seeded with representative
      `link_reports` rows: counts match, statuses preserved, reporter FKs
      intact, `createdAt` preserved (not reset).
- [ ] `link_reports` table gone; no Prisma or code references remain
      (`grep -ri linkreport` clean, modulo migration history).
- [ ] Domain reputation + auto-block behavior verified against the new
      model (integration test).

## Test requirements

1. Existing unit tests for `link-reports.ts` green against the new model.
2. Migration test: seed → migrate → assert row-for-row equivalence
   (behavior-comparison over code-comparison).
3. Integration: report → threshold → auto-block → notification flow on the
   new model.

## Files to add/modify

| File | Action |
|---|---|
| `apps/api/src/lib/routes/link-reports.ts` | modify (model switch + reason validation + escaping) |
| `apps/api/src/lib/services/user-data-deletion.ts` | modify (resourceId pseudonymization) |
| `prisma/schema.prisma` | modify (drop `LinkReport`; possible `domain` column on `Report` — P1-owner sign-off) |
| `prisma/migrations/{ts}_fold_link_reports_into_reports/migration.sql` | new (data copy + drop; reference rollback SQL committed alongside) |
| `apps/api/test/unit/link-reports.test.ts` | modify (mock renames + the two exception tests) |
| `apps/api/test/integration/report-migration.integration.test.ts` | new (runs via `test:integration` — CI job added in P1) |

## Security considerations

security-reviewer subagent runs on this PR (data migration). Checks:

- [ ] Migration is a single transaction — no window where reports exist in
      neither table. (Prisma applies a plain DML+DDL `migration.sql` in
      one transaction on Postgres by default — verify nothing in the file
      breaks that, e.g. no `CREATE INDEX CONCURRENTLY`.)
- [ ] No widening of who can read reports: any future moderator-queue
      access control is Phase 1; this stage adds **no new read endpoints**.
- [ ] Reporter identity handling unchanged (reports contain reporter
      userId — that's existing behavior, but confirm no new exposure path).

## Rollback plan

The PR is revertible **before release**: revert code + a hand-run rollback
SQL restoring `link_reports` from `reports WHERE report_type='LINK'`.
Commit that SQL alongside the migration as a reference artifact — Prisma
migrate is **forward-only** and will never execute it; it exists for a
human operating a pre-release rollback. After a release ships, roll
forward only.

## Open questions

- `domain` column on `Report` (indexed, LINK-only, nullable) vs. a
  `details Json?` — lean to the real column (it's queried hot by
  reputation scoring); confirm with P1 owner.

## Definition of done

All acceptance criteria checked; security review clean; merged to `main`.
Phase 1 account reporting is unblocked as "add a reportType".
