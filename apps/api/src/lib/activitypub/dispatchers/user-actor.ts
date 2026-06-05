/**
 * User Actor Dispatcher for Fedify
 *
 * Implements Fedify's ActorDispatcher interface for User actors.
 * Handles actor document retrieval, key pair management, and actor URI resolution.
 */

import type { ActorKeyPair } from "@fedify/fedify";
import type { Actor } from "@fedify/fedify/vocab";
import type { Env } from "../../../env.js";
import type { User } from "@prisma/client";
import { DatabaseConnectionManager } from "../../database-connection-manager.js";
import { detectRegionSync } from "../../region-detection.js";
import {
  withQueryTimeoutAndRetry,
  QueryTimeoutPresets,
} from "../../db-query-helper.js";
import { getLogger, Logger } from "../../logger.js";
import { getActivityPubBaseUrl } from "../fedify/context.js";
import { KeyPairService } from "../crypto.js";

/**
 * User Actor Dispatcher
 *
 * Handles User actors for ActivityPub federation.
 */
export class UserActorDispatcher {
  private env: Env;
  private logger: Logger;

  constructor(env: Env) {
    this.env = env;
    this.logger = getLogger();
  }

  /**
   * Get actor by URI
   *
   * @param uri - Actor URI (e.g., https://example.com/users/username)
   * @returns Actor object or null if not found
   */
  async getActor(uri: string): Promise<Actor | null> {
    try {
      // Parse actor URI to extract username
      // Format: https://example.com/users/{username}
      const url = new URL(uri);
      const match = url.pathname.match(/^\/users\/(.+)$/);
      if (!match) {
        this.logger.warn("[UserActorDispatcher] Invalid actor URI format", {
          uri,
        });
        return null;
      }

      const username = decodeURIComponent(match[1]);
      if (!username) {
        return null;
      }

      // Get region for database connection
      const region = "EU"; // Default region, could be enhanced to detect from request
      const dbManager = new DatabaseConnectionManager(this.env);

      // Fetch user from database
      const user = await withQueryTimeoutAndRetry(
        dbManager,
        region,
        this.env,
        async (db) => {
          return db.user.findUnique({
            where: { username },
            select: {
              id: true,
              username: true,
              actorUri: true,
              inboxUrl: true,
              outboxUrl: true,
              followersUrl: true,
              followingUrl: true,
              friendsUrl: true,
              publicKey: true,
              privateKey: true,
              suspended: true,
            },
          });
        },
        {
          ...QueryTimeoutPresets.STANDARD,
          context: {
            operation: "getActor",
            username,
          },
        },
      );

      if (!user) {
        return null;
      }

      // Check if user is suspended
      if (user.suspended) {
        return null;
      }

      // Check if user has ActivityPub fields set
      if (!user.actorUri || !user.publicKey) {
        this.logger.warn(
          "[UserActorDispatcher] User does not have ActivityPub fields set",
          { username },
        );
        return null;
      }

      // Convert User to Fedify Actor
      return this.userToActor(user);
    } catch (error: any) {
      this.logger.error("[UserActorDispatcher] Error getting actor", {
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

      // Get user to access private key
      const url = new URL(uri);
      const match = url.pathname.match(/^\/users\/(.+)$/);
      if (!match) {
        return null;
      }

      const username = decodeURIComponent(match[1]);
      const region = "EU"; // Default region
      const dbManager = new DatabaseConnectionManager(this.env);

      const user = await withQueryTimeoutAndRetry(
        dbManager,
        region,
        this.env,
        async (db) => {
          return db.user.findUnique({
            where: { username },
            select: {
              publicKey: true,
              privateKey: true,
            },
          });
        },
        {
          ...QueryTimeoutPresets.STANDARD,
          context: {
            operation: "getKeyPair",
            username,
          },
        },
      );

      if (!user || !user.publicKey || !user.privateKey) {
        return null;
      }

      // Decrypt private key
      const privateKeyPem = KeyPairService.decryptPrivateKey(
        user.privateKey,
        this.env,
      );

      // Extract actorUri from the URI parameter
      const actorUri = UserActorDispatcher.generateActorUri(username, this.env);

      return {
        keyId: new URL(`${actorUri}#main-key`),
        publicKey: user.publicKey as any,
        privateKey: privateKeyPem as any,
        cryptographicKey: undefined as any,
        multikey: undefined as any,
      } as ActorKeyPair;
    } catch (error: any) {
      this.logger.error("[UserActorDispatcher] Error getting key pair", {
        error: error.message,
        uri,
      });
      return null;
    }
  }

  /**
   * Convert User database record to Fedify Actor
   *
   * @param user - User database record (can be partial)
   * @returns Fedify Actor object
   */
  private userToActor(
    user: Partial<User> & {
      id: string;
      username: string | null;
      actorUri: string | null;
      inboxUrl: string | null;
      outboxUrl: string | null;
      followersUrl: string | null;
      followingUrl: string | null;
      friendsUrl: string | null;
      publicKey: string | null;
    },
  ): Actor {
    const baseUrl = getActivityPubBaseUrl(this.env);
    const actorUri =
      user.actorUri ||
      `${baseUrl}/users/${encodeURIComponent(user.username || "")}`;

    const actor: Actor = {
      id: new URL(actorUri),
      preferredUsername: user.username || "",
      inboxId: new URL(user.inboxUrl || `${actorUri}/inbox`),
      outboxId: new URL(user.outboxUrl || `${actorUri}/outbox`),
      followersId: new URL(user.followersUrl || `${actorUri}/followers`),
      followingId: new URL(user.followingUrl || `${actorUri}/following`),
    } as any;

    // Add type (Fedify's Actor type may not include this in type definition)
    (actor as any).type = "Person";

    // Add friends collection if available
    if (user.friendsUrl) {
      (actor as any).friends = new URL(user.friendsUrl);
    }

    // Add public key if available
    // Fedify's Actor type may not include publicKey in the type definition,
    // but it's part of the ActivityStreams spec, so we include it
    if (user.publicKey) {
      (actor as any).publicKey = {
        id: `${actorUri}#main-key`,
        owner: actorUri,
        publicKeyPem: user.publicKey,
      };
    }

    return actor;
  }

  /**
   * Generate actor URI for a user
   *
   * @param username - Username
   * @returns Actor URI
   */
  static generateActorUri(username: string, env: Env): string {
    const baseUrl = getActivityPubBaseUrl(env);
    return `${baseUrl}/users/${encodeURIComponent(username)}`;
  }
}
