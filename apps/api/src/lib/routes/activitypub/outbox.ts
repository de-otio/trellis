/**
 * ActivityPub Outbox Routes
 *
 * Handles retrieving ActivityPub activities from user outboxes.
 */

import { addCorsHeaders } from "../../../worker.js";
import { getOutboxActivities } from "../../activitypub/listeners/outbox.js";
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

export const outboxRoutes: Route[] = [
  {
    path: "/users/:username/outbox",
    method: "GET",
    middleware: [corsMiddleware()],
    handler: async (request, env, { params }) => {
      const securityHeaders = new SecurityHeaders(env);
      const { username } = params;

      // Use Fedify-based outbox retrieval
      const response = await getOutboxActivities(request, env, username);

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
    description: "Get ActivityPub outbox",
  },
];
