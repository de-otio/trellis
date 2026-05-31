/**
 * ActivityPub WebFinger Routes
 *
 * Routes for WebFinger protocol (actor discovery).
 */

import type { Route } from "../types.js";
import { corsMiddleware } from "../../middleware.js";
import { handleWebFinger } from "../../activitypub/webfinger/server.js";

/**
 * ActivityPub WebFinger routes
 */
export const webfingerRoutes: Route[] = [
  /**
   * GET /.well-known/webfinger
   * WebFinger endpoint for actor discovery
   */
  {
    path: "/.well-known/webfinger",
    method: "GET",
    handler: handleWebFinger,
    middleware: [corsMiddleware()],
    description: "WebFinger endpoint for ActivityPub actor discovery",
  },
];
