/**
 * Entity ActivityPub Profile Service
 *
 * Generic ActivityPub actor service for any entity type.
 * URI pattern: /entities/{entityType}/{entityId}
 *
 * This is entity-type-agnostic. Domain-specific actor enrichment
 * (e.g., breed in summary for dogs) is handled by the extension's
 * enrichActor hook — not here.
 */

import type { PrismaClient, Entity } from "@prisma/client";
import { ActorService } from "./actor.js";
import { KeyPairService } from "./crypto.js";
import type { Env } from "../../env.js";


export class EntityProfileService {
  /**
   * Generate ActivityPub actor URI for an entity
   */
  static generateActorUri(
    entityId: string,
    entityType: string,
    env: Env,
    requestUrl?: string,
  ): string {
    const baseUrl = ActorService.getBaseUrl(env, requestUrl);
    return `${baseUrl}/entities/${entityType}/${entityId}`;
  }

  /**
   * Get actor URI from entity, generating if missing
   */
  static getActorUri(entity: Entity, env: Env, requestUrl?: string): string {
    if (entity.actorUri) {
      return entity.actorUri;
    }
    return this.generateActorUri(entity.id, entity.entityType!, env, requestUrl);
  }

  /**
   * Generate collection URLs for an entity actor
   */
  static generateCollectionUrls(actorUri: string) {
    return {
      inbox: `${actorUri}/inbox`,
      outbox: `${actorUri}/outbox`,
      followers: `${actorUri}/followers`,
    };
  }

  /**
   * Initialize ActivityPub fields for a new entity
   */
  static async initializeActorFields(
    prisma: PrismaClient,
    entity: Entity,
    env: Env,
  ): Promise<Entity> {
    const entityType = entity.entityType!;
    const actorUri = this.generateActorUri(entity.id, entityType, env);
    const collections = this.generateCollectionUrls(actorUri);

    const { publicKey, privateKey } = KeyPairService.generateKeyPair();
    const encryptedPrivateKey = KeyPairService.encryptPrivateKey(privateKey, env);

    return await prisma.entity.update({
      where: { id: entity.id },
      data: {
        actorUri,
        inboxUrl: collections.inbox,
        outboxUrl: collections.outbox,
        followersUrl: collections.followers,
        publicKey,
        privateKey: encryptedPrivateKey,
      },
    });
  }

  /**
   * Get follower actor URIs for an entity (paginated)
   */
  static async getFollowers(
    prisma: PrismaClient,
    entityId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<string[]> {
    // TODO: redesign - use GraphService
    return [] as string[];
  }

  /**
   * Get follower count for an entity
   */
  static async getFollowersCount(
    prisma: PrismaClient,
    entityId: string,
  ): Promise<number> {
    // TODO: redesign - use GraphService
    return 0;
  }
}
