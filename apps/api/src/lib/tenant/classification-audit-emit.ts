/**
 * Classification audit emission (org-classification-and-discovery T1).
 *
 * Routes classification mutation events through the foundation-backed
 * `TenantAuditEmitter` in `audit-composer.ts`.
 *
 * Best-effort: a failed audit write never blocks the mutation. Callers use
 * fire-and-forget (`emitClassificationAudit({...}, db)` — no `await`).
 */

import type { AuditAction } from "@de-otio/saas-foundation/audit";
import { TenantAuditEmitter, type AuditPrismaClientLike } from "../audit-composer.js";
import {
  TENANT_CLASSIFICATION_CREATED,
  TENANT_CLASSIFICATION_CATEGORY_CHANGED,
  TENANT_CLASSIFICATION_TAG_ADDED,
  TENANT_CLASSIFICATION_TAG_REMOVED,
} from "../audit-actions.js";

export type ClassificationAuditAction =
  | "classification.created"
  | "classification.category_changed"
  | "classification.tag_added"
  | "classification.tag_removed";

export interface ClassificationAuditEvent {
  tenantId: string;
  actorUserId: string;
  action: ClassificationAuditAction;
  targetId: string; // classificationId or tagId depending on the action
  metadata?: Record<string, string | number | boolean | null>;
}

function actionFor(action: ClassificationAuditAction): AuditAction {
  switch (action) {
    case "classification.created":
      return TENANT_CLASSIFICATION_CREATED;
    case "classification.category_changed":
      return TENANT_CLASSIFICATION_CATEGORY_CHANGED;
    case "classification.tag_added":
      return TENANT_CLASSIFICATION_TAG_ADDED;
    case "classification.tag_removed":
      return TENANT_CLASSIFICATION_TAG_REMOVED;
  }
}

const emitter = new TenantAuditEmitter();

/**
 * Emit a classification mutation audit event. Fire-and-forget at the call
 * site; `prisma` is the region-resolved client already in scope at the
 * mutation.
 */
export function emitClassificationAudit(
  event: ClassificationAuditEvent,
  prisma: AuditPrismaClientLike,
): void {
  void emitter.emit(
    {
      type: actionFor(event.action),
      tenantId: event.tenantId,
      actorUserId: event.actorUserId,
      payload: {
        targetId: event.targetId,
        ...event.metadata,
      },
    },
    prisma,
  );
}
