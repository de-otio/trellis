/**
 * Connection Code Handler
 *
 * Generate and redeem shareable connection codes that create
 * scored relationships with connectionMethod "code" (initial score 0.7).
 */

import { randomBytes } from "crypto";
import type { Env } from "../env.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { Session } from "./session-cookie.js";

// Unambiguous alphanumeric characters (no 0/O/1/I/L)
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const MAX_EXPIRY_HOURS = 168; // 7 days
const MAX_USES = 10;
// Max active codes per user (prevents DB spam)
const MAX_ACTIVE_CODES_PER_USER = 50;

function generateCode(): string {
  // Rejection sampling to eliminate modulo bias.
  // CODE_CHARS.length = 30; discard bytes >= 240 (= 30 * 8, the largest multiple of 30 <= 255).
  const REJECTION_THRESHOLD = Math.floor(256 / CODE_CHARS.length) * CODE_CHARS.length; // 240
  let code = "";
  while (code.length < CODE_LENGTH) {
    const byte = randomBytes(1)[0]!;
    if (byte < REJECTION_THRESHOLD) {
      code += CODE_CHARS[byte % CODE_CHARS.length];
    }
  }
  return code;
}

export class ConnectionCodeHandler {
  async handleGenerate(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      const { z } = await import("zod");
      const body = await request.json() as Record<string, unknown>;

      const schema = z.object({
        entityId: z.string().min(1).max(100).optional(),
        expiresInHours: z.number().int().min(1).max(MAX_EXPIRY_HOURS).optional().default(24),
        maxUses: z.number().int().min(1).max(MAX_USES).optional().default(1),
      });

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      // If entityId provided, verify the user owns the entity in the active tenant
      if (parsed.data.entityId) {
        const ownership = await db.entityOwnership.findFirst({
          where: {
            entityId: parsed.data.entityId,
            userId: session.userId,
            tenantId: activeTenantId,
          },
        });
        if (!ownership) {
          return new Response(
            JSON.stringify({ error: "FORBIDDEN", message: "You must own the entity to create a connection code for it" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }
      }

      // Cap active (non-expired) codes per user to prevent DB spam.
      // Note: Prisma can't do column-to-column comparison (useCount < maxUses),
      // so we count non-expired codes only — a loose but sufficient guard.
      const activeCount = await db.connectionCode.count({
        where: {
          creatorId: session.userId,
          tenantId: activeTenantId,
          expiresAt: { gt: new Date() },
        },
      });
      if (activeCount >= MAX_ACTIVE_CODES_PER_USER) {
        return new Response(
          JSON.stringify({ error: "LIMIT_EXCEEDED", message: `You may have at most ${MAX_ACTIVE_CODES_PER_USER} active connection codes` }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }

      const expiresAt = new Date(Date.now() + parsed.data.expiresInHours * 60 * 60 * 1000);
      const code = generateCode();

      const connectionCode = await db.connectionCode.create({
        data: {
          code,
          creatorId: session.userId,
          entityId: parsed.data.entityId || null,
          expiresAt,
          maxUses: parsed.data.maxUses,
          tenantId: activeTenantId,
        },
      });

      return new Response(
        JSON.stringify({ id: connectionCode.id, code, expiresAt: expiresAt.toISOString() }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      return this.handleError(error, env);
    }
  }

  async handleRedeem(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      const { z } = await import("zod");
      const body = await request.json() as Record<string, unknown>;

      const schema = z.object({
        code: z.string().min(1).max(20).transform((s) => s.toUpperCase().trim()),
      });

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "code is required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      const connectionCode = await db.connectionCode.findFirst({
        where: { code: parsed.data.code, tenantId: activeTenantId },
      });

      if (!connectionCode) {
        return new Response(
          JSON.stringify({ error: "NOT_FOUND", message: "Connection code not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      // Uniform rejection for all non-redeemable states to prevent oracle attacks.
      // We do not distinguish self-owned / expired / maxed to prevent code enumeration.
      const isOwn = connectionCode.creatorId === session.userId;
      const isExpired = connectionCode.expiresAt < new Date();
      const isMaxed = connectionCode.useCount >= connectionCode.maxUses;

      if (isOwn || isExpired || isMaxed) {
        return new Response(
          JSON.stringify({ error: "NOT_FOUND", message: "Connection code is invalid or unavailable" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      // Atomically: create redemption + conditional increment of useCount.
      // The @@unique([codeId, userId]) constraint prevents duplicate redemptions (TOCTOU-safe).
      // The conditional update (useCount < maxUses) prevents over-redemption under concurrency.

      try {
        await db.$transaction([
          db.connectionCodeRedemption.create({
            data: {
              codeId: connectionCode.id,
              userId: session.userId,
              tenantId: activeTenantId,
            },
          }),
          db.connectionCode.update({
            where: {
              id: connectionCode.id,
              useCount: { lt: connectionCode.maxUses },
            },
            data: { useCount: { increment: 1 } },
          }),
        ]);
      } catch (txError: any) {
        // P2002 = unique constraint violation (duplicate redemption)
        if (txError?.code === "P2002") {
          return new Response(
            JSON.stringify({ error: "CONFLICT", message: "You have already redeemed this code" }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
        // P2025 = record not found for update (useCount >= maxUses, conditional update failed)
        if (txError?.code === "P2025") {
          return new Response(
            JSON.stringify({ error: "GONE", message: "Connection code has reached maximum uses" }),
            { status: 410, headers: { "content-type": "application/json" } },
          );
        }
        throw txError;
      }

      // Create graph relationships (non-fatal if graph fails)
      try {
        const { createGraphServiceFromEnv } = await import("./graph/index.js");
        const graphService = await createGraphServiceFromEnv(env);

        // Create relationship: redeemer → code creator
        await graphService.createRelationship({
          userId: session.userId,
          targetType: "user",
          targetId: connectionCode.creatorId,
          connectionMethod: "code",
        });

        // If code is for a specific entity, also create relationship to entity
        if (connectionCode.entityId) {
          await graphService.createRelationship({
            userId: session.userId,
            targetType: "entity",
            targetId: connectionCode.entityId,
            connectionMethod: "code",
          });
        }
      } catch (graphError: any) {
        const logger = getLogger();
        logger.error("[ConnectionCodeHandler] Graph sync failed during redemption (non-fatal):", {
          code: connectionCode.code,
          userId: session.userId,
          error: graphError.message,
        });
      }

      return new Response(
        JSON.stringify({
          redeemed: true,
          creatorId: connectionCode.creatorId,
          entityId: connectionCode.entityId,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      return this.handleError(error, env);
    }
  }

  async handleGetMyCodes(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const activeOnly = url.searchParams.get("active") !== "false";

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      const where: any = { creatorId: session.userId, tenantId: activeTenantId };
      if (activeOnly) {
        where.expiresAt = { gt: new Date() };
        // Prisma doesn't support column-to-column comparison directly,
        // so we filter in JS after fetching
      }

      const codes = await db.connectionCode.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 50, // Circuit breaker
        include: {
          _count: { select: { redemptions: true } },
        },
      });

      // Filter out maxed-out codes if activeOnly
      const filtered = activeOnly
        ? codes.filter((c: any) => c.useCount < c.maxUses)
        : codes;

      const result = filtered.map((c: any) => ({
        id: c.id,
        code: c.code,
        entityId: c.entityId,
        expiresAt: c.expiresAt.toISOString(),
        maxUses: c.maxUses,
        useCount: c.useCount,
        redemptions: c._count.redemptions,
        createdAt: c.createdAt.toISOString(),
      }));

      return new Response(JSON.stringify({ codes: result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return this.handleError(error, env);
    }
  }

  async handleRevoke(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const codeId = url.searchParams.get("codeId");

      if (!codeId) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "codeId is required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      const code = await db.connectionCode.findFirst({ where: { id: codeId, tenantId: activeTenantId } });

      if (!code) {
        return new Response(
          JSON.stringify({ error: "NOT_FOUND", message: "Connection code not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      if (code.creatorId !== session.userId) {
        return new Response(
          JSON.stringify({ error: "FORBIDDEN", message: "You can only revoke your own codes" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      // Delete redemptions first, then code
      await db.$transaction([
        db.connectionCodeRedemption.deleteMany({ where: { codeId } }),
        db.connectionCode.delete({ where: { id: codeId } }),
      ]);

      return new Response(null, { status: 204 });
    } catch (error: any) {
      return this.handleError(error, env);
    }
  }

  private handleError(error: any, env: Env): Response {
    const logger = getLogger();
    if (error instanceof SyntaxError) {
      return new Response(
        JSON.stringify({ error: "VALIDATION_ERROR", message: "Invalid JSON body" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    logger.error("[ConnectionCodeHandler] Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "INTERNAL_ERROR", message: "Internal server error" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

import { getLogger, Logger } from "./logger.js";
