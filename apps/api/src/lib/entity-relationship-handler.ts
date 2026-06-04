/**
 * Entity Relationship Handler
 *
 * CRUD for typed entity-to-entity relationships (PACK_MATE, SIBLING, etc.).
 * Relationships require confirmation from the target entity's owner.
 */

import type { Env } from "../env.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { Session } from "./session-cookie.js";

const VALID_ENTITY_RELATIONSHIP_TYPES = [
  "PACK_MATE", "SIBLING", "PLAYMATE", "PARENT", "OFFSPRING", "WALK_BUDDY",
] as const;

export class EntityRelationshipHandler {
  async handleCreate(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { z } = await import("zod");
      const body = await request.json() as Record<string, unknown>;

      const schema = z.object({
        entityId: z.string().min(1).max(100),
        relatedEntityId: z.string().min(1).max(100),
        type: z.enum(VALID_ENTITY_RELATIONSHIP_TYPES),
      });

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      if (parsed.data.entityId === parsed.data.relatedEntityId) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "Cannot create relationship with the same entity" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Verify the caller owns entityId at the handler boundary (before the graph call)
      // to avoid network I/O to the graph DB for unauthorized requests and prevent entity enumeration.
      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);
      const ownership = await db.entityOwnership.findFirst({
        where: { entityId: parsed.data.entityId, userId: session.userId },
      });
      if (!ownership) {
        return new Response(
          JSON.stringify({ error: "FORBIDDEN", message: "Not authorized to perform this action" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const relationship = await graphService.createEntityRelationship({
        entityId: parsed.data.entityId,
        relatedEntityId: parsed.data.relatedEntityId,
        type: parsed.data.type,
        proposedByUserId: session.userId,
      });

      return new Response(JSON.stringify(relationship), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.mapGraphError(error, env);
    }
  }

  async handleConfirm(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { z } = await import("zod");
      const body = await request.json() as Record<string, unknown>;

      const schema = z.object({
        entityId: z.string().min(1).max(100),
        relatedEntityId: z.string().min(1).max(100),
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

      const relationship = await graphService.confirmEntityRelationship(
        parsed.data.entityId,
        parsed.data.relatedEntityId,
        session.userId,
      );

      return new Response(JSON.stringify(relationship), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.mapGraphError(error, env);
    }
  }

  async handleReject(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { z } = await import("zod");
      const body = await request.json() as Record<string, unknown>;

      const schema = z.object({
        entityId: z.string().min(1).max(100),
        relatedEntityId: z.string().min(1).max(100),
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

      await graphService.rejectEntityRelationship(
        parsed.data.entityId,
        parsed.data.relatedEntityId,
        session.userId,
      );

      return new Response(null, { status: 204 });
    } catch (error: any) {
      return await this.mapGraphError(error, env);
    }
  }

  async handleRemove(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const entityId = url.searchParams.get("entityId");
      const relatedEntityId = url.searchParams.get("relatedEntityId");

      if (!entityId || !relatedEntityId) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "entityId and relatedEntityId are required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      await graphService.removeEntityRelationship(entityId, relatedEntityId, session.userId);

      return new Response(null, { status: 204 });
    } catch (error: any) {
      return await this.mapGraphError(error, env);
    }
  }

  async handleGetForEntity(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const entityId = url.searchParams.get("entityId");

      if (!entityId) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "entityId is required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const type = url.searchParams.get("type") || undefined;
      const status = url.searchParams.get("status") || undefined;

      if (type && !VALID_ENTITY_RELATIONSHIP_TYPES.includes(type as any)) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: `Invalid type. Must be one of: ${VALID_ENTITY_RELATIONSHIP_TYPES.join(", ")}` }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      if (status && !["PENDING", "CONFIRMED", "REJECTED"].includes(status)) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "status must be PENDING, CONFIRMED, or REJECTED" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Check if the requesting user owns this entity.
      // Non-owners can only see CONFIRMED relationships (PENDING/REJECTED may leak private info).
      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);
      const ownership = await db.entityOwnership.findFirst({
        where: { entityId, userId: session.userId },
      });

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const effectiveStatus = ownership ? (status as any) : "CONFIRMED";

      const relationships = await graphService.getEntityRelationships(entityId, {
        type,
        status: effectiveStatus,
      });

      return new Response(JSON.stringify({ relationships }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.mapGraphError(error, env);
    }
  }

  async handleGetPending(
    _request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const relationships = await graphService.getPendingEntityRelationships(session.userId);

      return new Response(JSON.stringify({ relationships }), {
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
      logger.warn("[EntityRelationshipHandler] Not found:", error.message);
      return new Response(
        JSON.stringify({ error: "NOT_FOUND", message: "Entity relationship not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    if (error?.constructor?.name === "GraphConflictError") {
      logger.warn("[EntityRelationshipHandler] Conflict:", error.message);
      return new Response(
        JSON.stringify({ error: "CONFLICT", message: "Entity relationship already exists" }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    if (error?.constructor?.name === "GraphAuthorizationError") {
      logger.warn("[EntityRelationshipHandler] Forbidden:", error.message);
      return new Response(
        JSON.stringify({ error: "FORBIDDEN", message: "Not authorized to perform this action" }),
        { status: 403, headers: { "content-type": "application/json" } },
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
        logger.warn("[EntityRelationshipHandler] Graph connection error", { code: error.code, name: error.constructor.name });
      }
      return new Response(JSON.stringify({ error: "service_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json", "Retry-After": "1" },
      });
    }

    logger.error("[EntityRelationshipHandler] Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "INTERNAL_ERROR", message: "Internal server error" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

import { getLogger, Logger } from "./logger.js";
