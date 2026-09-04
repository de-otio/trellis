/**
 * Report Handler (compliance plan 08 §2.2 — the generic Art. 16 illegal-content
 * notice path). Jurisdiction-neutral: it validates the report, resolves the
 * data-driven `ReportCategory`, dedups, persists, and fires the reporter receipt
 * + (for ILLEGAL_* routing classes) the operator alert. It routes ONLY on
 * `category.routingClass` — it never learns what a category means.
 *
 * Back-compat: this is purely additive. LINK reports (`routes/link-reports.ts`)
 * and ACCOUNT reports are untouched; new-style reports set
 * `reportType: "CONTENT"` + `categoryKey`.
 *
 * Takedown / statement-of-reasons / evidence / authority filing are NOT here —
 * they are Lane A2 (plan 08 Phase 2).
 */

import type { Env } from "../env.js";
import type { Session } from "./session-cookie.js";
import type { TrellisRequestContext } from "./request-context.js";
import { DataRouter } from "./data-router.js";
import { getLogger } from "./logger.js";
import { sendReportReceipt } from "./report-notifications.js";
import {
  getOperatorAlertHook,
  routingClassAlertsOperator,
} from "./report-operator-alert.js";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/**
 * Validated `resourceType` set (plan 08 §2.1): the CONTENT targets plus the
 * legacy `url`/`user` values, so this endpoint can also carry ACCOUNT-style
 * (`user`) notices without a second route. The category drives semantics.
 */
export const REPORT_RESOURCE_TYPES = [
  "post",
  "comment",
  "media",
  "entity",
  "user",
  "url",
] as const;

/** Report statuses that count as "open" for dedup (one open report per key). */
export const OPEN_REPORT_STATUSES = ["pending", "acknowledged"] as const;

export interface CreateReportResult {
  status: number;
  body: Record<string, unknown>;
}

export class ReportHandler {
  /**
   * POST /api/reports — file a content report. Auth + rate-limit are enforced by
   * the route; this method owns validation, category routing, dedup, and the
   * reporter/operator notifications.
   */
  async handleCreate(
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    const logger = getLogger();
    const region = requestContext?.region || env.DEFAULT_REGION || "EU";
    const db = DataRouter.getDatabaseForRegion(region, env);

    try {
      const { z } = await import("zod");
      const schema = z.object({
        categoryKey: z.string().min(1).max(200),
        resourceType: z.enum(REPORT_RESOURCE_TYPES),
        resourceId: z.string().min(1).max(512),
        reason: z.string().max(1000).optional(),
      });

      const parsed = schema.safeParse(
        await request.json().catch(() => ({})),
      );
      if (!parsed.success) {
        return json(400, {
          error: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Invalid report",
        });
      }
      const { categoryKey, resourceType, resourceId, reason } = parsed.data;

      // Resolve the data-driven category. Unknown OR inactive => 400 (plan §5).
      const category = await db.reportCategory.findUnique({
        where: { key: categoryKey },
        select: { key: true, active: true, routingClass: true },
      });
      if (!category || !category.active) {
        return json(400, {
          error: "INVALID_CATEGORY",
          message: "Unknown or inactive report category.",
        });
      }

      // Dedup: same reporter + resource + category with an OPEN report already
      // exists => return that one (idempotent), do NOT create a second or
      // re-send the receipt.
      const existing = await db.report.findFirst({
        where: {
          reporterUserId: session.userId,
          resourceType,
          resourceId,
          categoryKey,
          status: { in: [...OPEN_REPORT_STATUSES] },
        },
        select: { id: true, status: true, createdAt: true },
      });
      if (existing) {
        return json(200, {
          success: true,
          deduplicated: true,
          report: {
            id: existing.id,
            status: existing.status,
            categoryKey,
            createdAt: existing.createdAt.toISOString(),
          },
        });
      }

      const report = await db.report.create({
        data: {
          reportType: "CONTENT",
          resourceType,
          resourceId,
          categoryKey,
          reporterUserId: session.userId,
          reason: reason || null,
          status: "pending",
        },
        select: { id: true, status: true, createdAt: true },
      });

      // Resolve the reporter's email + tenant for the receipt notification.
      const reporter = await db.user.findUnique({
        where: { id: session.userId },
        select: { email: true, personalTenantId: true },
      });
      const tenantId = session.activeTenantId ?? reporter?.personalTenantId ?? null;

      // Art. 16(4) receipt — best-effort (never throws), awaited for determinism.
      await sendReportReceipt(
        {
          reportId: report.id,
          reporterUserId: session.userId,
          reporterEmail: reporter?.email ?? session.email,
          tenantId,
        },
        env,
      );

      // ILLEGAL_PRIORITY carve-out (plan 08 §2.3/§2.6): hide + evidence hold +
      // suppressed statement + non-appealable block class + a PENDING authority
      // report, all before any human looks at the queue. Authority SUBMISSION
      // stays human-gated. Never throws — see report-carveout.ts.
      if (category.routingClass === "ILLEGAL_PRIORITY") {
        const { applyIllegalPriorityCarveOut, isCarveOutResourceType } =
          await import("./compliance/report-carveout.js");
        if (isCarveOutResourceType(resourceType)) {
          await applyIllegalPriorityCarveOut(
            db as unknown as Parameters<typeof applyIllegalPriorityCarveOut>[0],
            {
              reportId: report.id,
              resourceType,
              resourceId,
            },
            env,
            region as Parameters<typeof applyIllegalPriorityCarveOut>[3],
          );
        }
      }

      // ILLEGAL_PRIORITY / ILLEGAL => alert the operator immediately (M1 clock).
      if (routingClassAlertsOperator(category.routingClass)) {
        try {
          await getOperatorAlertHook()(
            {
              reportId: report.id,
              routingClass: category.routingClass,
              categoryKey,
              resourceType,
              resourceId,
            },
            env,
          );
        } catch (error) {
          logger.error("[Reports] operator alert failed", error);
        }
      }

      logger.info("[Reports] content report created", {
        reportId: report.id,
        routingClass: category.routingClass,
        resourceType,
      });

      return json(201, {
        success: true,
        report: {
          id: report.id,
          status: report.status,
          categoryKey,
          createdAt: report.createdAt.toISOString(),
        },
      });
    } catch (error) {
      logger.error("[Reports] error creating report", error);
      return json(500, { error: "Internal server error" });
    }
  }

  /**
   * GET /api/report-categories — the ACTIVE report vocabulary a client renders
   * in its category picker.
   *
   * The vocabulary is deployment-seeded data, never a compiled-in list, so a
   * client MUST read it from here rather than hardcoding categories: core ships
   * no jurisdiction or offence vocabulary, and a client that hardcoded one would
   * put it back into the published surface by the back door.
   *
   * Returns `key` + the deployment's localized `labels` only. `routingClass` is
   * deliberately WITHHELD: it is the operator's routing decision, and telling a
   * reporter which categories trigger the priority path is an oracle over the
   * deployment's enforcement posture. Inactive categories are omitted entirely —
   * that is the gate a deployment uses to ship a category before its legal
   * review lands.
   */
  async handleListCategories(
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    const logger = getLogger();
    const region = requestContext?.region || env.DEFAULT_REGION || "EU";
    const db = DataRouter.getDatabaseForRegion(region, env);

    try {
      const rows = await db.reportCategory.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
        select: { key: true, labels: true },
      });

      return json(200, {
        categories: rows.map((c) => ({ key: c.key, labels: c.labels })),
      });
    } catch (error) {
      logger.error("[Reports] error listing report categories", error);
      return json(500, { error: "Internal server error" });
    }
  }

  /**
   * GET /api/reports/:id — the reporter's status poll for ONE of their reports.
   *
   * This is the Art. 16 loop made observable to the person who filed it. It
   * returns, in one document:
   *   - `receipt`     — Art. 16(4) confirmation of receipt (always present; the
   *                     row's own existence IS the receipt, so a lost email
   *                     never costs the reporter their confirmation);
   *   - `decision`    — Art. 16(5) outcome, once decided;
   *   - `statementOfReasons` — the FACT and the kind of restriction applied,
   *                     once decided and actioned;
   *   - `remedies`    — Art. 16(5) redress information, once decided.
   *
   * Reporter-scoped: a report belonging to someone else 404s exactly as a
   * non-existent one does, so this cannot be used to enumerate report ids.
   *
   * ANTI-TIP-OFF: a SUPPRESSED statement of reasons is never surfaced here. The
   * suppression exists so the affected user is not warned; echoing it to the
   * reporter would leak the same fact through a second door, and a reporter is
   * not necessarily a disinterested party.
   */
  async handleStatus(
    reportId: string,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    const logger = getLogger();
    const region = requestContext?.region || env.DEFAULT_REGION || "EU";
    const db = DataRouter.getDatabaseForRegion(region, env);

    try {
      const report = await db.report.findFirst({
        where: { id: reportId, reporterUserId: session.userId },
        select: {
          id: true,
          reportType: true,
          resourceType: true,
          resourceId: true,
          categoryKey: true,
          status: true,
          resolution: true,
          resolvedAt: true,
          createdAt: true,
        },
      });
      if (!report) {
        // Identical to "not yours" — no oracle.
        return json(404, {
          error: "NOT_FOUND",
          message: "Report not found.",
        });
      }

      const { REPORT_TEMPLATE_KEYS, resolveReportTemplate } = await import(
        "./report-templates.js"
      );
      const params = { reportId: report.id };

      const decided = report.status === "decided" && report.resolution != null;
      const actioned = decided && report.resolution === "actioned";

      // Art. 17 statement: only the fact + restriction, only when one was
      // actually delivered (suppressed => invisible), only once actioned.
      let statementOfReasons: {
        restriction: string;
        issuedAt: string;
      } | null = null;
      if (actioned) {
        const statement = await db.statementOfReasons.findFirst({
          where: {
            resourceType: report.resourceType,
            resourceId: report.resourceId,
            suppressed: false,
          },
          orderBy: { createdAt: "desc" },
          select: { restriction: true, createdAt: true },
        });
        if (statement) {
          statementOfReasons = {
            restriction: statement.restriction,
            issuedAt: statement.createdAt.toISOString(),
          };
        }
      }

      const receiptCopy = resolveReportTemplate(
        REPORT_TEMPLATE_KEYS.RECEIPT,
        params,
      );

      return json(200, {
        report: {
          id: report.id,
          reportType: report.reportType,
          resourceType: report.resourceType,
          resourceId: report.resourceId,
          categoryKey: report.categoryKey,
          status: report.status,
          createdAt: report.createdAt.toISOString(),
        },
        // Art. 16(4).
        receipt: {
          confirmed: true,
          receivedAt: report.createdAt.toISOString(),
          title: receiptCopy.title,
          body: receiptCopy.body,
        },
        // Art. 16(5).
        decision: decided
          ? {
              outcome: report.resolution,
              decidedAt: report.resolvedAt?.toISOString() ?? null,
              ...resolveReportTemplate(
                report.resolution === "actioned"
                  ? REPORT_TEMPLATE_KEYS.DECISION_ACTIONED
                  : REPORT_TEMPLATE_KEYS.DECISION_REJECTED,
                params,
              ),
            }
          : null,
        // Art. 17, as far as it concerns the reporter: that a restriction was
        // applied and of what kind. Never the affected user, never the template
        // key, never the params.
        statementOfReasons,
        // Art. 16(5) redress information — travels with the decision.
        remedies: decided
          ? resolveReportTemplate(REPORT_TEMPLATE_KEYS.REDRESS, params)
          : null,
      });
    } catch (error) {
      logger.error("[Reports] error reading report status", error);
      return json(500, { error: "Internal server error" });
    }
  }

  /**
   * GET /api/reports/mine — the reporter's own notices + statuses (all report
   * types, newest first). Cursor pagination on `createdAt`.
   */
  async handleListMine(
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
    url: URL,
  ): Promise<Response> {
    const logger = getLogger();
    const region = requestContext?.region || env.DEFAULT_REGION || "EU";
    const db = DataRouter.getDatabaseForRegion(region, env);

    try {
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 50)
        : 20;
      const cursor = url.searchParams.get("cursor");

      const rows = await db.report.findMany({
        where: {
          reporterUserId: session.userId,
          ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        select: {
          id: true,
          reportType: true,
          resourceType: true,
          resourceId: true,
          categoryKey: true,
          status: true,
          resolution: true,
          reason: true,
          createdAt: true,
        },
      });

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);

      return json(200, {
        reports: items.map((r) => ({
          id: r.id,
          reportType: r.reportType,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          categoryKey: r.categoryKey,
          status: r.status,
          resolution: r.resolution,
          reason: r.reason,
          createdAt: r.createdAt.toISOString(),
        })),
        cursor: hasMore ? items[items.length - 1].createdAt.toISOString() : undefined,
        hasMore,
      });
    } catch (error) {
      logger.error("[Reports] error listing reports", error);
      return json(500, { error: "Internal server error" });
    }
  }
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
