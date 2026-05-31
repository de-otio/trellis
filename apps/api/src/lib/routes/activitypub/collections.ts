/**
 * ActivityPub Collection Routes
 *
 * Routes for ActivityPub collections (followers, following, friends).
 * These endpoints return ActivityStreams OrderedCollection documents.
 */

import { OrderedCollection, respondWithObject } from "@fedify/fedify";
import { UserActorDispatcher } from "../../activitypub/dispatchers/user-actor.js";
import { getFedifyContext } from "../../activitypub/fedify/context.js";
import { sharedDatabaseConnectionManager } from "../../database-connection-manager.js";
import {
  QueryTimeoutPresets,
  withQueryTimeoutAndRetry,
} from "../../db-query-helper.js";
import { getLogger, Logger } from "../../logger.js";
import { corsMiddleware } from "../../middleware.js";
import { detectRegionSync } from "../../region-detection.js";
import { SecurityHeaders } from "../../security-headers.js";
import type { Route } from "../types.js";

/**
 * ActivityPub collection routes
 */
export const collectionRoutes: Route[] = [
  /**
   * GET /users/:username/followers
   * Returns ActivityPub followers collection for a user
   */
  {
    path: "/users/:username/followers",
    method: "GET",
    handler: async (request, env, { params, url }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      try {
        const username = params?.username;
        if (!username) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Username is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Decode username
        const decodedUsername = decodeURIComponent(username);

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Fetch user from database
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { username: decodedUsername },
              select: {
                id: true,
                username: true,
                actorUri: true,
                suspended: true,
                deletionConfirmedAt: true,
              },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getFollowersCollection",
              username: decodedUsername,
            },
          },
        );

        if (!user) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "User not found" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Check if user is suspended or deleted
        if (user.suspended || user.deletionConfirmedAt) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "User not found" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Check if user has ActivityPub fields set
        if (!user.actorUri) {
          logger.warn(
            `[ActivityPub] User ${decodedUsername} does not have ActivityPub fields set`,
          );
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Actor not available" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Get followers count
        const followersCount = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            // TODO: redesign - use GraphService
            return 0;
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getFollowersCollection_count",
              userId: user.id,
            },
          },
        );

        // Build collection URL using Fedify actor dispatcher
        const actorUri = UserActorDispatcher.generateActorUri(
          user.username || "",
          env,
        );
        const collectionUrl = new URL(`${actorUri}/followers`);

        // Use Fedify's OrderedCollection for type-safe serialization
        const federation = getFedifyContext(env);
        const collection = new OrderedCollection({
          id: collectionUrl,
          totalItems: followersCount,
          first: new URL(`${collectionUrl.toString()}?page=1`),
        });

        // Use Fedify's respondWithObject for proper JSON-LD serialization
        const response = await respondWithObject(
          request as any,
          collection as any,
        );

        const responseBody = await response.text();
        return securityHeaders.createSecureResponse(responseBody, {
          status: response.status,
          headers: {
            ...Object.fromEntries(response.headers.entries()),
            "content-type": "application/activity+json",
          },
        });
      } catch (error: any) {
        logger.error(
          "[ActivityPub] Error fetching followers collection:",
          error,
        );

        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get ActivityPub followers collection for a user",
  },
];
