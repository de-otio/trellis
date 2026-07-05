/**
 * Upload Session Routes
 *
 * Two session kinds share these endpoints (see prisma UploadSession):
 *
 *  - LEGACY (no/empty JSON body on create): the original optimistic
 *    image-upload session tracking mediaIds uploaded through the proxied
 *    POST /api/media path.
 *
 *  - PRESIGNED (T14; body carries {mimeType, sizeBytes}): direct-to-S3
 *    video/audio upload. Create returns a presigned S3 POST grant
 *    (content-length-range byte rail, exact key + Content-Type pins); the
 *    client uploads straight to S3; complete verifies the bytes and flips the
 *    session/media state. The FROZEN client contract lives in
 *    doc/media/presigned-upload-contract.md.
 */

import { CorsHandler } from "../cors-handler.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { UploadSessionHandler } from "../upload-session-handler.js";
import { PresignedUploadHandler } from "../presigned-upload-handler.js";
import type { Route } from "./types.js";

/** JSON + CORS + security-header response helper shared by these routes. */
function jsonResponse(
  securityHeaders: SecurityHeaders,
  request: Request,
  env: any,
  body: unknown,
  status: number,
): Promise<Response> {
  const response = securityHeaders.createSecureResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  return CorsHandler.addCorsHeaders(response, request, env);
}

/**
 * POST /api/upload-sessions
 * Create a new upload session (legacy optimistic, or presigned direct-to-S3
 * when the JSON body declares {mimeType, sizeBytes}).
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
        return jsonResponse(
          securityHeaders,
          request,
          env,
          { error: "Unauthorized" },
          401,
        );
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

      // Kind discrimination: a JSON body declaring the upload selects the
      // presigned direct-to-S3 flow; no/empty body is the legacy flow.
      let body: unknown = null;
      try {
        const text = await request.text();
        body = text ? JSON.parse(text) : null;
      } catch {
        return jsonResponse(
          securityHeaders,
          request,
          env,
          { error: "Invalid JSON body" },
          400,
        );
      }

      const declared =
        body !== null && typeof body === "object"
          ? (body as { mimeType?: unknown; sizeBytes?: unknown })
          : null;
      if (declared && (declared.mimeType !== undefined || declared.sizeBytes !== undefined)) {
        // ── Presigned flow ──
        if (
          typeof declared.mimeType !== "string" ||
          typeof declared.sizeBytes !== "number"
        ) {
          return jsonResponse(
            securityHeaders,
            request,
            env,
            {
              error: "Invalid request",
              message:
                "A presigned upload session requires mimeType (string) and sizeBytes (number).",
            },
            400,
          );
        }
        const presignedHandler = new PresignedUploadHandler(env);
        const result = await presignedHandler.createSession(
          session.userId,
          region,
          env,
          { mimeType: declared.mimeType, sizeBytes: declared.sizeBytes },
        );
        if (!result.ok) {
          return jsonResponse(
            securityHeaders,
            request,
            env,
            { error: result.error, message: result.message },
            result.status,
          );
        }
        return jsonResponse(securityHeaders, request, env, result, 201);
      }

      // ── Legacy flow ──
      const result = await uploadSessionHandler.createSession(
        session.userId,
        region,
        env,
      );

      return jsonResponse(securityHeaders, request, env, result, 201);
    } catch (error) {
      logger.error("Failed to create upload session", {
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse(
        securityHeaders,
        request,
        env,
        { error: "Internal server error" },
        500,
      );
    }
  },
  middleware: [corsMiddleware(), csrfMiddleware()],
  description:
    "Create an upload session (legacy optimistic, or presigned direct-to-S3 with {mimeType, sizeBytes})",
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

      // Presigned sessions first: the handler's lookup is scoped to
      // (id, userId, kind="presigned"), so a legacy session id (or another
      // user's session) misses with 404 and falls through to the legacy path.
      const presignedHandler = new PresignedUploadHandler(env);
      const presignedResult = await presignedHandler.completeSession(
        sessionId,
        session.userId,
        region,
        env,
      );
      if (presignedResult.ok) {
        return jsonResponse(securityHeaders, request, env, presignedResult, 200);
      }
      if (presignedResult.status !== 404) {
        return jsonResponse(
          securityHeaders,
          request,
          env,
          { error: presignedResult.error, message: presignedResult.message },
          presignedResult.status,
        );
      }

      // Complete session (legacy)
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

      // Presigned sessions first (same 404-falls-through dispatch as complete).
      const presignedHandler = new PresignedUploadHandler(env);
      const presignedResult = await presignedHandler.abandonSession(
        sessionId,
        session.userId,
        region,
        env,
      );
      if (presignedResult.ok) {
        return jsonResponse(securityHeaders, request, env, presignedResult, 200);
      }
      if (presignedResult.status !== 404) {
        return jsonResponse(
          securityHeaders,
          request,
          env,
          { error: presignedResult.error, message: presignedResult.message },
          presignedResult.status,
        );
      }

      // Abandon session (legacy)
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
