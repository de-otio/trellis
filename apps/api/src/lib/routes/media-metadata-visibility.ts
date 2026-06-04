import { CorsHandler } from "../cors-handler.js";
import { sharedDatabaseConnectionManager } from "../database-connection-manager.js";
import {
  QueryTimeoutPresets,
  withQueryTimeoutAndRetry,
} from "../db-query-helper.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

import { z } from "zod";

const PatchVisibilitySchema = z
  .object({
    metadataVisible: z.boolean().optional(),
    locationVisible: z.boolean().optional(),
  })
  .refine(
    (v) => v.metadataVisible !== undefined || v.locationVisible !== undefined,
    {
      message:
        "At least one of metadataVisible or locationVisible must be provided",
    },
  );

export const mediaMetadataVisibilityRoutes: Route[] = [
  {
    path: "/api/media/:mediaId/metadata-visibility",
    method: "PATCH",
    handler: async (request, env, context) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const sessionManager = new SessionManager();

      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      if (!session) {
        const res = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        );
        return CorsHandler.addCorsHeaders(res, request, env);
      }

      // Rate limiting: 30/60s per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/:mediaId/metadata-visibility",
        30,
        60,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      const mediaId = context.params?.mediaId;
      if (!mediaId) {
        const res = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Invalid request",
            message: "Media ID is required",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(res, request, env);
      }

      let bodyJson: unknown;
      try {
        bodyJson = await request.json();
      } catch {
        const res = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Invalid JSON body" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(res, request, env);
      }

      const parsed = PatchVisibilitySchema.safeParse(bodyJson);
      if (!parsed.success) {
        const res = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Validation error",
            issues: parsed.error.flatten(),
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(res, request, env);
      }

      const { RegionDetector } = await import("../region-detection.js");
      const regionDetector = new RegionDetector(env);
      const region = await regionDetector.detectRegion(
        request,
        undefined,
        undefined,
      );

      // Ownership: reuse MediaHandler.getMediaDetails ownership semantics
      const { MediaHandler } = await import("../media-handler.js");
      const mediaHandler = MediaHandler.create(env);
      await mediaHandler.getMediaDetails(mediaId, session.userId, env, request);

      const updated = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          const dbAny = db as any;
          return await dbAny.mediaFile.update({
            where: { id: mediaId },
            data: {
              ...(parsed.data.metadataVisible !== undefined
                ? { metadataVisible: parsed.data.metadataVisible }
                : {}),
              ...(parsed.data.locationVisible !== undefined
                ? { locationVisible: parsed.data.locationVisible }
                : {}),
            },
            select: {
              id: true,
              metadataVisible: true,
              locationVisible: true,
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "patchMetadataVisibility",
            userId: session.userId,
            mediaId,
          },
        },
      );

      // Audit log best-effort
      try {
        const { TrellisAuditLogger } = await import("../audit-composer.js");
        const auditLogger = new TrellisAuditLogger(env);
        const ipAddress =
          request.headers.get("CF-Connecting-IP") ||
          request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
          undefined;
        const userAgent = request.headers.get("User-Agent") || undefined;

        await auditLogger.log(
          {
            type: "data_update",
            action: "media_metadata_visibility_updated",
            resource: "media",
            resourceId: mediaId,
            userId: session.userId,
            region,
            ipAddress,
            userAgent,
            metadata: {
              mediaId,
              ...parsed.data,
            },
            severity: "low",
            success: true,
          },
          env,
        );
      } catch (e) {
        logger.warn("[Media Visibility] Audit logging failed", {
          error: (e as any)?.message,
        });
      }

      const res = securityHeaders.createSecureResponse(
        JSON.stringify({
          success: true,
          media: updated,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-cache, no-store, must-revalidate", // Don't cache state changes
            pragma: "no-cache",
            expires: "0",
          },
        },
      );
      return CorsHandler.addCorsHeaders(res, request, env);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update per-media metadata/location visibility flags",
  },
];
