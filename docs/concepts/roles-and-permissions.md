---
title: Roles and Permissions
description: How Trellis authorizes requests with a two-layer role model, a capability catalog, and mapping from external IdP groups to tenant roles.
sidebar: Roles and Permissions
order: 40
---

# Roles and Permissions

Once a user has authenticated, Trellis decides what they can do using two
independent role axes, a catalog of fine-grained capabilities, and — for
federated tenants — a mapping from the external IdP's groups to tenant roles.

## Two-layer model

Trellis separates a platform-wide role from a per-tenant role:

| Axis | Where stored | Purpose | Examples |
|---|---|---|---|
| **Global role** (`UserRole`) | `users.role` | Platform-wide capability | `END_USER`, `B2B_PARTNER`, `PARTNER_ADMIN`, `INTERNAL`, `CONTENT_CREATOR`, `MODERATOR`, `SUPER_ADMIN` |
| **Tenant role** (`TenantRole`) | `tenant_members.role` per (user, tenant) | What the user can do within their active tenant | `OWNER`, `ADMIN`, `MEMBER`, `GUEST` |

Both surface in the session token. Authorization in route handlers consults
either or both, depending on what is being protected.

### When does each axis apply?

- **Global role only** — platform administration tooling and cross-tenant abuse
  moderation.
- **Tenant role only** — the vast majority of API endpoints. "Manage members of
  my tenant" needs `tenantRole >= ADMIN`; "post in my tenant" needs
  `tenantRole >= MEMBER`.
- **Both** — edge cases. A `SUPER_ADMIN` can act across tenant scope by design,
  so its global role bypasses the tenant check.

## Capability catalog

Roles are bundles of *capabilities*. Capabilities are constant strings — easier
to reason about than nested role hierarchies, and they map cleanly to per-route
authorization.

```typescript
export const Capability = {
  // Tenant management
  TenantUpdate:     'tenant.update',
  TenantDelete:     'tenant.delete',
  TenantSuspend:    'tenant.suspend',

  // Member management
  MemberInvite:     'member.invite',
  MemberRemove:     'member.remove',
  MemberChangeRole: 'member.change_role',
  MemberSuspend:    'member.suspend',
  MemberView:       'member.view',

  // Identity provider
  IdpConfigure:     'idp.configure',
  IdpView:          'idp.view',
  RoleMappingEdit:  'role_mapping.edit',

  // Domains
  DomainAdd:        'domain.add',
  DomainVerify:     'domain.verify',
  DomainRemove:     'domain.remove',
  DomainView:       'domain.view',

  // Entities
  EntityCreate:     'entity.create',
  EntityUpdate:     'entity.update',
  EntityDelete:     'entity.delete',
  EntityView:       'entity.view',

  // Posts
  PostCreate:       'post.create',
  PostUpdate:       'post.update',     // own post
  PostDelete:       'post.delete',     // own post
  PostModerate:     'post.moderate',   // any post in tenant
  PostView:         'post.view',

  // Events
  EventCreate:      'event.create',
  EventUpdate:      'event.update',    // own event
  EventDelete:      'event.delete',    // own event
  EventModerate:    'event.moderate',  // any event in tenant

  // Audit
  AuditView:        'audit.view',

  // Organization classification & directory
  ClassificationEdit: 'classification.edit',
  DirectoryEdit:       'directory.edit',

  // Agent sessions — approve, list, and revoke device-auth sessions on
  // behalf of the tenant. Granted to ADMIN and OWNER.
  ManageAgentSessions: 'manage:agent_sessions',
} as const;

export type CapabilityValue = typeof Capability[keyof typeof Capability];
```

Conventions:

- **Naming:** `<resource>.<verb>` — lowercase, dot-separated, no abbreviations.
  (`manage:agent_sessions` predates the convention and uses a colon; it is the
  one exception.)
- **Scope:** capabilities are tenant-scoped unless prefixed `platform.`.
- **Granularity:** "view" and "modify" split where it matters, collapsed where it
  does not.

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
| `event.create` | ✅ | ✅ | ✅ | |
| `event.update` | ✅⁵ | ✅⁵ | ✅⁵ | |
| `event.delete` | ✅⁵ | ✅⁵ | ✅⁵ | |
| `event.moderate` | ✅ | ✅ | | |
| `audit.view` | ✅ | ✅ | | |
| `classification.edit` | ✅ | ✅ | | |
| `directory.edit` | ✅ | ✅ | | |
| `manage:agent_sessions` | ✅ | ✅ | | |

¹ ADMIN cannot promote anyone to OWNER. Only the current OWNER can transfer
ownership.
² Any entity in the tenant.
³ Only entities the user has `EntityOwnership` on.
⁴ Only the user's own posts (cross-user takedowns require `post.moderate`).
⁵ Only the user's own events (creating is a plain MEMBER capability; updating,
cancelling, or managing the shifts of *another* member's event requires
`event.moderate`, held by ADMIN and OWNER). RSVP-ing and signing up for shifts
need no event capability — only the `MEMBER` role floor.

Grants are defined as static role-to-capability sets in code:

```typescript
export const RoleGrants: Record<TenantRole, Set<CapabilityValue>> = {
  OWNER: new Set([...AdminGrants, Capability.TenantDelete, Capability.TenantSuspend]),
  ADMIN: AdminGrants,
  MEMBER: MemberGrants,
  GUEST: GuestGrants,
};
```

The four canonical roles are `OWNER`, `ADMIN`, `MEMBER`, and `GUEST`.

## Authorization in handlers

Route handlers gate on a capability via a guard:

```typescript
export function requireCapability(cap: CapabilityValue) {
  return async (auth: AuthContext, ctx: { tenantId?: string; resource?: any }) => {
    if (auth.globalRole === 'SUPER_ADMIN') return;  // bypass

    const grants = RoleGrants[auth.tenantRole];
    if (!grants.has(cap)) throw new ForbiddenError(`requires ${cap}`);

    // Capability-specific resource scoping (e.g. own-post-only edits)
    if (cap === Capability.PostUpdate && ctx.resource?.authorId !== auth.userId) {
      if (!grants.has(Capability.PostModerate)) {
        throw new ForbiddenError('not your post');
      }
    }
  };
}
```

Two invariants every handler respects:

1. **Active-tenant check.** If the request mutates tenant-scoped state,
   `auth.activeTenantId` must equal the path-parameter `tenantId`; otherwise the
   user is acting on a tenant they are not currently in. `SUPER_ADMIN` bypasses.
2. **Resource tenant-scoping.** Every query against a tenant-scoped table
   includes a `tenantId` filter — no exceptions. This is enforced in review and
   by a lint rule plus tests.

## IdP group → tenant role mapping

When a federated user signs in, their IdP sends a `groups` claim. The tenant has
previously defined role-mapping rows that map specific group identifiers to a
`TenantRole`.

```typescript
async function resolveTenantRole(
  tenantId: string,
  idpGroups: string[],
  defaultRole: TenantRole | null,
): Promise<TenantRole | null> {
  if (idpGroups.length === 0) return defaultRole;

  const mappings = await db.tenantRoleMapping.findMany({
    where: { tenantId, idpGroupName: { in: idpGroups } },
    orderBy: [{ priority: 'asc' }, { tenantRole: 'desc' }],
  });

  if (mappings.length === 0) return defaultRole;
  return mappings[0].tenantRole;
}
```

**Tie-breaking:**

- Lower `priority` wins, so admins can make a specific "Admins" group beat a
  generic "Employees" group.
- If priorities are equal, the highest role wins
  (OWNER > ADMIN > MEMBER > GUEST).
- No match falls back to the IdP's configured default role (commonly `MEMBER`,
  or `null` to deny).
- **OWNER is never granted by a mapping.** A mapping or default role that
  resolves to `OWNER` is capped to `ADMIN` by the resolver as a
  defense-in-depth backstop, because there is exactly one OWNER per tenant and
  it is set only by tenant creation and explicit ownership transfer.

This handles the common case of a flat "all employees" group that emits to
everyone: map it to `MEMBER` at a high priority number, then add a
"Trellis-Admins" group at a low priority number for elevated access.

### Group identifiers in practice

| IdP | Common identifier | Notes |
|---|---|---|
| OIDC (group-ID mode) | Group object GUID | Stable; recommended. |
| OIDC (displayName mode) | Group display name | Brittle — a rename breaks the mapping. |
| Okta | Group name string | Configurable. |
| Google Workspace | Group email | e.g. `group@example.com`. |
| Generic SAML | The SAML group attribute value | Per-IdP. |

A test federated sign-in lets a tenant admin observe the `groups` claim their
IdP actually emits and build mappings from those identifiers. (A dedicated
claim-capture endpoint is planned; today this is done via a real sign-in, which
Trellis records as the tenant's `TEST_SIGN_IN` setup milestone.)

### Propagation timing

- **Adding or removing a role mapping** takes effect on the user's next token
  refresh; tokens are not proactively re-issued.
- **Adding a user to an IdP group** takes effect on the next token refresh *if*
  the IdP re-issues the user's group claims at that time. Some OIDC providers
  only re-fetch group memberships on full re-authentication.

## OWNER transfer

There is exactly one OWNER per organization tenant. To transfer ownership:

```http
POST /api/tenants/{id}/transfer-ownership
{ "newOwnerUserId": "u_..." }
```

Requirements:

- The caller is the current OWNER.
- `newOwnerUserId` is an active member of the tenant.

In one transaction, the old owner's membership becomes `ADMIN`, the new owner's
becomes `OWNER`, and the cached authorization state for both is invalidated.

## Tenant role for personal tenants

A user is always `OWNER` of their personal tenant, and no other roles apply.
This is enforced at the data layer: the personal-owner reference is unique on the
tenant, and the personal tenant's membership row is created with `role=OWNER` and
never modified.

## Anti-patterns

- ❌ **Don't query without a `tenantId` predicate.** Always include
  `tenantId: auth.activeTenantId`, or omit it explicitly with a comment for a
  deliberately global query.
- ❌ **Don't trust `tenantId` from the request body or query string for read
  authorization.** It must equal `auth.activeTenantId`; a body field is a
  check, not a source.
- ❌ **Don't use the global role to enforce tenant-scoped rules.** Tenant-scoped
  mutations are gated by the tenant role for that tenant.
- ❌ **Don't expose the role-grants table to tenant admins for editing.** Surface
  the four roles, not the capability list.
- ❌ **Don't allow password sign-in to bypass a federated tenant's MFA.** The
  intent is that a tenant with an active IdP should not let a member of its
  federated domain fall back to password auth and sidestep IdP-enforced MFA.
  **Status:** this is a design goal, not an enforced control yet — there is no
  PreAuthentication trigger today that blocks the password flow by email
  domain. JIT still links a federated identity to an existing password account
  by email, so both paths can coexist until this lands (see
  [just-in-time provisioning](../reference/just-in-time-provisioning.md#account-linking)).

## Related

- [Tenancy Model](./tenancy-model.md)
- [Organization Classification & Directory](./org-classification-and-directory.md)
