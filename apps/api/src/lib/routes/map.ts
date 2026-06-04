/**
 * Map Routes
 */

import { corsMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import type { Route } from "./types.js";

export const mapRoutes: Route[] = [
  {
    path: "/api/map/nearby",
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      return securityHeaders.createSecureResponse(
        JSON.stringify({ posts: [], error: "Not implemented - Milestone E" }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
    },
    middleware: [corsMiddleware()],
    description: "Get nearby posts on map",
  },
];
