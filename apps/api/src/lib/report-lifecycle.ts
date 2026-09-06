/**
 * Report lifecycle (compliance plan 08 §2.2). The free-string `status` column
 * carries the CONTENT-report lifecycle:
 *
 *   pending  ->  acknowledged  ->  decided   (resolution: "actioned" | "rejected")
 *   pending  ->  decided                        (ack is optional)
 *
 * This module is the transition MECHANISM: it validates the move, persists it,
 * and — when a report reaches the terminal `decided` state — fires the Art.
 * 16(5) decision notification to the reporter. The admin/decision ROUTE that
 * drives it is Lane A2; Lane A ships the mechanism + its tests.
 *
 * Legacy LINK/ACCOUNT statuses (`reviewed`/`resolved`) are NOT part of this
 * state machine and are left untouched.
 */

import type { Env } from "../env.js";
import { createPrisma } from "../db.js";
import { getLogger } from "./logger.js";
import {
  sendReportDecision,
  type ReportDecisionOutcome,
} from "./report-notifications.js";

export const REPORT_LIFECYCLE_STATUSES = [
  "pending",
  "acknowledged",
  "decided",
] as const;
export type ReportLifecycleStatus = (typeof REPORT_LIFECYCLE_STATUSES)[number];

/** Allowed forward transitions in the CONTENT-report lifecycle. */
const ALLOWED_TRANSITIONS: Record<string, ReadonlyArray<ReportLifecycleStatus>> = {
  pending: ["acknowledged", "decided"],
  acknowledged: ["decided"],
  decided: [],
};

export class InvalidReportTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid report status transition: "${from}" -> "${to}"`);
    this.name = "InvalidReportTransitionError";
  }
}

export class ReportNotFoundError extends Error {
  constructor(reportId: string) {
    super(`Report ${reportId} not found`);
    this.name = "ReportNotFoundError";
  }
}

export interface TransitionInput {
  reportId: string;
  toStatus: ReportLifecycleStatus;
  /** Required when `toStatus === "decided"`. */
  resolution?: ReportDecisionOutcome;
  region?: string;
  /**
   * When set, the report's `reportType` must match or the transition throws
   * `ReportNotFoundError` — the caller's scope check folded into this
   * function's own `Report` lookup instead of a separate pre-fetch of the
   * same row (quality sweep 2026-09-05, D6).
   */
  expectedReportType?: string;
}

export interface TransitionResult {
  id: string;
  status: string;
  resolution: string | null;
}

/**
 * Transition a report's lifecycle status. On reaching `decided`, sets
 * `resolution` + `resolvedAt` and sends the reporter the decision notification
 * (best-effort). Throws `InvalidReportTransitionError` for an illegal move and
 * `ReportNotFoundError` for a missing report.
 */
export async function transitionReportStatus(
  input: TransitionInput,
  env: Env,
): Promise<TransitionResult> {
  const logger = getLogger();
  const region = input.region ?? env.DEFAULT_REGION ?? "EU";
  const db = createPrisma(env, region);

  const report = await db.report.findUnique({
    where: { id: input.reportId },
    select: { id: true, status: true, reporterUserId: true, reportType: true },
  });
  if (!report) throw new ReportNotFoundError(input.reportId);
  if (input.expectedReportType !== undefined && report.reportType !== input.expectedReportType) {
    // A report of the wrong type is not this caller's to transition — treat
    // it as not found rather than driving it into a lifecycle it does not
    // belong to.
    throw new ReportNotFoundError(input.reportId);
  }

  const allowed = ALLOWED_TRANSITIONS[report.status] ?? [];
  if (!allowed.includes(input.toStatus)) {
    throw new InvalidReportTransitionError(report.status, input.toStatus);
  }

  if (input.toStatus === "decided") {
    if (input.resolution !== "actioned" && input.resolution !== "rejected") {
      throw new InvalidReportTransitionError(
        report.status,
        "decided (resolution must be 'actioned' or 'rejected')",
      );
    }

    const updated = await db.report.update({
      where: { id: report.id },
      data: {
        status: "decided",
        resolution: input.resolution,
        resolvedAt: new Date(),
      },
      select: { id: true, status: true, resolution: true },
    });

    // Art. 16(5) decision notification — resolve reporter email + tenant.
    const reporter = await db.user.findUnique({
      where: { id: report.reporterUserId },
      select: { email: true, personalTenantId: true },
    });
    await sendReportDecision(
      {
        reportId: report.id,
        reporterUserId: report.reporterUserId,
        reporterEmail: reporter?.email ?? null,
        tenantId: reporter?.personalTenantId ?? null,
      },
      input.resolution,
      env,
    );

    logger.info("[Reports] report decided", {
      reportId: report.id,
      resolution: input.resolution,
    });
    return updated;
  }

  const updated = await db.report.update({
    where: { id: report.id },
    data: { status: input.toStatus },
    select: { id: true, status: true, resolution: true },
  });
  logger.info("[Reports] report status transitioned", {
    reportId: report.id,
    toStatus: input.toStatus,
  });
  return updated;
}
