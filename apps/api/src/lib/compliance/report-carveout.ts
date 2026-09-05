// ILLEGAL_PRIORITY carve-out on report intake (compliance plan 08 §2.3/§2.6).
//
// A report whose category routes to `ILLEGAL_PRIORITY` must not wait on a human
// queue to take its FIRST actions. There is no standing moderator, so the intake
// path itself performs the protective steps, and only those:
//
//   1. HIDE the resource immediately (serving stops).
//   2. PRESERVE the original under an evidence hold (Art. 18) — via the injected
//      EvidencePreservationStore seam, so the hard-delete GC and the
//      account-deletion cascade skip it while the case is open.
//   3. Write a SUPPRESSED statement of reasons: the record exists for the audit
//      trail, delivery to the affected user is skipped (non-tip-off).
//   4. Mark media `blockClass = illegal-suspected` so `isAppealable()` returns
//      false — the item is never offered the appeal/submit-for-analysis path.
//   5. Create a `pending` AuthorityReport.
//
// WHAT IT DELIBERATELY DOES NOT DO: submit anything to an authority. Filing stays
// human-gated (`markAuthorityReportSubmitted`), exactly as the media-review
// `escalateCsam` stub already decides for the upload side. Automating a report to
// a federal police portal off an unreviewed user accusation is a worse failure
// than a delayed one, and a reporter-triggered auto-submit would additionally be
// a denial-of-service vector against any user.
//
// Nothing here is category-aware: it routes on `RoutingClass` only, so no
// jurisdiction or offence vocabulary is compiled into the published core.

import type { Env } from "../../env.js";
import { getLogger } from "../logger.js";
import type { Region } from "../region-detection.js";
import { processingKey, isCasKeyError } from "../media/cas-keys.js";
import {
  isEvidencePreservationConfigured,
  ComplianceSeamNotConfiguredError,
  PLACEHOLDER_EVIDENCE_BUCKET,
} from "../media/compliance-seams.js";
import {
  restrictContent,
  getComplianceAlarmHook,
  type RestrictContentDb,
  type RestrictResourceType,
} from "./restrict-content.js";
import {
  createPendingAuthorityReport,
  type AuthorityReportDb,
} from "./authority-report.js";

/**
 * Template key for the Art. 17 statement written (never delivered) for an
 * illegal-suspected restriction. Deployment-supplied copy, as everywhere else.
 */
export const ILLEGAL_PRIORITY_STATEMENT_TEMPLATE_KEY =
  "statement.restriction.illegal-suspected";

/**
 * Audited grounds for suppressing delivery of that statement. Neutral token —
 * it names the CARVE-OUT, not the offence.
 */
export const ILLEGAL_PRIORITY_SUPPRESS_REASON = "non-tip-off:illegal-suspected";

/** Resource types the carve-out can act on (entity has no serve gate to shut). */
const CARVEOUT_RESOURCE_TYPES: ReadonlyArray<string> = [
  "post",
  "comment",
  "media",
  "entity",
];

export function isCarveOutResourceType(
  resourceType: string,
): resourceType is RestrictResourceType {
  return CARVEOUT_RESOURCE_TYPES.includes(resourceType);
}

export interface CarveOutInput {
  reportId: string;
  resourceType: RestrictResourceType;
  resourceId: string;
}

export interface CarveOutResult {
  applied: boolean;
  /** Set when the protective steps ran. */
  evidenceId?: string;
  statementId?: string;
  authorityReportId?: string;
  /**
   * True when the item was hidden, preserved and held but the
   * `blockClass = illegal-suspected` write did not land. The carve-out is
   * PARTIAL: protection and the authority report are in place, the durable
   * non-appealable marker is not. `computeDisposition` fails closed on the
   * evidence hold meanwhile, so nothing is offered an appeal — but the row
   * needs repairing. (Quality sweep 2026-09-05, A3.)
   */
  blockClassUnwritten?: boolean;
  /** Set when the carve-out could not run; the report row still exists. */
  failure?:
    | "owner-unresolved"
    | "seam-not-configured"
    | "evidence-source-unresolved"
    | "error";
}

/**
 * Minimal Prisma slice the carve-out needs on top of {@link RestrictContentDb}:
 * the owner lookups and the media block-class write.
 */
export interface CarveOutDb extends RestrictContentDb, AuthorityReportDb {
  post: RestrictContentDb["post"] & {
    findUnique(args: {
      where: { id: string };
      select: { authorId: true; tenantId: true };
    }): Promise<{ authorId: string; tenantId: string } | null>;
  };
  postComment: RestrictContentDb["postComment"] & {
    findUnique(args: {
      where: { id: string };
      select: { authorId: true; tenantId: true };
    }): Promise<{ authorId: string; tenantId: string } | null>;
  };
  mediaFile: RestrictContentDb["mediaFile"] & {
    findUnique(args: {
      where: { id: string };
      select: {
        uploadedBy: true;
        tenantId: true;
        contentHash: true;
      };
    }): Promise<{
      uploadedBy: string;
      tenantId: string;
      contentHash: string | null;
    } | null>;
  };
  entityOwnership: {
    findFirst(args: {
      where: { entityId: string; status: string };
      select: { userId: true; tenantId: true };
    }): Promise<{ userId: string; tenantId: string } | null>;
  };
}

interface ResolvedOwner {
  affectedUserId: string;
  tenantId?: string;
  bytesLocation?: { bucket: string; key: string };
  /** True for media, which is the only type carrying a stored block class. */
  isMedia: boolean;
}

/**
 * Apply the ILLEGAL_PRIORITY carve-out for a freshly created report.
 *
 * NEVER THROWS. The report row and its Art. 16(4) receipt are already committed
 * when this runs; a carve-out failure is an OPERATOR fault (an ILLEGAL_PRIORITY
 * category activated without an evidence store wired), and dropping the reporter's
 * notice on the floor because of it would be strictly worse — the notice is the
 * one thing the reporter cannot re-create and the one thing Art. 16 obliges us to
 * keep. So a failure fires the compliance alarm hook (critical, operator-visible)
 * and is reported back in {@link CarveOutResult.failure}.
 */
export async function applyIllegalPriorityCarveOut(
  db: CarveOutDb,
  input: CarveOutInput,
  env: Env,
  region: Region,
): Promise<CarveOutResult> {
  const logger = getLogger();

  try {
    const owner = await resolveOwner(db, input, env);
    if (!owner) {
      await alarm(
        "illegal-priority-owner-unresolved",
        `report:${input.reportId}`,
        { resourceType: input.resourceType },
      );
      return { applied: false, failure: "owner-unresolved" };
    }

    // Fail-fast, before any mutation, exactly as restrictContent does: an
    // ILLEGAL_PRIORITY category is only safe to activate once the deployment has
    // wired evidence preservation. Seeded categories ship `active: false` for
    // precisely this reason.
    if (!isEvidencePreservationConfigured()) {
      throw new ComplianceSeamNotConfiguredError("EvidencePreservationStore");
    }

    // Also fail-fast (V2 Finding G, same rule as the moderation-feedback illegal
    // path): illegal MEDIA must have a REAL, resolvable evidence copy-source
    // before anything is preserved. Without it the store copies no bytes and
    // writes a manifest that LOOKS like preserved evidence — the failure mode
    // this whole path exists to prevent. Refuse before mutating rather than
    // half-preserve. Text has no stored bytes, so the guard is media-only.
    if (owner.isMedia) {
      const loc = owner.bytesLocation;
      if (!loc || !loc.bucket || loc.bucket === PLACEHOLDER_EVIDENCE_BUCKET) {
        await alarm(
          "illegal-priority-evidence-source-unresolved",
          `report:${input.reportId}`,
          { bucket: loc?.bucket ?? "<none>" },
        );
        return { applied: false, failure: "evidence-source-unresolved" };
      }
    }

    const restricted = await restrictContent(
      db,
      {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        affectedUserId: owner.affectedUserId,
        ...(owner.tenantId ? { tenantId: owner.tenantId } : {}),
        reportChain: [input.reportId],
        uploaderContext: { userId: owner.affectedUserId },
        ...(owner.bytesLocation ? { bytesLocation: owner.bytesLocation } : {}),
      },
      {
        preserve: true,
        statementTemplateKey: ILLEGAL_PRIORITY_STATEMENT_TEMPLATE_KEY,
        // Non-tip-off: the statement is WRITTEN for audit, not DELIVERED.
        suppressStatement: { reasonKey: ILLEGAL_PRIORITY_SUPPRESS_REASON },
        restriction: "hidden",
      },
      env,
      region,
    );

    // Non-appealable from here on. Written after restrictContent so a preserve
    // failure cannot leave a block class on an item that was never hidden.
    //
    // Both orderings have a bad window, so this one is chosen and then guarded
    // rather than swapped (quality sweep 2026-09-05, A3). Writing the class
    // first marks an item that may never be hidden; writing it last — this
    // order — leaves an item hidden, preserved and evidence-held with a NULL
    // block class if only this write fails, and `isAppealable(null)` is
    // deliberately `true`. Letting the failure reach the outer catch would be
    // worse still: the carve-out would return `applied: false` and no authority
    // report would be created for content that IS already hidden and preserved,
    // which is the Art.-18 obligation abandoned at the last step.
    //
    // So: this failure is caught here, alarmed under its own kind so an
    // operator can find and repair the row, recorded in the result, and the
    // carve-out continues to file the authority report. The appeal path is
    // covered meanwhile by `computeDisposition`, which fails closed on the
    // evidence hold that IS in place.
    let blockClassUnwritten = false;
    if (owner.isMedia) {
      try {
        await db.mediaFile.update({
          where: { id: input.resourceId },
          data: { blockClass: "illegal-suspected" },
          select: { id: true },
        });
      } catch (error) {
        blockClassUnwritten = true;
        logger.error("[Reports] carve-out could not write the block class", {
          reportId: input.reportId,
          resourceId: input.resourceId,
        });
        await alarm(
          "illegal-priority-block-class-unwritten",
          `report:${input.reportId}`,
          { resourceId: input.resourceId, error: String(error) },
        );
      }
    }

    const jurisdiction =
      (env as unknown as { COMPLIANCE_JURISDICTION?: string })
        .COMPLIANCE_JURISDICTION ?? "UNKNOWN";

    // PENDING only — never submitted. See the module header.
    const authorityReport = await createPendingAuthorityReport(
      db,
      {
        jurisdiction,
        evidenceId: restricted.evidenceId ?? null,
        // Refs, never bytes; no category, no reporter free text.
        bundle: {
          contentRef: `${input.resourceType}:${input.resourceId}`,
          reportChain: [input.reportId],
          uploaderContext: { userId: owner.affectedUserId },
        },
      },
      env,
      region,
    );

    if (restricted.preserveFailed) {
      // restrictContent has already alarmed; surface it in the log line too so
      // the intake path's own trace shows a half-complete carve-out.
      logger.error("[Reports] carve-out preserved nothing (item still hidden)", {
        reportId: input.reportId,
      });
    }

    logger.info("[Reports] ILLEGAL_PRIORITY carve-out applied", {
      reportId: input.reportId,
      authorityReportId: authorityReport.id,
    });

    return {
      applied: true,
      ...(restricted.evidenceId ? { evidenceId: restricted.evidenceId } : {}),
      statementId: restricted.statementId,
      authorityReportId: authorityReport.id,
      ...(blockClassUnwritten ? { blockClassUnwritten: true } : {}),
    };
  } catch (error) {
    const seamMissing = error instanceof ComplianceSeamNotConfiguredError;
    logger.error("[Reports] ILLEGAL_PRIORITY carve-out FAILED", {
      reportId: input.reportId,
      seamMissing,
    });
    await alarm(
      seamMissing
        ? "illegal-priority-seam-not-configured"
        : "illegal-priority-carveout-failed",
      `report:${input.reportId}`,
      { error: String(error) },
    );
    return {
      applied: false,
      failure: seamMissing ? "seam-not-configured" : "error",
    };
  }
}

async function alarm(
  kind: string,
  ref: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await getComplianceAlarmHook()({ kind, ref, detail });
  } catch {
    // The alarm hook is the last line; a failure there must not mask the
    // original outcome.
  }
}

/**
 * Resolve the content owner (Art. 17 statement recipient) and, for media, the
 * REAL evidence copy-source. The bucket comes from the same single env value the
 * media pipeline uses — never a hardcoded placeholder (V2 Finding G).
 */
async function resolveOwner(
  db: CarveOutDb,
  input: CarveOutInput,
  env: Env,
): Promise<ResolvedOwner | null> {
  switch (input.resourceType) {
    case "post": {
      const row = await db.post.findUnique({
        where: { id: input.resourceId },
        select: { authorId: true, tenantId: true },
      });
      if (!row) return null;
      return {
        affectedUserId: row.authorId,
        ...(row.tenantId ? { tenantId: row.tenantId } : {}),
        isMedia: false,
      };
    }
    case "comment": {
      const row = await db.postComment.findUnique({
        where: { id: input.resourceId },
        select: { authorId: true, tenantId: true },
      });
      if (!row) return null;
      return {
        affectedUserId: row.authorId,
        ...(row.tenantId ? { tenantId: row.tenantId } : {}),
        isMedia: false,
      };
    }
    case "media": {
      const row = await db.mediaFile.findUnique({
        where: { id: input.resourceId },
        select: { uploadedBy: true, tenantId: true, contentHash: true },
      });
      if (!row) return null;
      const mediaBucketName =
        (env as unknown as { MEDIA_BUCKET_NAME?: string }).MEDIA_BUCKET_NAME ?? "";
      let bytesLocation: { bucket: string; key: string } | undefined;
      if (mediaBucketName && row.contentHash != null) {
        const key = processingKey(row.tenantId, row.contentHash);
        if (!isCasKeyError(key)) {
          bytesLocation = { bucket: mediaBucketName, key };
        }
      }
      return {
        affectedUserId: row.uploadedBy,
        ...(row.tenantId ? { tenantId: row.tenantId } : {}),
        ...(bytesLocation ? { bytesLocation } : {}),
        isMedia: true,
      };
    }
    case "entity": {
      const row = await db.entityOwnership.findFirst({
        where: { entityId: input.resourceId, status: "ACTIVE" },
        select: { userId: true, tenantId: true },
      });
      if (!row) return null;
      return {
        affectedUserId: row.userId,
        ...(row.tenantId ? { tenantId: row.tenantId } : {}),
        isMedia: false,
      };
    }
  }
}
