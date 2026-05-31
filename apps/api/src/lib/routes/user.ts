/**
 * User Routes
 *
 * Routes for user profile management
 */

import { addCorsHeaders } from "../../worker.js";
import { sharedDatabaseConnectionManager } from "../database-connection-manager.js";
import {
  QueryTimeoutPresets,
  withQueryTimeoutAndRetry,
} from "../db-query-helper.js";
import { getIPAddress } from "../ip-scrubber.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { detectRegionSync, isValidRegion } from "../region-detection.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";

export const userRoutes: Route[] = [
  {
    path: "/api/user/profile",
    method: "PATCH",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
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
        const body = (await request.json()) as { stealth_mode?: boolean };
        const { stealth_mode } = body;

        // Validate input - stealth_mode must be boolean if provided
        if (stealth_mode !== undefined && typeof stealth_mode !== "boolean") {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid input: stealth_mode must be a boolean",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Update user profile
        const updatedUser = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.update({
              where: { id: session.userId },
              data: {
                ...(stealth_mode !== undefined && {
                  stealthMode: stealth_mode,
                }),
              },
              select: {
                id: true,
                email: true,
                role: true,
                stealthMode: true,
                actorUri: true,
                handle: true,
                createdAt: true,
              },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "updateUserProfile",
              userId: session.userId,
            },
          },
        );

        // Format response to match Flutter expectations
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            id: updatedUser.id,
            email: updatedUser.email,
            role: updatedUser.role,
            stealth_mode: updatedUser.stealthMode,
            actor_uri: updatedUser.actorUri,
            handle: updatedUser.handle,
            created_at: updatedUser.createdAt.toISOString(),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[User] Error updating profile:", error);

        // Handle not found error
        if (
          error.code === "P2025" ||
          error.message?.includes("Record to update not found")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "User not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Handle other errors
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to update profile" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update user profile settings",
  },
  {
    path: "/api/user/region-preference",
    method: "POST",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
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
        const body = await request.json();
        const { region } = body as { region?: string };

        // Validate region
        if (!region || typeof region !== "string") {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid input: region is required and must be a string",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        if (!isValidRegion(region)) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid region. Valid regions: US, EU, CN",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get region for database connection (use detected region, not user preference)
        const detectedRegion = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Update user region preference
        // Note: We update in the detected region's database, but the user's dataRegion stays the same
        const updatedUser = await withQueryTimeoutAndRetry(
          dbManager,
          detectedRegion,
          env,
          async (db) => {
            return db.user.update({
              where: { id: session.userId },
              data: {
                region, // Update user preference
                // Note: dataRegion is NOT changed - it tracks where data is stored
              },
              select: {
                id: true,
                email: true,
                region: true,
                dataRegion: true,
              },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "updateUserRegionPreference",
              userId: session.userId,
            },
          },
        );

        // PHASE 3: Invalidate region cache when user changes region preference
        // This ensures cached region data is updated immediately
        if (env.FOLLOWERS_KV) {
          try {
            // Invalidate region cache
            await env.FOLLOWERS_KV.delete(`region:${session.userId}`);
            // Invalidate validation cache (forces re-validation on next request)
            await env.FOLLOWERS_KV.delete(
              `region:validation:${session.userId}`,
            );
            logger.debug(
              "[UserRoutes] Invalidated region cache on preference change",
              {
                userId: session.userId,
                newRegion: region,
              },
            );
          } catch (error: any) {
            logger.warn("[UserRoutes] Failed to invalidate region cache", {
              userId: session.userId,
              error: error.message,
            });
            // Non-critical - cache will be updated on next request
          }
        }

        // Note: Session userRegion will be updated on next request
        // For immediate update, we could update session here, but it's not critical

        // Format response
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            region: updatedUser.region,
            data_region: updatedUser.dataRegion,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[UserRoutes] Error updating region preference:", error);
        const validator = new Validator();
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update user region preference",
  },
  {
    path: "/api/user/cross-region-consent",
    method: "POST",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
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
          dataRegion: string;
          accessRegion: string;
          consented: boolean;
        };

        // Validate regions
        if (
          !isValidRegion(body.dataRegion) ||
          !isValidRegion(body.accessRegion)
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid region" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get region for database connection (use accessRegion to store consent)
        const region = body.accessRegion as any;
        const dbManager = sharedDatabaseConnectionManager;

        // Get user's actual dataRegion
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { dataRegion: true },
            });
          },
          QueryTimeoutPresets.USER_FACING,
        );

        if (!user) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "User not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Verify dataRegion matches
        if (user.dataRegion !== body.dataRegion) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Data region mismatch" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Upsert consent record
        const ipAddress = getIPAddress(request);
        const userAgent = request.headers.get("User-Agent") || undefined;

        const consent = (await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.crossRegionConsent.upsert({
              where: {
                userId_dataRegion_accessRegion: {
                  userId: session.userId,
                  dataRegion: body.dataRegion,
                  accessRegion: body.accessRegion,
                },
              },
              create: {
                userId: session.userId,
                dataRegion: body.dataRegion,
                accessRegion: body.accessRegion,
                consented: body.consented,
                consentedAt: body.consented ? new Date() : null,
                withdrawnAt: body.consented ? null : new Date(),
                ipAddress,
                userAgent,
              },
              update: {
                consented: body.consented,
                consentedAt: body.consented ? new Date() : null,
                withdrawnAt: body.consented ? null : new Date(),
                ipAddress,
                userAgent,
              },
            });
          },
          QueryTimeoutPresets.USER_FACING,
        )) as {
          consented: boolean;
          dataRegion: string;
          accessRegion: string;
        };

        const successResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            consented: consent.consented,
            dataRegion: consent.dataRegion,
            accessRegion: consent.accessRegion,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(successResponse, request, env);
      } catch (error) {
        logger.error(
          "[UserRoutes] Error recording cross-region consent:",
          error,
        );
        const validator = new Validator();
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Record user consent for cross-region data access",
  },
];
