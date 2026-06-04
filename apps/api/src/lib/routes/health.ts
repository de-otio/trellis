/**
 * Health and Configuration Routes
 */

import { CSRFProtection } from "../csrf.js";
import { CostAccumulator } from "../cost-accumulator.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware } from "../middleware.js";
import { OpenAiBudget } from "../openai-budget.js";
import { addRegionHeadersAsync } from "../request-context.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

export const healthRoutes: Route[] = [
  // Health check
  {
    path: "/health",
    method: "GET",
    handler: async (request, env, { requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);

      // Lightweight cost alert flag (no auth required, no dollar amounts)
      let costAlert = false;
      try {
        const budgetStatus = await new OpenAiBudget({
          enabled: (env as any).OPENAI_BUDGET_ENABLED !== "false",
          maxRequestsPerHour: parseInt((env as any).OPENAI_BUDGET_HOURLY_MAX || "500", 10),
          maxRequestsPerDay: parseInt((env as any).OPENAI_BUDGET_DAILY_MAX || "5000", 10),
        }).getStatus();
        costAlert = budgetStatus.exceeded;
      } catch {
        // Fail-open: if cost check fails, don't flag
      }

      const response = securityHeaders.createSecureResponse(
        JSON.stringify({ ok: true, region: requestContext?.region, costAlert }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );

      if (requestContext) {
        return addRegionHeadersAsync(response, requestContext);
      }
      return response;
    },
    description: "Health check endpoint",
  },

  // Region configuration
  {
    path: "/api/config",
    method: "GET",
    handler: async (request, env, { requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);

      if (!requestContext) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request context not available" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      const response = securityHeaders.createSecureResponse(
        JSON.stringify({
          region: requestContext.region,
          features: requestContext.config.features,
          endpoints: requestContext.config.endpoints,
          timeouts: requestContext.config.timeouts,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );

      return addRegionHeadersAsync(response, requestContext);
    },
    middleware: [corsMiddleware()],
    description: "Get region configuration and feature flags",
  },

  // CSRF token generation endpoint
  {
    path: "/api/csrf-token",
    method: "GET",
    handler: async (request, env, { url }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);

      // Get session to link token to user
      const sessionSecret = env.SESSION_SECRET;
      const logger = getLogger();

      const authHeader = request.headers.get("Authorization");
      logger.debug("[CSRF Token] Attempting to get session", {
        secretLength: sessionSecret.length,
        hasCookie: !!request.headers.get("Cookie"),
        hasAuthHeader: !!authHeader,
        cookieHeader:
          request.headers.get("Cookie")?.substring(0, 100) || "none",
        authHeaderPreview: authHeader?.substring(0, 50) || "none",
      });

      const session = await sessionManager.getSession(request, sessionSecret, env);

      if (!session) {
        logger.warn("[CSRF Token] Unauthorized request - no valid session", {
          secretLength: sessionSecret.length,
          cookieHeader:
            request.headers.get("Cookie")?.substring(0, 100) || "none",
        });
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        // Generate new CSRF token
        const token = CSRFProtection.generateToken();

        // Store token in session (Double Submit Cookie pattern)
        const updatedSession = CSRFProtection.storeTokenInSession(
          token,
          session,
        );

        // Encrypt updated session to get new token (for Authorization header approach)
        // This ensures the frontend can update its localStorage token with the CSRF token included
        const sessionSecret = env.SESSION_SECRET;
        const encryptedSessionToken = await sessionManager.encryptSession(
          JSON.stringify(updatedSession),
          sessionSecret,
          env.SESSION_SALT,
        );

        // Update session cookie with new token
        // Cookie domain logic - simplified for health check
        const cookieDomain = undefined; // Health check doesn't need cookie domain
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            token,
            // Include updated session token for Authorization header approach
            // Frontend should update localStorage with this token
            sessionToken: encryptedSessionToken,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );

        // Set updated session cookie
        const responseWithSession = await sessionManager.setSession(
          response,
          updatedSession,
          sessionSecret,
          cookieDomain,
          env,
        );

        return responseWithSession;
      } catch (error) {
        getLogger().error("Error generating CSRF token:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to generate CSRF token" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get CSRF token for authenticated requests",
  },
];
