/**
 * ActivityPub Inbox Routes
 *
 * Handles receiving ActivityPub activities in user inboxes.
 */

import { addCorsHeaders } from "../../../worker.js";
import { ActivityService } from "../../activitypub/activity-service.js";
import { processInboxActivity } from "../../activitypub/listeners/inbox.js";
import { sharedDatabaseConnectionManager } from "../../database-connection-manager.js";
import {
  QueryTimeoutPresets,
  withQueryTimeoutAndRetry,
} from "../../db-query-helper.js";
import { getLogger, Logger } from "../../logger.js";
import { corsMiddleware } from "../../middleware.js";
import { detectRegionSync } from "../../region-detection.js";
import { SecurityHeaders } from "../../security-headers.js";
import { SessionManager } from "../../session-cookie.js";
import type { Route } from "../types.js";

/**
 * One deny body for the inbox collection (AP §5.2: readable only by its
 * owner). "No such user" and "not your inbox" share status and body so an
 * anonymous caller learns nothing from the difference.
 */
const INBOX_DENY_BODY = JSON.stringify({ error: "Not found" });
const INBOX_DENY_INIT = {
  status: 404,
  headers: { "content-type": "application/json" },
} as const;

export interface ActivityPubEnv {
  DATABASE_URL?: string;
  HYPERDRIVE?: any;
  LOG_LEVEL?: string;
  DEFAULT_REGION?: string;
  ACTIVITYPUB_BASE_URL?: string;
}

export const inboxRoutes: Route[] = [
  {
    path: "/users/:username/inbox",
    method: "POST",
    middleware: [corsMiddleware()],
    handler: async (request, env, { params }) => {
      const securityHeaders = new SecurityHeaders(env);
      const { username } = params;

      // Use Fedify-based inbox processing
      const response = await processInboxActivity(request, env, username);

      // Add security headers and CORS
      const secureResponse = securityHeaders.createSecureResponse(
        await response.text(),
        {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        },
      );
      return addCorsHeaders(secureResponse, request, env);
    },
    description: "Receive ActivityPub activity in inbox",
  },
  {
    path: "/users/:username/inbox",
    method: "GET",
    middleware: [corsMiddleware()],
    handler: async (request, env, { params }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const { username } = params;
      const url = new URL(request.url);
      const page = parseInt(url.searchParams.get("page") || "1", 10);
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") || "20", 10),
        100,
      );

      try {
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
          const errorResponse = securityHeaders.createSecureResponse(
            INBOX_DENY_BODY,
            INBOX_DENY_INIT,
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // The inbox is a PRIVATE collection: only its owner reads it. It used
        // to list every received activity (who follows, likes and messages
        // this user, plus DM object URIs) to any anonymous caller. Owner means
        // a local session for exactly this user; a signed GET is not accepted
        // here because a local actor's own key is never a valid inbound
        // signer, and no remote party is ever the owner of a local inbox.
        const session = await new SessionManager().getSession(
          request,
          env.SESSION_SECRET,
          env,
        );
        if (!session || session.userId !== user.id) {
          logger.warn("[Inbox] inbox read refused", {
            username,
            hasSession: Boolean(session),
          });
          const errorResponse = securityHeaders.createSecureResponse(
            INBOX_DENY_BODY,
            INBOX_DENY_INIT,
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get inbox activities
        const activities = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return ActivityService.getInboxActivities(
              db,
              user.actorUri!,
              page,
              limit,
            );
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getInboxActivities",
              username,
            },
          },
        );

        const totalItems = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return ActivityService.getInboxCount(db, user.actorUri!);
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getInboxCount",
              username,
            },
          },
        );

        // Format as OrderedCollection
        const collection = {
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "OrderedCollection",
          id: `${user.actorUri}/inbox`,
          totalItems,
          orderedItems: activities.map((a) => ({
            type: a.type,
            actor: a.actorUri,
            object: a.objectId,
            published: a.published.toISOString(),
          })),
        };

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(collection),
          {
            status: 200,
            headers: {
              "content-type": "application/activity+json",
            },
          },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Inbox] Error getting inbox activities", {
          error: (error as Error).message,
          username,
        });
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    description: "Get ActivityPub inbox activities",
  },
];
