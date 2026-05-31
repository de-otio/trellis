/**
 * Tenant CRUD Handler
 *
 * Handlers for:
 *  - POST /api/tenants          — create org tenant
 *  - GET  /api/tenants/:id      — read tenant
 *  - PATCH /api/tenants/:id     — update displayName
 *  - GET  /api/users/me/tenants — list caller's memberships
 *  - POST /api/auth/switch-tenant       — change active tenant + invalidate cache
 *  - POST /api/tenants/:id/transfer-ownership — OWNER hand-off
 */

import type { Prisma } from "@prisma/client";
import type { Env } from "../../env.js";
import type { AuthContext } from "../auth/auth-context.js";
import { requireActiveTenant, requireOwnTenant } from "../auth/auth-middleware.js";
import { requireRole } from "../auth/require.js";
import { validateTenantSlug } from "./slug-validator.js";
import { createClaimsCacheFromEnv } from "../auth/claims-cache.js";
import { transferOwnership } from "./transfer-ownership.js";
import { TenantAuditEmitter } from "../audit-composer.js";
import { AuditEventType } from "../audit-actions.js";

const auditEmitter = new TenantAuditEmitter();

export class TenantHandler {
  /**
   * POST /api/tenants
   * Creates an ORGANIZATION tenant. Caller becomes OWNER.
   * If caller is END_USER their global role is bumped to B2B_PARTNER.
   */
  async handleCreate(
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
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
      slug: z.string(),
      displayName: z.string().min(1).max(100),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid input" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const { slug, displayName } = parsed.data;

    const slugResult = validateTenantSlug(slug);
    if (!slugResult.ok) {
      return new Response(
        JSON.stringify({ error: slugResult.code, message: slugResult.message }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    try {
      const result = await db.$transaction(async (tx: Prisma.TransactionClient) => {
        const tenant = await tx.tenant.create({
          data: {
            slug,
            displayName,
            type: "ORGANIZATION",
            status: "ACTIVE",
          },
        });

        await tx.tenantMember.create({
          data: {
            tenantId: tenant.id,
            userId: auth.userId,
            role: "OWNER",
            status: "ACTIVE",
            joinedAt: new Date(),
          },
        });

        // Idempotent role bump: END_USER → B2B_PARTNER.
        await tx.user.updateMany({
          where: { id: auth.userId, role: "END_USER" },
          data: { role: "B2B_PARTNER" },
        });

        return tenant;
      });

      void auditEmitter.emit(
        {
          type: AuditEventType.TENANT_CREATED,
          tenantId: result.id,
          actorUserId: auth.userId,
          payload: { tenantId: result.id, slug: result.slug, displayName: result.displayName, type: "ORGANIZATION" },
        },
        db,
      );

      return new Response(
        JSON.stringify({ id: result.id, slug: result.slug, displayName: result.displayName }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err as { code?: string }).code === "P2002"
      ) {
        return new Response(
          JSON.stringify({ error: "SLUG_TAKEN", message: "A tenant with this slug already exists" }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      throw err;
    }
  }

  /**
   * GET /api/tenants/:id
   * Returns the tenant. Caller must be an active member.
   */
  async handleGet(
    tenantId: string,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    // GET /api/tenants/:id is a data endpoint — leak nothing about tenants
    // outside the caller's scope. requireOwnTenant returns the same 404 as a
    // missing tenant, so the response does not distinguish the two cases.
    const denied = requireOwnTenant(auth, tenantId);
    if (denied) return denied;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        slug: true,
        displayName: true,
        type: true,
        status: true,
        createdAt: true,
      },
    });

    if (!tenant) {
      return new Response(
        JSON.stringify({ error: "NOT_FOUND", message: "Tenant not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify(tenant), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * PATCH /api/tenants/:id
   * Updates displayName. Requires OWNER or ADMIN.
   */
  async handleUpdate(
    tenantId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireRole(auth, "ADMIN");
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
      displayName: z.string().min(1).max(100),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid input" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      return new Response(
        JSON.stringify({ error: "NOT_FOUND", message: "Tenant not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    const updated = await db.tenant.update({
      where: { id: tenantId },
      data: { displayName: parsed.data.displayName },
      select: { id: true, slug: true, displayName: true },
    });

    void auditEmitter.emit(
      {
        type: AuditEventType.TENANT_UPDATED,
        tenantId,
        actorUserId: auth.userId,
        payload: { tenantId, displayName: parsed.data.displayName },
      },
      db,
    );

    return new Response(JSON.stringify(updated), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * GET /api/users/me/tenants
   * Lists all active tenant memberships for the caller.
   */
  async handleListMyTenants(
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const memberships = await db.tenantMember.findMany({
      where: { userId: auth.userId, status: "ACTIVE" },
      include: {
        tenant: {
          select: {
            id: true,
            slug: true,
            displayName: true,
            type: true,
            status: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    });

    const result = memberships.map((m: {
      tenantId: string;
      role: string;
      tenant: { id: string; slug: string; displayName: string; type: string; status: string };
    }) => ({
      tenantId: m.tenantId,
      role: m.role,
      tenant: m.tenant,
    }));

    return new Response(JSON.stringify({ memberships: result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * POST /api/auth/switch-tenant
   * Changes the user's active tenant. Invalidates DynamoDB claim cache so
   * the next token refresh picks up the new activeTenantId.
   */
  async handleSwitchTenant(
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
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

    const schema = z.object({ tenantId: z.string().min(1) });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: "VALIDATION_ERROR", message: "tenantId is required" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const { tenantId } = parsed.data;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const membership = await db.tenantMember.findUnique({
      where: {
        tenantId_userId: { tenantId, userId: auth.userId },
      },
      select: { status: true },
    });

    if (!membership) {
      return new Response(
        JSON.stringify({ error: "FORBIDDEN", message: "You are not a member of this tenant" }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }

    if (membership.status !== "ACTIVE") {
      return new Response(
        JSON.stringify({ error: "FORBIDDEN", message: "Your membership in this tenant is not active" }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }

    // Look up tenant slug + role for cache write so the next pre-token-gen
    // invocation reads the user's chosen tenant rather than re-running the
    // first-org-then-personal heuristic.
    const tenantWithRole = await db.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId: auth.userId } },
      select: {
        role: true,
        tenant: { select: { slug: true } },
      },
    });

    // Persist the user's chosen tenant in the DDB claim cache so the next
    // pre-token-generation invocation honors the choice rather than reverting
    // to the first-org / personal-tenant heuristic.
    try {
      const cache = createClaimsCacheFromEnv();
      if (tenantWithRole) {
        await cache.invalidate(auth.cognitoSub);
        await cache.put(auth.cognitoSub, {
          userId: auth.userId,
          globalRole: auth.globalRole,
          activeTenantId: tenantId,
          tenantSlug: tenantWithRole.tenant.slug,
          tenantRole: tenantWithRole.role,
          handle: auth.handle,
        });
      } else {
        await cache.invalidate(auth.cognitoSub);
      }
    } catch {
      // Cache write is best-effort: don't block the switch if DDB is
      // unavailable. The TTL-based expiry will eventually correct stale data.
    }

    return new Response(
      JSON.stringify({ ok: true, tenantId }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  /**
   * POST /api/tenants/:id/transfer-ownership
   * Current OWNER hands off ownership to another active member.
   * Both users' cache entries are invalidated.
   */
  async handleTransferOwnership(
    tenantId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const activeTenantDenied = requireActiveTenant(auth, tenantId);
    if (activeTenantDenied) return activeTenantDenied;

    const roleDenied = requireRole(auth, "OWNER");
    if (roleDenied) return roleDenied;

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

    const schema = z.object({ newOwnerUserId: z.string().min(1) });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: "VALIDATION_ERROR", message: "newOwnerUserId is required" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const { newOwnerUserId } = parsed.data;
    if (newOwnerUserId === auth.userId) {
      return new Response(
        JSON.stringify({ error: "VALIDATION_ERROR", message: "New owner must be a different user" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const result = await transferOwnership({
      db,
      tenantId,
      currentOwnerUserId: auth.userId,
      newOwnerUserId,
    });

    if (!result.ok) {
      if (result.code === "NOT_MEMBER" || result.code === "INACTIVE") {
        return new Response(
          JSON.stringify({ error: "NOT_FOUND", message: "New owner must be an active member of this tenant" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      if (result.code === "ALREADY_OWNER") {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "New owner must be a different user" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: "CONFLICT", message: "OWNER row not found" }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }

    void auditEmitter.emit(
      {
        type: AuditEventType.TENANT_OWNERSHIP_TRANSFERRED,
        tenantId,
        actorUserId: auth.userId,
        payload: { tenantId, actorUserId: auth.userId, targetUserId: newOwnerUserId, oldRole: "OWNER", newRole: "ADMIN" },
      },
      db,
    );

    try {
      const cache = createClaimsCacheFromEnv();
      await Promise.all([
        result.oldOwnerCognitoSub ? cache.invalidate(result.oldOwnerCognitoSub) : Promise.resolve(),
        result.newOwnerCognitoSub ? cache.invalidate(result.newOwnerCognitoSub) : Promise.resolve(),
      ]);
    } catch {
      // Best-effort; don't block the transfer.
    }

    return new Response(
      JSON.stringify({ ok: true, newOwnerId: newOwnerUserId }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
}
