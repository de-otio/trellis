/**
 * Route Types
 *
 * Shared types for route definitions used by both core and extensions.
 */

/** Route pattern — exact path, prefix with *, or regex */
export type RoutePattern = string | RegExp;

/** Middleware context passed to middleware functions */
export interface MiddlewareContext {
  request: Request;
  url: URL;
  pathname: string;
  method: string;
  requestContext?: unknown;
}

/** Middleware function — wraps a handler with pre/post processing */
export type Middleware = (
  context: MiddlewareContext,
  next: () => Promise<Response>,
) => Promise<Response>;

/** Route definition */
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

  /** HTTP method(s) - '*' for all methods, or specific method(s) */
  method?: string | string[];

  /** Route handler function */
  handler: (
    request: Request,
    env: unknown,
    context: {
      url: URL;
      pathname: string;
      params: Record<string, string>;
      requestContext?: unknown;
    },
  ) => Promise<Response>;

  /** Middleware to apply (executed in order) */
  middleware?: Middleware[];

  /** Route description (for documentation) */
  description?: string;

  /** API version (for versioning support) */
  version?: string;
}
