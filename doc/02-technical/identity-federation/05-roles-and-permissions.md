# Roles and Permissions

How authorization works once a user has authenticated. Two layers (global + tenant-scoped), a permission catalog, and how IdP groups map to tenant roles.

## Two-layer model

Trellis has two independent role axes:

| Axis | Where stored | Purpose | Examples |
|---|---|---|---|
| **Global role** (`UserRole`) | `users.role` column | Platform-wide capability — does this user have any B2B context, are they internal staff, are they a SUPER_ADMIN? | `END_USER`, `B2B_PARTNER`, `INTERNAL`, `SUPER_ADMIN` |
| **Tenant role** (`TenantRole`) | `tenant_members.role` per (user, tenant) | What can this user do *within* their currently-active tenant? | `OWNER`, `ADMIN`, `MEMBER`, `GUEST` |

Both surface in the JWT (`custom:globalRole`, `custom:tenantRole`). Authorization decisions in route handlers consult either or both depending on what's being protected.

### When does each axis apply?

- **Global role only:** platform admin tooling (`/api/internal/...`), abuse moderation across tenants, system feature flags.
- **Tenant role only:** the vast majority of API endpoints. "Manage members of *my* tenant" needs `tenantRole >= ADMIN`; "post in *my* tenant" needs `tenantRole >= MEMBER`.
- **Both:** edge cases. E.g., "delete any post in any tenant" needs `globalRole = SUPER_ADMIN` *and* the post must be loadable; `tenantRole` is irrelevant because SUPER_ADMIN bypasses tenant scope by design.

## Capability catalog

Roles are bundles of *capabilities*. We define capabilities as constant strings — easier to reason about than nested role hierarchies, and they map cleanly to per-route authorization.

```typescript
// trellis: apps/api/src/lib/auth/capabilities.ts
export const Capability = {
  // Tenant management
  TenantUpdate:           'tenant.update',          // displayName, slug
  TenantDelete:           'tenant.delete',          // Phase 3
  TenantSuspend:          'tenant.suspend',         // OWNER only

  // Member management
  MemberInvite:           'member.invite',
  MemberRemove:           'member.remove',
  MemberChangeRole:       'member.change_role',
  MemberSuspend:          'member.suspend',
  MemberView:             'member.view',

  // Identity provider
  IdpConfigure:           'idp.configure',          // create / edit / disable
  IdpView:                'idp.view',
  RoleMappingEdit:        'role_mapping.edit',

  // Domains
  DomainAdd:              'domain.add',
  DomainVerify:           'domain.verify',
  DomainRemove:           'domain.remove',
  DomainView:             'domain.view',

  // Entities
  EntityCreate:           'entity.create',
  EntityUpdate:           'entity.update',
  EntityDelete:           'entity.delete',
  EntityView:             'entity.view',

  // Posts
  PostCreate:             'post.create',
  PostUpdate:             'post.update',            // own post
  PostDelete:             'post.delete',            // own post
  PostModerate:           'post.moderate',          // any post in tenant
  PostView:               'post.view',

  // Audit
  AuditView:              'audit.view',
} as const;

export type CapabilityValue = typeof Capability[keyof typeof Capability];
```

A few rules:

- **Naming:** `<resource>.<verb>`. Lowercase. Dot-separated. No abbreviations.
- **Scope:** all capabilities are tenant-scoped unless prefixed `platform.` (none in MVP — used for `globalRole = SUPER_ADMIN` later).
- **Granularity:** "view" and "modify" split where it matters; collapsed where it doesn't.

## Default role grants

| Capability | OWNER | ADMIN | MEMBER | GUEST |
|---|:---:|:---:|:---:|:---:|
| `tenant.update` | ✅ | ✅ | | |
| `tenant.delete` | ✅ | | | |
| `tenant.suspend` | ✅ | | | |
| `member.invite` | ✅ | ✅ | | |
| `member.remove` | ✅ | ✅ | | |
| `member.change_role` | ✅ | ✅¹ | | |
| `member.suspend` | ✅ | ✅ | | |
| `member.view` | ✅ | ✅ | ✅ | |
| `idp.configure` | ✅ | ✅ | | |
| `idp.view` | ✅ | ✅ | | |
| `role_mapping.edit` | ✅ | ✅ | | |
| `domain.add` | ✅ | ✅ | | |
| `domain.verify` | ✅ | ✅ | | |
| `domain.remove` | ✅ | ✅ | | |
| `domain.view` | ✅ | ✅ | ✅ | ✅ |
| `entity.create` | ✅ | ✅ | ✅ | |
| `entity.update` | ✅² | ✅² | ✅³ | |
| `entity.delete` | ✅² | ✅² | ✅³ | |
| `entity.view` | ✅ | ✅ | ✅ | ✅ |
| `post.create` | ✅ | ✅ | ✅ | |
| `post.update` | ✅⁴ | ✅⁴ | ✅⁴ | |
| `post.delete` | ✅⁴ | ✅⁴ | ✅⁴ | |
| `post.moderate` | ✅ | ✅ | | |
| `post.view` | ✅ | ✅ | ✅ | ✅ |
| `audit.view` | ✅ | ✅ | | |

¹ ADMIN cannot promote anyone to OWNER. Only the current OWNER can transfer ownership.
² Any entity in the tenant.
³ Only entities the user has `EntityOwnership` on.
⁴ Only the user's own posts (subject to `post.moderate` for cross-user takedowns).

These are static defaults defined in code:

```typescript
// trellis: apps/api/src/lib/auth/role-grants.ts
export const RoleGrants: Record<TenantRole, Set<CapabilityValue>> = {
  OWNER: new Set([...AdminGrants, Capability.TenantDelete, Capability.TenantSuspend]),
  ADMIN: AdminGrants,
  MEMBER: MemberGrants,
  GUEST: GuestGrants,
};
```

Custom roles or per-capability overrides per tenant are out of scope for MVP. We commit to the four canonical roles.

## Authorization in handlers

The trellis route guard pattern:

```typescript
// trellis: apps/api/src/lib/auth/require.ts
export function requireCapability(cap: CapabilityValue) {
  return async (auth: AuthContext, ctx: { tenantId?: string; resource?: any }) => {
    if (auth.globalRole === 'SUPER_ADMIN') return;  // bypass

    const grants = RoleGrants[auth.tenantRole];
    if (!grants.has(cap)) throw new ForbiddenError(`requires ${cap}`);

    // Capability-specific resource scoping (e.g. own-post-only edits)
    if (cap === Capability.PostUpdate && ctx.resource?.authorId !== auth.userId) {
      // PostUpdate normally requires ownership; PostModerate is the cross-user variant.
      const moderateGrants = RoleGrants[auth.tenantRole];
      if (!moderateGrants.has(Capability.PostModerate)) {
        throw new ForbiddenError('not your post');
      }
    }
  };
}
```

Used in route handlers like:

```typescript
// trellis: apps/api/src/lib/routes/tenants.ts (sketch)
{
  path: /^\/api\/tenants\/([^/]+)\/members$/,
  method: 'POST',
  handler: async (request, env, { pathname, requestContext }) => {
    const auth = await authMiddleware(request);
    if (!auth) return unauthorized();

    const tenantId = pathname.match(/.../)![1];
    if (auth.activeTenantId !== tenantId) return forbidden('wrong tenant');

    await requireCapability(Capability.MemberInvite)(auth, { tenantId });

    // ... handle invite
  },
}
```

Two **invariants** every handler must respect:

1. **Active-tenant check:** if the request mutates tenant-scoped state, `auth.activeTenantId` must equal the path-parameter `tenantId`. Otherwise the user is acting on a tenant they're not currently in. SUPER_ADMIN bypasses.
2. **Resource tenant-scoping:** every Prisma query against tenant-scoped tables (Entity, Post, etc.) includes a `tenantId` filter. **No exceptions.** Code review must enforce this; eslint custom rule + tests check it.

## IdP group → tenant role mapping

When a federated user signs in, their Entra (or other IdP) sends a `groups` claim containing the user's group memberships. The tenant has previously defined `TenantRoleMapping` rows that map specific group identifiers → `TenantRole`.

Resolution algorithm (executed by the pre-token-gen Lambda):

```typescript
async function resolveTenantRole(
  tenantId: string,
  idpGroups: string[],   // values from the IdP's groups claim
  defaultRole: TenantRole | null,
): Promise<TenantRole | null> {
  if (idpGroups.length === 0) return defaultRole;

  const mappings = await db.tenantRoleMapping.findMany({
    where: { tenantId, idpGroupName: { in: idpGroups } },
    orderBy: [{ priority: 'asc' }, { tenantRole: 'desc' }],
    // priority asc → admin-grants beat member-grants when same priority
    // tenantRole desc → OWNER > ADMIN > MEMBER > GUEST as tie-breaker
  });

  if (mappings.length === 0) return defaultRole;
  return mappings[0].tenantRole;
}
```

**Tie-breaking:**

- Lower `priority` wins. Tenant admins use this to ensure "Admins" group beats a generic "Employees" group.
- If priorities equal: highest role wins (OWNER > ADMIN > MEMBER > GUEST).
- No matches → `IdP.defaultRole` (configured per tenant; commonly `MEMBER` or `null` to deny).

**Rationale for priority:** typical Entra setup has a flat "all employees" group that emits to everyone. The tenant admin sets that mapping to `MEMBER` priority 100, then adds "Trellis-Admins" → `ADMIN` priority 10. Admins get ADMIN, others get MEMBER, no overlap surprises.

### Group identifiers in practice

| IdP | Common identifier | Notes |
|---|---|---|
| Entra (OIDC) | Group object GUID | Default. Stable. Set in Entra "Token configuration → Group ID". |
| Entra (OIDC, displayName mode) | Group displayName | Brittle: rename in Entra breaks Trellis mapping. Don't recommend. |
| Okta | Group name string | Configurable. |
| Google Workspace | Group email | `group@de-otio.org`. |
| Generic SAML | Whatever the SAML attribute emits | Per-IdP. |

The tenant admin sees which identifiers their IdP emits via a "Test sign-in" feature: Trellis captures the `groups` claim from a real federated login (their own) and shows it to them in the role-mapping UI. They map from there.

### Onwards-compatibility

- **Adding a new role mapping** — picks up on the user's next token refresh (≤ 1 hour given access token TTL).
- **Removing a mapping** — same. We don't proactively re-issue tokens.
- **Adding a user to an IdP group** — picks up on next token refresh, *if* the IdP re-issues the user's claims at that time. Some OIDC providers (including Entra) only re-fetch group memberships on full re-auth; others on token refresh. We document this.

## OWNER transfer

Exactly one OWNER per organization tenant. To transfer:

```http
POST /api/tenants/{id}/transfer-ownership
{ "newOwnerUserId": "u_clxxxx" }
```

Requires:
- Caller is the current OWNER.
- `newOwnerUserId` is an active TenantMember of the tenant (typically already an ADMIN).

Effect (in one transaction):
- `tenant_members` row for old owner: `role = ADMIN`.
- `tenant_members` row for new owner: `role = OWNER`.
- DDB cache invalidated for both.

## Tenant role for personal tenants

A user is always `OWNER` of their personal tenant. No other roles apply. This is enforced at the data layer: `personal_owner_user_id` is unique on `Tenant`, and the personal tenant's `TenantMember` row is created with `role=OWNER` and never modified.

## Anti-patterns and pitfalls

- ❌ **Don't query without a tenantId predicate.** A handler that does `prisma.entity.findMany({ where: { entityType: 'venue' } })` is a tenant-isolation bug waiting to happen. Always include `tenantId: auth.activeTenantId` (or omit explicitly with a comment for global queries).
- ❌ **Don't trust `tenantId` from request body or query params for read auth.** It must equal `auth.activeTenantId`. The body field, if present, is a check-not-source.
- ❌ **Don't grant `SUPER_ADMIN` to anyone in MVP.** Reserved for future internal tooling. Grant `INTERNAL` for support staff who can read but not mutate.
- ❌ **Don't use `globalRole` to enforce tenant-scoped rules.** "B2B_PARTNER means can manage venues" is wrong — there's an org tenant with venue resources, and `tenantRole` for that org tenant is what gates venue mutations.
- ❌ **Don't expose role-grants table to tenant admins for editing.** Roles are static in MVP. Surface the four roles, not the capability list.
- ❌ **Don't put password-protected accounts in federated tenants by default.** A tenant with an active IdP should disallow password sign-ins for users in their domain (otherwise password-stealing bypasses MFA enforced by the IdP). Implementation: pre-authentication trigger checks the user's email domain against the tenant's federated state and blocks password flow.

## Future work

- **Custom roles** with per-tenant capability bundles. Phase 3+.
- **Resource-level grants** (e.g., "can manage *this venue* only"). Phase 3+.
- **Conditional role mappings** (e.g., "Admins of EU group → ADMIN, US group → ADMIN, US contractors → GUEST"). Phase 2 if a customer demands it.
- **`platform.*` capabilities** for SUPER_ADMIN tooling. Phase 2 when we build internal admin UI.
