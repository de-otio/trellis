# P1 — Schema Enablers

**Recommended model:** **Opus** (foundational, blocks all other stages, irreversibility is the whole point)
**Effort:** ~2 days
**Blocks:** P2, P3, P4, P5
**Branch:** `feat/P1-schema-enablers` off `main`

## Goal

Land all Phase 0 schema seams in one additive migration set: the
`InteractionEvent` table, signup metadata on `User`, the generalized
`Report` model, per-tenant `FeatureToggle` scoping, and the `MODERATOR`
role. Capture/usage code is **not** in scope — P2–P5 wire it.

## Design reference

- [`08-implementation-roadmap.md §Phase 0`](../../doc/02-technical/surveillance-threat-model/08-implementation-roadmap.md) — E1–E5 rationale
- [`03-coordinated-inauthentic-behavior.md`](../../doc/02-technical/surveillance-threat-model/03-coordinated-inauthentic-behavior.md) — what the event data must support
- [`07-data-minimization.md`](../../doc/02-technical/surveillance-threat-model/07-data-minimization.md) — retention invariant

## Scope

### In scope

1. **`InteractionEvent` model** (E1):
   - `id` (cuid), `actorUserId`, `targetType` (`USER | ENTITY | POST`),
     `targetId`, `interactionType` (string — same vocabulary as
     `InteractionCounts` in `apps/api/src/lib/graph/postgres/scoring.ts`:
     view, react, comment, share, depth_mode, profile_visit,
     content_creation), `tenantId?`, `createdAt`, `expiresAt`.
   - Indexes: `[actorUserId, createdAt]`, `[targetType, targetId, createdAt]`,
     `[expiresAt]` (pruning).
   - Append-only by convention: no `updatedAt`, no update path.
   - **Erasure**: `actorUserId` FK with `onDelete: Cascade`. `targetId` has
     no FK, so cascade can't reach rows *about* a deleted user — P2 adds
     the explicit `deleteMany` to `user-data-deletion.ts` (GDPR Art. 17;
     retention aging-out is not prompt erasure).
2. **`User` signup metadata** (E2), all nullable/additive:
   - `signupMethod` enum `SignupMethod { COGNITO | INVITE | MAGIC_LINK }`
   - `invitationId String? @map("invitation_id")` FK → `Invitation`
   - **No IP/UA columns on User** — client signals go to `SecurityEvent`
     (P3), which already has retention.
3. **`Report` model** (E3):
   - `reportType` enum `ReportType { LINK | ACCOUNT }`, `resourceType`,
     `resourceId`, `reporterUserId`, `reason?`, `status`
     (default `"pending"`), `assigneeUserId?`, `resolvedAt?`,
     `resolution?`, `createdAt`.
   - Indexes: `[reportType, status]`, `[resourceType, resourceId]`,
     `[reporterUserId]`.
   - **Erasure**: `reporterUserId` FK with `onDelete: Cascade` (matches the
     current `LinkReport` behavior — a deleted reporter's reports go with
     them). Erasure of the *reported* user (ACCOUNT `resourceId`) is
     handled by pseudonymization in P4.
   - `LinkReport` is **untouched** in this stage (P4 folds it in).
4. **`FeatureToggle.tenantId`** (E4): nullable `tenantId` column. Replace
   `@unique` on `key` with `@@unique([key, tenantId])` **plus** a raw
   partial unique index in the migration SQL:
   `CREATE UNIQUE INDEX feature_toggles_key_global ON feature_toggles(key) WHERE tenant_id IS NULL;`
   (Postgres treats NULLs as distinct — without the partial index,
   duplicate global rows for the same key would be allowed.)
   Hand-edited migration SQL has direct precedent:
   `prisma/migrations/20260602162901_research_foundations/migration.sql`
   ships a partial unique index. Caveat from that precedent: the partial
   index is not expressible in `schema.prisma`, so document it in the
   migration (and schema comment) to avoid a later `prisma migrate dev`
   treating it as drift.
5. **`MODERATOR`** added to the `UserRole` enum (E5).
6. **`SecurityEvent.retentionUntil` tightened to non-nullable** (currently
   `DateTime?`): rows with NULL escape the hourly-cron pruning forever —
   exactly the unbounded client-metadata log the threat model forbids, and
   P3 is about to write IP/UA rows into this table. Audit all existing
   `SecurityEvent` writers (fix any that omit it), backfill NULL rows in
   the migration (`createdAt + 365 days`), then add `NOT NULL`. Same
   principle as `InteractionEvent.expiresAt`.
7. `npm run prisma:generate`; seed fixtures updated if any reference the
   changed models.
8. **CI gates** (plan-wide enabler, see README §Test-first invariant):
   - **Coverage**: run `npm run test:coverage` against the current `main`
     baseline; if the global 80% thresholds in `vitest.config.ts` pass,
     add the coverage run to `ci.yml`; if not, add a CI-scoped config that
     enforces 80% on this plan's new files and record the baseline gap in
     the PR body.
   - **Schema/integration suites**: `npm test` excludes
     `test/integration/**`, and no CI job runs `test:schema` or
     `test:integration` today — this plan's schema-shape and integration
     tests would otherwise never execute in CI. Add a `test:schema` job to
     `ci.yml` (mirror the existing `graph` job's Postgres service
     container); extend to `test:integration` if runtime allows.

### Out of scope

- Writing `InteractionEvent` rows (P2), signup capture (P3), Report usage +
  LinkReport fold-in (P4), toggle-service resolution (P5).
- Any detection logic, thresholds, or moderator routes (Phase 1/2).

## Acceptance criteria

- [ ] `npm run prisma:migrate:dev` clean on a fresh dev database; migration
      re-run is a no-op.
- [ ] `tsc --noEmit` clean; existing test suite green (changes are
      additive — nothing existing should break, unlike a destructive
      migration).
- [ ] Partial unique index verified in `psql`: inserting two global rows
      with the same toggle `key` fails; same `key` under two different
      tenants succeeds.
- [ ] FK integrity: `InteractionEvent.actorUserId` and
      `Report.reporterUserId` reject non-existent users.
- [ ] `expiresAt` is **non-nullable** on `InteractionEvent` (retention is
      not optional — see security checks).

## Test requirements

Schema-shape tests in `apps/api/test/integration/schema/` (pattern:
`tenant-shape.integration.test.ts`; run via `npm run test:schema` /
`vitest.schema.config.ts` — the `.integration.` infix and directory are
load-bearing, the config's include glob is
`test/integration/schema/**/*.test.ts`):

1. `interaction-event-shape.integration.test.ts` — columns, non-nullable
   `expiresAt`, indexes, `onDelete: Cascade` on `actorUserId`.
2. `report-shape.integration.test.ts` — discriminator + polymorphic
   fields, queue-ready fields nullable, reporter cascade.
3. `feature-toggle-scope.integration.test.ts` — the two unique-constraint
   behaviors above (real Postgres via Docker Compose).
4. `user-signup-metadata.integration.test.ts` — nullable fields,
   `invitationId` FK, `SecurityEvent.retentionUntil` NOT NULL.

## Files to add/modify

| File | Action |
|---|---|
| `prisma/schema.prisma` | modify (additive + `SecurityEvent.retentionUntil` NOT NULL) |
| `prisma/migrations/{ts}_surveillance_phase0_enablers/migration.sql` | new (includes the raw partial index + retentionUntil backfill) |
| `.github/workflows/ci.yml` | modify (coverage gate + `test:schema` job) |
| `apps/api/test/integration/schema/interaction-event-shape.integration.test.ts` | new |
| `apps/api/test/integration/schema/report-shape.integration.test.ts` | new |
| `apps/api/test/integration/schema/feature-toggle-scope.integration.test.ts` | new |
| `apps/api/test/integration/schema/user-signup-metadata.integration.test.ts` | new |

## Security considerations

security-reviewer subagent runs on this PR. Specific checks:

- [ ] `InteractionEvent` has **no free-text/content column** — event type +
      references only. The table must be useless as a content archive.
- [ ] `expiresAt` non-nullable; `SecurityEvent.retentionUntil` non-nullable
      after this migration; no schema path to an unbounded behavioral log
      (data-minimization invariant).
- [ ] No raw IP/UA columns added to `User` or `InteractionEvent`.
- [ ] `Report.resourceId` is an opaque string — no FK to `User` for
      ACCOUNT reports (reported account may be deleted; aggregate pattern
      analysis survives via **pseudonymized** resourceId, see P4 — not via
      retained plaintext user IDs).
- [ ] Erasure paths complete: cascades on `actorUserId`/`reporterUserId`
      verified; non-FK reference cleanup (`InteractionEvent.targetId`,
      `Report.resourceId`) assigned to P2/P4 — **no new table may carry a
      deleted user's ID after `deleteUserData()` runs.**
- [ ] `tenantId` columns are nullable here **by design** (single-tenant
      deployments) — confirm downstream RLS plans (multi-tenancy doc)
      aren't violated.

## Rollback plan

Additive migration; if review fails, revert the PR before any downstream
stage merges. No data exists yet in the new tables.

## Open questions

None — shapes were settled in the roadmap (E1–E5). Default retention
*values* are P2/P3 decisions (runtime config, not schema).

## Definition of done

All acceptance criteria checked; security review clean; merged to `main`.
P2–P5 unblocked.
