# T3 — Tenant CRUD + Auth Middleware

**Recommended model:** Sonnet 4.6
**Effort:** ~6 days
**Depends on:** T1 (schema), T2 (Lambdas)
**Blocks:** T4–T8, S3 (consuming app's org-creation wizard)
**Branch:** `feat/T3-tenant-crud`

## Goal

Implement the route handlers and middleware for tenant lifecycle: create organization tenant, switch active tenant, list user's memberships. Audit every existing handler so it queries are tenant-scoped.

## Design reference

- [`doc/02-technical/identity-federation/03-onboarding-flows.md §2`](../../doc/02-technical/identity-federation/03-onboarding-flows.md#2-organization-tenant-creation)
- [`doc/02-technical/identity-federation/05-roles-and-permissions.md`](../../doc/02-technical/identity-federation/05-roles-and-permissions.md) — capability catalog (used here)

## Scope

### In scope

1. **Routes:**
   - `POST /api/tenants` — create organization tenant; caller becomes OWNER.
   - `GET /api/tenants/{id}` — read tenant.
   - `PATCH /api/tenants/{id}` — update display name.
   - `GET /api/users/me/tenants` — list user's memberships.
   - `POST /api/auth/switch-tenant` — change active tenant.
   - `POST /api/tenants/{id}/transfer-ownership` — OWNER hand-off.
2. **`AuthContext`** type and middleware refactor at `apps/api/src/lib/auth/auth-middleware.ts`:
   - Reads new claims (`activeTenantId`, `tenantRole`, etc.) into the context.
   - Adds `requireActiveTenant(tenantIdFromPath)` helper.
3. **Slug validation** uses the regex + reserved-list from T1.
4. **Audit existing handlers** — every route that queries a tenant-scoped Prisma model gets `tenantId: auth.activeTenantId` added to its `where`. Routes that ignored tenant scope previously now enforce it. List of routes to audit: see `apps/api/src/lib/routes/` directory.
5. **Slug uniqueness** at the Postgres level (already enforced via `@unique`); handler returns 409 on conflict.
6. **Idempotency-Key middleware** scaffolded (full implementation in T9b).

### Out of scope

- Domain CRUD (T4).
- IdP CRUD (T5).
- Member CRUD (T6).
- Audit-log emission (T7) — call placeholder.

## Acceptance criteria

- [ ] `POST /api/tenants {slug, displayName}` creates tenant + TenantMember, bumps caller's `User.role` to `B2B_PARTNER` if `END_USER`.
- [ ] Slug rejected if reserved or invalid format → 400 with structured error.
- [ ] Slug rejected if taken → 409.
- [ ] `POST /api/auth/switch-tenant` rejects if user is not a member → 403.
- [ ] `POST /api/auth/switch-tenant` invalidates DynamoDB claim cache for that user.
- [ ] All existing tenant-scoped routes now include `tenantId` in queries; cross-tenant test fixture proves no leak.
- [ ] **Cross-tenant isolation tests:** every tenant-scoped endpoint has at least one "auth-as-A querying B → 404 (no leak of existence)" test.
- [ ] `requireCapability` middleware exists in skeleton form (full catalog in T6).

## Test requirements

### Coverage floor

- **Tenant CRUD handlers:** 85% lines, 80% branches.
- **Auth middleware:** 95% lines.
- **Cross-tenant isolation:** 100% endpoint coverage (every tenant-scoped endpoint has at least one denial test).

### Required tests

1. **Tenant create handler tests:**
   - Happy path: 201, body shape, DB rows present.
   - Slug invalid format: 400.
   - Slug reserved: 400.
   - Slug taken: 409.
   - Race: 2 simultaneous creates with same slug → exactly one succeeds.
   - User role bump: END_USER → B2B_PARTNER on first org tenant.
2. **Switch-tenant tests:**
   - Valid membership: 200 + cache invalidation.
   - Not a member: 403.
   - Suspended membership: 403.
3. **Audit pass tests** — for each tenant-scoped route, the cross-tenant denial test fires.

## Files to add/modify

| File | Action |
|---|---|
| `apps/api/src/lib/routes/tenants.ts` | new |
| `apps/api/src/lib/routes/auth.ts` | modify (add switch-tenant) |
| `apps/api/src/lib/auth/auth-middleware.ts` | modify |
| `apps/api/src/lib/auth/auth-context.ts` | new |
| `apps/api/src/lib/auth/require.ts` | new (skeleton; full catalog T6) |
| `apps/api/src/lib/tenant/slug-validator.ts` | new |
| `apps/api/src/lib/tenant/tenant-handler.ts` | new |
| `apps/api/test/_helpers/multi-tenant-fixture.ts` | new (the fixture from quality.md) |
| `apps/api/test/routes/tenants.test.ts` | new |
| `apps/api/test/routes/auth-switch-tenant.test.ts` | new |
| `apps/api/test/cross-tenant/*.test.ts` | new (one per audited endpoint) |
| All `apps/api/src/lib/routes/*.ts` (existing tenant-scoped ones) | modify (add tenantId predicate) |

## Security considerations

- [ ] Slug regex tested against shell-escape and URL-injection attempts.
- [ ] Switch-tenant requires the target tenant in the user's memberships; never trust the body.
- [ ] Audit pass: every Prisma `findMany`/`findFirst`/`update` against a tenant-scoped model includes `tenantId`. CI lint flag (custom eslint rule) added to enforce.

## Definition of done

All acceptance criteria checked. PR reviewed by human, merged to integration branch.
