/**
 * ActivityPub Direct Message Routes
 *
 * Routes for sending and retrieving direct messages.
 * DMs use ActivityPub Create activities with bto field for privacy.
 */

import { respondWithObject } from "@fedify/fedify";
import { addCorsHeaders } from "../../../worker.js";
import { DmService } from "../../activitypub/dm-service.js";
import { getFedifyContext } from "../../activitypub/fedify/context.js";
import { DmServiceFedify } from "../../activitypub/services/dm-service-fedify.js";
import { sharedDatabaseConnectionManager } from "../../database-connection-manager.js";
import {
  QueryTimeoutPresets,
  withQueryTimeoutAndRetry,
} from "../../db-query-helper.js";
import { getLogger, Logger } from "../../logger.js";
import { corsMiddleware, csrfMiddleware } from "../../middleware.js";
import { detectRegionSync } from "../../region-detection.js";
import { SecurityHeaders } from "../../security-headers.js";
import { SessionManager } from "../../session-cookie.js";
import type { Route } from "../types.js";

/**
 * ActivityPub direct message routes
 */
export const messageRoutes: Route[] = [
  /**
   * POST /api/messages
   * Send a direct message
   */
  {
    path: "/api/messages",
    method: "POST",
    handler: async (request, env, { url }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const sessionManager = new SessionManager();

      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Parse request body
        const body = (await request.json()) as {
          recipientId: string;
          text: string;
        };
        const { recipientId, text } = body;

        // Validate input
        if (!recipientId || typeof recipientId !== "string") {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "recipientId is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        if (!text || typeof text !== "string" || text.trim().length === 0) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "text is required and cannot be empty" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        if (text.length > 5000) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "text must be 5000 characters or less" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Fetch sender and recipient
        const [sender, recipient] = await Promise.all([
          withQueryTimeoutAndRetry(
            dbManager,
            region,
            env,
            async (db) => {
              return db.user.findUnique({
                where: { id: session.userId },
                select: {
                  id: true,
                  username: true,
                  actorUri: true,
                  publicKey: true,
                  suspended: true,
                  deletionConfirmedAt: true,
                },
              });
            },
            {
              ...QueryTimeoutPresets.STANDARD,
              context: {
                operation: "sendDM_fetchSender",
                userId: session.userId,
              },
            },
          ),
          withQueryTimeoutAndRetry(
            dbManager,
            region,
            env,
            async (db) => {
              return db.user.findUnique({
                where: { id: recipientId },
                select: {
                  id: true,
                  username: true,
                  actorUri: true,
                  publicKey: true,
                  suspended: true,
                  deletionConfirmedAt: true,
                  dmAccess: true,
                },
              });
            },
            {
              ...QueryTimeoutPresets.STANDARD,
              context: {
                operation: "sendDM_fetchRecipient",
                recipientId,
              },
            },
          ),
        ]);

        if (!sender || !sender.actorUri || !sender.publicKey) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Sender not found or not configured for ActivityPub",
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        if (!recipient || !recipient.actorUri || !recipient.publicKey) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Recipient not found or not configured for ActivityPub",
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        if (sender.suspended || sender.deletionConfirmedAt) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Sender account is suspended or deleted" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        if (recipient.suspended || recipient.deletionConfirmedAt) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Recipient account is suspended or deleted",
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Safer Social Design: Enforce DM access control
        if (recipient) {
          const recipientDmAccess = (recipient as any).dmAccess || "CONNECTIONS";
          if (recipientDmAccess === "NOBODY") {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "FORBIDDEN", message: "This user does not accept direct messages" }),
              { status: 403, headers: { "content-type": "application/json" } },
            );
            return addCorsHeaders(errorResponse, request, env);
          }
          if (recipientDmAccess === "CONNECTIONS") {
            // Check if they are mutual follows
            const mutualFollow = await withQueryTimeoutAndRetry(
              dbManager,
              region,
              env,
              async (db) => {
                // TODO: redesign - use GraphService for mutual follow check
                return false as any;
              },
              { ...QueryTimeoutPresets.STANDARD, context: { operation: "checkMutualFollow" } },
            );
            if (!mutualFollow) {
              const errorResponse = securityHeaders.createSecureResponse(
                JSON.stringify({ error: "FORBIDDEN", message: "You can only message mutual connections" }),
                { status: 403, headers: { "content-type": "application/json" } },
              );
              return addCorsHeaders(errorResponse, request, env);
            }
          }
        }

        // Create direct message
        const dm = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return DmServiceFedify.createDirectMessage(
              db,
              sender as any,
              recipient as any,
              text.trim(),
              env,
              url.toString(),
              logger,
            );
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "sendDM_create",
              senderId: sender.id,
              recipientId: recipient.id,
            },
          },
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            id: dm.id,
            recipientId: dm.recipientId,
            text: dm.text,
            read: dm.read,
            createdAt: dm.createdAt.toISOString(),
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[ActivityPub] Error sending direct message:", error);

        // Handle specific errors
        if (error.message?.includes("remote actor")) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Cannot send DM to remote actor (standalone mode)",
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to send direct message" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Send a direct message",
  },

  /**
   * GET /api/messages
   * Get direct messages for the authenticated user
   */
  {
    path: "/api/messages",
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const sessionManager = new SessionManager();

      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Parse query parameters
        const url = new URL(request.url);
        const type = (url.searchParams.get("type") || "all") as
          | "sent"
          | "received"
          | "all";
        const limit = Math.min(
          parseInt(url.searchParams.get("limit") || "50", 10),
          100,
        );
        const cursor = url.searchParams.get("cursor") || undefined;

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Get DMs
        const result = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return DmService.getDms(db, session.userId, type, limit, cursor);
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getDMs",
              userId: session.userId,
              type,
            },
          },
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            messages: result.messages.map((dm) => ({
              id: dm.id,
              senderId: dm.senderId,
              recipientId: dm.recipientId,
              text: dm.text,
              read: dm.read,
              readAt: dm.readAt?.toISOString() || null,
              createdAt: dm.createdAt.toISOString(),
            })),
            hasMore: result.hasMore,
            nextCursor: result.nextCursor,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[ActivityPub] Error fetching direct messages:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to fetch direct messages" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Get direct messages for authenticated user",
  },

  /**
   * GET /messages/:messageId
   * Get a specific DM as ActivityPub Note object
   */
  {
    path: "/messages/:messageId",
    method: "GET",
    handler: async (request, env, { params, url }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      try {
        const messageId = params?.messageId;
        if (!messageId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Message ID is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Fetch DM with sender and recipient
        const dm = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.directMessage.findUnique({
              where: { id: messageId },
              include: {
                sender: {
                  select: {
                    id: true,
                    username: true,
                    actorUri: true,
                    publicKey: true,
                  },
                },
                recipient: {
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
              operation: "getDMNote",
              messageId,
            },
          },
        );

        if (
          !dm ||
          !dm.objectId ||
          !dm.sender?.actorUri ||
          !dm.recipient?.actorUri
        ) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Message not found" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Use Fedify to serialize Note object
        const federation = getFedifyContext(env);
        const note = await DmServiceFedify.createDmNote(
          messageId,
          dm.sender as any,
          dm.recipient as any,
          dm.text,
          dm.createdAt,
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
        logger.error("[ActivityPub] Error fetching DM note:", error);

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
    description: "Get ActivityPub Note object for a direct message",
  },

  /**
   * POST /api/messages/:messageId/read
   * Mark a direct message as read
   */
  {
    path: "/api/messages/:messageId/read",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const sessionManager = new SessionManager();

      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        const messageId = (request as any).params?.messageId;
        if (!messageId) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Message ID is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Mark as read
        await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return DmService.markAsRead(db, messageId, session.userId);
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "markDMAsRead",
              userId: session.userId,
              messageId,
            },
          },
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ success: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[ActivityPub] Error marking DM as read:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to mark message as read" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Mark a direct message as read",
  },
];
