/**
 * Classification Handler — tenant self-declared classification CRUD.
 *
 * Endpoints (wired in routes/tenant-classification.ts):
 *   PUT    /api/tenants/:id/classification        — create or update classification
 *   GET    /api/tenants/:id/classification        — read classification + tags
 *   POST   /api/tenants/:id/classification/tags   — add a tag
 *   DELETE /api/tenants/:id/classification/tags/:tagId — remove a tag
 *
 * MVP invariants:
 *   - `verificationSource` is always SELF_DECLARED (Phase 2 adds verifier integrations).
 *   - `categoryId` must reference an existing, active `PlatformCategory` row. There
 *     is no free-text path — reject any request that isn't picking an existing node.
 *   - Cross-tenant isolation: every handler calls `requireActiveTenant` or
 *     `requireOwnTenant` before any capability or DB check.
 *   - Capability: mutation endpoints require `ClassificationEdit` (ADMIN/OWNER).
 *   - Audit: every mutation emits a fire-and-forget classification audit event.
 */

import type { Env } from "../../env.js";
import type { AuthContext } from "../auth/auth-context.js";
import { requireActiveTenant, requireOwnTenant } from "../auth/auth-middleware.js";
import { Capability, requireCapability } from "../auth/require.js";
import { emitClassificationAudit } from "./classification-audit-emit.js";

const JSON_HEADERS = { "content-type": "application/json" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export class ClassificationHandler {
  /**
   * PUT /api/tenants/:id/classification
   *
   * Creates or updates the tenant's classification. `categoryId` must point to
   * an existing, active `PlatformCategory`. `verificationSource` is always
   * SELF_DECLARED in MVP.
   */
  async handleUpsert(
    tenantId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    // 1. Cross-tenant isolation guard (403 — distinguishable from 404 for write paths).
    const tenantDenied = requireActiveTenant(auth, tenantId);
    if (tenantDenied) return tenantDenied;

    // 2. Capability check — ADMIN/OWNER only.
    const capDenied = requireCapability(auth, Capability.ClassificationEdit);
    if (capDenied) return capDenied;

    // 3. Parse + validate body.
    const { z } = await import("zod");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "INVALID_JSON", message: "Request body must be valid JSON" });
    }

    const schema = z.object({
      categoryId: z.string().min(1),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid input",
      });
    }

    const { categoryId } = parsed.data;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    // 4. Confirm category exists and is active.
    const category = await db.platformCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, isActive: true },
    });

    if (!category) {
      return jsonResponse(404, { error: "NOT_FOUND", message: "Category not found" });
    }
    if (!category.isActive) {
      return jsonResponse(422, { error: "CATEGORY_INACTIVE", message: "Category is not active" });
    }

    // 5. Upsert the classification.
    const existing = await db.tenantClassification.findUnique({
      where: { tenantId },
      select: { id: true, categoryId: true },
    });

    const isNew = existing === null;
    const categoryChanged = !isNew && existing.categoryId !== categoryId;

    const classification = await db.tenantClassification.upsert({
      where: { tenantId },
      create: {
        tenantId,
        categoryId,
        verificationSource: "SELF_DECLARED",
      },
      update: {
        categoryId,
      },
      select: {
        id: true,
        tenantId: true,
        categoryId: true,
        verificationSource: true,
        verifiedAt: true,
        verificationRevokedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // 6. Audit emit (fire-and-forget).
    if (isNew) {
      emitClassificationAudit(
        {
          tenantId,
          actorUserId: auth.userId,
          action: "classification.created",
          targetId: classification.id,
          metadata: { categoryId },
        },
        db,
      );
    } else if (categoryChanged) {
      emitClassificationAudit(
        {
          tenantId,
          actorUserId: auth.userId,
          action: "classification.category_changed",
          targetId: classification.id,
          metadata: { oldCategoryId: existing.categoryId, newCategoryId: categoryId },
        },
        db,
      );
    }

    return jsonResponse(isNew ? 201 : 200, classification);
  }

  /**
   * GET /api/tenants/:id/classification
   *
   * Returns the tenant's classification and tags. Any active tenant member may
   * call this. Uses `requireOwnTenant` (404 rather than 403) to avoid
   * leaking existence of other tenants' classifications.
   */
  async handleGet(
    tenantId: string,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    // Cross-tenant isolation (data read — 404 to avoid existence-leak).
    const tenantDenied = requireOwnTenant(auth, tenantId);
    if (tenantDenied) return tenantDenied;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const classification = await db.tenantClassification.findUnique({
      where: { tenantId },
      select: {
        id: true,
        tenantId: true,
        categoryId: true,
        verificationSource: true,
        verifiedAt: true,
        verificationRevokedAt: true,
        createdAt: true,
        updatedAt: true,
        tags: {
          select: {
            id: true,
            categoryId: true,
            category: {
              select: { code: true, displayName: true },
            },
          },
        },
        category: {
          select: { code: true, displayName: true },
        },
      },
    });

    if (!classification) {
      return jsonResponse(404, { error: "NOT_FOUND", message: "Classification not found" });
    }

    return jsonResponse(200, classification);
  }

  /**
   * POST /api/tenants/:id/classification/tags
   *
   * Adds a secondary category tag to the tenant's classification. The
   * `categoryId` must reference an existing, active `PlatformCategory`.
   */
  async handleAddTag(
    tenantId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const tenantDenied = requireActiveTenant(auth, tenantId);
    if (tenantDenied) return tenantDenied;

    const capDenied = requireCapability(auth, Capability.ClassificationEdit);
    if (capDenied) return capDenied;

    const { z } = await import("zod");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "INVALID_JSON", message: "Request body must be valid JSON" });
    }

    const schema = z.object({
      categoryId: z.string().min(1),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid input",
      });
    }

    const { categoryId } = parsed.data;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    // Confirm category exists and is active.
    const category = await db.platformCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, isActive: true },
    });

    if (!category) {
      return jsonResponse(404, { error: "NOT_FOUND", message: "Category not found" });
    }
    if (!category.isActive) {
      return jsonResponse(422, { error: "CATEGORY_INACTIVE", message: "Category is not active" });
    }

    // Confirm the tenant has a classification to attach tags to.
    const classification = await db.tenantClassification.findUnique({
      where: { tenantId },
      select: { id: true },
    });

    if (!classification) {
      return jsonResponse(404, { error: "NOT_FOUND", message: "Classification not found — create one first" });
    }

    // Create the tag (unique constraint on [classificationId, categoryId] prevents duplicates).
    let tag: { id: string; classificationId: string; categoryId: string };
    try {
      tag = await db.tenantClassificationTag.create({
        data: {
          tenantId,
          classificationId: classification.id,
          categoryId,
        },
        select: { id: true, classificationId: true, categoryId: true },
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2002") {
        return jsonResponse(409, { error: "TAG_EXISTS", message: "This tag already exists" });
      }
      throw err;
    }

    emitClassificationAudit(
      {
        tenantId,
        actorUserId: auth.userId,
        action: "classification.tag_added",
        targetId: tag.id,
        metadata: { classificationId: classification.id, categoryId },
      },
      db,
    );

    return jsonResponse(201, tag);
  }

  /**
   * DELETE /api/tenants/:id/classification/tags/:tagId
   *
   * Removes a secondary category tag. The tag must belong to this tenant's
   * classification.
   */
  async handleRemoveTag(
    tenantId: string,
    tagId: string,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const tenantDenied = requireActiveTenant(auth, tenantId);
    if (tenantDenied) return tenantDenied;

    const capDenied = requireCapability(auth, Capability.ClassificationEdit);
    if (capDenied) return capDenied;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    // Fetch tag, confirming it belongs to this tenant.
    const tag = await db.tenantClassificationTag.findFirst({
      where: { id: tagId, tenantId },
      select: { id: true, classificationId: true, categoryId: true },
    });

    if (!tag) {
      return jsonResponse(404, { error: "NOT_FOUND", message: "Tag not found" });
    }

    await db.tenantClassificationTag.delete({ where: { id: tagId } });

    emitClassificationAudit(
      {
        tenantId,
        actorUserId: auth.userId,
        action: "classification.tag_removed",
        targetId: tag.id,
        metadata: { classificationId: tag.classificationId, categoryId: tag.categoryId },
      },
      db,
    );

    return jsonResponse(200, { ok: true });
  }
}
