/**
 * CONTENT-report admin handler (compliance plan 08 §2.2 — the review surface).
 *
 * WHY THIS IS A SEPARATE SURFACE FROM `/api/admin/reports`.
 * The existing moderator queue in `routes/admin.ts` is scoped
 * `reportType: "LINK"` on purpose: it renders `linkUrl`/`domain`, drives
 * DomainReputationService on approval, and runs a DIFFERENT state machine
 * (`approved` | `rejected` | `dismissed`). CONTENT reports carry no domain, must
 * not touch domain reputation, and run the Art. 16 lifecycle
 * (`pending -> acknowledged -> decided` with `resolution`) whose terminal
 * transition is what sends the reporter their Art. 16(5) decision notice.
 * Widening the LINK queue would merge two state machines into one free-string
 * column and make "approve" mean two different things. So: same auth posture,
 * separate route, one shared lifecycle mechanism (`report-lifecycle.ts`).
 *
 * SUPER_ADMIN-gated via `authMiddleware` + `globalRole`, matching the sibling
 * `report-category-admin-handler.ts`.
 */

import type { Env } from "../env.js";
import type { AuthContext } from "./auth/auth-context.js";
import { DataRouter } from "./data-router.js";
import { getLogger } from "./logger.js";
import {
  transitionReportStatus,
  InvalidReportTransitionError,
  ReportNotFoundError,
  REPORT_LIFECYCLE_STATUSES,
  type ReportLifecycleStatus,
} from "./report-lifecycle.js";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Transitions an operator may drive from the review surface. */
const REVIEWABLE_TARGET_STATUSES: ReadonlyArray<ReportLifecycleStatus> = [
  "acknowledged",
  "decided",
];

const ROUTING_CLASSES = [
  "ILLEGAL_PRIORITY",
  "ILLEGAL",
  "POLICY_VIOLATION",
  "FEEDBACK",
] as const;

function requireSuperAdmin(auth: AuthContext): Response | null {
  if (auth.globalRole === "SUPER_ADMIN") return null;
  return json(403, {
    error: "FORBIDDEN",
    message: "SUPER_ADMIN role required for content-report review.",
  });
}

export class ContentReportAdminHandler {
  /**
   * GET /api/admin/content-reports
   *
   * The CONTENT queue. Filterable by `status`, `categoryKey` and
   * `routingClass`; ordered oldest-first by default because this is a
   * deadline-bearing queue (Art. 16 expects timely handling), so the item that
   * has waited longest is the one an operator should see first.
   */
  async handleList(
    auth: AuthContext,
    env: Env,
    url: URL,
    region: string,
  ): Promise<Response> {
    const denied = requireSuperAdmin(auth);
    if (denied) return denied;

    const logger = getLogger();
    try {
      const db = DataRouter.getDatabaseForRegion(region, env);

      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 100)
        : 50;
      const cursor = url.searchParams.get("cursor");
      const status = url.searchParams.get("status");
      const categoryKey = url.searchParams.get("categoryKey");
      const routingClass = url.searchParams.get("routingClass");

      if (status && !REPORT_LIFECYCLE_STATUSES.includes(status as never)) {
        return json(400, {
          error: "VALIDATION_ERROR",
          message: `status must be one of: ${REPORT_LIFECYCLE_STATUSES.join(", ")}`,
        });
      }
      if (routingClass && !ROUTING_CLASSES.includes(routingClass as never)) {
        return json(400, {
          error: "VALIDATION_ERROR",
          message: `routingClass must be one of: ${ROUTING_CLASSES.join(", ")}`,
        });
      }

      const rows = await db.report.findMany({
        where: {
          // The counterpart of admin.ts's `reportType: "LINK"` scope: this queue
          // shows CONTENT reports and only CONTENT reports.
          reportType: "CONTENT",
          ...(status ? { status } : {}),
          ...(categoryKey ? { categoryKey } : {}),
          ...(routingClass ? { category: { routingClass: routingClass as never } } : {}),
          ...(cursor ? { createdAt: { gt: new Date(cursor) } } : {}),
        },
        orderBy: { createdAt: "asc" },
        take: limit + 1,
        select: {
          id: true,
          resourceType: true,
          resourceId: true,
          categoryKey: true,
          reporterUserId: true,
          reason: true,
          status: true,
          resolution: true,
          resolvedAt: true,
          createdAt: true,
          category: { select: { routingClass: true } },
        },
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;

      return json(200, {
        reports: items.map((r) => ({
          id: r.id,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          categoryKey: r.categoryKey,
          routingClass: r.category?.routingClass ?? null,
          reporterUserId: r.reporterUserId,
          reason: r.reason,
          status: r.status,
          resolution: r.resolution,
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        hasMore,
        cursor: hasMore ? items[items.length - 1].createdAt.toISOString() : undefined,
      });
    } catch (error) {
      logger.error("[ContentReportAdmin] list failed", error);
      return json(500, { error: "Internal server error" });
    }
  }

  /**
   * POST /api/admin/content-reports/:id/decision
   *
   * Drives the Art. 16 lifecycle. `{ status: "decided" }` requires a
   * `resolution` and is what sends the reporter their Art. 16(5) decision
   * notice — that side effect lives in `transitionReportStatus`, so this route
   * cannot decide a report without notifying its reporter.
   */
  async handleDecision(
    reportId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
    region: string,
  ): Promise<Response> {
    const denied = requireSuperAdmin(auth);
    if (denied) return denied;

    const logger = getLogger();
    const { z } = await import("zod");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, {
        error: "INVALID_JSON",
        message: "Request body must be valid JSON",
      });
    }

    const schema = z.object({
      status: z.enum(REVIEWABLE_TARGET_STATUSES as readonly [string, ...string[]]),
      resolution: z.enum(["actioned", "rejected"]).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return json(400, {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid decision",
      });
    }
    if (parsed.data.status === "decided" && !parsed.data.resolution) {
      return json(400, {
        error: "VALIDATION_ERROR",
        message: "resolution ('actioned' | 'rejected') is required to decide a report.",
      });
    }

    // Scope check BEFORE the transition: this surface reviews CONTENT reports
    // only, so a LINK/ACCOUNT id must 404 here rather than be driven into the
    // Art. 16 state machine it does not belong to.
    const db = DataRouter.getDatabaseForRegion(region, env);
    const scoped = await db.report.findFirst({
      where: { id: reportId, reportType: "CONTENT" },
      select: { id: true },
    });
    if (!scoped) {
      return json(404, {
        error: "NOT_FOUND",
        message: "Content report not found.",
      });
    }

    try {
      const updated = await transitionReportStatus(
        {
          reportId,
          toStatus: parsed.data.status as ReportLifecycleStatus,
          ...(parsed.data.resolution ? { resolution: parsed.data.resolution } : {}),
          region,
        },
        env,
      );

      logger.info("[ContentReportAdmin] report reviewed", {
        reportId,
        toStatus: parsed.data.status,
        actorUserId: auth.userId,
      });

      return json(200, {
        success: true,
        report: {
          id: updated.id,
          status: updated.status,
          resolution: updated.resolution,
        },
      });
    } catch (error) {
      if (error instanceof ReportNotFoundError) {
        return json(404, { error: "NOT_FOUND", message: "Content report not found." });
      }
      if (error instanceof InvalidReportTransitionError) {
        return json(409, {
          error: "INVALID_TRANSITION",
          message: error.message,
        });
      }
      logger.error("[ContentReportAdmin] decision failed", error);
      return json(500, { error: "Internal server error" });
    }
  }
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
