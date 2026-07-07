/**
 * Collection Handler
 *
 * CRUD for curated Collections (user/entity discovery lists) + item management.
 *
 * Design: open-social-web/03-collections.md. Key rules enforced here:
 * - Caps (`env.collection.maxItems`, `env.collection.maxPerUser`) are runtime
 *   config, never a compiled constant (threshold-secrecy, CLAUDE.md rule 8).
 * - Add-time visibility check: adding a referent to a PUBLIC/UNLISTED
 *   collection requires the referent to currently be public.
 * - Read-time visibility filter (SEC-12, critical): reads of a PUBLIC/UNLISTED
 *   collection re-check each referent's CURRENT visibility and filter out any
 *   referent that has since gone non-public. The add-time check alone is not
 *   sufficient because a referent can go private after being added.
 */

import type { Env } from "../env.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { Session } from "./session-cookie.js";
import { getLogger, Logger } from "./logger.js";

type TargetType = "user" | "entity";

interface CollectionItemLike {
  id: string;
  collectionId: string;
  targetType: string;
  targetId: string;
  position: number;
  note: string | null;
  addedAt: Date;
}

interface CollectionLike {
  id: string;
  tenantId: string;
  ownerUserId: string;
  title: string;
  description: string | null;
  visibility: "PUBLIC" | "UNLISTED" | "PRIVATE";
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function serializeCollection(collection: CollectionLike) {
  return {
    id: collection.id,
    tenantId: collection.tenantId,
    ownerUserId: collection.ownerUserId,
    title: collection.title,
    description: collection.description,
    visibility: collection.visibility,
    itemCount: collection.itemCount,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  };
}

function serializeItem(item: CollectionItemLike) {
  return {
    id: item.id,
    targetType: item.targetType,
    targetId: item.targetId,
    position: item.position,
    note: item.note,
    addedAt: item.addedAt,
  };
}

export class CollectionHandler {
  /**
   * Create a new collection owned by session.userId.
   */
  async handleCreate(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { z } = await import("zod");
      const body = (await request.json()) as Record<string, unknown>;

      const schema = z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        visibility: z.enum(["PUBLIC", "UNLISTED", "PRIVATE"]).optional().default("PRIVATE"),
      });

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse(
          { error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message },
          400,
        );
      }

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      const tenantId = await this.resolveTenantId(session, db);
      if (!tenantId) {
        return jsonResponse({ error: "INTERNAL_ERROR", message: "Tenant resolution failed" }, 500);
      }

      const maxPerUser = env.collection.maxPerUser;
      const existingCount = await db.collection.count({
        where: { ownerUserId: session.userId },
      });
      if (existingCount >= maxPerUser) {
        return jsonResponse(
          {
            error: "LIMIT_EXCEEDED",
            message: `You may have at most ${maxPerUser} collections`,
          },
          409,
        );
      }

      const collection = await db.collection.create({
        data: {
          tenantId,
          ownerUserId: session.userId,
          title: parsed.data.title,
          description: parsed.data.description ?? null,
          visibility: parsed.data.visibility,
        },
      });

      return jsonResponse(serializeCollection(collection), 201);
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * Get a collection by id. `session` may be null for anonymous reads of
   * PUBLIC/UNLISTED collections; PRIVATE collections require the owner.
   */
  async handleGet(
    id: string,
    _request: Request,
    session: Session | null,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      const collection = await db.collection.findUnique({ where: { id } });
      if (!collection) {
        return jsonResponse({ error: "NOT_FOUND", message: "Collection not found" }, 404);
      }

      const isOwner = session?.userId === collection.ownerUserId;
      if (collection.visibility === "PRIVATE" && !isOwner) {
        // 404, not 403 — do not confirm existence of a private collection.
        return jsonResponse({ error: "NOT_FOUND", message: "Collection not found" }, 404);
      }

      const items = await db.collectionItem.findMany({
        where: { collectionId: id },
        orderBy: { position: "asc" },
      });

      const visibleItems =
        collection.visibility === "PRIVATE" ? items : await this.filterVisibleItems(items, db);

      return jsonResponse(
        {
          ...serializeCollection(collection),
          items: visibleItems.map(serializeItem),
        },
        200,
      );
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * Update title/description/visibility. Owner-only.
   */
  async handleUpdate(
    id: string,
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { z } = await import("zod");
      const body = (await request.json()) as Record<string, unknown>;

      const schema = z
        .object({
          title: z.string().min(1).max(200).optional(),
          description: z.string().max(2000).nullable().optional(),
          visibility: z.enum(["PUBLIC", "UNLISTED", "PRIVATE"]).optional(),
        })
        .refine(
          (v) => v.title !== undefined || v.description !== undefined || v.visibility !== undefined,
          {
            message: "At least one field must be provided",
          },
        );

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse(
          { error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message },
          400,
        );
      }

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      const collection = await db.collection.findUnique({ where: { id } });
      if (!collection) {
        return jsonResponse({ error: "NOT_FOUND", message: "Collection not found" }, 404);
      }
      if (collection.ownerUserId !== session.userId) {
        return jsonResponse({ error: "FORBIDDEN", message: "You do not own this collection" }, 403);
      }

      const updated = await db.collection.update({
        where: { id },
        data: {
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
          ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
        },
      });

      return jsonResponse(serializeCollection(updated), 200);
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * Delete a collection (and its items, via onDelete: Cascade). Owner-only.
   */
  async handleDelete(
    id: string,
    _request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      const collection = await db.collection.findUnique({ where: { id } });
      if (!collection) {
        return jsonResponse({ error: "NOT_FOUND", message: "Collection not found" }, 404);
      }
      if (collection.ownerUserId !== session.userId) {
        return jsonResponse({ error: "FORBIDDEN", message: "You do not own this collection" }, 403);
      }

      await db.collection.delete({ where: { id } });

      return new Response(null, { status: 204 });
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * List a user's PUBLIC collections (discovery surface). Anonymous-ok.
   */
  async handleListByOwner(
    request: Request,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const ownerUserId = url.searchParams.get("owner");
      if (!ownerUserId) {
        return jsonResponse(
          { error: "VALIDATION_ERROR", message: "owner query parameter is required" },
          400,
        );
      }

      const limitStr = url.searchParams.get("limit");
      const limit = Math.min(Math.max(parseInt(limitStr || "20", 10) || 20, 1), 100);

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      const collections = await db.collection.findMany({
        where: { ownerUserId, visibility: "PUBLIC" },
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      return jsonResponse({ collections: collections.map(serializeCollection) }, 200);
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * List the session owner's own collections, all visibilities.
   */
  async handleListMine(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const limitStr = url.searchParams.get("limit");
      const limit = Math.min(Math.max(parseInt(limitStr || "20", 10) || 20, 1), 100);

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      const collections = await db.collection.findMany({
        where: { ownerUserId: session.userId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      return jsonResponse({ collections: collections.map(serializeCollection) }, 200);
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * Add an item to a collection. Owner-only. Cap-enforced
   * (`env.collection.maxItems`). Validates the referent exists and, for
   * PUBLIC/UNLISTED collections, that it is currently public.
   */
  async handleAddItem(
    id: string,
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { z } = await import("zod");
      const body = (await request.json()) as Record<string, unknown>;

      const schema = z.object({
        targetType: z.enum(["user", "entity"]),
        targetId: z.string().min(1).max(100),
        note: z.string().max(500).optional(),
      });

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse(
          { error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message },
          400,
        );
      }

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      const collection = await db.collection.findUnique({ where: { id } });
      if (!collection) {
        return jsonResponse({ error: "NOT_FOUND", message: "Collection not found" }, 404);
      }
      if (collection.ownerUserId !== session.userId) {
        return jsonResponse({ error: "FORBIDDEN", message: "You do not own this collection" }, 403);
      }

      const maxItems = env.collection.maxItems;
      if (collection.itemCount >= maxItems) {
        return jsonResponse(
          {
            error: "LIMIT_EXCEEDED",
            message: `Collections may have at most ${maxItems} items`,
          },
          409,
        );
      }

      const targetType = parsed.data.targetType as TargetType;
      const targetId = parsed.data.targetId;

      const exists = await this.referentExists(targetType, targetId, db);
      if (!exists) {
        return jsonResponse(
          { error: "REFERENT_NOT_FOUND", message: "Referent does not exist" },
          404,
        );
      }

      if (collection.visibility !== "PRIVATE") {
        const isPublic = await this.isReferentPublic(targetType, targetId, db);
        if (!isPublic) {
          return jsonResponse(
            {
              error: "REFERENT_NOT_PUBLIC",
              message: "Referent must be public to be added to a PUBLIC or UNLISTED collection",
            },
            422,
          );
        }
      }

      const item = await db.collectionItem.create({
        data: {
          collectionId: id,
          targetType,
          targetId,
          position: collection.itemCount,
          note: parsed.data.note ?? null,
        },
      });

      await db.collection.update({
        where: { id },
        data: { itemCount: { increment: 1 } },
      });

      return jsonResponse(serializeItem(item), 201);
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * Remove an item from a collection. Owner-only.
   */
  async handleRemoveItem(
    id: string,
    itemId: string,
    _request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      const collection = await db.collection.findUnique({ where: { id } });
      if (!collection) {
        return jsonResponse({ error: "NOT_FOUND", message: "Collection not found" }, 404);
      }
      if (collection.ownerUserId !== session.userId) {
        return jsonResponse({ error: "FORBIDDEN", message: "You do not own this collection" }, 403);
      }

      const item = await db.collectionItem.findUnique({ where: { id: itemId } });
      if (!item || item.collectionId !== id) {
        return jsonResponse({ error: "NOT_FOUND", message: "Item not found" }, 404);
      }

      await db.collectionItem.delete({ where: { id: itemId } });
      await db.collection.update({
        where: { id },
        data: { itemCount: { decrement: 1 } },
      });

      return new Response(null, { status: 204 });
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * Reorder items within a collection. Owner-only. `orderedItemIds` must be
   * exactly the current set of item ids (no additions/removals via reorder).
   */
  async handleReorderItems(
    id: string,
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const { z } = await import("zod");
      const body = (await request.json()) as Record<string, unknown>;

      const schema = z.object({
        orderedItemIds: z.array(z.string().min(1)).min(1),
      });

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse(
          { error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message },
          400,
        );
      }

      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);

      const collection = await db.collection.findUnique({ where: { id } });
      if (!collection) {
        return jsonResponse({ error: "NOT_FOUND", message: "Collection not found" }, 404);
      }
      if (collection.ownerUserId !== session.userId) {
        return jsonResponse({ error: "FORBIDDEN", message: "You do not own this collection" }, 403);
      }

      const items = await db.collectionItem.findMany({ where: { collectionId: id } });
      const currentIds = new Set(items.map((i: CollectionItemLike) => i.id));
      const requestedIds = parsed.data.orderedItemIds;

      const sameSet =
        requestedIds.length === currentIds.size &&
        requestedIds.every((itemId: string) => currentIds.has(itemId)) &&
        new Set(requestedIds).size === requestedIds.length;

      if (!sameSet) {
        return jsonResponse(
          {
            error: "VALIDATION_ERROR",
            message: "orderedItemIds must contain exactly the collection's current items",
          },
          400,
        );
      }

      for (let index = 0; index < requestedIds.length; index++) {
        await db.collectionItem.update({
          where: { id: requestedIds[index] },
          data: { position: index },
        });
      }

      const reordered = await db.collectionItem.findMany({
        where: { collectionId: id },
        orderBy: { position: "asc" },
      });

      return jsonResponse({ items: reordered.map(serializeItem) }, 200);
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * Resolve the tenant a new collection is created under. No ambient tenant
   * is available on the cookie session, so this falls back to the owner's
   * personal tenant — mirroring the resolution used for media (see
   * `lib/media/tenant-resolution.ts`: "personal-fallback"). Every user gets a
   * personal tenant at sign-up, so this should always resolve for a real
   * session; a miss means the session's user row is in an inconsistent state.
   */
  private async resolveTenantId(session: Session, db: any): Promise<string | null> {
    const user = await db.user.findUnique({
      where: { id: session.userId },
      select: { personalTenantId: true },
    });
    return user?.personalTenantId ?? null;
  }

  /** Does the referent row currently exist at all? */
  private async referentExists(
    targetType: TargetType,
    targetId: string,
    db: any,
  ): Promise<boolean> {
    if (targetType === "user") {
      const user = await db.user.findUnique({ where: { id: targetId }, select: { id: true } });
      return !!user;
    }
    const entity = await db.entity.findUnique({ where: { id: targetId }, select: { id: true } });
    return !!entity;
  }

  /**
   * Is the referent CURRENTLY public? Users are public when
   * `profileVisibility === "PUBLIC"`. Entities have no visibility field of
   * their own in the current schema, so an existing entity is treated as
   * public.
   */
  private async isReferentPublic(
    targetType: TargetType,
    targetId: string,
    db: any,
  ): Promise<boolean> {
    if (targetType === "user") {
      const user = await db.user.findUnique({
        where: { id: targetId },
        select: { profileVisibility: true },
      });
      return user?.profileVisibility === "PUBLIC";
    }
    const entity = await db.entity.findUnique({ where: { id: targetId }, select: { id: true } });
    return !!entity;
  }

  /**
   * SEC-12: re-check each item's referent CURRENT visibility and drop any
   * that is no longer public. Batches lookups by target type to avoid N+1
   * queries.
   */
  private async filterVisibleItems(
    items: CollectionItemLike[],
    db: any,
  ): Promise<CollectionItemLike[]> {
    if (items.length === 0) return items;

    const userIds = [
      ...new Set(items.filter((i) => i.targetType === "user").map((i) => i.targetId)),
    ];
    const entityIds = [
      ...new Set(items.filter((i) => i.targetType === "entity").map((i) => i.targetId)),
    ];

    const [publicUsers, existingEntities] = await Promise.all([
      userIds.length > 0
        ? db.user.findMany({
            where: { id: { in: userIds }, profileVisibility: "PUBLIC" },
            select: { id: true },
          })
        : Promise.resolve([]),
      entityIds.length > 0
        ? db.entity.findMany({
            where: { id: { in: entityIds } },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);

    const publicUserIds = new Set(publicUsers.map((u: { id: string }) => u.id));
    const existingEntityIds = new Set(existingEntities.map((e: { id: string }) => e.id));

    return items.filter((item) => {
      if (item.targetType === "user") return publicUserIds.has(item.targetId);
      if (item.targetType === "entity") return existingEntityIds.has(item.targetId);
      return false;
    });
  }

  private mapError(error: any): Response {
    const logger: Logger = getLogger();

    if (error instanceof SyntaxError) {
      return jsonResponse({ error: "VALIDATION_ERROR", message: "Invalid JSON body" }, 400);
    }

    if (error?.code === "P2002") {
      logger.warn("[CollectionHandler] Unique constraint violation:", error.message);
      return jsonResponse({ error: "CONFLICT", message: "Item already in collection" }, 409);
    }

    if (error?.code === "P2025") {
      logger.warn("[CollectionHandler] Record not found:", error.message);
      return jsonResponse({ error: "NOT_FOUND", message: "Not found" }, 404);
    }

    logger.error("[CollectionHandler] Unexpected error:", error);
    return jsonResponse({ error: "INTERNAL_ERROR", message: "Internal server error" }, 500);
  }
}
