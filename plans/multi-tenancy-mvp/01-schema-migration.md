# T1 — Schema Migration (the bottleneck)

**Recommended model:** **Opus 4.7** (foundational, irreversible, security-sensitive)
**Effort:** ~4 days
**Blocks:** every other stage in this release
**Branch:** `feat/T1-schema-migration` off `feat/identity-federation-v0.7`

## Goal

Add the multi-tenancy data model to trellis: `Tenant`, `TenantMember`, `TenantDomain`, `TenantIdentityProvider`, `TenantRoleMapping`, `TenantInvitation`. Add `tenantId` foreign keys to every tenant-scoped table. Drop the stub `Partner` model.

## Design reference

- [`doc/02-technical/identity-federation/02-data-model.md`](../../doc/02-technical/identity-federation/02-data-model.md) — canonical schema definition, ER diagram, migration strategy.
- [`doc/02-technical/identity-federation/01-tenancy-model.md`](../../doc/02-technical/identity-federation/01-tenancy-model.md) — tenancy invariants this schema enforces.

## Scope

### In scope

1. New Prisma models: `Tenant`, `TenantMember`, `TenantDomain`, `TenantIdentityProvider`, `TenantRoleMapping`, `TenantInvitation`.
2. New enums: `TenantType`, `TenantStatus`, `TenantRole`, `TenantMemberStatus`, `IdpKind`, `IdpStatus`.
3. Add `tenantId String @map("tenant_id")` (non-nullable) FK to:
   - `Entity`
   - `Post`
   - `PostComment`
   - `Group`
   - `GroupMember`
   - `ConnectionCode`
   - `ConnectionCodeRedemption`
   - `EntityOwnership`
   - `Notification`
4. Add `personalTenantId String? @unique @map("personal_tenant_id")` to `User`.
5. Add `User` relations to `TenantMember`, `TenantInvitation`, personal `Tenant`.
6. **Drop** `Partner` model and `User.partnerId`.
7. **Drop** `User.partner` relation.
8. Single migration file: `add_tenancy_model.sql`.
9. Composite indexes on `(tenantId, ...)` per [02-data-model.md §indexing-notes](../../doc/02-technical/identity-federation/02-data-model.md#indexing-notes).
10. Update Prisma client generation (`npm run prisma:generate`).
11. Update seed/dev fixtures so any seeded data carries valid `tenantId`.
12. Smoke-test API still boots after migration.

### Out of scope (deferred to other stages)

- Route handlers consuming the schema (T3+).
- Lambda code reading the schema (T2).
- Authorization logic (T6).
- Audit-log table extensions (T7).
- Personal-tenant auto-creation logic (T2).

## Acceptance criteria

- [ ] `npm run prisma:migrate:dev --name add_tenancy_model` runs cleanly on a fresh dev database.
- [ ] `npm run prisma:generate` produces a Prisma client with the new types.
- [ ] `tsc --noEmit` clean across `apps/api`.
- [ ] Existing test suite still runs (some tests will fail because they reference the removed `Partner` model — that's expected; those are flagged for the appropriate downstream stages).
- [ ] New migration is idempotent on re-run (Prisma migration framework handles this).
- [ ] `psql` shows the new tables with correct columns, types, FKs, indexes.
- [ ] Foreign keys all `ON DELETE CASCADE` per the design.
- [ ] No nullable `tenantId` anywhere in the new schema (greenfield assumption).
- [ ] Reserved-slug seed data committed (see Slug reservation list below).
- [ ] **G1 gate review:** human + security-reviewer subagent inspect the migration before merge.

## Test requirements

### Coverage floor: not applicable

Schema migrations don't have unit-test coverage in the conventional sense. **However:**

### Required tests

1. **Schema-shape test** in `apps/api/test/schema/tenant-shape.test.ts`:
   ```typescript
   it('Tenant model has expected columns', () => {
     // Use Prisma's introspection to assert column names, types, nullability
   });
   it('every tenant-scoped table has non-nullable tenant_id', () => { /* ... */ });
   it('Partner model is dropped', () => { /* ... */ });
   ```
2. **Migration-idempotency test** — applying the migration twice does not error.
3. **Foreign-key integrity test** — inserting an `Entity` with a non-existent `tenantId` is rejected.
4. **Cascade-delete test** — deleting a `Tenant` cascades to its `TenantMember`, `TenantDomain`, etc.

These tests live in `apps/api/test/schema/` and use a real Postgres (Docker Compose).

## Slug reservation list

Add `apps/api/src/lib/tenant/reserved-slugs.ts` with the initial list:

```typescript
export const RESERVED_SLUGS = new Set([
  // Platform terms
  'admin', 'api', 'app', 'auth', 'billing', 'console', 'dashboard',
  'help', 'mail', 'staff', 'support', 'system', 'team', 'www',
  'static', 'media', 'cdn', 'oauth', 'sso', 'agents', 'agent',
  // Platform/vendor specific
  'de-otio', 'deotio', 'trellis',
  // Top brands (illustrative — extend as needed)
  'amazon', 'apple', 'google', 'meta', 'microsoft',
  'facebook', 'twitter', 'instagram', 'whatsapp',
  // Generic
  'about', 'contact', 'legal', 'privacy', 'terms',
]);
```

The slug regex is `/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/` — 3–32 chars, no leading/trailing dash, no `--`.

## Files to add/modify

| File | Action |
|---|---|
| `prisma/schema.prisma` | modify (add models, drop `Partner`) |
| `prisma/migrations/{timestamp}_add_tenancy_model/migration.sql` | new |
| `apps/api/src/lib/tenant/reserved-slugs.ts` | new |
| `apps/api/test/schema/tenant-shape.test.ts` | new |
| `apps/api/test/schema/migration-idempotency.test.ts` | new |
| `apps/api/test/schema/cascade-delete.test.ts` | new |
| `scripts/seed/dev-seed.ts` (if exists) | modify (add tenant seed data) |

## Security considerations

This is the most security-sensitive stage in the release. The security-reviewer subagent runs on this PR.

Specific checks:

- [ ] No nullable `tenantId` on tenant-scoped tables — would create cross-tenant leak surface.
- [ ] All FKs use `ON DELETE CASCADE` so tenant deletion (Phase 3) won't orphan rows.
- [ ] Composite indexes start with `tenantId` (most queries scope by tenant first).
- [ ] No PII columns named in plain text (e.g. don't add a `socialSecurityNumber` field to any model).
- [ ] Slug regex prevents `..`, `\\`, special chars that could break URL routing or shell escapes.
- [ ] Reserved-slug list includes all admin/auth/system terms.
- [ ] Migration drops `partners` table cleanly — no orphan FK references.

## Rollback plan

If G1 review fails:

1. Revert the PR (no other stage has merged yet).
2. Re-author with fixes.
3. Re-submit. No downstream cost.

## Open questions

None — all open questions in the design phase were resolved before this stage was authored.

## Definition of done

All acceptance criteria checked. PR is reviewed at G1 (human + security-reviewer subagent) and merged to `feat/identity-federation-v0.7`.
