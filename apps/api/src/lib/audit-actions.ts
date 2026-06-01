/**
 * Trellis audit-action constants (phase 1.C.2).
 *
 * These are the canonical `action` strings trellis writes to the
 * foundation audit log. `AuditAction` is an OPEN string union (frozen
 * type) — well-known foundation values get autocomplete; consumers
 * extend with their own dotted names without an API bump. We therefore
 * declare these as `AuditAction`-typed constants (NOT an enum) so the
 * call sites read symbolically while the values stay plain strings.
 *
 * Naming follows foundation's dotted convention. Two families:
 *   - data lifecycle  (data.*, auth.*, system.region_change)
 *   - tenant / IdP     (tenant.*, auth.agent_session.*, auth.refresh_replay)
 *
 * The tenant/IdP set is the migration of the old
 * `lib/audit/event-types.ts` `AuditEventType` catalog; the string
 * VALUES are preserved exactly so existing rows / dashboards keep
 * matching.
 */

import type { AuditAction } from "@de-otio/saas-foundation/audit";

// ── Data-lifecycle actions ───────────────────────────────────────────
export const DATA_READ: AuditAction = "data.read";
export const DATA_CREATE: AuditAction = "data.create";
export const DATA_UPDATE: AuditAction = "data.update";
export const DATA_DELETE: AuditAction = "data.delete";

export const AUTH_LOGIN: AuditAction = "auth.login";
export const AUTH_LOGOUT: AuditAction = "auth.logout";
export const AUTHZ_DENIED: AuditAction = "authz.denied";
export const AUTHZ_GRANTED: AuditAction = "authz.granted";

export const SYSTEM_REGION_CHANGE: AuditAction = "system.region_change";

// ── Tenant / IdP actions (migrated from lib/audit/event-types.ts) ─────
// VALUES preserved verbatim from the old `AuditEventType` catalog.
export const TENANT_CREATED: AuditAction = "tenant.created";
export const TENANT_UPDATED: AuditAction = "tenant.updated";
export const TENANT_OWNERSHIP_TRANSFERRED: AuditAction = "tenant.ownership_transferred";
export const TENANT_MEMBER_INVITED: AuditAction = "tenant.member.invited";
export const TENANT_MEMBER_JOINED: AuditAction = "tenant.member.joined";
export const TENANT_MEMBER_ROLE_CHANGED: AuditAction = "tenant.member.role_changed";
export const TENANT_MEMBER_REMOVED: AuditAction = "tenant.member.removed";
export const TENANT_DOMAIN_ADDED: AuditAction = "tenant.domain.added";
export const TENANT_DOMAIN_VERIFIED: AuditAction = "tenant.domain.verified";
export const TENANT_DOMAIN_REMOVED: AuditAction = "tenant.domain.removed";
export const TENANT_IDP_CONNECTED: AuditAction = "tenant.idp.connected";
export const TENANT_IDP_MODIFIED: AuditAction = "tenant.idp.modified";
export const TENANT_IDP_DISABLED: AuditAction = "tenant.idp.disabled";
export const TENANT_IDP_DELETED: AuditAction = "tenant.idp.deleted";
export const TENANT_ROLE_MAPPING_ADDED: AuditAction = "tenant.role_mapping.added";
export const TENANT_ROLE_MAPPING_REMOVED: AuditAction = "tenant.role_mapping.removed";
export const TENANT_FEDERATED_LOGIN_SUCCESS: AuditAction = "tenant.federated_login.success";
export const TENANT_FEDERATED_LOGIN_DENIED: AuditAction = "tenant.federated_login.denied";
export const TENANT_ROLE_REFRESHED_JIT: AuditAction = "tenant.role.refreshed_jit";

export const AUTH_AGENT_SESSION_APPROVED: AuditAction = "auth.agent_session.approved";
export const AUTH_AGENT_SESSION_REVOKED: AuditAction = "auth.agent_session.revoked";
export const AUTH_REFRESH_REPLAY: AuditAction = "auth.refresh_replay";

/**
 * Old tenant/IdP `AuditEventType` string -> `AuditAction` constant.
 * The values are identical (preserved verbatim), so this is an identity
 * map at runtime; it exists so the four `AuditEventEmitter` consumers
 * (idp-handler, tenant-handler, agent-authorize, agent-sessions) can
 * keep referencing `AuditEventType.TENANT_*` symbolically via a single
 * re-exported object.
 */
export const AuditEventType = {
  TENANT_CREATED,
  TENANT_UPDATED,
  TENANT_OWNERSHIP_TRANSFERRED,
  TENANT_MEMBER_INVITED,
  TENANT_MEMBER_JOINED,
  TENANT_MEMBER_ROLE_CHANGED,
  TENANT_MEMBER_REMOVED,
  TENANT_DOMAIN_ADDED,
  TENANT_DOMAIN_VERIFIED,
  TENANT_DOMAIN_REMOVED,
  TENANT_IDP_CONNECTED,
  TENANT_IDP_MODIFIED,
  TENANT_IDP_DISABLED,
  TENANT_IDP_DELETED,
  TENANT_ROLE_MAPPING_ADDED,
  TENANT_ROLE_MAPPING_REMOVED,
  TENANT_FEDERATED_LOGIN_SUCCESS,
  TENANT_FEDERATED_LOGIN_DENIED,
  TENANT_ROLE_REFRESHED_JIT,
  AUTH_AGENT_SESSION_APPROVED,
  AUTH_AGENT_SESSION_REVOKED,
  AUTH_REFRESH_REPLAY,
} as const;
