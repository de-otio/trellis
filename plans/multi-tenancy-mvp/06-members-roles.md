# T6 — Members + Role Mapping + Capability Catalog

**Recommended model:** **Opus 4.7** for the auth core (capability catalog, RoleGrants matrix, `requireCapability` middleware) — security-critical per the model-assignment override rule in the consuming application's strategy plan. Sonnet 4.6 acceptable for the member CRUD handlers and role-mapping CRUD on top of the catalog. *(sec finding #6)*
**Effort:** ~4 days
**Depends on:** T1 (schema), T3 (auth context)
**Blocks:** consuming-app stages — S4 (member UI), S7 (walkthrough doc)
**Branch:** `feat/T6-members-roles`

## Substages (so Opus runs only where needed)

- **T6-a (Opus):** capability catalog (`capabilities.ts`), `RoleGrants` matrix, `requireCapability` middleware (full impl), comprehensive tests of the matrix.
- **T6-b (Sonnet):** member CRUD route handlers, role-mapping CRUD route handlers, transfer-ownership flow.

T6-a must merge before T6-b can ship — T6-b's tests rely on T6-a's middleware.

## Goal

Member CRUD endpoints, role-mapping CRUD, full capability catalog + `requireCapability` middleware (skeleton from T3 → complete).

## Design reference

- [`doc/02-technical/identity-federation/05-roles-and-permissions.md`](../../doc/02-technical/identity-federation/05-roles-and-permissions.md) — full capability catalog
- [`doc/02-technical/identity-federation/06-just-in-time-provisioning.md §deprovisioning`](../../doc/02-technical/identity-federation/06-just-in-time-provisioning.md#deprovisioning)

## Scope

### In scope

1. **Member routes:**
   - `GET /api/tenants/{id}/members` — paginated, with role + status.
   - `PATCH /api/tenants/{id}/members/{memberId} {role}` — change role.
   - `DELETE /api/tenants/{id}/members/{memberId}` — soft-delete + AdminUserGlobalSignOut.
   - `POST /api/tenants/{id}/transfer-ownership {newOwnerUserId}` — atomic OWNER swap.
2. **Role-mapping routes:**
   - `GET / POST / PATCH / DELETE /api/tenants/{id}/role-mappings` — full CRUD.
   - Validation: priority must be positive int; `idpGroupName` must not be empty; cannot map to OWNER.
3. **Capability catalog** at `apps/api/src/lib/auth/capabilities.ts` — full list per design.
4. **`RoleGrants`** matrix at `apps/api/src/lib/auth/role-grants.ts`.
5. **`requireCapability(cap)`** middleware (full implementation):
   - Resolves capability against `auth.tenantRole`.
   - SUPER_ADMIN bypass.
   - Resource-scoped checks for `entity.update`/`post.update` (own-only by default).
6. **Prevent self-demotion:** OWNER cannot lose role without transfer-ownership flow.
7. **Cache invalidation** on every mutation (DynamoDB cache for affected user).

### Out of scope

- Tenant-scoped audit-log emission (T7 wires up; T6 calls placeholder).
- Tenant-side audit-log read endpoint (T7).
- Custom roles (Phase 3).

## Acceptance criteria

- [ ] List members: paginated, includes role + status + last-active.
- [ ] Change role: requires `member.change_role` capability; cache invalidated.
- [ ] Cannot promote anyone to OWNER via PATCH (returns 422 with remediation pointing to transfer-ownership endpoint).
- [ ] Remove member: status → REMOVED, `AdminUserGlobalSignOut` called.
- [ ] Transfer ownership: atomic; old OWNER → ADMIN, new OWNER → OWNER; cache invalidated for both.
- [ ] Role-mapping CRUD: full coverage.
- [ ] Cannot map to OWNER role.
- [ ] `requireCapability` denies for missing capability with 403; allows with no-op for present.
- [ ] Cross-tenant isolation: A cannot list/modify B's members or mappings.
- [ ] OWNER cannot demote themselves (returns 422).

## Test requirements

### Coverage floor

- **Handlers:** 85% lines.
- **Capability catalog + RoleGrants matrix:** 100% (data structure; assert via tests).
- **requireCapability:** 95% lines.

### Required tests

1. Per-endpoint unit tests.
2. Role-grants assertion: every (Role × Capability) cell of the matrix tested.
3. SUPER_ADMIN bypass: granted regardless of tenantRole.
4. Resource-scoping: PostUpdate/EntityUpdate checks `authorId === auth.userId` unless PostModerate held.
5. Transfer-ownership transaction: simulated mid-transaction failure leaves no partial state.
6. Cross-tenant isolation tests for all endpoints.

## Files to add/modify

| File | Action |
|---|---|
| `apps/api/src/lib/auth/capabilities.ts` | new |
| `apps/api/src/lib/auth/role-grants.ts` | new |
| `apps/api/src/lib/auth/require.ts` | modify (full impl) |
| `apps/api/src/lib/routes/tenant-members.ts` | new |
| `apps/api/src/lib/routes/tenant-role-mappings.ts` | new |
| `apps/api/src/lib/tenant/transfer-ownership.ts` | new |
| `apps/api/test/lib/role-grants-matrix.test.ts` | new |
| `apps/api/test/lib/require-capability.test.ts` | new |
| `apps/api/test/routes/tenant-members.test.ts` | new |
| `apps/api/test/routes/tenant-role-mappings.test.ts` | new |

## Security considerations

- [ ] OWNER demotion path: transfer-ownership ONLY; PATCH cannot demote OWNER.
- [ ] Self-removal of OWNER: 422.
- [ ] Cache invalidation always succeeds (or the mutation rolls back).
- [ ] `AdminUserGlobalSignOut` errors don't fail the API call (best-effort revoke; logged for forensic).
- [ ] Role-mapping target validation: cannot include OWNER (only transfer-ownership can produce OWNER).

## Definition of done

All acceptance criteria checked. PR reviewed, merged to integration branch.
