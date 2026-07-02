/**
 * Tenant classification routes.
 *
 *   PUT    /api/tenants/:id/classification           — create/update classification (ADMIN+)
 *   GET    /api/tenants/:id/classification           — read classification + tags (any member)
 *   POST   /api/tenants/:id/classification/tags      — add a category tag (ADMIN+)
 *   DELETE /api/tenants/:id/classification/tags/:tagId — remove a tag (ADMIN+)
 *
 * Cross-tenant isolation: every route delegates to ClassificationHandler methods
 * which call `requireActiveTenant` (mutations) or `requireOwnTenant` (reads)
 * before any capability check or DB work.
 *
 * Authentication: required (MVP). Unauthenticated requests → 401.
 */

import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { ClassificationHandler } from "../tenant/classification-handler.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

const CLASSIFICATION_BASE = /^\/api\/tenants\/([^/]+)\/classification$/;
const CLASSIFICATION_TAGS = /^\/api\/tenants\/([^/]+)\/classification\/tags$/;
const CLASSIFICATION_TAG_ITEM = /^\/api\/tenants\/([^/]+)\/classification\/tags\/([^/]+)$/;

export const tenantClassificationRoutes: Route[] = [
  {
    path: CLASSIFICATION_BASE,
    method: "PUT",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = pathname.match(CLASSIFICATION_BASE)?.[1] ?? "";
      const handler = new ClassificationHandler();
      const response = await handler.handleUpsert(tenantId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Create or update tenant classification (ADMIN+, classification.edit capability required)",
  },

  {
    path: CLASSIFICATION_BASE,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = pathname.match(CLASSIFICATION_BASE)?.[1] ?? "";
      const handler = new ClassificationHandler();
      const response = await handler.handleGet(tenantId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "Get tenant classification and tags (any tenant member)",
  },

  {
    path: CLASSIFICATION_TAGS,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = pathname.match(CLASSIFICATION_TAGS)?.[1] ?? "";
      const handler = new ClassificationHandler();
      const response = await handler.handleAddTag(tenantId, request, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Add a classification tag (ADMIN+, classification.edit capability required)",
  },

  {
    path: CLASSIFICATION_TAG_ITEM,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const match = pathname.match(CLASSIFICATION_TAG_ITEM);
      const tenantId = match?.[1] ?? "";
      const tagId = match?.[2] ?? "";
      const handler = new ClassificationHandler();
      const response = await handler.handleRemoveTag(tenantId, tagId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Remove a classification tag (ADMIN+, classification.edit capability required)",
  },
];
