/**
 * ReportCategory Admin Handler (compliance plan 08 §2.1).
 *
 * SUPER_ADMIN-gated management of the data-driven `ReportCategory` vocabulary.
 * The deployment SEEDS its categories (`seed:report-categories`); this surface
 * lets an operator create/update/deactivate and list them at runtime. Mirrors
 * `tenant/platform-category-admin-handler.ts` (same auth guard + audit pattern).
 *
 * Core stays jurisdiction-neutral: it validates `routingClass` (the only thing
 * it routes on) and stores `labels` opaquely — it never interprets category
 * meaning.
 */

import type { Env } from "../env.js";
import type { AuthContext } from "./auth/auth-context.js";
import {
  REPORT_CATEGORY_CREATED,
  REPORT_CATEGORY_DEACTIVATED,
  REPORT_CATEGORY_UPDATED,
} from "./audit-actions.js";
import type { AuditAction } from "@de-otio/saas-foundation/audit";
import type { Region } from "./region-detection.js";

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
    message: "SUPER_ADMIN role required for report-category administration.",
  });
}

async function emitAudit(
  action: AuditAction,
  resourceId: string,
  actorUserId: string,
  metadata: Record<string, unknown>,
  env: Env,
): Promise<void> {
  try {
    const { TrellisAuditLogger } = await import("./audit-composer.js");
    const region: Region =
      ((env as unknown as { DEFAULT_REGION?: string }).DEFAULT_REGION as Region) ??
      "EU";
    const auditLogger = new TrellisAuditLogger();
    await auditLogger.logSystemAction(
      action,
      {
        resource: "report_category",
        resourceId,
        userId: actorUserId,
        region,
        success: true,
        metadata: { ...metadata, actorUserId },
      },
      env as Parameters<
        InstanceType<typeof TrellisAuditLogger>["logSystemAction"]
      >[2],
    );
  } catch {
    // Best-effort: audit failure must not block the mutation.
  }
}

export class ReportCategoryAdminHandler {
  /**
   * POST /api/admin/report-categories
   * Create or update (upsert by `key`) a report category. SUPER_ADMIN only.
   */
  async handleUpsert(
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied = requireSuperAdmin(auth);
    if (denied) return denied;

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
      key: z
        .string()
        .min(1)
        .max(200)
        .regex(
          /^[a-z][a-z0-9:-]*$/,
          "key must be lowercase alphanumeric with hyphens or colons",
        ),
      routingClass: z.enum(ROUTING_CLASSES),
      labels: z.record(z.string(), z.string()),
      active: z.boolean().optional(),
      sortOrder: z.number().int().min(0).optional(),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return json(400, {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid input",
      });
    }
    const { key, routingClass, labels, active, sortOrder } = parsed.data;

    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);

    const existing = await db.reportCategory.findUnique({
      where: { key },
      select: { key: true },
    });

    const saved = await db.reportCategory.upsert({
      where: { key },
      create: {
        key,
        routingClass,
        labels,
        ...(active !== undefined && { active }),
        ...(sortOrder !== undefined && { sortOrder }),
      },
      update: {
        routingClass,
        labels,
        ...(active !== undefined && { active }),
        ...(sortOrder !== undefined && { sortOrder }),
      },
      select: {
        key: true,
        routingClass: true,
        labels: true,
        active: true,
        sortOrder: true,
      },
    });

    void emitAudit(
      existing ? REPORT_CATEGORY_UPDATED : REPORT_CATEGORY_CREATED,
      key,
      auth.userId,
      { routingClass, active: saved.active },
      env,
    );

    return json(existing ? 200 : 201, saved);
  }

  /**
   * POST /api/admin/report-categories/:key/deactivate
   * Deactivate a category (active=false). SUPER_ADMIN only. Existing reports
   * keep their categoryKey; the category simply stops being offerable/valid for
   * new reports.
   */
  async handleDeactivate(
    key: string,
    _request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied = requireSuperAdmin(auth);
    if (denied) return denied;

    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);

    const existing = await db.reportCategory.findUnique({
      where: { key },
      select: { key: true, active: true },
    });
    if (!existing) {
      return json(404, {
        error: "NOT_FOUND",
        message: "Report category not found",
      });
    }
    if (!existing.active) {
      return json(409, {
        error: "CONFLICT",
        message: "Report category is already inactive",
      });
    }

    await db.reportCategory.update({
      where: { key },
      data: { active: false },
    });

    void emitAudit(REPORT_CATEGORY_DEACTIVATED, key, auth.userId, {}, env);

    return json(200, { ok: true, key, active: false });
  }

  /**
   * GET /api/admin/report-categories
   * List all report categories (admin view — includes inactive). SUPER_ADMIN only.
   */
  async handleList(auth: AuthContext, env: Env): Promise<Response> {
    const denied = requireSuperAdmin(auth);
    if (denied) return denied;

    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);

    const categories = await db.reportCategory.findMany({
      orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { key: "asc" }],
      select: {
        key: true,
        routingClass: true,
        labels: true,
        active: true,
        sortOrder: true,
      },
    });

    return json(200, { categories });
  }
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
