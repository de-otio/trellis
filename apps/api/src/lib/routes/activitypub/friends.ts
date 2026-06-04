/**
 * ActivityPub Friends Routes
 *
 * Handles friends collection endpoint for ActivityPub.
 */

import { addCorsHeaders } from "../../../worker.js";
import { getFriendsCollection } from "../../activitypub/listeners/friends-collection.js";
import { corsMiddleware } from "../../middleware.js";
import { SecurityHeaders } from "../../security-headers.js";
import type { Route } from "../types.js";

export interface ActivityPubEnv {
  DATABASE_URL?: string;
  HYPERDRIVE?: any;
  LOG_LEVEL?: string;
  DEFAULT_REGION?: string;
  ACTIVITYPUB_BASE_URL?: string;
}

export const friendsRoutes: Route[] = [
  {
    path: "/users/:username/friends",
    method: "GET",
    middleware: [corsMiddleware()],
    handler: async (request, env, { params }) => {
      const securityHeaders = new SecurityHeaders(env);
      const { username } = params;

      // Use Fedify-based friends collection retrieval
      const response = await getFriendsCollection(request, env, username);

      // Add security headers and CORS
      const secureResponse = securityHeaders.createSecureResponse(
        await response.text(),
        {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        },
      );
      return addCorsHeaders(secureResponse, request, env);
    },
    description: "Get ActivityPub friends collection",
  },
];
