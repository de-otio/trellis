/**
 * Upload Session Routes
 *
 * Handles upload session management for optimistic image uploads.
 * Provides endpoints for creating, managing, and completing upload sessions.
 */

import { CorsHandler } from "../cors-handler.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { UploadSessionHandler } from "../upload-session-handler.js";
import type { Route } from "./types.js";

/**
 * POST /api/upload-sessions
 * Create a new upload session
 */
const createUploadSession: Route = {
  method: "POST",
  path: "/api/upload-sessions",
  handler: async (request, env, context) => {
    const logger = getLogger();
    const securityHeaders = new SecurityHeaders(env);
    const sessionManager = new SessionManager();
    const rateLimiter = new RateLimiter();
    const uploadSessionHandler = new UploadSessionHandler(env);

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

      // Rate limiting: 10 sessions per hour per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/upload-sessions",
        10, // 10 requests
        3600, // per hour
        session.userId,
      );

      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      // Detect region
      const { RegionDetector } = await import("../region-detection.js");
      const regionDetector = new RegionDetector(env);
      const region = await regionDetector.detectRegion(
        request,
        undefined,
        undefined,
      );

      // Create upload session
      const result = await uploadSessionHandler.createSession(
        session.userId,
        region,
        env,
      );

      const response = securityHeaders.createSecureResponse(
        JSON.stringify(result),
        { status: 201, headers: { "content-type": "application/json" } },
      );
      return CorsHandler.addCorsHeaders(response, request, env);
    } catch (error) {
      logger.error("Failed to create upload session", {
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
  description: "Create a new upload session for optimistic image uploads",
};

/**
 * POST /api/upload-sessions/:id/media
 * Add media to an upload session
 */
const addMediaToSession: Route = {
  method: "POST",
  path: "/api/upload-sessions/:id/media",
  handler: async (request, env, context) => {
    const logger = getLogger();
    const securityHeaders = new SecurityHeaders(env);
    const sessionManager = new SessionManager();
    const uploadSessionHandler = new UploadSessionHandler(env);

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

      // Get session ID from params
      const sessionId = context.params?.id;
      if (!sessionId) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Session ID is required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Parse request body
      let body: any;
      try {
        body = await request.json();
      } catch {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Invalid JSON body" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      const { mediaId } = body;
      if (!mediaId) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "mediaId is required" }),
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

      // Add media to session
      const result = await uploadSessionHandler.addMediaToSession(
        sessionId,
        session.userId,
        mediaId,
        region,
        env,
      );

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
      logger.error("Failed to add media to upload session", {
        sessionId: context.params?.id,
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
  description: "Add media to an upload session",
};

/**
 * POST /api/upload-sessions/:id/complete
 * Complete an upload session
 */
const completeUploadSession: Route = {
  method: "POST",
  path: "/api/upload-sessions/:id/complete",
  handler: async (request, env, context) => {
    const logger = getLogger();
    const securityHeaders = new SecurityHeaders(env);
    const sessionManager = new SessionManager();
    const uploadSessionHandler = new UploadSessionHandler(env);

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

      // Get session ID from params
      const sessionId = context.params?.id;
      if (!sessionId) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Session ID is required" }),
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

      // Complete session
      const result = await uploadSessionHandler.completeSession(
        sessionId,
        session.userId,
        region,
        env,
      );

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
      logger.error("Failed to complete upload session", {
        sessionId: context.params?.id,
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
  description: "Complete an upload session and mark all media as attached",
};

/**
 * POST /api/upload-sessions/:id/abandon
 * Abandon an upload session
 */
const abandonUploadSession: Route = {
  method: "POST",
  path: "/api/upload-sessions/:id/abandon",
  handler: async (request, env, context) => {
    const logger = getLogger();
    const securityHeaders = new SecurityHeaders(env);
    const sessionManager = new SessionManager();
    const uploadSessionHandler = new UploadSessionHandler(env);

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

      // Get session ID from params
      const sessionId = context.params?.id;
      if (!sessionId) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Session ID is required" }),
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

      // Abandon session
      const result = await uploadSessionHandler.abandonSession(
        sessionId,
        session.userId,
        region,
        env,
      );

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
      logger.error("Failed to abandon upload session", {
        sessionId: context.params?.id,
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
  description: "Abandon an upload session and mark all media as orphaned",
};

export const uploadSessionRoutes: Route[] = [
  createUploadSession,
  addMediaToSession,
  completeUploadSession,
  abandonUploadSession,
];
