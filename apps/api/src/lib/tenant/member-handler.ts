/**
 * Member CRUD handler — list, change role, delete.
 *
 * Endpoints (wired in routes/tenant-members.ts):
 *   GET    /api/tenants/:id/members
 *   PATCH  /api/tenants/:id/members/:memberId   { role }
 *   DELETE /api/tenants/:id/members/:memberId
 *   POST   /api/tenants/:id/transfer-ownership  { newOwnerUserId }
 *
 * Invariants enforced here:
 *  - Cross-tenant: every Prisma query includes `tenantId: auth.activeTenantId`.
 *  - Single-OWNER: PATCH cannot promote anyone to OWNER (transfer-ownership only).
 *  - Self-demotion: OWNER cannot lose their own role via PATCH or DELETE.
 *  - Cache invalidation: every mutation invalidates the affected user's claims
 *    cache before returning.
 *  - AdminUserGlobalSignOut on member removal is best-effort; log + continue.
 *  - Audit emit: stub call site for T7 to replace.
 */

import type { Prisma, TenantRole, TenantMemberStatus } from "@prisma/client";
import {
  CognitoIdentityProviderClient,
  AdminUserGlobalSignOutCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { Env } from "../../env.js";
import type { AuthContext } from "../auth/auth-context.js";
import { requireActiveTenant } from "../auth/auth-middleware.js";
import { Capability, requireCapability } from "../auth/require.js";
import { createClaimsCacheFromEnv } from "../auth/claims-cache.js";
import { emitTenantAudit } from "./audit-emit.js";
import { transferOwnership } from "./transfer-ownership.js";

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

async function invalidateCache(env: Env, cognitoSub: string | null | undefined): Promise<void> {
  if (!cognitoSub) return;
  try {
    const cache = createClaimsCacheFromEnv();
    await cache.invalidate(cognitoSub);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "Cache invalidation failed",
        cognitoSub,
        error: String(err),
      }),
    );
  }
  // env is unused but kept in the signature in case T7 wants to read DDB
  // table name from env directly rather than via the factory.
  void env;
}

async function bestEffortGlobalSignOut(
  env: Env,
  username: string,
): Promise<void> {
  const userPoolId = env.COGNITO_USER_POOL_ID;
  if (!userPoolId || !username) return;
  try {
    const client = new CognitoIdentityProviderClient({
      region: env.COGNITO_REGION ?? process.env.AWS_REGION,
    });
    await client.send(
      new AdminUserGlobalSignOutCommand({
        UserPoolId: userPoolId,
        Username: username,
      }),
    );
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "AdminUserGlobalSignOut failed",
        username,
        error: String(err),
      }),
    );
  }
}

export class MemberHandler {
  /** GET /api/tenants/:id/members — paginated. */
  async handleList(
    tenantId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireCapability(auth, Capability.MemberView);
    if (denied) return denied;

    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50"), 1), 200);
    const cursor = url.searchParams.get("cursor") ?? undefined;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const where: Prisma.TenantMemberWhereInput = { tenantId };
    const members = await db.tenantMember.findMany({
      where,
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        invitedAt: true,
        lastActiveAt: true,
        user: { select: { id: true, email: true, handle: true } },
      },
    });

    const hasMore = members.length > limit;
    const page = hasMore ? members.slice(0, limit) : members;
    const nextCursor = hasMore ? page[page.length - 1]?.id : null;

    return jsonResponse(200, {
      members: page.map((m) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt,
        invitedAt: m.invitedAt,
        lastActiveAt: m.lastActiveAt,
        user: m.user,
      })),
      nextCursor,
    });
  }

  /** PATCH /api/tenants/:id/members/:memberId — change role. */
  async handlePatchRole(
    tenantId: string,
    memberId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireCapability(auth, Capability.MemberChangeRole);
    if (denied) return denied;

    const { z } = await import("zod");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "INVALID_JSON", message: "Body must be valid JSON" });
    }

    const schema = z.object({
      role: z.enum(["ADMIN", "MEMBER", "GUEST"]),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Invalid role";
      const isOwner =
        typeof body === "object" &&
        body !== null &&
        (body as { role?: string }).role === "OWNER";
      if (isOwner) {
        return unprocessable(
          "OWNER cannot be assigned via PATCH",
          `POST /api/tenants/${tenantId}/transfer-ownership`,
        );
      }
      return jsonResponse(400, { error: "VALIDATION_ERROR", message: msg });
    }

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const target = await db.tenantMember.findFirst({
      where: { id: memberId, tenantId },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        user: { select: { cognitoSub: true } },
      },
    });

    if (!target) {
      return jsonResponse(404, { error: "NOT_FOUND", message: "Member not found" });
    }

    if (target.role === "OWNER") {
      return unprocessable(
        "Cannot demote OWNER via PATCH",
        `POST /api/tenants/${tenantId}/transfer-ownership`,
      );
    }

    if (target.userId === auth.userId && auth.tenantRole === "OWNER") {
      return unprocessable(
        "OWNER cannot self-demote",
        `POST /api/tenants/${tenantId}/transfer-ownership`,
      );
    }

    if (target.role === parsed.data.role) {
      return jsonResponse(200, { id: target.id, role: target.role, unchanged: true });
    }

    const updated = await db.tenantMember.update({
      where: { id: target.id },
      data: { role: parsed.data.role as TenantRole },
      select: { id: true, userId: true, role: true, status: true },
    });

    await invalidateCache(env, target.user.cognitoSub);

    emitTenantAudit(
      {
        tenantId,
        actorUserId: auth.userId,
        action: "member.change_role",
        targetType: "member",
        targetId: target.id,
        metadata: { previousRole: target.role, newRole: updated.role },
      },
      db,
    );

    return jsonResponse(200, updated);
  }

  /** DELETE /api/tenants/:id/members/:memberId — soft-delete + sign-out. */
  async handleRemove(
    tenantId: string,
    memberId: string,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireCapability(auth, Capability.MemberRemove);
    if (denied) return denied;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const target = await db.tenantMember.findFirst({
      where: { id: memberId, tenantId },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        user: { select: { cognitoSub: true, email: true } },
      },
    });

    if (!target) {
      return jsonResponse(404, { error: "NOT_FOUND", message: "Member not found" });
    }

    if (target.role === "OWNER") {
      return unprocessable(
        "OWNER cannot be removed",
        `POST /api/tenants/${tenantId}/transfer-ownership`,
      );
    }

    if (target.userId === auth.userId && auth.tenantRole === "OWNER") {
      return unprocessable(
        "OWNER cannot remove themselves",
        `POST /api/tenants/${tenantId}/transfer-ownership`,
      );
    }

    if (target.status === ("REMOVED" satisfies TenantMemberStatus)) {
      return jsonResponse(200, { id: target.id, status: "REMOVED", unchanged: true });
    }

    await db.tenantMember.update({
      where: { id: target.id },
      data: { status: "REMOVED", removedAt: new Date() },
    });

    await invalidateCache(env, target.user.cognitoSub);
    await bestEffortGlobalSignOut(env, target.user.email);

    emitTenantAudit(
      {
        tenantId,
        actorUserId: auth.userId,
        action: "member.remove",
        targetType: "member",
        targetId: target.id,
        metadata: { userId: target.userId },
      },
      db,
    );

    return jsonResponse(200, { id: target.id, status: "REMOVED" });
  }

  /** POST /api/tenants/:id/transfer-ownership { newOwnerUserId }. */
  async handleTransferOwnership(
    tenantId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied = requireActiveTenant(auth, tenantId);
    if (denied) return denied;

    if (auth.tenantRole !== "OWNER" && auth.globalRole !== "SUPER_ADMIN") {
      return jsonResponse(403, {
        error: "FORBIDDEN",
        message: "Only the current OWNER can transfer ownership",
      });
    }

    const { z } = await import("zod");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "INVALID_JSON", message: "Body must be valid JSON" });
    }

    const parsed = z.object({ newOwnerUserId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, {
        error: "VALIDATION_ERROR",
        message: "newOwnerUserId is required",
      });
    }

    if (parsed.data.newOwnerUserId === auth.userId) {
      return jsonResponse(400, {
        error: "VALIDATION_ERROR",
        message: "New owner must be a different user",
      });
    }

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const result = await transferOwnership({
      db,
      tenantId,
      currentOwnerUserId: auth.userId,
      newOwnerUserId: parsed.data.newOwnerUserId,
    });

    if (!result.ok) {
      const code = result.code;
      if (code === "NOT_MEMBER" || code === "INACTIVE") {
        return jsonResponse(404, {
          error: "NOT_FOUND",
          message: "New owner must be an active member of this tenant",
        });
      }
      if (code === "ALREADY_OWNER") {
        return jsonResponse(400, {
          error: "VALIDATION_ERROR",
          message: "New owner must be a different user",
        });
      }
      return jsonResponse(409, { error: "CONFLICT", message: "OWNER row not found" });
    }

    await invalidateCache(env, result.oldOwnerCognitoSub);
    await invalidateCache(env, result.newOwnerCognitoSub);

    emitTenantAudit(
      {
        tenantId,
        actorUserId: auth.userId,
        action: "tenant.transfer_ownership",
        targetType: "tenant",
        targetId: tenantId,
        metadata: { newOwnerUserId: parsed.data.newOwnerUserId },
      },
      db,
    );

    return jsonResponse(200, { ok: true, newOwnerId: parsed.data.newOwnerUserId });
  }
}
