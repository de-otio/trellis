/**
 * ActivityPub Actor Routes
 *
 * Routes for ActivityPub actor documents and collections.
 * These endpoints are publicly accessible and return JSON-LD documents.
 */

import { respondWithObject } from "@fedify/fedify";
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
 * ActivityPub actor routes
 */
export const actorRoutes: Route[] = [
  /**
   * GET /users/:username
   * Returns ActivityPub actor document for a user
   */
  {
    path: "/users/:username",
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

        // Decode username (in case it's URL-encoded)
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
                inboxUrl: true,
                outboxUrl: true,
                followersUrl: true,
                followingUrl: true,
                friendsUrl: true,
                publicKey: true,
                suspended: true,
                deletionConfirmedAt: true,
              },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getActorDocument",
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
        // If not, this is an existing user that hasn't been migrated yet
        if (!user.actorUri || !user.publicKey) {
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

        // Use Fedify dispatcher to get actor, then serialize with Fedify
        try {
          const dispatcher = new UserActorDispatcher(env);

          // Get actor using Fedify dispatcher
          const actor = await dispatcher.getActor(user.actorUri);

          if (!actor) {
            return securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Actor not found" }),
              {
                status: 404,
                headers: { "content-type": "application/json" },
              },
            );
          }

          // Get Fedify federation for serialization
          const federation = getFedifyContext(env);

          // Use Fedify's respondWithObject to serialize actor to JSON-LD
          // This ensures proper JSON-LD serialization and content negotiation
          const response = await respondWithObject(
            request as any,
            actor as any,
          );

          // Apply security headers to Fedify's response
          const responseBody = await response.text();
          return securityHeaders.createSecureResponse(responseBody, {
            status: response.status,
            headers: {
              ...Object.fromEntries(response.headers.entries()),
              // Ensure content type is set correctly
              "content-type": "application/activity+json",
            },
          });
        } catch (fedifyError: any) {
          // Fedify serialization failed - log error and return 500
          logger.error("[ActivityPub] Fedify serialization failed", {
            error: fedifyError?.message || String(fedifyError),
            username: decodedUsername,
          });

          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Internal server error" }),
            {
              status: 500,
              headers: { "content-type": "application/json" },
            },
          );
        }
      } catch (error: any) {
        logger.error("[ActivityPub] Error fetching actor document:", error);

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
    description: "Get ActivityPub actor document for a user",
  },
];
