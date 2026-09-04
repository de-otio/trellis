// Takedown orchestration (compliance plan 08 §2.3 — M1 + M7 ordering,
// jurisdiction-neutral). ONE core service:
//
//   1. HIDE immediately (`hidden=true`; serving stops now). Bytes are NEVER
//      hard-deleted here — hard-delete is a separate GC job — so preservation
//      never races deletion.
//   2. PRESERVE (if requested) via the injected EvidencePreservationStore seam.
//      Hiding NEVER blocks on it: on transient failure we retry (bounded) and,
//      on repeated failure, fire the alarm hook — the item stays hidden either
//      way. A MISSING (un-injected) store fails LOUD *before* any mutation (a
//      mis-wired deploy must not silently drop evidence).
//   3. STATEMENT OF REASONS (Art. 17) to the affected user — unless suppressed
//      (non-tip-off carve-out: still written for audit, delivery skipped).
//   4. AUDIT every step.
//
// Plus the evidence-hold GUARD (§2.3 item 5): the hard-delete GC purge and the
// account-deletion cascade must skip content under a live evidence hold. This
// module owns the single canonical hold-exempt predicate both call sites use.

import type { Env } from "../../env.js";
import { getLogger } from "../logger.js";
import type { Region } from "../region-detection.js";
import { TrellisAuditLogger } from "../audit-composer.js";
import {
  CONTENT_RESTRICTED,
  EVIDENCE_PRESERVED,
  EVIDENCE_PRESERVE_FAILED,
  STATEMENT_OF_REASONS_ISSUED,
} from "../audit-actions.js";
import {
  getEvidencePreservationStore,
  isEvidencePreservationConfigured,
  ComplianceSeamNotConfiguredError,
  type EvidenceBundle,
} from "../media/compliance-seams.js";
import {
  writeStatementOfReasons,
  type StatementOfReasonsDb,
} from "./statement-of-reasons.js";

// ---------------------------------------------------------------------------
// Evidence-hold guard (plan 08 §2.3 item 5) — the single source of truth.
// ---------------------------------------------------------------------------

/**
 * The canonical Prisma `where` fragment that EXCLUDES content under a live
 * evidence hold. Applied by BOTH the nightly hard-delete purge and the
 * account-deletion media-erasure cascade so a held original is never destroyed
 * while an authority case is open. Referencing one definition keeps the two call
 * sites from drifting.
 */
export function evidenceHoldExemptWhere(): { evidenceHold: false } {
  return { evidenceHold: false };
}

// ---------------------------------------------------------------------------
// Alarm hook — repeated preservation failure needs operator attention.
// ---------------------------------------------------------------------------

export interface ComplianceAlarm {
  readonly kind: string;
  readonly ref: string;
  readonly detail?: Record<string, unknown>;
}
export type ComplianceAlarmHook = (alarm: ComplianceAlarm) => Promise<void>;

let injectedAlarmHook: ComplianceAlarmHook | undefined;
export function setComplianceAlarmHook(hook: ComplianceAlarmHook): void {
  injectedAlarmHook = hook;
}
export function __resetComplianceAlarmHookForTests(): void {
  injectedAlarmHook = undefined;
}
export function getComplianceAlarmHook(): ComplianceAlarmHook {
  return (
    injectedAlarmHook ??
    (async (alarm) => {
      getLogger().error("[Compliance] ALARM (no hook injected)", alarm);
    })
  );
}

/** Bounded in-request preserve retries. Deployment may add an async queue too. */
export const MAX_PRESERVE_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// restrictContent.
// ---------------------------------------------------------------------------

export type RestrictResourceType = "post" | "comment" | "media" | "entity";

export interface RestrictContentRef {
  resourceType: RestrictResourceType;
  resourceId: string;
  /** The affected user (content owner) — the Art. 17 statement recipient. */
  affectedUserId: string;
  tenantId?: string;
  /** The chain of report ids / signals that led here (for the evidence bundle). */
  reportChain?: ReadonlyArray<string>;
  /** Uploader/account context available at preservation time (refs, not bytes). */
  uploaderContext?: Record<string, unknown>;
  /** Where the preserved bytes live (media path). Refs only. */
  bytesLocation?: { bucket: string; key: string; versionId?: string };
}

export interface RestrictContentOpts {
  /** Copy to the evidence store before serving stops permanently. */
  preserve: boolean;
  /** Deployment-supplied Art. 17 template key. */
  statementTemplateKey: string;
  /** Non-tip-off carve-out: writes the statement, skips delivery. */
  suppressStatement?: { reasonKey: string };
  /** "removed" | "hidden" | "account-suspended" … (default "hidden"). */
  restriction?: string;
  /** Template PARAMS only — never raw classifier output (sanitized downstream). */
  statementParams?: Record<string, unknown>;
}

export interface RestrictContentResult {
  restricted: true;
  evidenceId?: string;
  statementId: string;
  /** True if preservation was requested but ultimately failed (item still hidden). */
  preserveFailed?: boolean;
}

/** Prisma slice restrictContent needs (structural — mockable in unit tests). */
export interface RestrictContentDb extends StatementOfReasonsDb {
  mediaFile: {
    update(args: {
      where: { id: string };
      data: {
        hidden?: boolean;
        hiddenAt?: Date;
        hiddenBy?: string;
        evidenceHold?: boolean;
        evidenceId?: string;
        // Server-only class (block-class.ts). Written by the ILLEGAL_PRIORITY
        // carve-out; never crosses the API boundary.
        blockClass?: string;
      };
      select: { id: true };
    }): Promise<{ id: string }>;
  };
  post: {
    update(args: {
      where: { id: string };
      data: { hiddenByAuthor?: boolean };
      select: { id: true };
    }): Promise<{ id: string }>;
  };
  postComment: {
    update(args: {
      where: { id: string };
      data: { deletedAt?: Date };
      select: { id: true };
    }): Promise<{ id: string }>;
  };
}

const SYSTEM_ACTOR = "system:compliance";

/**
 * Orchestrate a takedown. See the module header for ordering + failure
 * semantics. Returns the statement id and (when preserved) the evidence id.
 */
export async function restrictContent(
  db: RestrictContentDb,
  ref: RestrictContentRef,
  opts: RestrictContentOpts,
  env: Env,
  region: Region,
): Promise<RestrictContentResult> {
  const audit = new TrellisAuditLogger(env);

  // FAIL LOUD, BEFORE ANY MUTATION: preservation requested but no store injected
  // is a misconfiguration, not a transient fault — refuse rather than hide-then-
  // silently-drop-evidence.
  if (opts.preserve && !isEvidencePreservationConfigured()) {
    throw new ComplianceSeamNotConfiguredError("EvidencePreservationStore");
  }

  // 1. HIDE immediately (serving stops; bytes NOT deleted).
  await hideResource(db, ref, opts.preserve);
  await audit.logSystemAction(
    CONTENT_RESTRICTED,
    {
      resource: ref.resourceType,
      resourceId: ref.resourceId,
      userId: ref.affectedUserId,
      region,
      success: true,
      severity: "high",
      metadata: {
        restriction: opts.restriction ?? "hidden",
        preserve: opts.preserve,
      },
    },
    env,
  );

  // 2. PRESERVE (if requested). Hiding already committed — a failure here never
  //    un-hides.
  let evidenceId: string | undefined;
  let preserveFailed = false;
  if (opts.preserve) {
    const bundle: EvidenceBundle = {
      contentRef: `${ref.resourceType}:${ref.resourceId}`,
      ...(ref.bytesLocation ? { bytesLocation: ref.bytesLocation } : {}),
      ...(ref.uploaderContext ? { uploaderContext: ref.uploaderContext } : {}),
      ...(ref.reportChain ? { reportChain: ref.reportChain } : {}),
      timestamps: { restrictedAt: new Date().toISOString() },
    };
    const outcome = await preserveWithRetry(bundle, env, region);
    if (outcome.ok) {
      evidenceId = outcome.evidenceId;
      if (ref.resourceType === "media") {
        await db.mediaFile.update({
          where: { id: ref.resourceId },
          data: { evidenceId, evidenceHold: true },
          select: { id: true },
        });
      }
      await audit.logSystemAction(
        EVIDENCE_PRESERVED,
        {
          resource: "evidence",
          resourceId: evidenceId,
          region,
          success: true,
          severity: "high",
          metadata: { contentRef: bundle.contentRef },
        },
        env,
      );
    } else {
      preserveFailed = true;
      await audit.logSystemAction(
        EVIDENCE_PRESERVE_FAILED,
        {
          resource: "evidence",
          resourceId: bundle.contentRef,
          region,
          success: false,
          severity: "critical",
        },
        env,
      );
    }
  }

  // 3. STATEMENT OF REASONS (unless suppressed → written, not delivered).
  const statement = await writeStatementOfReasons(
    db,
    {
      affectedUserId: ref.affectedUserId,
      resourceType: ref.resourceType,
      resourceId: ref.resourceId,
      restriction: opts.restriction ?? "hidden",
      templateKey: opts.statementTemplateKey,
      ...(opts.statementParams ? { params: opts.statementParams } : {}),
      ...(opts.suppressStatement ? { suppress: opts.suppressStatement } : {}),
    },
    env,
  );

  // 4. AUDIT the statement step.
  await audit.logSystemAction(
    STATEMENT_OF_REASONS_ISSUED,
    {
      resource: "statement_of_reasons",
      resourceId: statement.statementId,
      userId: ref.affectedUserId,
      region,
      success: true,
      severity: "medium",
      metadata: { suppressed: statement.suppressed, delivered: statement.delivered },
    },
    env,
  );

  return {
    restricted: true,
    ...(evidenceId ? { evidenceId } : {}),
    statementId: statement.statementId,
    ...(preserveFailed ? { preserveFailed: true } : {}),
  };
}

/** Hide the resource without hard-deleting it. Total over resource types. */
async function hideResource(
  db: RestrictContentDb,
  ref: RestrictContentRef,
  preserve: boolean,
): Promise<void> {
  switch (ref.resourceType) {
    case "media":
      await db.mediaFile.update({
        where: { id: ref.resourceId },
        data: {
          hidden: true,
          hiddenAt: new Date(),
          hiddenBy: SYSTEM_ACTOR,
          ...(preserve ? { evidenceHold: true } : {}),
        },
        select: { id: true },
      });
      return;
    case "post":
      // Reuse the single available post hide flag as a moderation hide (stops
      // the post being served); deletedAt (hard/soft delete) is deliberately
      // untouched so bytes/rows survive for a possible evidence hold.
      await db.post.update({
        where: { id: ref.resourceId },
        data: { hiddenByAuthor: true },
        select: { id: true },
      });
      return;
    case "comment":
      // Comments have no separate hidden flag; soft-delete (deletedAt) is the
      // hide — reversible, and does not purge the row.
      await db.postComment.update({
        where: { id: ref.resourceId },
        data: { deletedAt: new Date() },
        select: { id: true },
      });
      return;
    case "entity":
      // Entity restriction is recorded via the audit + statement steps; there is
      // no byte-serving surface to gate here.
      getLogger().warn("[restrictContent] entity restriction recorded (no serve gate to toggle)", {
        resourceId: ref.resourceId,
      });
      return;
  }
}

interface PreserveOk {
  ok: true;
  evidenceId: string;
}
interface PreserveFail {
  ok: false;
}

/**
 * Preserve with bounded retries. A {@link ComplianceSeamNotConfiguredError} is
 * NOT caught here (it is a misconfiguration surfaced upstream before hiding). Any
 * other error is retried up to {@link MAX_PRESERVE_ATTEMPTS}; on exhaustion the
 * alarm hook fires and we return `{ ok: false }` — the caller keeps the item
 * hidden regardless.
 */
async function preserveWithRetry(
  bundle: EvidenceBundle,
  _env: Env,
  _region: Region,
): Promise<PreserveOk | PreserveFail> {
  const store = getEvidencePreservationStore();
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PRESERVE_ATTEMPTS; attempt++) {
    try {
      const { evidenceId } = await store.preserve(bundle);
      return { ok: true, evidenceId };
    } catch (error) {
      lastError = error;
      getLogger().error("[restrictContent] preserve attempt failed", {
        attempt,
        contentRef: bundle.contentRef,
      });
    }
  }
  await getComplianceAlarmHook()({
    kind: "evidence-preservation-failed",
    ref: bundle.contentRef,
    detail: { attempts: MAX_PRESERVE_ATTEMPTS, error: String(lastError) },
  });
  return { ok: false };
}
