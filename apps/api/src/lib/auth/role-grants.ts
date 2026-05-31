/**
 * Static default capability grants per `TenantRole`.
 *
 * The four canonical roles are:
 *   GUEST  — read-only on public surfaces.
 *   MEMBER — can post, update/delete own posts, manage own entities.
 *   ADMIN  — manage tenant config, members, IdPs, domains, role mappings.
 *   OWNER  — superset of ADMIN plus tenant.delete and tenant.suspend.
 *
 * Custom roles or per-tenant overrides are out of scope for MVP.
 *
 * Hierarchy invariant (asserted in tests):
 *   GUEST ⊂ MEMBER ⊂ ADMIN ⊂ OWNER.
 */

import type { TenantRole } from "@prisma/client";
import { Capability, type CapabilityValue } from "./capabilities.js";

const GuestGrants: ReadonlySet<CapabilityValue> = new Set<CapabilityValue>([
  Capability.DomainView,
  Capability.EntityView,
  Capability.PostView,
]);

const MemberGrants: ReadonlySet<CapabilityValue> = new Set<CapabilityValue>([
  ...GuestGrants,
  Capability.MemberView,
  Capability.EntityCreate,
  Capability.EntityUpdate,
  Capability.EntityDelete,
  Capability.PostCreate,
  Capability.PostUpdate,
  Capability.PostDelete,
]);

const AdminGrants: ReadonlySet<CapabilityValue> = new Set<CapabilityValue>([
  ...MemberGrants,
  Capability.TenantUpdate,
  Capability.MemberInvite,
  Capability.MemberRemove,
  Capability.MemberChangeRole,
  Capability.MemberSuspend,
  Capability.IdpConfigure,
  Capability.IdpView,
  Capability.RoleMappingEdit,
  Capability.DomainAdd,
  Capability.DomainVerify,
  Capability.DomainRemove,
  Capability.PostModerate,
  Capability.AuditView,
  Capability.ManageAgentSessions,
]);

const OwnerGrants: ReadonlySet<CapabilityValue> = new Set<CapabilityValue>([
  ...AdminGrants,
  Capability.TenantDelete,
  Capability.TenantSuspend,
]);

export const RoleGrants: Record<TenantRole, ReadonlySet<CapabilityValue>> = {
  OWNER: OwnerGrants,
  ADMIN: AdminGrants,
  MEMBER: MemberGrants,
  GUEST: GuestGrants,
};
