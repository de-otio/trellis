/**
 * Orphaned Media Routes
 *
 * Handles marking media as orphaned for optimistic image uploads.
 */

import { CorsHandler } from "../cors-handler.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { OrphanedMediaHandler } from "../orphaned-media-handler.js";
import type { Route } from "./types.js";

/**
 * POST /api/media/:id/mark-orphaned
 * Mark a media file as orphaned
 */
const markMediaOrphaned: Route = {
  method: "POST",
  path: "/api/media/:id/mark-orphaned",
  handler: async (request, env, context) => {
    const logger = getLogger();
    const securityHeaders = new SecurityHeaders(env);
    const sessionManager = new SessionManager();
    const orphanedMediaHandler = new OrphanedMediaHandler(env);

    try {
      // Authenticate user
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      if (!session?.userId) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Get media ID from params
      const mediaId = context.params?.id;
      if (!mediaId) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Media ID is required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Detect region
      const { RegionDetector } = await import("../region-detection.js");
      const regionDetector = new RegionDetector(env);
      const region = await regionDetector.detectRegion(
        request,
        undefined,
        undefined,
      );

      // Mark media as orphaned with timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Request timeout")), 5000);
      });

      const resultPromise = orphanedMediaHandler.markMediaAsOrphaned(
        mediaId,
        session.userId,
        region,
        env,
      );

      const result = await Promise.race([resultPromise, timeoutPromise]);

      if (!result.success) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: result.error }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      const response = securityHeaders.createSecureResponse(
        JSON.stringify(result),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      return CorsHandler.addCorsHeaders(response, request, env);
    } catch (error) {
      if (error instanceof Error && error.message === "Request timeout") {
        logger.warn("Mark media as orphaned request timeout", {
          mediaId: context.params?.id,
        });
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request timeout" }),
          { status: 504, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      logger.error("Failed to mark media as orphaned", {
        mediaId: context.params?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      const errorResponse = securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      return CorsHandler.addCorsHeaders(errorResponse, request, env);
    }
  },
  middleware: [corsMiddleware(), csrfMiddleware()],
  description: "Mark a media file as orphaned",
};

export const orphanedMediaRoutes: Route[] = [markMediaOrphaned];
