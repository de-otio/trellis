/**
 * Capability catalog — every action a tenant member can be authorized to do.
 *
 * Naming: `<resource>.<verb>`, lowercase, dot-separated, no abbreviations.
 * Capabilities are tenant-scoped unless prefixed `platform.` (none in MVP).
 *
 * Source of truth: doc/02-technical/identity-federation/05-roles-and-permissions.md.
 */

export const Capability = {
  TenantUpdate: "tenant.update",
  TenantDelete: "tenant.delete",
  TenantSuspend: "tenant.suspend",

  MemberInvite: "member.invite",
  MemberRemove: "member.remove",
  MemberChangeRole: "member.change_role",
  MemberSuspend: "member.suspend",
  MemberView: "member.view",

  IdpConfigure: "idp.configure",
  IdpView: "idp.view",
  RoleMappingEdit: "role_mapping.edit",

  DomainAdd: "domain.add",
  DomainVerify: "domain.verify",
  DomainRemove: "domain.remove",
  DomainView: "domain.view",

  EntityCreate: "entity.create",
  EntityUpdate: "entity.update",
  EntityDelete: "entity.delete",
  EntityView: "entity.view",

  PostCreate: "post.create",
  PostUpdate: "post.update",
  PostDelete: "post.delete",
  PostModerate: "post.moderate",
  PostView: "post.view",

  AuditView: "audit.view",

  // Org classification + public directory (org-classification-and-discovery).
  // Both gate `TenantRole >= ADMIN` (wired in role-grants.ts AdminGrants).
  // ClassificationEdit: declare/change a tenant's PlatformCategory + tags.
  // DirectoryEdit: create/update the tenant's public directory listing,
  // including discoverability and location precision.
  ClassificationEdit: "classification.edit",
  DirectoryEdit: "directory.edit",

  // Agent session management (T9b-d) — approve, list, revoke device-auth
  // sessions on behalf of the tenant. Granted to ADMIN/OWNER.
  ManageAgentSessions: "manage:agent_sessions",
} as const;

export type CapabilityValue = (typeof Capability)[keyof typeof Capability];

/** All capabilities, used by tests + reflection helpers. */
export const ALL_CAPABILITIES: ReadonlyArray<CapabilityValue> =
  Object.values(Capability) as ReadonlyArray<CapabilityValue>;
