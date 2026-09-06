/**
 * Shared best-effort admin-audit emitter.
 *
 * Was duplicated near line-for-line in `tenant/platform-category-admin-handler.ts`
 * (`emitPlatformCategoryAudit`) and `report-category-admin-handler.ts`
 * (`emitAudit`), differing only in the hardcoded `resource` string. One
 * parameterized helper; both call sites collapse to one line each (quality
 * sweep 2026-09-05, D3).
 */

import type { AuditAction } from "@de-otio/saas-foundation/audit";
import type { Env } from "../env.js";
import type { Region } from "./region-detection.js";

/**
 * Emit a best-effort system-action audit event for an admin mutation.
 * Errors are swallowed: an audit failure must never block the mutation it
 * describes.
 */
export async function emitAdminAudit(
  action: AuditAction,
  resource: string,
  resourceId: string,
  actorUserId: string,
  metadata: Record<string, unknown>,
  env: Env,
): Promise<void> {
  try {
    const { TrellisAuditLogger } = await import("./audit-composer.js");
    const region: Region = (env.DEFAULT_REGION as Region) ?? "EU";
    const auditLogger = new TrellisAuditLogger();
    await auditLogger.logSystemAction(
      action,
      {
        resource,
        resourceId,
        userId: actorUserId,
        region,
        success: true,
        metadata: { ...metadata, actorUserId },
      },
      env as Parameters<InstanceType<typeof TrellisAuditLogger>["logSystemAction"]>[2],
    );
  } catch {
    // Best-effort: audit failure must not block the mutation.
  }
}
