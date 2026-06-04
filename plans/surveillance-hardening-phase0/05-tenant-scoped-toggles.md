# P5 — Tenant-Scoped Feature Toggles

**Recommended model:** Sonnet
**Effort:** ~2 days
**Blocks:** Phase 1 signup friction (per-tenant config), Phase 2 per-tenant thresholds
**Branch:** `feat/P5-tenant-scoped-toggles` off `main` (requires P1 merged)

## Goal

Make the half-built seam real: `FeatureFlagsManager.getFeatureFlags(tenantId)`
already accepts a `tenantId` parameter and ignores it
(`apps/api/src/lib/feature-flags.ts`). After this stage, toggle resolution
is **tenant-specific row → global row → default**, with zero behavior change
for deployments that never create a tenant-scoped row.

## Design reference

- [`08-implementation-roadmap.md §E4`](../../doc/02-technical/surveillance-threat-model/08-implementation-roadmap.md)
- [`06-registration-friction.md`](../../doc/02-technical/surveillance-threat-model/06-registration-friction.md) — first consumer of per-tenant config
- [`09-public-project-exposure.md`](../../doc/02-technical/surveillance-threat-model/09-public-project-exposure.md) — toggles as the threshold-secrecy mechanism

## Scope

### In scope

1. **`FeatureToggleService` resolution**: `getToggle(key, tenantId?)`
   resolves tenant row first, falls back to global (tenantId NULL), then
   to the coded default. One query (`WHERE key = ? AND (tenant_id = ? OR
   tenant_id IS NULL) ORDER BY tenant_id NULLS LAST LIMIT 1`) or two —
   measure, don't guess; this is on hot paths.
2. **`FeatureFlagsManager`** honors its `tenantId` parameter; all existing
   call sites that already pass a tenantId keep working, call sites that
   don't pass one get global behavior (unchanged).
3. **Admin/seed surface**: `npm run seed:feature-toggles`
   (`apps/api/scripts/seed-feature-toggles.ts`) and the feature-toggle
   admin routes (`apps/api/src/lib/routes/admin.ts`) can create/update
   tenant-scoped rows. Tenant-scoped writes require the caller to be
   scoped to that tenant (or SUPER_ADMIN) — no cross-tenant toggle writes.
4. **List/enumerate path**: `FeatureToggleService.getAllToggles()`
   (`apps/api/src/lib/feature-toggle-service.ts`) currently has no tenant
   parameter — left as-is it would return every tenant's override rows to
   any caller. Scope it: returns global rows + the caller's tenant rows
   only. Even the *existence* of another tenant's override (the key name
   alone) leaks which tenants customized friction/detection settings —
   target-selection intel for an adversary.
5. **Caching**: if toggle reads are cached today, the cache key must
   include tenantId. Verify before assuming — a shared cache returning
   tenant A's value to tenant B is the failure mode of this stage.

### Out of scope

- Defining any new toggle keys (Phase 1 friction keys, Phase 2 threshold
  keys define their own).
- Per-user flags.
- UI for tenant admins (consuming vertical's concern).

## Acceptance criteria

- [ ] With no tenant rows present, all existing toggle behavior is
      byte-identical (regression: full suite green untouched).
- [ ] Tenant row overrides global; deleting the tenant row falls back to
      global; missing both yields the coded default.
- [ ] Cross-tenant isolation: tenant A's override is invisible to tenant B
      (standard cross-tenant denial test pattern from the multi-tenancy
      plan) — including via `getAllToggles()`: listing as tenant A returns
      no tenant-B rows, not even key names.
- [ ] Toggle writes audit-logged with tenant context (existing
      feature-toggle audit events extended).
- [ ] No N+1: resolving N flags for a request issues a bounded number of
      queries (the existing manager batches — preserve that).

## Test requirements

1. Resolution-order unit tests (tenant → global → default), including the
   NULLS-distinct edge from P1's partial unique index.
2. Cross-tenant isolation test.
3. Cache-key test if caching exists (tenant-scoped cache hit/miss).
4. Authorization test on tenant-scoped toggle writes.

## Files to add/modify

| File | Action |
|---|---|
| `apps/api/src/lib/feature-flags.ts` | modify |
| `apps/api/src/lib/feature-toggle-service.ts` | modify (resolution + scoped `getAllToggles`) |
| `apps/api/src/lib/routes/admin.ts` | modify (tenant-scoped writes + authz) |
| `apps/api/scripts/seed-feature-toggles.ts` | modify |
| `apps/api/test/unit/feature-toggle-scoping.test.ts` | new |

## Security considerations

security-reviewer subagent runs on this PR (it changes an authorization
boundary).

- [ ] Cross-tenant toggle reads/writes impossible (isolation tests above),
      including the list/enumerate path.
- [ ] A tenant override can only make *that tenant's* experience differ —
      confirm no toggle key gates a cross-tenant or global behavior in a
      way a tenant admin could abuse (review the existing key list against
      this).
- [ ] Audit events for toggle changes carry actor + tenant (these are the
      operational thresholds of the future — their change history matters).

## Rollback plan

Resolution falls back to global when no tenant rows exist, so rollback =
delete tenant rows + revert code. No migration involved (schema landed in
P1).

## Open questions

- Whether toggle reads are currently cached (and where) — discovery task;
  determines item 4's scope.

## Definition of done

All acceptance criteria checked; merged to `main`. Phase 1/2 can define
per-tenant keys without touching the mechanism.
