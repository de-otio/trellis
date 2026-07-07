/**
 * Curated Collections Routes
 *
 * CRUD + item management for Collections (curated profile/entity lists —
 * design: open-social-web/03-collections.md).
 *
 * Exported as `curatedCollectionRoutes` (NOT `collectionRoutes` — that name
 * is already taken by the ActivityPub collection routes in
 * `routes/activitypub/collections.ts`).
 *
 * Auth: mutations require a session and ownership; reads of PUBLIC/UNLISTED
 * collections are anonymous-ok; PRIVATE collections require the owner.
 */

import { CollectionHandler } from "../collection-handler.js";
import { featureToggleMiddleware } from "../feature-gate-middleware.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

const COLLECTION_ID_RE = /^\/api\/collections\/([^/]+)$/;
const COLLECTION_ITEMS_RE = /^\/api\/collections\/([^/]+)\/items$/;
const COLLECTION_ITEM_RE = /^\/api\/collections\/([^/]+)\/items\/([^/]+)$/;
const COLLECTION_REORDER_RE = /^\/api\/collections\/([^/]+)\/items\/reorder$/;

export const curatedCollectionRoutes: Route[] = [
  {
    path: "/api/collections",
    method: "POST",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new CollectionHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const response = await handler.handleCreate(request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      featureToggleMiddleware("collections_enabled"),
    ],
    description: "Create a collection",
  },

  {
    path: "/api/collections/mine",
    method: "GET",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new CollectionHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const response = await handler.handleListMine(request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), featureToggleMiddleware("collections_enabled")],
    description: "List the authenticated user's own collections",
  },

  {
    path: "/api/collections",
    method: "GET",
    handler: async (request, env, { requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const handler = new CollectionHandler();
      const response = await handler.handleListByOwner(request, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), featureToggleMiddleware("collections_enabled")],
    description: "List a user's public collections",
  },

  {
    path: COLLECTION_ID_RE,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new CollectionHandler();
      // Anonymous-ok: session may be null for PUBLIC/UNLISTED reads.
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      const id = pathname.match(COLLECTION_ID_RE)?.[1];
      if (!id) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "Invalid path" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const response = await handler.handleGet(id, request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), featureToggleMiddleware("collections_enabled")],
    description: "Get a collection by id",
  },

  {
    path: COLLECTION_ID_RE,
    method: "PATCH",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new CollectionHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const id = pathname.match(COLLECTION_ID_RE)?.[1];
      if (!id) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "Invalid path" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const response = await handler.handleUpdate(id, request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      featureToggleMiddleware("collections_enabled"),
    ],
    description: "Update a collection",
  },

  {
    path: COLLECTION_ID_RE,
    method: "DELETE",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new CollectionHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const id = pathname.match(COLLECTION_ID_RE)?.[1];
      if (!id) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "Invalid path" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const response = await handler.handleDelete(id, request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      featureToggleMiddleware("collections_enabled"),
    ],
    description: "Delete a collection",
  },

  {
    path: COLLECTION_ITEMS_RE,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new CollectionHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const id = pathname.match(COLLECTION_ITEMS_RE)?.[1];
      if (!id) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "Invalid path" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const response = await handler.handleAddItem(id, request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      featureToggleMiddleware("collections_enabled"),
    ],
    description: "Add an item to a collection",
  },

  {
    path: COLLECTION_REORDER_RE,
    method: "PATCH",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new CollectionHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const id = pathname.match(COLLECTION_REORDER_RE)?.[1];
      if (!id) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "Invalid path" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const response = await handler.handleReorderItems(id, request, session, env, requestContext!);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      featureToggleMiddleware("collections_enabled"),
    ],
    description: "Reorder items within a collection",
  },

  {
    path: COLLECTION_ITEM_RE,
    method: "DELETE",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new CollectionHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const match = pathname.match(COLLECTION_ITEM_RE);
      const id = match?.[1];
      const itemId = match?.[2];
      if (!id || !itemId) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "Invalid path" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const response = await handler.handleRemoveItem(
        id,
        itemId,
        request,
        session,
        env,
        requestContext!,
      );
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      featureToggleMiddleware("collections_enabled"),
    ],
    description: "Remove an item from a collection",
  },
];
