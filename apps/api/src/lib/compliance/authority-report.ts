// Authority-report tracking (compliance plan 08 §2.6 — M3, channel-agnostic).
// The RECORD is identical in every country; the CHANNEL (injected) decides HOW a
// confirmed report is filed. Core NEVER auto-submits: creation only ever yields a
// `pending` record. Submission is an explicit, operator-confirmed action (a false
// positive to a federal-police portal is not acceptable). Closing a report
// releases the evidence hold.

import type { Env } from "../../env.js";
import { getLogger } from "../logger.js";
import {
  getAuthorityReportChannel,
  getEvidencePreservationStore,
} from "../media/compliance-seams.js";
import { TrellisAuditLogger } from "../audit-composer.js";
import {
  AUTHORITY_REPORT_CREATED,
  AUTHORITY_REPORT_SUBMITTED,
  AUTHORITY_REPORT_CLOSED,
  EVIDENCE_HOLD_RELEASED,
} from "../audit-actions.js";
import type { Region } from "../region-detection.js";

/** Minimal Prisma slice for authority-report persistence. */
export interface AuthorityReportDb {
  authorityReport: {
    create(args: {
      data: {
        jurisdiction: string;
        status: string;
        evidenceId?: string | null;
        bundle: Record<string, unknown>;
      };
      select: { id: true; status: true };
    }): Promise<{ id: string; status: string }>;
    findUnique(args: {
      where: { id: string };
      select: { id: true; status: true; evidenceId: true; channelMode: true };
    }): Promise<{
      id: string;
      status: string;
      evidenceId: string | null;
      channelMode: string | null;
    } | null>;
    /**
     * Conditional transition. The `where` carries the EXPECTED status, so the
     * database decides the race: `count === 1` means this caller made the
     * transition and nobody else did.
     */
    updateMany(args: {
      where: { id: string; status: string };
      data: { status: string };
    }): Promise<{ count: number }>;
    update(args: {
      where: { id: string };
      data: {
        status?: string;
        channelMode?: string | null;
        submittedAt?: Date;
        closedAt?: Date;
      };
      select: { id: true; status: true };
    }): Promise<{ id: string; status: string }>;
  };
}

export interface CreateAuthorityReportInput {
  jurisdiction: string;
  evidenceId?: string | null;
  /** Art.-18 info bundle — REFS, never bytes. */
  bundle: Record<string, unknown>;
}

/**
 * Create a `pending` authority report. This function DELIBERATELY does not touch
 * the {@link AuthorityReportChannel} — nothing is filed on creation. The record
 * sits `pending` until an operator confirms via {@link markAuthorityReportSubmitted}.
 */
export async function createPendingAuthorityReport(
  db: AuthorityReportDb,
  input: CreateAuthorityReportInput,
  env: Env,
  region: Region,
): Promise<{ id: string; status: string }> {
  const record = await db.authorityReport.create({
    data: {
      jurisdiction: input.jurisdiction,
      status: "pending",
      evidenceId: input.evidenceId ?? null,
      bundle: input.bundle,
    },
    select: { id: true, status: true },
  });

  await new TrellisAuditLogger(env).logSystemAction(
    AUTHORITY_REPORT_CREATED,
    {
      resource: "authority_report",
      resourceId: record.id,
      region,
      success: true,
      severity: "high",
      // Neutral metadata: NO category, NO classifier output.
      metadata: { jurisdiction: input.jurisdiction, status: "pending" },
    },
    env,
  );

  getLogger().info("[AuthorityReport] pending report created (NOT submitted)", {
    authorityReportId: record.id,
  });
  return record;
}

/**
 * Transient status held between claiming a report and the channel returning.
 * Not a state an operator ever sees on purpose: it exists so that the CLAIM is
 * a database decision rather than a read-then-write in application code.
 */
const SUBMITTING = "submitting";

/**
 * Operator-confirmed submission (M3). Files the report THROUGH the injected
 * channel — never called automatically by the pipeline. Persists the channel
 * mode + `submitted` status.
 *
 * **Idempotent, and now actually so.** A non-`pending` report is returned
 * unchanged without touching the channel. This was documented from the start
 * and never implemented: the function read `status` and then submitted
 * regardless, so a double-click, a client retry, or two operators working the
 * same queue filed the SAME report to the authority twice — through a channel
 * that is a real federal portal in production. (Quality sweep 2026-09-05, A1.)
 *
 * The guard is a conditional `updateMany` rather than a read-then-check,
 * because a read-then-check does not close the concurrent case — the one that
 * matters here, since "two operators clicked at once" is exactly how a shared
 * moderation queue is worked. The database decides who claims it.
 *
 * Ordering is claim → submit → confirm. The alternative (mark submitted, then
 * file) would leave a report that was never filed looking filed, which is the
 * worse failure for an Art.-18 obligation. If the channel throws, the claim is
 * released so the report returns to `pending` and can be retried.
 */
export async function markAuthorityReportSubmitted(
  db: AuthorityReportDb,
  id: string,
  input: { jurisdiction: string; bundle: Record<string, unknown>; evidenceId?: string | null },
  env: Env,
  region: Region,
): Promise<{ id: string; status: string; channelMode: string | null }> {
  const existing = await db.authorityReport.findUnique({
    where: { id },
    select: { id: true, status: true, evidenceId: true, channelMode: true },
  });
  if (!existing) throw new Error(`AuthorityReport ${id} not found`);

  if (existing.status !== "pending") {
    getLogger().info("[AuthorityReport] already filed — not submitting again", {
      authorityReportId: id,
      status: existing.status,
    });
    return { id: existing.id, status: existing.status, channelMode: existing.channelMode };
  }

  // Claim it. `count === 0` means another caller got there between the read
  // above and this write — the race the docstring's promise implies is closed.
  const claimed = await db.authorityReport.updateMany({
    where: { id, status: "pending" },
    data: { status: SUBMITTING },
  });
  if (claimed.count === 0) {
    const current = await db.authorityReport.findUnique({
      where: { id },
      select: { id: true, status: true, evidenceId: true, channelMode: true },
    });
    getLogger().info("[AuthorityReport] lost the submit race — not submitting again", {
      authorityReportId: id,
      status: current?.status,
    });
    return {
      id,
      status: current?.status ?? SUBMITTING,
      channelMode: current?.channelMode ?? null,
    };
  }

  let result;
  try {
    result = await getAuthorityReportChannel().submit({
      jurisdiction: input.jurisdiction,
      evidenceId: input.evidenceId ?? existing.evidenceId ?? undefined,
      bundle: input.bundle,
    });
  } catch (error) {
    // Release the claim so the report is retryable. Scoped to SUBMITTING so a
    // concurrent finalisation is never overwritten.
    await db.authorityReport.updateMany({
      where: { id, status: SUBMITTING },
      data: { status: "pending" },
    });
    throw error;
  }
  const channelMode = result.mode;

  const updated = await db.authorityReport.update({
    where: { id },
    data: { status: "submitted", channelMode, submittedAt: new Date() },
    select: { id: true, status: true },
  });

  await new TrellisAuditLogger(env).logSystemAction(
    AUTHORITY_REPORT_SUBMITTED,
    {
      resource: "authority_report",
      resourceId: id,
      region,
      success: true,
      severity: "high",
      metadata: { channelMode },
    },
    env,
  );

  return { ...updated, channelMode };
}

/**
 * Close an authority report and RELEASE the evidence hold (plan 08 §2.6). The
 * hold release calls the injected {@link EvidencePreservationStore} for the
 * WORM-copy hold and clears the DB `evidenceHold` flag on any media rows carrying
 * this evidence id, so the hard-delete GC path may resume for them.
 */
export async function markAuthorityReportClosed(
  db: AuthorityReportDb & {
    mediaFile?: {
      updateMany(args: {
        where: { evidenceId: string };
        data: { evidenceHold: boolean };
      }): Promise<{ count: number }>;
    };
  },
  id: string,
  reason: string,
  env: Env,
  region: Region,
): Promise<{ id: string; status: string }> {
  const existing = await db.authorityReport.findUnique({
    where: { id },
    select: { id: true, status: true, evidenceId: true, channelMode: true },
  });
  if (!existing) throw new Error(`AuthorityReport ${id} not found`);

  if (existing.evidenceId) {
    // Release the WORM legal hold (break-glass parity: audited). Best-effort on
    // the store; the DB flag clear below is what unblocks GC.
    try {
      await getEvidencePreservationStore().releaseHold(existing.evidenceId, reason);
    } catch (error) {
      getLogger().error("[AuthorityReport] hold release on store failed", error);
    }
    if (db.mediaFile) {
      await db.mediaFile.updateMany({
        where: { evidenceId: existing.evidenceId },
        data: { evidenceHold: false },
      });
    }
    await new TrellisAuditLogger(env).logSystemAction(
      EVIDENCE_HOLD_RELEASED,
      {
        resource: "evidence",
        resourceId: existing.evidenceId,
        region,
        success: true,
        severity: "high",
        metadata: { authorityReportId: id, reason },
      },
      env,
    );
  }

  const updated = await db.authorityReport.update({
    where: { id },
    data: { status: "closed", closedAt: new Date() },
    select: { id: true, status: true },
  });

  await new TrellisAuditLogger(env).logSystemAction(
    AUTHORITY_REPORT_CLOSED,
    { resource: "authority_report", resourceId: id, region, success: true, severity: "medium" },
    env,
  );

  return updated;
}
