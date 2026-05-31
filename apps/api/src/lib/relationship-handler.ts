/**
 * Relationship Handler
 *
 * CRUD operations for scored user relationships (circles model).
 * Replaces the old follow/unfollow system with scored, tiered relationships.
 */

import type { Env } from "../env.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { Session } from "./session-cookie.js";

export class RelationshipHandler {
  async handleCreateRelationship(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { z } = await import("zod");
      const body = await request.json() as Record<string, unknown>;

      const schema = z.object({
        targetType: z.enum(["user", "entity"]),
        targetId: z.string().min(1).max(100),
        connectionMethod: z.enum(["code", "import", "suggestion", "discovery"]).optional().default("discovery"),
      });

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Cannot create relationship with yourself
      if (parsed.data.targetType === "user" && parsed.data.targetId === session.userId) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "Cannot create relationship with yourself" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const relationship = await graphService.createRelationship({
        userId: session.userId,
        targetType: parsed.data.targetType,
        targetId: parsed.data.targetId,
        connectionMethod: parsed.data.connectionMethod,
      });

      return new Response(JSON.stringify(relationship), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.mapGraphError(error, env);
    }
  }

  async handleRemoveRelationship(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const targetType = url.searchParams.get("targetType");
      const targetId = url.searchParams.get("targetId");

      if (!targetType || !targetId || !["user", "entity"].includes(targetType)) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "targetType and targetId are required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      await graphService.removeRelationship(
        session.userId,
        targetType as "user" | "entity",
        targetId,
      );

      return new Response(null, { status: 204 });
    } catch (error: any) {
      return await this.mapGraphError(error, env);
    }
  }

  async handleUpdateScore(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { z } = await import("zod");
      const body = await request.json() as Record<string, unknown>;

      const schema = z.object({
        targetType: z.enum(["user", "entity"]),
        targetId: z.string().min(1).max(100),
        manualScore: z.number().min(0).max(1).nullable(),
      });

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const relationship = await graphService.updateRelationshipScore({
        userId: session.userId,
        targetType: parsed.data.targetType,
        targetId: parsed.data.targetId,
        manualScore: parsed.data.manualScore,
      });

      return new Response(JSON.stringify(relationship), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.mapGraphError(error, env);
    }
  }

  async handleGetRelationship(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const targetType = url.searchParams.get("targetType");
      const targetId = url.searchParams.get("targetId");

      if (!targetType || !targetId || !["user", "entity"].includes(targetType)) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "targetType and targetId are required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const relationship = await graphService.getRelationship(
        session.userId,
        targetType as "user" | "entity",
        targetId,
      );

      if (!relationship) {
        return new Response(
          JSON.stringify({ error: "NOT_FOUND", message: "Relationship not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify(relationship), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.mapGraphError(error, env);
    }
  }

  async handleGetRelationships(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const tierStr = url.searchParams.get("tier");
      const targetType = url.searchParams.get("targetType") || undefined;
      const limitStr = url.searchParams.get("limit");
      const cursor = url.searchParams.get("cursor");

      const tier = tierStr !== null ? parseInt(tierStr, 10) : undefined;
      if (tier !== undefined && (isNaN(tier) || tier < 0 || tier > 3)) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "tier must be 0, 1, 2, or 3" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      if (targetType && !["user", "entity"].includes(targetType)) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "targetType must be 'user' or 'entity'" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const limit = Math.min(Math.max(parseInt(limitStr || "20", 10) || 20, 1), 100);

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const result = await graphService.getRelationships(session.userId, {
        tier: tier as 0 | 1 | 2 | 3 | undefined,
        targetType: targetType as "user" | "entity" | undefined,
        pagination: { limit, cursor: cursor || undefined },
      });

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.mapGraphError(error, env);
    }
  }

  async handleGetGraph(
    _request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      // TODO: Implement session-age check once the Session type includes issuedAt.
      // The previous check used (session as any).issuedAt which is always undefined,
      // causing the re-auth guard to silently never fire. Removed to avoid false security.
      const logger = getLogger();
      logger.warn("[RelationshipHandler] handleGetGraph: session-age check not yet implemented — Session type lacks issuedAt field");

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const graphData = await graphService.getRelationshipGraph(session.userId);

      return new Response(JSON.stringify(graphData), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.mapGraphError(error, env);
    }
  }

  private async mapGraphError(error: any, env: Env): Promise<Response> {
    const logger = getLogger();

    if (error instanceof SyntaxError) {
      return new Response(
        JSON.stringify({ error: "VALIDATION_ERROR", message: "Invalid JSON body" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    if (error?.constructor?.name === "GraphNotFoundError") {
      logger.warn("[RelationshipHandler] Not found:", error.message);
      return new Response(
        JSON.stringify({ error: "NOT_FOUND", message: "Relationship not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    if (error?.constructor?.name === "GraphConflictError") {
      logger.warn("[RelationshipHandler] Conflict:", error.message);
      return new Response(
        JSON.stringify({ error: "CONFLICT", message: "Relationship already exists" }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    if (error?.constructor?.name === "GraphConnectionError") {
      const isPoolTimeout =
        typeof error.message === "string" &&
        error.message.includes("connection acquisition timed out");
      if (isPoolTimeout) {
        logger.warn("graph_pool_acquire_timeout", { code: error.code, name: error.constructor.name });
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      } else {
        logger.warn("[RelationshipHandler] Graph connection error", { code: error.code, name: error.constructor.name });
      }
      return new Response(JSON.stringify({ error: "service_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json", "Retry-After": "1" },
      });
    }

    logger.error("[RelationshipHandler] Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "INTERNAL_ERROR", message: "Internal server error" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

// Import at bottom to avoid circular dependency
import { getLogger, Logger } from "./logger.js";
