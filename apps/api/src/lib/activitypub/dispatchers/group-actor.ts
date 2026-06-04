/**
 * Group Actor Dispatcher for Fedify
 *
 * Implements Fedify's ActorDispatcher interface for Group actors.
 * Handles actor document retrieval, key pair management, and actor URI resolution.
 */

import type { ActorKeyPair } from "@fedify/fedify";
import type { Actor } from "@fedify/fedify/vocab";
import type { Env } from "../../../env.js";
import type { Group } from "@prisma/client";
import { DatabaseConnectionManager } from "../../database-connection-manager.js";
import { detectRegionSync } from "../../region-detection.js";
import {
  withQueryTimeoutAndRetry,
  QueryTimeoutPresets,
} from "../../db-query-helper.js";
import { getLogger, Logger } from "../../logger.js";
import { getActivityPubBaseUrl } from "../fedify/context.js";
import { KeyPairService } from "../crypto.js";
import { GroupService } from "../group-service.js";

/**
 * Group Actor Dispatcher
 *
 * Handles Group actors for ActivityPub federation.
 */
export class GroupActorDispatcher {
  private env: Env;
  private logger: Logger;

  constructor(env: Env) {
    this.env = env;
    this.logger = getLogger();
  }

  /**
   * Get actor by URI
   *
   * @param uri - Actor URI (e.g., https://example.com/groups/{groupId})
   * @returns Actor object or null if not found
   */
  async getActor(uri: string): Promise<Actor | null> {
    try {
      // Parse actor URI to extract group ID
      // Format: https://example.com/groups/{groupId}
      const url = new URL(uri);
      const match = url.pathname.match(/^\/groups\/(.+)$/);
      if (!match) {
        this.logger.warn("[GroupActorDispatcher] Invalid actor URI format", {
          uri,
        });
        return null;
      }

      const groupId = decodeURIComponent(match[1]);
      if (!groupId) {
        return null;
      }

      // Get region for database connection
      const region = "EU"; // Default region, could be enhanced to detect from request
      const dbManager = new DatabaseConnectionManager(this.env);

      // Fetch group from database
      const group = await withQueryTimeoutAndRetry(
        dbManager,
        region,
        this.env,
        async (db) => {
          return db.group.findUnique({
            where: { id: groupId },
            select: {
              id: true,
              name: true,
              description: true,
              actorUri: true,
              inboxUrl: true,
              outboxUrl: true,
              followersUrl: true,
              publicKey: true,
              privateKey: true,
              privacy: true,
            },
          });
        },
        {
          ...QueryTimeoutPresets.STANDARD,
          context: {
            operation: "getGroupActor",
            groupId,
          },
        },
      );

      if (!group) {
        return null;
      }

      // Check if group has ActivityPub fields set
      if (!group.actorUri || !group.publicKey) {
        this.logger.warn(
          "[GroupActorDispatcher] Group does not have ActivityPub fields set",
          { groupId },
        );
        return null;
      }

      // Convert Group to Fedify Actor
      return this.groupToActor(group);
    } catch (error: any) {
      this.logger.error("[GroupActorDispatcher] Error getting actor", {
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

      // Get group to access private key
      const url = new URL(uri);
      const match = url.pathname.match(/^\/groups\/(.+)$/);
      if (!match) {
        return null;
      }

      const groupId = decodeURIComponent(match[1]);
      const region = "EU"; // Default region
      const dbManager = new DatabaseConnectionManager(this.env);

      const group = await withQueryTimeoutAndRetry(
        dbManager,
        region,
        this.env,
        async (db) => {
          return db.group.findUnique({
            where: { id: groupId },
            select: {
              publicKey: true,
              privateKey: true,
            },
          });
        },
        {
          ...QueryTimeoutPresets.STANDARD,
          context: {
            operation: "getGroupKeyPair",
            groupId,
          },
        },
      );

      if (!group || !group.publicKey || !group.privateKey) {
        return null;
      }

      // Decrypt private key
      const privateKeyPem = KeyPairService.decryptPrivateKey(
        group.privateKey,
        this.env,
      );

      // Extract actorUri from the URI parameter (we already have it from the URL parsing)
      const actorUri = GroupService.generateActorUri(groupId, this.env);

      return {
        keyId: new URL(`${actorUri}#main-key`),
        publicKey: group.publicKey as any,
        privateKey: privateKeyPem as any,
        cryptographicKey: undefined as any,
        multikey: undefined as any,
      } as ActorKeyPair;
    } catch (error: any) {
      this.logger.error("[GroupActorDispatcher] Error getting key pair", {
        error: error.message,
        uri,
      });
      return null;
    }
  }

  /**
   * Convert Group database record to Fedify Actor
   *
   * @param group - Group database record (can be partial)
   * @returns Fedify Actor object
   */
  private groupToActor(
    group: Partial<Group> & {
      id: string;
      name: string;
      actorUri: string;
      inboxUrl: string;
      outboxUrl: string;
      followersUrl: string;
      publicKey: string;
      description: string | null;
      privacy: any;
    },
  ): Actor {
    const baseUrl = getActivityPubBaseUrl(this.env);
    const actorUri =
      group.actorUri || GroupService.generateActorUri(group.id, this.env);

    const actor: Actor = {
      id: new URL(actorUri),
      preferredUsername: group.id,
      inboxId: new URL(group.inboxUrl || `${actorUri}/inbox`),
      outboxId: new URL(group.outboxUrl || `${actorUri}/outbox`),
      followersId: new URL(group.followersUrl || `${actorUri}/followers`),
    } as any;

    // Add type (Fedify's Actor type may not include this in type definition)
    (actor as any).type = "Group"; // Fedify's Group type

    // Add public key if available
    if (group.publicKey) {
      (actor as any).publicKey = {
        id: new URL(`${actorUri}#main-key`),
        owner: new URL(actorUri),
        publicKeyPem: group.publicKey,
      };
    }

    // Add name
    if (group.name) {
      (actor as any).name = group.name;
    }

    // Add summary (description)
    if (group.description) {
      (actor as any).summary = group.description;
    }

    return actor;
  }

  /**
   * Generate actor URI for a group
   *
   * @param groupId - Group ID
   * @returns Actor URI
   */
  static generateActorUri(groupId: string, env: Env): string {
    return GroupService.generateActorUri(groupId, env);
  }
}
