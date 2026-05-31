/**
 * Route Helpers
 *
 * Common helper functions for route handlers to reduce duplication.
 */

import type { Env } from "../env.js";
import { CorsHandler } from "./cors-handler.js";
import { getLogger, Logger } from "./logger.js";
import type { TrellisRequestContext } from "./request-context.js";
import { SecurityHeaders } from "./security-headers.js";
import { SessionManager } from "./session-cookie.js";
import { Validator } from "./validation.js";

export interface RouteHandlerContext {
  request: Request;
  env: Env;
  url: URL;
  pathname: string;
  params: Record<string, string>;
  requestContext?: TrellisRequestContext;
}

/**
 * Route Helpers class
 */
export class RouteHelpers {
  private env: Env;
  private sessionManager: SessionManager;
  private securityHeaders: SecurityHeaders;
  private validator: Validator;
  private logger: Logger;

  constructor(env: Env) {
    this.env = env;
    this.sessionManager = new SessionManager();
    this.securityHeaders = new SecurityHeaders(env);
    this.validator = new Validator();
    this.logger = getLogger();
  }

  /**
   * Get session from request (returns null if not authenticated)
   *
   * Supports two authentication strategies:
   * 1. Cognito JWT in Authorization: Bearer header (preferred for new clients)
   * 2. Encrypted session cookie/token (legacy, for existing clients)
   *
   * @param request - Request object
   */
  async getSessionFromRequest(
    request: Request,
  ): Promise<{ userId: string; email: string } | null> {
    // Strategy 1: Try Cognito JWT if Bearer token looks like a JWT (has 2 dots)
    const authHeader = request.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token.split(".").length === 3) {
        try {
          const { verifyCognitoJwt } = await import("./auth/cognito-jwt.js");
          const claims = await verifyCognitoJwt(token);
          this.logger.debug("[RouteHelpers] Cognito JWT verified", {
            sub: claims.sub,
            username: claims.username,
          });
          return {
            userId: claims.sub,
            email: claims.email || claims.username,
          };
        } catch (err) {
          this.logger.debug("[RouteHelpers] Cognito JWT verification failed, falling through to session", err);
          // Fall through to encrypted session approach
        }
      }
    }

    // Strategy 2: Encrypted session cookie/token (legacy)
    const sessionSecret = this.env.SESSION_SECRET;
    return await this.sessionManager.getSession(
      request,
      sessionSecret,
      this.env,
    );
  }

  /**
   * Require authentication - returns error response if not authenticated
   */
  async requireAuth(context: RouteHandlerContext): Promise<Response | null> {
    const session = await this.getSessionFromRequest(context.request);
    if (!session) {
      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    return null;
  }

  /**
   * Wrap handler with error handling and security headers
   */
  async wrapHandler(
    handler: (
      context: RouteHandlerContext & {
        session: { userId: string; email: string };
      },
    ) => Promise<Response>,
    context: RouteHandlerContext,
    requireAuthFlag: boolean = true,
  ): Promise<Response> {
    try {
      // Check authentication if required
      if (requireAuthFlag) {
        const authError = await this.requireAuth(context);
        if (authError) {
          return await CorsHandler.addCorsHeaders(
            authError,
            context.request,
            context.env,
          );
        }
      }

      const session = await this.getSessionFromRequest(context.request);
      if (requireAuthFlag && !session) {
        const errorResponse = this.securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(
          errorResponse,
          context.request,
          context.env,
        );
      }

      const response = await handler({
        ...context,
        session: session!,
      });

      const securedResponse = this.securityHeaders.addSecurityHeaders(response);
      return await CorsHandler.addCorsHeaders(
        securedResponse,
        context.request,
        context.env,
      );
    } catch (error: any) {
      this.logger.error("Route handler error:", error);
      const errorResponse = this.securityHeaders.createSecureResponse(
        JSON.stringify({ error: this.validator.sanitizeError(error) }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      return await CorsHandler.addCorsHeaders(
        errorResponse,
        context.request,
        context.env,
      );
    }
  }

  /**
   * Extract parameter from pathname
   */
  extractPathParam(pathname: string, prefix: string): string | null {
    if (!pathname.startsWith(prefix)) {
      return null;
    }
    const param = pathname.slice(prefix.length);
    return param || null;
  }
}

/**
 * Legacy functions for backward compatibility
 * @deprecated Use new RouteHelpers class instead
 */
export async function getSession(
  request: Request,
  env: Env,
): Promise<{ userId: string; email: string } | null> {
  const helpers = new RouteHelpers(env);
  return helpers.getSessionFromRequest(request);
}

export async function requireAuth(
  context: RouteHandlerContext,
): Promise<Response | null> {
  const helpers = new RouteHelpers(context.env);
  return helpers.requireAuth(context);
}

export async function wrapHandler(
  handler: (
    context: RouteHandlerContext & {
      session: { userId: string; email: string };
    },
  ) => Promise<Response>,
  context: RouteHandlerContext,
  requireAuthFlag: boolean = true,
): Promise<Response> {
  const helpers = new RouteHelpers(context.env);
  return helpers.wrapHandler(handler, context, requireAuthFlag);
}

export function extractPathParam(
  pathname: string,
  prefix: string,
): string | null {
  const helpers = new RouteHelpers({} as Env);
  return helpers.extractPathParam(pathname, prefix);
}
