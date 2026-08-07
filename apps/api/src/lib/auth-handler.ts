/**
 * Auth Handler
 *
 * Handles authentication routes including magic link, SSO, and session management.
 *
 * PREPARATORY: Checks feature flags for authentication methods.
 */

import type { Env } from "../env.js";
import { CorsHandler } from "./cors-handler.js";
import { handleMagicLinkInitiate } from "./identity/magic-link-initiate.js";
import { getLogger, Logger } from "./logger.js";
import type { RateLimiter } from "./rate-limit.js";
import type { TrellisRequestContext } from "./request-context.js";
import { SecurityHeaders } from "./security-headers.js";

export class AuthHandler {
  /**
   * Auth routes — authentication is delegated to AWS Cognito + Amplify SDK.
   * Only the reCAPTCHA site key endpoint remains active.
   */
  static async handleAuthRoutes(
    request: Request,
    env: Env,
    url: URL,
    rateLimiter: RateLimiter,
    securityHeaders: SecurityHeaders,
    _requestContext?: TrellisRequestContext,
  ): Promise<Response> {
    const pathname = url.pathname;

    // Get allowed origin for CORS
    const allowedOrigin = CorsHandler.getAllowedOrigin(request, env);

    // CORS headers for auth endpoints
    // Note: Access-Control-Allow-Origin must be the exact origin (not '*') when using credentials
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-CSRF-Token, X-Retry-Count",
      "Access-Control-Allow-Credentials": "true",
    };

    // Only set Access-Control-Allow-Origin if we have an allowed origin
    // Browsers require exact origin match when credentials are involved
    if (allowedOrigin) {
      corsHeaders["Access-Control-Allow-Origin"] = allowedOrigin;
    }

    // Handle OPTIONS requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      // WS-3.3: provider-neutral magic-link initiation through the
      // IdentityProviderPort (IDENTITY_PROVIDER flag, default cognito).
      // Per-email 5/900s rate limit + enumeration stance live inside the
      // handler (inherited from G2 — see magic-link-initiate.ts).
      if (pathname === "/auth/magic-link" && request.method === "POST") {
        const response = await handleMagicLinkInitiate(
          request,
          env,
          rateLimiter,
          corsHeaders,
        );
        return securityHeaders.addSecurityHeaders(response);
      }

      // Invitation-gated registration. Only meaningful on a brokered IdP:
      // the Cognito path registers client-side through Amplify with the
      // PreSignUp trigger running the same gate, and this returns 501 there.
      // See identity/register.ts for why it must be a server endpoint.
      if (pathname === "/auth/register" && request.method === "POST") {
        const { handleRegister } = await import("./identity/register.js");
        const response = await handleRegister(request, env, rateLimiter, corsHeaders);
        return securityHeaders.addSecurityHeaders(response);
      }

      // Get reCAPTCHA site key (public endpoint)
      if (pathname === "/auth/recaptcha-site-key" && request.method === "GET") {
        const siteKey = env.RECAPTCHA_SITE_KEY || "";
        const response = new Response(JSON.stringify({ siteKey }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...corsHeaders,
          },
        });
        return securityHeaders.addSecurityHeaders(response);
      }

      // Authentication is handled by AWS Cognito + Amplify SDK in the Flutter client.
      // Legacy Supabase auth routes are no longer available.
      const deprecated = new Response(
        JSON.stringify({
          error: "This auth endpoint has been deprecated.",
          message:
            "Authentication is handled by AWS Cognito. Use the Amplify SDK in the client app.",
        }),
        { status: 410, headers: { "content-type": "application/json", ...corsHeaders } },
      );
      return securityHeaders.addSecurityHeaders(deprecated);
    } catch (error) {
      getLogger().error("Auth route error:", error);
      const errorResponse = securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Internal server error" }),
        {
          status: 500,
          headers: { "content-type": "application/json", ...corsHeaders },
        },
      );
      Object.entries(corsHeaders).forEach(([key, value]) => {
        errorResponse.headers.set(key, value);
      });
      return errorResponse;
    }
  }
}
