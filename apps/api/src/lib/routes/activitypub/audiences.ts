/**
 * ActivityPub Custom Audience Routes
 *
 * Routes for creating and managing custom audiences.
 * Custom audiences are ActivityStreams OrderedCollections used for post targeting.
 */

import { respondWithObject } from "@fedify/fedify";
import { addCorsHeaders } from "../../../worker.js";
import { CustomAudienceService } from "../../activitypub/audience-service.js";
import { getFedifyContext } from "../../activitypub/fedify/context.js";
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
 * ActivityPub custom audience routes
 */
export const audienceRoutes: Route[] = [
  /**
   * POST /api/audiences
   * Create a custom audience
   */
  {
    path: "/api/audiences",
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
          name: string;
          memberIds: string[];
        };
        const { name, memberIds } = body;

        // Validate input
        if (!name || typeof name !== "string" || name.trim().length === 0) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "name is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        if (!Array.isArray(memberIds) || memberIds.length === 0) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "memberIds must be a non-empty array" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Fetch creator
        const creator = await withQueryTimeoutAndRetry(
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
              operation: "createAudience_fetchCreator",
              userId: session.userId,
            },
          },
        );

        if (!creator || !creator.actorUri || !creator.publicKey) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Creator not found or not configured for ActivityPub",
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        if (creator.suspended || creator.deletionConfirmedAt) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Creator account is suspended or deleted",
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Create audience
        const audience = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return CustomAudienceService.createAudience(
              db,
              creator as any,
              name.trim(),
              memberIds,
              env,
              url.toString(),
            );
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "createAudience",
              userId: session.userId,
            },
          },
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            id: audience.id,
            name: audience.name,
            collectionId: audience.collectionId,
            createdAt: audience.createdAt.toISOString(),
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[ActivityPub] Error creating custom audience:", error);

        // Handle specific errors
        if (
          error.message?.includes("not found") ||
          error.message?.includes("not configured")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: error.message }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: error.message || "Failed to create custom audience",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Create a custom audience",
  },

  /**
   * GET /audiences/:audienceId
   * Get custom audience collection (ActivityPub OrderedCollection)
   */
  {
    path: "/audiences/:audienceId",
    method: "GET",
    handler: async (request, env, { params, url }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      try {
        const audienceId = params?.audienceId;
        if (!audienceId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Audience ID is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Parse pagination
        const urlObj = new URL(url.toString());
        const page = Math.max(
          1,
          parseInt(urlObj.searchParams.get("page") || "1", 10),
        );
        const limit = Math.min(
          50,
          parseInt(urlObj.searchParams.get("limit") || "50", 10),
        );

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Create Fedify OrderedCollection
        const federation = getFedifyContext(env);
        const collection = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return CustomAudienceService.createOrderedCollection(
              db,
              audienceId,
              env,
              url.toString(),
              page,
              limit,
            );
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getAudienceCollection",
              audienceId,
            },
          },
        );

        // Use Fedify's respondWithObject for proper JSON-LD serialization
        const response = await respondWithObject(
          request as any,
          collection as any,
        );

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
        logger.error(
          "[ActivityPub] Error fetching audience collection:",
          error,
        );

        if (error.message?.includes("not found")) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Audience not found" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

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
    description: "Get ActivityPub OrderedCollection for a custom audience",
  },

  /**
   * POST /api/audiences/:audienceId/members
   * Add member to custom audience
   */
  {
    path: "/api/audiences/:audienceId/members",
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
        const audienceId = (request as any).params?.audienceId;
        const body = (await request.json()) as { memberId: string };
        const { memberId } = body;

        if (!audienceId || !memberId) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "audienceId and memberId are required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Verify user owns the audience
        const audience = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.customAudience.findUnique({
              where: { id: audienceId },
              select: { creatorId: true },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "addAudienceMember_checkOwnership",
              userId: session.userId,
              audienceId,
            },
          },
        );

        if (!audience || audience.creatorId !== session.userId) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Audience not found or access denied" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Add member
        await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return CustomAudienceService.addMember(db, audienceId, memberId);
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "addAudienceMember",
              userId: session.userId,
              audienceId,
              memberId,
            },
          },
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ success: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[ActivityPub] Error adding audience member:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: error.message || "Failed to add member" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Add member to custom audience",
  },

  /**
   * DELETE /api/audiences/:audienceId/members/:memberId
   * Remove member from custom audience
   */
  {
    path: "/api/audiences/:audienceId/members/:memberId",
    method: "DELETE",
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
        const audienceId = (request as any).params?.audienceId;
        const memberId = (request as any).params?.memberId;

        if (!audienceId || !memberId) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "audienceId and memberId are required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Verify user owns the audience
        const audience = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.customAudience.findUnique({
              where: { id: audienceId },
              select: { creatorId: true },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "removeAudienceMember_checkOwnership",
              userId: session.userId,
              audienceId,
            },
          },
        );

        if (!audience || audience.creatorId !== session.userId) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Audience not found or access denied" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Remove member
        await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return CustomAudienceService.removeMember(db, audienceId, memberId);
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "removeAudienceMember",
              userId: session.userId,
              audienceId,
              memberId,
            },
          },
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ success: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[ActivityPub] Error removing audience member:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to remove member" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Remove member from custom audience",
  },
];
