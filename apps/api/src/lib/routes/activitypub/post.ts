/**
 * ActivityPub Post Routes
 *
 * Routes for ActivityPub post objects and activities.
 * These endpoints return ActivityStreams Note objects and Create activities.
 */

import { respondWithObject } from "@fedify/fedify";
import { getFedifyContext } from "../../activitypub/fedify/context.js";
import { PostActivityServiceFedify } from "../../activitypub/services/post-service-fedify.js";
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
 * ActivityPub post routes
 */
export const postRoutes: Route[] = [
  /**
   * GET /posts/:postId
   * Returns ActivityPub Note object for a post
   */
  {
    path: "/posts/:postId",
    method: "GET",
    handler: async (request, env, { params, url }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      try {
        const postId = params?.postId;
        if (!postId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post ID is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Fetch post with author
        const post = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.post.findUnique({
              where: { id: postId },
              include: {
                author: {
                  select: {
                    id: true,
                    username: true,
                    actorUri: true,
                    publicKey: true,
                  },
                },
              },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getPostNote",
              postId,
            },
          },
        );

        if (!post) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post not found" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Check if post is deleted
        if (post.deletedAt) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post not found" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Check if post has ActivityPub fields
        if (!post.objectId || !post.author?.actorUri) {
          logger.warn(
            `[ActivityPub] Post ${postId} does not have ActivityPub fields set`,
          );
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post not available" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Use Fedify to serialize Note object
        const federation = getFedifyContext(env);
        const note = await PostActivityServiceFedify.createNote(
          post,
          post.author as any,
          env,
          url.toString(),
        );

        // Use Fedify's respondWithObject for proper JSON-LD serialization
        const response = await respondWithObject(request as any, note as any);

        // Apply security headers to Fedify's response
        const responseBody = await response.text();
        return securityHeaders.createSecureResponse(responseBody, {
          status: response.status,
          headers: {
            ...Object.fromEntries(response.headers.entries()),
            "content-type": "application/activity+json",
          },
        });
      } catch (error: any) {
        logger.error("[ActivityPub] Error fetching post note:", error);

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
    description: "Get ActivityPub Note object for a post",
  },

  /**
   * GET /posts/:postId/activity
   * Returns ActivityPub Create activity for a post
   */
  {
    path: "/posts/:postId/activity",
    method: "GET",
    handler: async (request, env, { params, url }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      try {
        const postId = params?.postId;
        if (!postId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post ID is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Fetch post with author
        const post = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.post.findUnique({
              where: { id: postId },
              include: {
                author: {
                  select: {
                    id: true,
                    username: true,
                    actorUri: true,
                    publicKey: true,
                  },
                },
              },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getPostActivity",
              postId,
            },
          },
        );

        if (!post) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post not found" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Check if post is deleted
        if (post.deletedAt) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post not found" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Check if post has ActivityPub fields
        if (!post.activityId || !post.author?.actorUri) {
          logger.warn(
            `[ActivityPub] Post ${postId} does not have ActivityPub fields set`,
          );
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Activity not available" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Get activity from database
        const activity = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.activity.findFirst({
              where: {
                id: post.activityId || undefined,
                outboxActorUri: post.author.actorUri || undefined,
              },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getPostActivity_fromDb",
              postId,
              activityId: post.activityId,
            },
          },
        );

        // Always generate activity using Fedify (don't rely on database-stored format)
        const federation = getFedifyContext(env);
        const createActivity =
          await PostActivityServiceFedify.createCreateActivity(
            post,
            post.author as any,
            env,
            url.toString(),
          );

        // Use Fedify's respondWithObject for proper JSON-LD serialization
        const response = await respondWithObject(
          request as any,
          createActivity as any,
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
        logger.error("[ActivityPub] Error fetching post activity:", error);

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
    description: "Get ActivityPub Create activity for a post",
  },
];
