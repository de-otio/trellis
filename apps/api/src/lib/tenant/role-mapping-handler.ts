/**
 * Tenant role-mapping CRUD.
 *
 * Endpoints (wired in routes/tenant-role-mappings.ts):
 *   GET    /api/tenants/:id/role-mappings
 *   POST   /api/tenants/:id/role-mappings
 *   PATCH  /api/tenants/:id/role-mappings/:mappingId
 *   DELETE /api/tenants/:id/role-mappings/:mappingId
 *
 * Single-OWNER invariant: writes that target `tenantRole = OWNER` return 422.
 * `resolveTenantRole` (T2) already caps OWNER → ADMIN as defense-in-depth, but
 * we reject at write time so misconfiguration is loud rather than silent.
 */

import type { Prisma, TenantRole } from "@prisma/client";
import type { Env } from "../../env.js";
import type { AuthContext } from "../auth/auth-context.js";
import { requireActiveTenant } from "../auth/auth-middleware.js";
import { Capability, requireCapability } from "../auth/require.js";
import { emitTenantAudit } from "./audit-emit.js";

const JSON_HEADERS = { "content-type": "application/json" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function unprocessable(message: string, remediation?: string): Response {
  return jsonResponse(422, {
    error: "UNPROCESSABLE",
    message,
    ...(remediation ? { remediation } : {}),
  });
}

export class RoleMappingHandler {
  /** GET — list all mappings for the tenant. */
  async handleList(
    tenantId: string,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireCapability(auth, Capability.RoleMappingEdit);
    if (denied) return denied;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const mappings = await db.tenantRoleMapping.findMany({
      where: { tenantId },
      orderBy: [{ priority: "asc" }, { idpGroupName: "asc" }],
      select: {
        id: true,
        idpGroupName: true,
        tenantRole: true,
        priority: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return jsonResponse(200, { mappings });
  }

  /** POST — create a new mapping. Cannot map to OWNER. */
  async handleCreate(
    tenantId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireCapability(auth, Capability.RoleMappingEdit);
    if (denied) return denied;

    const { z } = await import("zod");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "INVALID_JSON", message: "Body must be valid JSON" });
    }

    if (
      typeof body === "object" &&
      body !== null &&
      (body as { tenantRole?: string }).tenantRole === "OWNER"
    ) {
      return unprocessable(
        "Cannot map IdP groups to OWNER",
        `POST /api/tenants/${tenantId}/transfer-ownership`,
      );
    }

    const schema = z.object({
      idpGroupName: z.string().min(1).max(255),
      tenantRole: z.enum(["ADMIN", "MEMBER", "GUEST"]),
      priority: z.number().int().positive().max(100000),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Invalid input";
      return jsonResponse(400, { error: "VALIDATION_ERROR", message: msg });
    }

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    try {
      const created = await db.tenantRoleMapping.create({
        data: {
          tenantId,
          idpGroupName: parsed.data.idpGroupName,
          tenantRole: parsed.data.tenantRole as TenantRole,
          priority: parsed.data.priority,
        },
        select: {
          id: true,
          idpGroupName: true,
          tenantRole: true,
          priority: true,
        },
      });

      emitTenantAudit(
        {
          tenantId,
          actorUserId: auth.userId,
          action: "role_mapping.create",
          targetType: "role_mapping",
          targetId: created.id,
          metadata: {
            idpGroupName: created.idpGroupName,
            tenantRole: created.tenantRole,
          },
        },
        db,
      );

      return jsonResponse(201, created);
    } catch (err) {
      if (
        err instanceof Error &&
        (err as { code?: string }).code === "P2002"
      ) {
        return jsonResponse(409, {
          error: "DUPLICATE",
          message: "A mapping for this idpGroupName already exists",
        });
      }
      throw err;
    }
  }

  /** PATCH — update tenantRole and/or priority of an existing mapping. */
  async handleUpdate(
    tenantId: string,
    mappingId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireCapability(auth, Capability.RoleMappingEdit);
    if (denied) return denied;

    const { z } = await import("zod");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "INVALID_JSON", message: "Body must be valid JSON" });
    }

    if (
      typeof body === "object" &&
      body !== null &&
      (body as { tenantRole?: string }).tenantRole === "OWNER"
    ) {
      return unprocessable(
        "Cannot map IdP groups to OWNER",
        `POST /api/tenants/${tenantId}/transfer-ownership`,
      );
    }

    const schema = z
      .object({
        tenantRole: z.enum(["ADMIN", "MEMBER", "GUEST"]).optional(),
        priority: z.number().int().positive().max(100000).optional(),
      })
      .refine((d) => d.tenantRole !== undefined || d.priority !== undefined, {
        message: "At least one of tenantRole or priority is required",
      });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Invalid input";
      return jsonResponse(400, { error: "VALIDATION_ERROR", message: msg });
    }

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const existing = await db.tenantRoleMapping.findFirst({
      where: { id: mappingId, tenantId },
      select: { id: true, idpGroupName: true, tenantRole: true, priority: true },
    });
    if (!existing) {
      return jsonResponse(404, { error: "NOT_FOUND", message: "Role mapping not found" });
    }

    const data: Prisma.TenantRoleMappingUpdateInput = {};
    if (parsed.data.tenantRole !== undefined) {
      data.tenantRole = parsed.data.tenantRole as TenantRole;
    }
    if (parsed.data.priority !== undefined) data.priority = parsed.data.priority;

    const updated = await db.tenantRoleMapping.update({
      where: { id: existing.id },
      data,
      select: {
        id: true,
        idpGroupName: true,
        tenantRole: true,
        priority: true,
      },
    });

    emitTenantAudit(
      {
        tenantId,
        actorUserId: auth.userId,
        action: "role_mapping.update",
        targetType: "role_mapping",
        targetId: existing.id,
        metadata: {
          previousRole: existing.tenantRole,
          previousPriority: existing.priority,
          newRole: updated.tenantRole,
          newPriority: updated.priority,
        },
      },
      db,
    );

    return jsonResponse(200, updated);
  }

  /** DELETE — remove a mapping. */
  async handleDelete(
    tenantId: string,
    mappingId: string,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireCapability(auth, Capability.RoleMappingEdit);
    if (denied) return denied;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const existing = await db.tenantRoleMapping.findFirst({
      where: { id: mappingId, tenantId },
      select: { id: true, idpGroupName: true, tenantRole: true },
    });
    if (!existing) {
      return jsonResponse(404, { error: "NOT_FOUND", message: "Role mapping not found" });
    }

    await db.tenantRoleMapping.delete({ where: { id: existing.id } });

    emitTenantAudit(
      {
        tenantId,
        actorUserId: auth.userId,
        action: "role_mapping.delete",
        targetType: "role_mapping",
        targetId: existing.id,
        metadata: {
          idpGroupName: existing.idpGroupName,
          tenantRole: existing.tenantRole,
        },
      },
      db,
    );

    return new Response(null, { status: 204 });
  }
}
