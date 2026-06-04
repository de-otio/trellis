/**
 * Relationship Routes
 *
 * CRUD for scored user relationships (replaces follow/unfollow).
 */

import { RelationshipHandler } from "../relationship-handler.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

export const relationshipRoutes: Route[] = [
  {
    path: "/api/relationships",
    method: "POST",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new RelationshipHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const response = await handler.handleCreateRelationship(request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Create a relationship",
  },

  {
    path: "/api/relationships",
    method: "DELETE",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new RelationshipHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const response = await handler.handleRemoveRelationship(request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Remove a relationship",
  },

  {
    path: "/api/relationships/score",
    method: "PATCH",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new RelationshipHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const response = await handler.handleUpdateScore(request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update relationship manual score",
  },

  {
    path: "/api/relationships/single",
    method: "GET",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new RelationshipHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const response = await handler.handleGetRelationship(request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "Get a single relationship",
  },

  {
    path: "/api/relationships",
    method: "GET",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new RelationshipHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const response = await handler.handleGetRelationships(request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "List relationships",
  },

  {
    path: "/api/relationships/graph",
    method: "GET",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new RelationshipHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const response = await handler.handleGetGraph(request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "Get relationship graph visualization",
  },
];
