/**
 * Route Types
 *
 * Shared types and interfaces for route definitions.
 */

import type { Env } from "../../env.js";
import type { TrellisRequestContext } from "../request-context.js";
import type { Middleware } from "../middleware.js";

/**
 * A route's path pattern: an exact/prefix string or an anchored RegExp.
 * (Historically lived in the now-removed `route-matcher.ts`; the linear
 * matcher it served was superseded by the Hono router in Stream 2.1.)
 */
export type RoutePattern = string | RegExp;

export interface Route {
  /**
   * Route pattern (exact path, prefix with *, or regex)
   * Examples:
   * - '/health' (exact)
   * - '/auth/*' (prefix)
   * - '/api/users/:id' (with parameter)
   * - /^\/api\/posts\/(\d+)$/ (regex)
   */
  path: RoutePattern;

  /**
   * HTTP method(s) - '*' for all methods, or specific method(s)
   */
  method?: string | string[];

  /**
   * Route handler function
   */
  handler: (
    request: Request,
    env: Env,
    context: {
      url: URL;
      pathname: string;
      params: Record<string, string>;
      requestContext?: TrellisRequestContext;
    },
  ) => Promise<Response>;

  /**
   * Middleware to apply (executed in order)
   */
  middleware?: Middleware[];

  /**
   * Route description (for documentation)
   */
  description?: string;

  /**
   * API version (for versioning support)
   */
  version?: string;

  /**
   * Opt-in flag for publication on the public OpenAPI spec
   * (`/openapi.json`) (G4 MEDIUM-3). Default `false` — only routes
   * explicitly marked `publicSpec: true` appear in the document. The
   * agent-discovery surface and the federation management routes are
   * expected to set this; non-federation routes (posts, comments,
   * media, ActivityPub, etc.) are excluded from the public spec.
   */
  publicSpec?: boolean;
}
