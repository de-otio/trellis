/**
 * ActivityPub Post Routes
 *
 * Routes for ActivityPub post objects and activities.
 * These endpoints return ActivityStreams Note objects and Create activities.
 */

import { respondWithObject } from "@fedify/fedify";
import { getFedifyContext } from "../../activitypub/fedify/context.js";
import { PostActivityServiceFedify } from "../../activitypub/services/post-service-fedify.js";
import { mayFederatePost } from "../../post-handler.js";
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
 * The single deny body for every refusal on these routes (D10).
 *
 * These endpoints are UNAUTHENTICATED. Distinguishing "no such post" from "that
 * post is not public" hands an anonymous caller an existence oracle for private
 * post ids — which matters precisely for an id they saw while the post WAS
 * public and which has since been narrowed. Previously the three refusal paths
 * returned three different bodies ("Post not found", "Post not available",
 * "Activity not available"), so the distinction was readable straight off the
 * response.
 *
 * Every reason therefore shares one status, one body and one header set. Keep it
 * that way: a new refusal branch must reuse this, not describe itself.
 */
const DENY_BODY = JSON.stringify({ error: "Post not found" });
const DENY_INIT = {
  status: 404,
  headers: { "content-type": "application/json" },
} as const;

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

        // ONE gate, one deny body. `mayFederatePost` is the load-bearing
        // addition: the presence of `objectId` used to be the only audience
        // check here, and it is not one. `objectId` is written when a post first
        // federates and is NEVER cleared, so narrowing a post from public to
        // private — or hiding it — left the CURRENT text publicly fetchable by
        // any anonymous caller, while every authenticated read path correctly
        // denied it. Editing after narrowing published the new private text.
        //
        // `mayFederatePost` also covers deletedAt and hiddenByAuthor, so the
        // conditions below are the full audience decision rather than a
        // liveness check.
        if (
          !post ||
          !mayFederatePost(post) ||
          !post.objectId ||
          !post.author?.actorUri
        ) {
          // Logged, not disclosed: the response cannot say which branch refused.
          logger.warn("[ActivityPub] object fetch refused", {
            postId,
            found: Boolean(post),
            federatable: post ? mayFederatePost(post) : false,
            hasObjectId: Boolean(post?.objectId),
            hasActorUri: Boolean(post?.author?.actorUri),
          });
          return securityHeaders.createSecureResponse(DENY_BODY, DENY_INIT);
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

        // Same single gate as the object route above — see DENY_BODY. The
        // Create activity wraps the same Note, so an audience check that guards
        // one and not the other guards neither.
        if (
          !post ||
          !mayFederatePost(post) ||
          !post.activityId ||
          !post.author?.actorUri
        ) {
          logger.warn("[ActivityPub] activity fetch refused", {
            postId,
            found: Boolean(post),
            federatable: post ? mayFederatePost(post) : false,
            hasActivityId: Boolean(post?.activityId),
            hasActorUri: Boolean(post?.author?.actorUri),
          });
          return securityHeaders.createSecureResponse(DENY_BODY, DENY_INIT);
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
