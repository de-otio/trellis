/**
 * Directory-profile audit emission.
 *
 * Routes `TenantDirectoryProfile` mutation events through the foundation-backed
 * `TenantAuditEmitter` in `audit-composer.ts`. Mirrors the shape of
 * `audit-emit.ts` (tenant domain/member events) exactly.
 *
 * Best-effort: the composer swallows + logs write failures, so a failed
 * audit write never blocks the mutation. Callers use fire-and-forget
 * (`emitDirectoryProfileAudit({...}, db)` — no `await`).
 *
 * Three auditable transitions per the security review (S12):
 *   - created             : profile first created (opt-in to the directory)
 *   - discoverable_changed: isDiscoverable toggled (critical — increases exposure)
 *   - precision_changed   : locationPrecision changed (critical — may increase
 *                           location exposure, e.g. CITY → NEIGHBORHOOD)
 */

import type { AuditAction } from "@de-otio/saas-foundation/audit";
import { TenantAuditEmitter, type AuditPrismaClientLike } from "../audit-composer.js";
import {
  TENANT_DIRECTORY_PROFILE_CREATED,
  TENANT_DIRECTORY_PROFILE_DISCOVERABLE_CHANGED,
  TENANT_DIRECTORY_PROFILE_PRECISION_CHANGED,
} from "../audit-actions.js";

export type DirectoryProfileAuditActionKey =
  | "directory_profile.created"
  | "directory_profile.discoverable_changed"
  | "directory_profile.precision_changed";

export interface DirectoryProfileAuditEvent {
  tenantId: string;
  actorUserId: string;
  action: DirectoryProfileAuditActionKey;
  targetId: string;
  metadata?: Record<string, string | number | boolean | null>;
}

function actionFor(action: DirectoryProfileAuditActionKey): AuditAction {
  switch (action) {
    case "directory_profile.created":
      return TENANT_DIRECTORY_PROFILE_CREATED;
    case "directory_profile.discoverable_changed":
      return TENANT_DIRECTORY_PROFILE_DISCOVERABLE_CHANGED;
    case "directory_profile.precision_changed":
      return TENANT_DIRECTORY_PROFILE_PRECISION_CHANGED;
  }
}

const emitter = new TenantAuditEmitter();

/**
 * Emit a directory-profile audit event. Fire-and-forget at the call site;
 * `prisma` is the region-resolved client already in scope at the mutation.
 */
export function emitDirectoryProfileAudit(
  event: DirectoryProfileAuditEvent,
  prisma: AuditPrismaClientLike,
): void {
  void emitter.emit(
    {
      type: actionFor(event.action),
      tenantId: event.tenantId,
      actorUserId: event.actorUserId,
      payload: {
        targetType: "directory_profile",
        targetId: event.targetId,
        ...event.metadata,
      },
    },
    prisma,
  );
}
