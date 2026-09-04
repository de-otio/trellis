/**
 * Moderation feedback + disposition routes (spec 07 §4 / plan 08 Phase 2).
 *
 *   GET  /api/media/:mediaId/disposition  — owner-scoped, coarse verdict
 *   POST /api/moderation/feedback         — consent-gated submit-for-analysis
 *
 * Shell mirrors reports.ts / media.ts: SessionManager auth, per-user KV
 * rate-limit, SecurityHeaders on every response, CORS (+CSRF on the mutating
 * POST). The anti-oracle 404 and the illegal carve-out live in the handlers.
 */

import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { getLogger } from "../logger.js";
import { ModerationDispositionHandler } from "../compliance/moderation-disposition.js";
import { ModerationFeedbackHandler } from "../compliance/moderation-feedback.js";
import type { Route } from "./types.js";

// Owner reads its own disposition often (polling): 60/min/user.
const DISPOSITION_RATE_LIMIT = 60;
const DISPOSITION_RATE_WINDOW_SECONDS = 60;
// Submit-for-analysis is a rarer, heavier action: 20/hour/user (F10 parity).
const FEEDBACK_RATE_LIMIT = 20;
const FEEDBACK_RATE_WINDOW_SECONDS = 3600;

export const moderationFeedbackRoutes: Route[] = [
  {
    path: "/api/media/:mediaId/disposition",
    method: "GET",
    handler: async (request, env, { params, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const rateLimiter = new RateLimiter();

      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env as any,
      );
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/:mediaId/disposition",
        DISPOSITION_RATE_LIMIT,
        DISPOSITION_RATE_WINDOW_SECONDS,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      const mediaId = params?.mediaId;
      if (!mediaId || !requestContext) {
        // No mediaId → the same uniform 404 (never a distinct signal).
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      const handler = new ModerationDispositionHandler();
      const response = await handler.handleGet(
        mediaId,
        session,
        env,
        requestContext,
      );
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description:
      "Owner-scoped media disposition: { status, appealable }. Non-owner and " +
      "not-found return an identical 404 (anti-oracle). Never returns " +
      "category/label/confidence.",
  },

  {
    path: "/api/moderation/feedback",
    method: "POST",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const rateLimiter = new RateLimiter();
      const logger = getLogger();

      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env as any,
      );
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/moderation/feedback",
        FEEDBACK_RATE_LIMIT,
        FEEDBACK_RATE_WINDOW_SECONDS,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      if (!requestContext) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request context not available" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const handler = new ModerationFeedbackHandler();
        const response = await handler.handleSubmit(
          request,
          session,
          env,
          requestContext,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("[Feedback] route failed", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description:
      "Consent-gated submit-for-analysis. consent must be literally true (else " +
      "400). Illegal-class items route to preserve+authority-report and never " +
      "reach the sink; the response is a neutral 202 in all accepted cases.",
  },
];
