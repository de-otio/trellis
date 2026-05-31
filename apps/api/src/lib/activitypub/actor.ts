/**
 * ActivityPub Actor System
 *
 * Handles actor URI generation, actor document serialization, and actor management.
 * Every user (and future dog profile) must have an ActivityPub actor.
 */

import type { Env } from "../../env.js";
import type { User } from "@prisma/client";

/**
 * ActivityPub Actor Service
 */
export class ActorService {
  /**
   * Get base URL for ActivityPub from environment
   * Uses APP_DOMAIN if available, otherwise derives from request URL
   */
  static getBaseUrl(env: Env, requestUrl?: string): string {
    // Try APP_DOMAIN first (e.g., https://www.example.com)
    if (env.APP_DOMAIN) {
      try {
        const url = new URL(env.APP_DOMAIN);
        return `${url.protocol}//${url.hostname}`;
      } catch {
        // Invalid URL, fall through
      }
    }

    // Try ACTIVITYPUB_BASE_URL if set
    const activityPubBaseUrl = (env as any).ACTIVITYPUB_BASE_URL;
    if (activityPubBaseUrl && typeof activityPubBaseUrl === "string") {
      try {
        const url = new URL(activityPubBaseUrl);
        return `${url.protocol}//${url.hostname}`;
      } catch {
        // Invalid URL, fall through
      }
    }

    // Derive from request URL if provided
    if (requestUrl) {
      try {
        const url = new URL(requestUrl);
        return `${url.protocol}//${url.hostname}`;
      } catch {
        // Invalid URL, fall through
      }
    }

    // Default fallback
    return "https://example.com";
  }

  /**
   * Generate ActivityPub actor URI for a user
   *
   * Format: https://example.com/users/{username}
   */
  static generateActorUri(
    username: string,
    env: Env,
    requestUrl?: string,
  ): string {
    if (!username) {
      throw new Error("Username is required to generate actor URI");
    }

    const baseUrl = this.getBaseUrl(env, requestUrl);
    return `${baseUrl}/users/${encodeURIComponent(username)}`;
  }

  /**
   * Get actor URI from user
   * Returns existing actorUri if present, otherwise generates one
   */
  static getActorUri(user: User, env: Env, requestUrl?: string): string {
    if (user.actorUri) {
      return user.actorUri;
    }

    // Generate if missing (for existing users)
    if (!user.username) {
      throw new Error("User must have username to generate actor URI");
    }

    return this.generateActorUri(user.username, env, requestUrl);
  }

  /**
   * Generate collection URLs for an actor
   */
  static generateCollectionUrls(
    actorUri: string,
    includeFriends: boolean = false,
  ): {
    inbox: string;
    outbox: string;
    followers: string;
    following: string;
    friends?: string;
  } {
    const urls: {
      inbox: string;
      outbox: string;
      followers: string;
      following: string;
      friends?: string;
    } = {
      inbox: `${actorUri}/inbox`,
      outbox: `${actorUri}/outbox`,
      followers: `${actorUri}/followers`,
      following: `${actorUri}/following`,
    };

    if (includeFriends) {
      urls.friends = `${actorUri}/friends`;
    }

    return urls;
  }

  /**
   * Validate actor URI format
   */
  static isValidActorUri(uri: string): boolean {
    try {
      const url = new URL(uri);
      // Must be HTTPS
      if (url.protocol !== "https:") {
        return false;
      }
      // Must have /users/ path
      if (!url.pathname.startsWith("/users/")) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}
