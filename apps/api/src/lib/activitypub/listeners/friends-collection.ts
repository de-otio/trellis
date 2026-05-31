/**
 * Fedify Friends Collection Listener
 *
 * Handles friends collection endpoint with Fedify integration.
 * Fedify handles JSON-LD serialization of the OrderedCollection.
 */

import type { Env } from "../../../env.js";
import { FriendshipService } from "../friendship-service.js";
import { getLogger, Logger } from "../../logger.js";
import { sharedDatabaseConnectionManager } from "../../database-connection-manager.js";
import {
  withQueryTimeoutAndRetry,
  QueryTimeoutPresets,
} from "../../db-query-helper.js";
import { detectRegionSync } from "../../region-detection.js";

/**
 * Get friends collection
 *
 * Retrieves friends for a user and formats them as an OrderedCollection.
 * Fedify will handle JSON-LD serialization when fully integrated.
 *
 * @param request - Incoming request
 * @param env - Cloudflare Workers environment
 * @param username - Target username
 * @returns Response with OrderedCollection
 */
export async function getFriendsCollection(
  request: Request,
  env: Env,
  username: string,
): Promise<Response> {
  const logger = getLogger();

  try {
    // Parse pagination parameters
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") || "20", 10),
      100,
    );

    // Get region and database
    const region = detectRegionSync(request, env);
    const dbManager = sharedDatabaseConnectionManager;

    // Get user by username
    const user = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (db) => {
        return db.user.findUnique({
          where: { username },
          select: {
            id: true,
            username: true,
            actorUri: true,
          },
        });
      },
      {
        ...QueryTimeoutPresets.STANDARD,
        context: {
          operation: "getUserByUsername",
          username,
        },
      },
    );

    if (!user || !user.actorUri) {
      logger.warn("[Fedify Friends Collection] User not found", { username });
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    // Get friends actor URIs
    const friendsActorUris = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (db) => {
        return FriendshipService.getFriendsActorUris(
          db,
          user.actorUri!,
          page,
          limit,
        );
      },
      {
        ...QueryTimeoutPresets.STANDARD,
        context: {
          operation: "getFriendsActorUris",
          username,
        },
      },
    );

    const totalItems = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (db) => {
        return FriendshipService.getFriendsCount(db, user.actorUri!);
      },
      {
        ...QueryTimeoutPresets.STANDARD,
        context: {
          operation: "getFriendsCount",
          username,
        },
      },
    );

    // Format as OrderedCollection (ActivityPub standard)
    const collection = {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "OrderedCollection",
      id: `${user.actorUri}/friends`,
      totalItems,
      orderedItems: friendsActorUris,
    };

    return new Response(JSON.stringify(collection), {
      status: 200,
      headers: {
        "content-type": "application/activity+json",
      },
    });
  } catch (error) {
    logger.error(
      "[Fedify Friends Collection] Error getting friends collection",
      {
        error: (error as Error).message,
        username,
      },
    );
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
