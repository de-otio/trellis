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

// ── Research / Experiment / Platform-control actions ─────────────────
//
// CONVENTION — research.query events MUST NEVER store raw query text in
// metadata; query text may contain PII. Store a hash or template string
// with parameters redacted. See doc/02-technical/development/audit-and-toggle-conventions.md.
export const RESEARCH_QUERY: AuditAction = "research.query";
export const RESEARCH_EXTRACT: AuditAction = "research.extract";
export const EXPERIMENT_ASSIGN: AuditAction = "experiment.assign";

// FEATURE_TOGGLE_CHANGED: emitted by FeatureToggleService.setToggle on
// every toggle write. Metadata: { key, oldEnabled, newEnabled, changedBy }
// where changedBy is the admin's USER ID (not email).
export const FEATURE_TOGGLE_CHANGED: AuditAction = "feature_toggle.changed";

// PROVENANCE_CHANGED: every synthetic-content provenance transition, up or
// down (AI Act Art. 50). Metadata is { old, new, basis, resourceType,
// resourceId } with the actor as `userId` — NEVER an email. Downward
// corrections are staff-reviewed and this is their audit trail, which is why
// the action covers both directions rather than only escalations.
// See trellis-internal analysis/ai-act-transparency/03 §6.
export const PROVENANCE_CHANGED: AuditAction = "provenance.changed";

// CONSENT_CHANGED: canonical action for user consent mutations emitted
// by the consent-management layer (another agent owns the emit sites).
export const CONSENT_CHANGED: AuditAction = "consent.changed";

// ── Org classification / directory / platform-category actions ────────
//
// Every mutable surface in the org-classification + directory feature is
// auditable — each changes something another user's experience depends on
// (a feed-filter result, a directory listing's visibility, or the shared
// taxonomy every tenant's classification resolves against). The
// `.discoverable_changed` / `.precision_changed` transitions matter
// specifically because they INCREASE what's exposed about a tenant
// (private → searchable, CITY → EXACT location).
export const TENANT_CLASSIFICATION_CREATED: AuditAction = "tenant_classification.created";
export const TENANT_CLASSIFICATION_CATEGORY_CHANGED: AuditAction = "tenant_classification.category_changed";
export const TENANT_CLASSIFICATION_VERIFIED: AuditAction = "tenant_classification.verified";
export const TENANT_CLASSIFICATION_VERIFICATION_REVOKED: AuditAction = "tenant_classification.verification_revoked";
export const TENANT_CLASSIFICATION_TAG_ADDED: AuditAction = "tenant_classification.tag_added";
export const TENANT_CLASSIFICATION_TAG_REMOVED: AuditAction = "tenant_classification.tag_removed";

export const TENANT_DIRECTORY_PROFILE_CREATED: AuditAction = "tenant_directory_profile.created";
export const TENANT_DIRECTORY_PROFILE_DISCOVERABLE_CHANGED: AuditAction = "tenant_directory_profile.discoverable_changed";
export const TENANT_DIRECTORY_PROFILE_PRECISION_CHANGED: AuditAction = "tenant_directory_profile.precision_changed";

export const PLATFORM_CATEGORY_CREATED: AuditAction = "platform_category.created";
export const PLATFORM_CATEGORY_DEACTIVATED: AuditAction = "platform_category.deactivated";
export const PLATFORM_CATEGORY_REPARENTED: AuditAction = "platform_category.reparented";

// ── Media-moderation review-queue actions (T9) ────────────────────────
// Every human moderator decision on a REVIEW/QUARANTINED media item writes
// one of these. The audited moderator VIEW bypass writes MEDIA_MODERATION_VIEWED
// BEFORE any bytes are served (the bypass is never silent). CSAM escalation is a
// human-paging STUB — it locks the item and records intent; it performs NO
// automated statutory reporting (that is handled out-of-band by a human).
export const MEDIA_MODERATION_APPROVED: AuditAction = "media.moderation.approved";
export const MEDIA_MODERATION_REJECTED: AuditAction = "media.moderation.rejected";
export const MEDIA_MODERATION_CSAM_ESCALATED: AuditAction = "media.moderation.csam_escalated";
export const MEDIA_MODERATION_VIEWED: AuditAction = "media.moderation.viewed";

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
  // Research / Experiment / Platform-control
  RESEARCH_QUERY,
  RESEARCH_EXTRACT,
  EXPERIMENT_ASSIGN,
  FEATURE_TOGGLE_CHANGED,
  CONSENT_CHANGED,
  PROVENANCE_CHANGED,
} as const;
