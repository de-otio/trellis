# T2 — Cognito Lambda Triggers

**Recommended model:** **Opus 4.7** (auth path, security-critical, transaction integrity)
**Effort:** ~4 days
**Depends on:** T1 (schema)
**Blocks:** T3+ (which depend on the User row being created), S2 (CDK wiring)
**Branch:** `feat/T2-cognito-triggers`

## Goal

Implement the **PostConfirmation** and **PreTokenGeneration** Lambda handlers that integrate Cognito with the trellis tenancy data model. Includes JIT user provisioning for federated users and DynamoDB-backed claim caching.

## Design reference

- [`doc/02-technical/identity-federation/04-cognito-federation.md`](../../doc/02-technical/identity-federation/04-cognito-federation.md) §pre-token-generation-lambda
- [`doc/02-technical/identity-federation/06-just-in-time-provisioning.md`](../../doc/02-technical/identity-federation/06-just-in-time-provisioning.md) — full JIT design + sample code

## Scope

### In scope

1. **PostConfirmation Lambda** at `apps/api/src/lambda/post-confirmation.ts`:
   - Trigger source: `PostConfirmation_ConfirmSignUp`, `PostConfirmation_ConfirmForgotPassword`.
   - Creates `User` row with `cognitoSub`, `email`, `role`, `handle`.
   - Creates personal `Tenant` of `type=PERSONAL`.
   - Creates `TenantMember` row with `role=OWNER`.
   - For federated users: detects via `event.request.userAttributes.identities`; resolves federated tenant by email domain; creates `TenantMember` for that tenant if domain matches a verified `TenantDomain` and an `ACTIVE` IdP.
   - All in a single Prisma transaction (atomic).
   - Idempotent: handles retry by Cognito (uses `upsert` everywhere).
   - Writes initial DynamoDB claim cache entry.
2. **PreTokenGeneration Lambda** at `apps/api/src/lambda/pre-token-generation.ts`:
   - DynamoDB cache lookup keyed on `cognitoSub`.
   - Cache miss → query RDS for User + active TenantMember + TenantRole resolved from groups.
   - For federated users on every issuance: re-resolve role from current `idpGroups` via `TenantRoleMapping` (catches admin-side group changes within token TTL).
   - Returns claims: `custom:userId`, `custom:globalRole`, `custom:activeTenantId`, `custom:tenantSlug`, `custom:tenantRole`, `custom:handle`.
   - Cache TTL 1 hour.
3. **DynamoDB cache layer** at `apps/api/src/lib/auth/claims-cache.ts`:
   - `get(cognitoSub)`, `put(cognitoSub, claims, ttlSeconds)`, `invalidate(cognitoSub)`.
   - PK = `claims:{cognitoSub}`, SK = `meta`, TTL field = `ttl`.
   - Single-table design (uses the existing `{stage}-{appName}` table provided by the consuming deployment).
4. **Role resolver** at `apps/api/src/lib/tenant/resolve-role.ts`:
   - `resolveTenantRole(tenantId, idpGroups, defaultRole)` per the algorithm in [05-roles-and-permissions.md](../../doc/02-technical/identity-federation/05-roles-and-permissions.md#idp-group-tenant-role-mapping).
   - Priority-ordered resolution; tie-breaker by role rank.
5. **Handle derivation** at `apps/api/src/lib/user/derive-handle.ts`:
   - From email local-part, lowercased, special chars stripped, with collision-suffix.

### Out of scope (deferred)

- Tenant CRUD endpoints (T3).
- IdP CRUD (T5).
- Audit-log emission (T7) — use placeholder for now.
- Device-authorization adapter (T9b).

## Acceptance criteria

- [ ] PostConfirmation: signing up creates User + personal Tenant + TenantMember atomically.
- [ ] PostConfirmation: federated sign-in with verified domain → creates TenantMember in that tenant with role from group mapping.
- [ ] PostConfirmation: federated sign-in with NO verified domain → creates User + personal tenant only; no org tenant membership.
- [ ] PostConfirmation: re-running on the same sub is a no-op (idempotency).
- [ ] PreTokenGen: cache hit returns claims without RDS call.
- [ ] PreTokenGen: cache miss queries RDS, populates cache.
- [ ] PreTokenGen: federated user role refreshes when `TenantRoleMapping` changes (within ≤1h).
- [ ] PreTokenGen: missing user (drift) returns minimal claims (no `userId`); does not throw.
- [ ] All Lambda errors land in CloudWatch with structured fields (no stack traces leaking secrets).
- [ ] **G2 gate review:** security-reviewer subagent on the PR.

## Test requirements

### Coverage floor

- **Lambda triggers:** 90% lines, 85% branches.
- **Claims cache + role resolver:** 95% lines.

### Required tests

1. **PostConfirmation unit tests** (`apps/api/test/lambda/post-confirmation.test.ts`):
   - Cognito-native sign-up: creates User + personal Tenant.
   - Federated sign-up, domain matches verified tenant: adds TenantMember with mapped role.
   - Federated sign-up, no domain match: only personal tenant.
   - Federated sign-up, no role mapping: applies `defaultRole`.
   - Federated sign-up, no `defaultRole`: skips org TenantMember; still creates personal.
   - Idempotency: running twice produces same end-state.
   - Transaction failure: nothing partially created.
**Cross-tenant domain-resolution test** *(sec finding #8)*:
- Federated user with email `alice@domain-a.example` is provisioned as a member of the tenant that owns `domain-a.example` — **never** in tenant-B which owns `domain-b.example`.
- Domain-to-tenant resolution is exact-match-only on `tenant_domains.domain == lower(email-domain)` AND `verifiedAt IS NOT NULL`. Verify with mocked Prisma + test fixture seeded with two tenants.
- Negative case: email at unverified or non-existent domain → personal-tenant only, no org-tenant membership added.

2. **PreTokenGeneration unit tests:**
   - Cache hit: returns claims without RDS call (mock RDS unused).
   - Cache miss: queries RDS, writes cache.
   - Group claim absent: applies defaults.
   - Role refresh on group change: returns new role on next call after `TenantRoleMapping` change.
   - User drift (RDS row missing): returns sentinel claims, doesn't throw.
3. **DynamoDB cache integration tests** (against DynamoDB Local).
4. **Role resolver unit tests** (`apps/api/test/lib/resolve-role.test.ts`):
   - Single match: returns its role.
   - Multiple matches: priority-ordered + tie-breaker.
   - No matches: returns `defaultRole`.
   - `defaultRole=null` + no matches: returns `null`.
   - Empty `idpGroups`: returns `defaultRole`.
5. **Handle derivation tests:**
   - Standard email → expected handle.
   - Special chars stripped.
   - Collision: suffix added.

## Files to add/modify

| File | Action |
|---|---|
| `apps/api/src/lambda/post-confirmation.ts` | **rewrite** (existing stub) |
| `apps/api/src/lambda/pre-token-generation.ts` | **rewrite** (existing stub) |
| `apps/api/src/lib/auth/claims-cache.ts` | new |
| `apps/api/src/lib/tenant/resolve-role.ts` | new |
| `apps/api/src/lib/tenant/derive-domain.ts` | new (helpers for email→domain extraction) |
| `apps/api/src/lib/user/derive-handle.ts` | new |
| `apps/api/test/lambda/post-confirmation.test.ts` | new |
| `apps/api/test/lambda/pre-token-generation.test.ts` | new |
| `apps/api/test/lib/claims-cache.test.ts` | new (integration) |
| `apps/api/test/lib/resolve-role.test.ts` | new |
| `apps/api/test/lib/derive-handle.test.ts` | new |

## Security considerations

- [ ] No PII (email body, group claim contents) logged. Only counts + outcomes.
- [ ] Cognito event payload trusted only for `cognitoSub` and `userAttributes`; never trust client-supplied claims.
- [ ] Prisma transactions roll back cleanly on partial failure (no half-created users).
- [ ] DynamoDB cache writes use `ConditionExpression` to prevent stale-overwrites in concurrent runs.
- [ ] Lambda timeout configured (10s for PostConfirm, 3s for PreTokenGen).
- [ ] Lambda memory configured (PostConfirm: 512MB; PreTokenGen: 256MB — these run on every token refresh).
- [ ] Lambda runs **inside VPC with RDS Proxy** to mitigate cold-start tax. DynamoDB is reached via a VPC Gateway Endpoint (no NAT). The earlier "outside VPC for cache hits, inside VPC for cache miss" framing was architecturally wrong — Lambda VPC config is per-function, not per-invocation. *(Sec finding #2)*

## Definition of done

All acceptance criteria checked. PR reviewed at G2 (human + security-reviewer subagent), merged to integration branch.
