/**
 * Entity Actor Dispatcher for Fedify
 *
 * Implements Fedify's ActorDispatcher interface for Entity actors (any entityType).
 * Single source of truth for actor document serialization — the route handler
 * delegates here rather than maintaining a separate serialization path.
 */

import type { Actor, ActorKeyPair } from "@fedify/fedify";
import type { Env } from "../../../env.js";
import type { Entity } from "@prisma/client";
import { DatabaseConnectionManager } from "../../database-connection-manager.js";
import { detectRegionSync } from "../../region-detection.js";
import {
  withQueryTimeoutAndRetry,
  QueryTimeoutPresets,
} from "../../db-query-helper.js";
import { getLogger, Logger } from "../../logger.js";
import { getActivityPubBaseUrl } from "../fedify/context.js";
import { KeyPairService } from "../crypto.js";
import { EntityProfileService } from "../entity-profile-service.js";
import { getExtension } from "../../../extensions.js";

/**
 * Entity Actor Dispatcher
 *
 * Handles Entity actors (any entityType) for ActivityPub federation.
 */
export class EntityActorDispatcher {
  private env: Env;
  private logger: Logger;

  constructor(env: Env) {
    this.env = env;
    this.logger = getLogger();
  }

  /**
   * Get actor by URI
   *
   * @param uri - Actor URI (e.g., https://example.com/entities/dog/{entityId})
   * @returns Actor object or null if not found
   */
  async getActor(uri: string): Promise<Actor | null> {
    // Validate URL format first - throw if invalid
    let url: URL;
    try {
      url = new URL(uri);
    } catch (error) {
      // Invalid URL format - throw error as expected by tests
      throw new Error(`Invalid URL format: ${uri}`);
    }

    try {
      // Parse actor URI to extract entity type and ID
      // Format: https://example.com/entities/{entityType}/{entityId}
      const match = url.pathname.match(/^\/entities\/([^/]+)\/(.+)$/);
      if (!match) {
        this.logger.warn("[EntityActorDispatcher] Invalid actor URI format", {
          uri,
        });
        return null;
      }

      const entityId = decodeURIComponent(match[2]);
      if (!entityId) {
        return null;
      }

      // Get region for database connection
      const region = "EU"; // Default region, could be enhanced to detect from request
      const dbManager = new DatabaseConnectionManager(this.env);

      // Fetch entity from database
      const entity = await withQueryTimeoutAndRetry(
        dbManager,
        region,
        this.env,
        async (db) => {
          const entity = await db.entity.findUnique({
            where: { id: entityId },
            select: {
              id: true,
              name: true,
              entityType: true,
              metadata: true,
              actorUri: true,
              inboxUrl: true,
              outboxUrl: true,
              followersUrl: true,
              publicKey: true,
              privateKey: true,
              owners: { select: { userId: true, role: true }, where: { status: 'ACTIVE' as const } },
            },
          });

          if (!entity) {
            return null;
          }

          // Get owner to include actorUri
          const primaryOwnerId = (entity as any).owners?.[0]?.userId;
          const owner = primaryOwnerId ? await db.user.findUnique({
            where: { id: primaryOwnerId },
            select: {
              actorUri: true,
            },
          }) : null;

          return {
            ...entity,
            owner,
          };
        },
        {
          ...QueryTimeoutPresets.STANDARD,
          context: {
            operation: "getEntityActor",
            entityId,
          },
        },
      );

      if (!entity) {
        return null;
      }

      // Check if entity has ActivityPub fields set
      if (!entity.actorUri || !entity.publicKey) {
        this.logger.warn(
          "[EntityActorDispatcher] Entity does not have ActivityPub fields set",
          { entityId },
        );
        return null;
      }

      // Convert Entity to Fedify Actor
      return this.entityToActor(
        entity as unknown as Entity & { owner?: { actorUri: string | null } | null },
      );
    } catch (error: any) {
      this.logger.error("[EntityActorDispatcher] Error getting actor", {
        error: error.message,
        uri,
      });
      return null;
    }
  }

  /**
   * Get key pair for an actor
   *
   * @param uri - Actor URI
   * @returns Key pair or null if not found
   */
  async getKeyPair(uri: string): Promise<ActorKeyPair | null> {
    try {
      const actor = await this.getActor(uri);
      if (!actor) {
        return null;
      }

      // Get entity to access private key
      const url = new URL(uri);
      const match = url.pathname.match(/^\/entities\/([^/]+)\/(.+)$/);
      if (!match) {
        return null;
      }

      const entityType = decodeURIComponent(match[1]);
      const entityId = decodeURIComponent(match[2]);
      const region = "EU"; // Default region
      const dbManager = new DatabaseConnectionManager(this.env);

      const entity = await withQueryTimeoutAndRetry(
        dbManager,
        region,
        this.env,
        async (db) => {
          return db.entity.findUnique({
            where: { id: entityId },
            select: {
              publicKey: true,
              privateKey: true,
            },
          });
        },
        {
          ...QueryTimeoutPresets.STANDARD,
          context: {
            operation: "getEntityKeyPair",
            entityId,
          },
        },
      );

      if (!entity || !entity.publicKey || !entity.privateKey) {
        return null;
      }

      // Decrypt private key
      const privateKeyPem = KeyPairService.decryptPrivateKey(
        entity.privateKey,
        this.env,
      );

      // Extract actorUri from the URI parameter (we already have it from the URL parsing)
      const actorUri = EntityProfileService.generateActorUri(entityId, entityType, this.env);

      return {
        keyId: new URL(`${actorUri}#main-key`),
        publicKey: entity.publicKey as any,
        privateKey: privateKeyPem as any,
        cryptographicKey: undefined as any,
        multikey: undefined as any,
      } as ActorKeyPair;
    } catch (error: any) {
      this.logger.error("[EntityActorDispatcher] Error getting key pair", {
        error: error.message,
        uri,
      });
      return null;
    }
  }

  /**
   * Convert Entity database record to Fedify Actor
   *
   * @param entity - Entity database record (with owner)
   * @returns Fedify Actor object
   */
  entityToActor(
    entity: Entity & { owner?: { actorUri: string | null } | null },
  ): Actor {
    const actorUri =
      entity.actorUri ||
      EntityProfileService.generateActorUri(entity.id, entity.entityType!, this.env);
    const metadata = (entity.metadata as any) || {};

    const actor: Actor = {
      id: new URL(actorUri),
      preferredUsername: entity.id,
      inboxId: new URL(entity.inboxUrl || `${actorUri}/inbox`),
      outboxId: new URL(entity.outboxUrl || `${actorUri}/outbox`),
      followersId: new URL(entity.followersUrl || `${actorUri}/followers`),
    } as any;

    (actor as any).type = "Person";

    if (entity.publicKey) {
      (actor as any).publicKey = {
        id: new URL(`${actorUri}#main-key`),
        owner: new URL(actorUri),
        publicKeyPem: entity.publicKey,
      };
    }

    if (entity.name) {
      (actor as any).name = entity.name;
    }

    if (metadata.bio) {
      (actor as any).summary = metadata.bio;
    }

    if (entity.owner?.actorUri) {
      (actor as any).attributedTo = new URL(entity.owner.actorUri);
    }

    // Extension enrichment — display fields only
    const ext = getExtension(entity.entityType ?? "");
    if (ext?.activityPub?.enrichActor) {
      const enrichment = ext.activityPub.enrichActor(entity);
      if (enrichment.summary) (actor as any).summary = enrichment.summary;
      if (enrichment.icon) (actor as any).icon = enrichment.icon;
      if (enrichment.attachment) (actor as any).attachment = enrichment.attachment;
      if (enrichment.properties) {
        const BLOCKED_KEYS = new Set([
          "id", "publicKey", "inbox", "outbox", "endpoints",
          "@context", "preferredUsername", "type",
        ]);
        for (const [key, value] of Object.entries(enrichment.properties)) {
          if (!BLOCKED_KEYS.has(key)) {
            (actor as any)[key] = value;
          }
        }
      }
    }

    return actor;
  }


  /**
   * Generate actor URI for an entity
   */
  static generateActorUri(entityId: string, env: Env, entityType: string = "entity"): string {
    return EntityProfileService.generateActorUri(entityId, entityType, env);
  }
}
