/**
 * Tenant audit emission (phase 1.C.2).
 *
 * Routes the T6 mutation audit events (member change-role / remove,
 * ownership transfer, role-mapping CRUD) through the foundation-backed
 * `TenantAuditEmitter` in `audit-composer.ts`. Replaces the old
 * console-only stub.
 *
 * Best-effort: the composer swallows + logs write failures, so a failed
 * audit write never blocks the mutation. Callers keep the existing
 * fire-and-forget shape (`emitTenantAudit({...}, db)` — no `await`).
 */

import type { AuditAction } from "@de-otio/saas-foundation/audit";
import { TenantAuditEmitter, type AuditPrismaClientLike } from "../audit-composer.js";
import {
  TENANT_MEMBER_ROLE_CHANGED,
  TENANT_MEMBER_REMOVED,
  TENANT_OWNERSHIP_TRANSFERRED,
  TENANT_ROLE_MAPPING_ADDED,
  TENANT_ROLE_MAPPING_REMOVED,
} from "../audit-actions.js";

export interface TenantAuditEvent {
  tenantId: string;
  actorUserId: string;
  action:
    | "member.change_role"
    | "member.remove"
    | "tenant.transfer_ownership"
    | "role_mapping.create"
    | "role_mapping.update"
    | "role_mapping.delete";
  targetType: "member" | "role_mapping" | "tenant";
  targetId: string;
  metadata?: Record<string, string | number | boolean | null>;
}

/** Map the trellis tenant-mutation action to a frozen `AuditAction`. */
function actionFor(action: TenantAuditEvent["action"]): AuditAction {
  switch (action) {
    case "member.change_role":
      return TENANT_MEMBER_ROLE_CHANGED;
    case "member.remove":
      return TENANT_MEMBER_REMOVED;
    case "tenant.transfer_ownership":
      return TENANT_OWNERSHIP_TRANSFERRED;
    case "role_mapping.create":
    case "role_mapping.update":
      return TENANT_ROLE_MAPPING_ADDED;
    case "role_mapping.delete":
      return TENANT_ROLE_MAPPING_REMOVED;
  }
}

const emitter = new TenantAuditEmitter();

/**
 * Emit a tenant mutation audit event. Fire-and-forget at the call site;
 * `prisma` is the region-resolved client already in scope at the
 * mutation.
 */
export function emitTenantAudit(event: TenantAuditEvent, prisma: AuditPrismaClientLike): void {
  void emitter.emit(
    {
      type: actionFor(event.action),
      tenantId: event.tenantId,
      actorUserId: event.actorUserId,
      payload: {
        targetType: event.targetType,
        targetId: event.targetId,
        ...event.metadata,
      },
    },
    prisma,
  );
}
