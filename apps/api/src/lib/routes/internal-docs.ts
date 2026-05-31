/**
 * Internal Docs Routes
 */

import { addCorsHeaders } from "../../worker.js";
import { InternalDocsHandler } from "../internal-docs-handler.js";
import { corsMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import type { Route } from "./types.js";

export const internaldocsRoutes: Route[] = [
  {
    path: "/api/internal/docs/*",
    method: "*",
    handler: async (request, env, { pathname }) => {
      const docsHandler = new InternalDocsHandler();
      const securityHeaders = new SecurityHeaders(env);

      if (
        pathname === "/api/internal/docs/navigation" &&
        request.method === "GET"
      ) {
        const response = await docsHandler.handleGetNavigation(request, env);
        return addCorsHeaders(response, request, env);
      }

      if (
        pathname === "/api/internal/docs/dashboard" &&
        request.method === "GET"
      ) {
        const response = await docsHandler.handleGetDashboardDocs(request, env);
        return addCorsHeaders(response, request, env);
      }

      if (pathname === "/api/internal/docs" && request.method === "GET") {
        const response = await docsHandler.handleGetDocsList(request, env);
        return addCorsHeaders(response, request, env);
      }

      const filenameMatch = pathname.match(/^\/api\/internal\/docs\/(.+)$/);
      if (filenameMatch && request.method === "GET") {
        const response = await docsHandler.handleGetDoc(
          request,
          env,
          filenameMatch[1],
        );
        return addCorsHeaders(response, request, env);
      }

      const errorResponse = securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
      return addCorsHeaders(errorResponse, request, env);
    },
    middleware: [corsMiddleware()],
    description: "Internal documentation routes",
  },
];
