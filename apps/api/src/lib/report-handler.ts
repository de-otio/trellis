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

      // ILLEGAL_PRIORITY / ILLEGAL => alert the operator immediately (M1 clock).
      // Hook point only — no takedown here (Lane A2).
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
