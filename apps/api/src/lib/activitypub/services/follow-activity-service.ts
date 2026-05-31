/**
 * Follow Activity Service (Fedify-Based)
 *
 * Handles creation and processing of Follow activities using Fedify's type-safe Follow class.
 */

import { Follow } from "@fedify/fedify";
import type { Env } from "../../../env.js";
import type { User } from "@prisma/client";
import { UserActorDispatcher } from "../dispatchers/user-actor.js";
import { getActivityPubBaseUrl } from "../fedify/context.js";

/**
 * Service for managing Follow activities with Fedify
 */
export class FollowActivityService {
  /**
   * Create a Follow activity using Fedify
   *
   * @param follower - User who is following
   * @param targetActorUri - Actor URI of the target being followed
   * @param env - Environment configuration
   * @param requestUrl - Optional request URL for generating activity ID
   * @returns Fedify Follow activity
   */
  static createFollowActivity(
    follower: User,
    targetActorUri: string,
    env: Env,
    requestUrl?: string,
  ): Follow {
    const baseUrl = getActivityPubBaseUrl(env, requestUrl);
    const followerActorUri = UserActorDispatcher.generateActorUri(
      follower.username || "",
      env,
    );

    // Generate a unique activity ID for this follow
    const activityId = `${baseUrl}/activities/${crypto.randomUUID()}`;

    // Create Fedify Follow activity
    const followActivity = new Follow({
      id: new URL(activityId),
      actor: new URL(followerActorUri),
      object: new URL(targetActorUri),
    });

    return followActivity;
  }

  /**
   * Parse a Follow activity from JSON
   *
   * This can be used when receiving Follow activities in the inbox.
   * Fedify's Follow class can be instantiated from JSON-LD.
   *
   * @param json - JSON-LD representation of Follow activity
   * @returns Fedify Follow activity or null if invalid
   */
  static parseFollowActivity(json: any): Follow | null {
    try {
      if (json.type !== "Follow" || !json.actor || !json.object) {
        return null;
      }

      return new Follow({
        id: json.id ? new URL(json.id) : undefined,
        actor: new URL(
          typeof json.actor === "string" ? json.actor : json.actor.id,
        ),
        object: new URL(
          typeof json.object === "string" ? json.object : json.object.id,
        ),
      });
    } catch (error) {
      return null;
    }
  }
}
