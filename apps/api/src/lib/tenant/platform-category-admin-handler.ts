/**
 * PlatformCategory Admin Handler
 *
 * Platform-level admin operations on the shared `PlatformCategory` taxonomy.
 * Every method here is SUPER_ADMIN-gated via the global `UserRole` — this is
 * platform administration, not tenant administration, so no tenant capability
 * check is appropriate. A capability check would be wrong here: it verifies
 * the caller's role *within their active tenant*, not their platform role.
 *
 * Operations:
 *   - handleCreate  — create a new PlatformCategory node
 *   - handleDeactivate — deactivate a node (with mandatory reassignment when
 *                        active TenantClassification rows depend on it)
 *   - handleReparent — move a node to a new parent (rejects cycles)
 *
 * Audit: every mutation emits a platform-category audit event via
 * `TrellisAuditLogger.logSystemAction` (fire-and-forget, best-effort).
 * Platform events have no tenantId, so `TenantAuditEmitter` is not used.
 */

import type { Env } from "../../env.js";
import type { AuthContext } from "../auth/auth-context.js";
import { resolveDescendantCategoryIds } from "../org-category/tree.js";
import {
  PLATFORM_CATEGORY_CREATED,
  PLATFORM_CATEGORY_DEACTIVATED,
  PLATFORM_CATEGORY_REPARENTED,
} from "../audit-actions.js";
import type { AuditAction } from "@de-otio/saas-foundation/audit";
import type { Region } from "../region-detection.js";

// ── Auth guard ─────────────────────────────────────────────────────────────

function requireSuperAdmin(auth: AuthContext): Response | null {
  if (auth.globalRole === "SUPER_ADMIN") return null;
  return new Response(
    JSON.stringify({
      error: "FORBIDDEN",
      message: "SUPER_ADMIN role required for platform category administration.",
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}

// ── Audit helper ───────────────────────────────────────────────────────────

async function emitPlatformCategoryAudit(
  action: AuditAction,
  resourceId: string,
  actorUserId: string,
  metadata: Record<string, unknown>,
  env: Env,
): Promise<void> {
  try {
    const { TrellisAuditLogger } = await import("../audit-composer.js");
    const region: Region =
      (env as unknown as { DEFAULT_REGION?: string }).DEFAULT_REGION as Region ?? "EU";
    const auditLogger = new TrellisAuditLogger();
    await auditLogger.logSystemAction(
      action,
      {
        resource: "platform_category",
        resourceId,
        userId: actorUserId,
        region,
        success: true,
        metadata: { ...metadata, actorUserId },
      },
      env as Parameters<InstanceType<typeof TrellisAuditLogger>["logSystemAction"]>[2],
    );
  } catch {
    // Best-effort: audit failures must not block the mutation.
  }
}

// ── Handler ────────────────────────────────────────────────────────────────

export class PlatformCategoryAdminHandler {
  /**
   * POST /api/admin/platform-categories
   * Create a new PlatformCategory node in the shared taxonomy.
   * SUPER_ADMIN only.
   */
  async handleCreate(
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
      return new Response(
        JSON.stringify({ error: "INVALID_JSON", message: "Request body must be valid JSON" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const schema = z.object({
      code: z.string().min(1).max(200).regex(
        /^[a-z][a-z0-9:-]*$/,
        "code must be lowercase alphanumeric with hyphens or colons",
      ),
      displayName: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      order: z.number().int().min(0).optional().default(0),
      parentCategoryId: z.string().min(1).optional(),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({
          error: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Invalid input",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const { code, displayName, description, order, parentCategoryId } = parsed.data;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    // Validate parentCategoryId if supplied.
    if (parentCategoryId !== undefined) {
      const parent = await db.platformCategory.findUnique({
        where: { id: parentCategoryId },
        select: { id: true, isActive: true },
      });
      if (!parent) {
        return new Response(
          JSON.stringify({
            error: "NOT_FOUND",
            message: "Parent category not found",
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      if (!parent.isActive) {
        return new Response(
          JSON.stringify({
            error: "VALIDATION_ERROR",
            message: "Parent category is inactive — cannot create a child under an inactive node",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
    }

    try {
      const created = await db.platformCategory.create({
        data: {
          code,
          displayName,
          ...(description !== undefined && { description }),
          order,
          ...(parentCategoryId !== undefined && { parentCategoryId }),
        },
        select: {
          id: true,
          code: true,
          displayName: true,
          description: true,
          order: true,
          isActive: true,
          parentCategoryId: true,
          createdAt: true,
        },
      });

      void emitPlatformCategoryAudit(
        PLATFORM_CATEGORY_CREATED,
        created.id,
        auth.userId,
        { code: created.code, displayName: created.displayName, parentCategoryId: created.parentCategoryId },
        env,
      );

      return new Response(JSON.stringify(created), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    } catch (err: unknown) {
      if (
        err !== null &&
        typeof err === "object" &&
        (err as { code?: unknown }).code === "P2002"
      ) {
        return new Response(
          JSON.stringify({ error: "CONFLICT", message: "A category with this code already exists" }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      throw err;
    }
  }

  /**
   * POST /api/admin/platform-categories/:id/deactivate
   * Deactivate a PlatformCategory node.
   *
   * If any active TenantClassification rows point at this node (or any of its
   * descendants), a `reassignTo` category id MUST be supplied and valid:
   *   1. It must exist.
   *   2. It must be active.
   *   3. It must not be the node being deactivated.
   *   4. It must not be a descendant of the node being deactivated.
   *
   * Affected TenantClassification rows are bulk-reassigned in the same
   * transaction as the deactivation, so there is no window of orphaned data.
   * SUPER_ADMIN only.
   */
  async handleDeactivate(
    categoryId: string,
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
      body = {};
    }

    const schema = z.object({
      reassignTo: z.string().min(1).optional(),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({
          error: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Invalid input",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const { reassignTo } = parsed.data;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    // Fetch the target category plus all categories (for descendant resolution).
    const [target, allCategories] = await Promise.all([
      db.platformCategory.findUnique({
        where: { id: categoryId },
        select: { id: true, code: true, isActive: true },
      }),
      db.platformCategory.findMany({
        select: { id: true, code: true, parentCategoryId: true },
      }),
    ]);

    if (!target) {
      return new Response(
        JSON.stringify({ error: "NOT_FOUND", message: "Platform category not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    if (!target.isActive) {
      return new Response(
        JSON.stringify({ error: "CONFLICT", message: "Platform category is already inactive" }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }

    // Determine all category ids that will be deactivated (node + descendants).
    const affectedCategoryIds = resolveDescendantCategoryIds(categoryId, allCategories);

    // Check whether any TenantClassification rows depend on the affected nodes.
    const affectedClassificationCount = await db.tenantClassification.count({
      where: { categoryId: { in: affectedCategoryIds } },
    });

    if (affectedClassificationCount > 0) {
      // reassignTo is mandatory when classifications depend on this subtree.
      if (!reassignTo) {
        return new Response(
          JSON.stringify({
            error: "REASSIGN_REQUIRED",
            message:
              `${affectedClassificationCount} tenant classification(s) depend on this category or its descendants. ` +
              "Provide a `reassignTo` category id to bulk-reassign them before deactivating.",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }

      // Validate the reassignTo target.
      // Rule 1 + 2: must exist and be active.
      const reassignTarget = await db.platformCategory.findUnique({
        where: { id: reassignTo },
        select: { id: true, isActive: true },
      });

      if (!reassignTarget) {
        return new Response(
          JSON.stringify({
            error: "VALIDATION_ERROR",
            message: "reassignTo category not found",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (!reassignTarget.isActive) {
        return new Response(
          JSON.stringify({
            error: "VALIDATION_ERROR",
            message: "reassignTo category is inactive — cannot reassign to an inactive node",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      // Rule 3: must not be the node being deactivated.
      if (reassignTo === categoryId) {
        return new Response(
          JSON.stringify({
            error: "VALIDATION_ERROR",
            message: "reassignTo must not be the same as the category being deactivated",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      // Rule 4: must not be a descendant of the node being deactivated.
      if (affectedCategoryIds.includes(reassignTo)) {
        return new Response(
          JSON.stringify({
            error: "VALIDATION_ERROR",
            message:
              "reassignTo must not be a descendant of the category being deactivated — " +
              "that would reassign into a node that is itself about to become unreachable",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Bulk-reassign in the same transaction as the deactivation.
      await db.$transaction([
        db.tenantClassification.updateMany({
          where: { categoryId: { in: affectedCategoryIds } },
          data: { categoryId: reassignTo },
        }),
        db.platformCategory.updateMany({
          where: { id: { in: affectedCategoryIds } },
          data: { isActive: false },
        }),
      ]);

      void emitPlatformCategoryAudit(
        PLATFORM_CATEGORY_DEACTIVATED,
        categoryId,
        auth.userId,
        {
          code: target.code,
          affectedDescendants: affectedCategoryIds.filter((id) => id !== categoryId),
          affectedClassificationCount,
          reassignedTo: reassignTo,
        },
        env,
      );

      return new Response(
        JSON.stringify({
          ok: true,
          deactivatedIds: affectedCategoryIds,
          reclassifiedCount: affectedClassificationCount,
          reassignedTo: reassignTo,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // No classifications depend on this subtree — simple deactivation.
    await db.platformCategory.updateMany({
      where: { id: { in: affectedCategoryIds } },
      data: { isActive: false },
    });

    void emitPlatformCategoryAudit(
      PLATFORM_CATEGORY_DEACTIVATED,
      categoryId,
      auth.userId,
      {
        code: target.code,
        affectedDescendants: affectedCategoryIds.filter((id) => id !== categoryId),
        affectedClassificationCount: 0,
      },
      env,
    );

    return new Response(
      JSON.stringify({
        ok: true,
        deactivatedIds: affectedCategoryIds,
        reclassifiedCount: 0,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  /**
   * POST /api/admin/platform-categories/:id/reparent
   * Move a PlatformCategory to a new parent.
   *
   * Rejects if the new parent is a descendant of the node being reparented —
   * that would introduce a cycle. Even though the taxonomy is platform-curated
   * (SUPER_ADMIN-only writes), a reparent typo is exactly the maintenance
   * surface where a cycle could slip in. SUPER_ADMIN only.
   */
  async handleReparent(
    categoryId: string,
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
      return new Response(
        JSON.stringify({ error: "INVALID_JSON", message: "Request body must be valid JSON" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const schema = z.object({
      newParentCategoryId: z.string().min(1).nullable(),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({
          error: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Invalid input",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const { newParentCategoryId } = parsed.data;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    // Fetch the node being reparented.
    const target = await db.platformCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, code: true, isActive: true, parentCategoryId: true },
    });

    if (!target) {
      return new Response(
        JSON.stringify({ error: "NOT_FOUND", message: "Platform category not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    // Reparenting an inactive node is not allowed — it's confusing and generally
    // indicates a workflow error.
    if (!target.isActive) {
      return new Response(
        JSON.stringify({
          error: "CONFLICT",
          message: "Cannot reparent an inactive category",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }

    if (newParentCategoryId !== null) {
      // Validate the new parent.
      const newParent = await db.platformCategory.findUnique({
        where: { id: newParentCategoryId },
        select: { id: true, isActive: true },
      });

      if (!newParent) {
        return new Response(
          JSON.stringify({ error: "NOT_FOUND", message: "New parent category not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      if (!newParent.isActive) {
        return new Response(
          JSON.stringify({
            error: "VALIDATION_ERROR",
            message: "New parent category is inactive — cannot reparent under an inactive node",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Cycle guard: new parent must NOT be a descendant of the node being reparented.
      const allCategories = await db.platformCategory.findMany({
        select: { id: true, code: true, parentCategoryId: true },
      });
      const descendants = resolveDescendantCategoryIds(categoryId, allCategories);

      if (descendants.includes(newParentCategoryId)) {
        return new Response(
          JSON.stringify({
            error: "CYCLE_DETECTED",
            message:
              "Cannot reparent: the new parent is a descendant of the node being reparented. " +
              "This would introduce a cycle in the category tree.",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }
    }

    const updated = await db.platformCategory.update({
      where: { id: categoryId },
      data: { parentCategoryId: newParentCategoryId },
      select: {
        id: true,
        code: true,
        parentCategoryId: true,
        updatedAt: true,
      },
    });

    void emitPlatformCategoryAudit(
      PLATFORM_CATEGORY_REPARENTED,
      categoryId,
      auth.userId,
      {
        code: target.code,
        oldParentCategoryId: target.parentCategoryId,
        newParentCategoryId: updated.parentCategoryId,
      },
      env,
    );

    return new Response(
      JSON.stringify({
        ok: true,
        id: updated.id,
        code: updated.code,
        parentCategoryId: updated.parentCategoryId,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
}
