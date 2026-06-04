/**
 * Entities Routes
 *
 * Replaces dogs routes for white-label support.
 */

import { CorsHandler } from "../cors-handler.js";
import { DataRouter } from "../data-router.js";
import { getWrappedDatabase } from "../database-wrapper-helper.js";
import { EntityHandler } from "../entity-handler.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { createRequestContext } from "../request-context.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { TaxonomyHandler } from "../taxonomy-handler.js";
import { createTaxonomyHandler } from "../taxonomy-handler-factory.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { Validator } from "../validation.js";
import { ValidationError } from "../validation/validate-request.js";
import type { Route } from "./types.js";

export const entitiesRoutes: Route[] = [
  {
    path: "/api/entities",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const entityHandler = new EntityHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      try {
        const requestContext = await createRequestContext(request, env);
        const response = await entityHandler.listEntityProfiles(
          session,
          env,
          request,
          requestContext,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error listing entities:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        // Ensure CORS headers are added to error responses
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "List entity profiles",
  },

  {
    path: "/api/entities",
    method: "POST",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const validator = new Validator();
      const entityHandler = new EntityHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/entities",
        25,
        60,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      console.error("[ROUTES/ENTITIES] About to call createEntityProfile", {
        userId: session.userId,
        email: session.email,
      });
      try {
        const response = await entityHandler.createEntityProfile(
          request,
          session,
          env,
        );
        console.error("[ROUTES/ENTITIES] createEntityProfile returned", {
          status: response.status,
        });
        return securityHeaders.addSecurityHeaders(response);
      } catch (error: any) {
        logger.error("Error creating entity:", error);

        // Handle validation errors with proper status code (400)
        if (error instanceof ValidationError) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify(error.toResponse()),
            {
              status: error.getStatusCode(),
              headers: { "content-type": "application/json" },
            },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // For other errors, return 500
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        // Ensure CORS headers are added to error responses
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Create entity profile",
  },

  {
    path: /^\/api\/entities\/([^/]+)$/,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const entityHandler = new EntityHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      const entityId = pathname.split("/api/entities/")[1];
      try {
        const response = await entityHandler.getEntityProfile(
          entityId,
          session,
          env,
          request,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error getting entity:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        // Ensure CORS headers are added to error responses
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "Get entity profile",
  },

  {
    path: /^\/api\/entities\/([^/]+)$/,
    method: "PUT",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const entityHandler = new EntityHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      const entityId = pathname.split("/api/entities/")[1];
      try {
        const response = await entityHandler.updateEntityProfile(
          entityId,
          request,
          session,
          env,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error updating entity:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update entity profile",
  },

  {
    path: /^\/api\/entities\/([^/]+)$/,
    method: "PATCH",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const entityHandler = new EntityHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      const entityId = pathname.split("/api/entities/")[1];
      try {
        const response = await entityHandler.updateEntityProfile(
          entityId,
          request,
          session,
          env,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error updating entity:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update entity profile (partial)",
  },

  {
    path: /^\/api\/entities\/([^/]+)$/,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const entityHandler = new EntityHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      const entityId = pathname.split("/api/entities/")[1];
      try {
        const response = await entityHandler.deleteEntityProfile(
          entityId,
          session,
          env,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error deleting entity:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Delete entity profile",
  },

  // Entity Taxonomy Tags
  {
    path: /^\/api\/entities\/([^/]+)\/taxonomy-tags$/,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const validator = new Validator();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Apply rate limiting: 100 tag operations per hour per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/entities/:entityId/taxonomy-tags",
        100,
        3600,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const entityId = pathname
          .split("/api/entities/")[1]
          .split("/taxonomy-tags")[0];

        // Get tenant ID from authenticated JWT
        const auth = await authMiddleware(request, env);
        if (!auth || !auth.activeTenantId) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }
        const tenantId = auth.activeTenantId;

        // Get region and database
        const requestContext = await createRequestContext(request, env);
        const region = requestContext.region || "US";
        const db = DataRouter.getDatabaseForRegion(
          region,
          env,
          request,
          session.userId,
        );

        // Verify entity exists in caller's tenant and user owns it
        const entity = await (db.entity.findFirst({
          where: { id: entityId, tenantId },
          select: { id: true, owners: { select: { userId: true, role: true }, where: { status: 'ACTIVE' } } },
        }) as unknown as Promise<{ id: string; owners: { userId: string; role: string }[] } | null>);

        if (!entity) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Entity not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        if (!entity.owners?.some((o: any) => o.userId === session.userId)) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Check request body size (max 10KB for tag operations)
        const contentLength = request.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > 10 * 1024) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Request body too large",
              message: "Maximum request body size is 10KB",
            }),
            { status: 413, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Parse request body
        const body = (await request.json()) as { taxonIds?: string[] };
        if (!body.taxonIds || !Array.isArray(body.taxonIds)) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "taxonIds array is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Validate taxon IDs format
        const taxonIdPattern = /^[a-z-]+:[a-z-]+:[a-z-]+$/;
        const invalidTaxonIds = body.taxonIds.filter(
          (id: string) => typeof id !== "string" || !taxonIdPattern.test(id),
        );
        if (invalidTaxonIds.length > 0) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid taxon ID format",
              invalidTaxonIds,
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Get database and taxonomy handler
        const wrappedDb = getWrappedDatabase(region, env, request);
        const taxonomyHandler = new TaxonomyHandler(
          wrappedDb,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );

        // Add taxonomy tags
        await taxonomyHandler.addEntityTaxonomyTags(
          entityId,
          body.taxonIds as string[],
        );

        // Get updated tags
        const tags = await taxonomyHandler.getEntityTaxonomyTags(entityId);

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            tags: tags.map((t) => ({
              taxonId: t.taxonId,
              displayName: t.displayName,
              description: t.description,
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("Error adding taxonomy tags to entity:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Add taxonomy tags to entity",
  },

  {
    path: /^\/api\/entities\/([^/]+)\/taxonomy-tags$/,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const validator = new Validator();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Apply rate limiting
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/entities/:entityId/taxonomy-tags",
        100,
        3600,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const entityId = pathname
          .split("/api/entities/")[1]
          .split("/taxonomy-tags")[0];

        // Get tenant ID from authenticated JWT
        const auth = await authMiddleware(request, env);
        if (!auth || !auth.activeTenantId) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }
        const tenantId = auth.activeTenantId;

        // Get region and database
        const requestContext = await createRequestContext(request, env);
        const region = requestContext.region || "US";
        const db = DataRouter.getDatabaseForRegion(
          region,
          env,
          request,
          session.userId,
        );

        // Verify entity exists in caller's tenant and user owns it
        const entity = await (db.entity.findFirst({
          where: { id: entityId, tenantId },
          select: { id: true, owners: { select: { userId: true, role: true }, where: { status: 'ACTIVE' } } },
        }) as unknown as Promise<{ id: string; owners: { userId: string; role: string }[] } | null>);

        if (!entity) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Entity not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        if (!entity.owners?.some((o: any) => o.userId === session.userId)) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Check request body size (max 10KB for tag operations)
        const contentLength = request.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > 10 * 1024) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Request body too large",
              message: "Maximum request body size is 10KB",
            }),
            { status: 413, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Parse request body
        const body = (await request.json()) as { taxonIds?: string[] };
        if (!body.taxonIds || !Array.isArray(body.taxonIds)) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "taxonIds array is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Get database and taxonomy handler
        const wrappedDb = getWrappedDatabase(region, env, request);
        const taxonomyHandler = new TaxonomyHandler(
          wrappedDb,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );

        // Remove taxonomy tags
        await taxonomyHandler.removeEntityTaxonomyTags(
          entityId,
          body.taxonIds as string[],
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ success: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("Error removing taxonomy tags from entity:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Remove taxonomy tags from entity",
  },

  {
    path: /^\/api\/entities\/([^/]+)\/taxonomy-tags$/,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      try {
        const sessionManager = new SessionManager();
        const securityHeaders = new SecurityHeaders(env);
        const logger = getLogger();
        const validator = new Validator();
        const sessionSecret = env.SESSION_SECRET;
        const session = await sessionManager.getSession(request, sessionSecret, env);

        // Tenant-scoped resource — require auth.
        const auth = await authMiddleware(request, env);
        if (!auth || !auth.activeTenantId) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }
        const tenantId = auth.activeTenantId;

        const entityId = pathname
          .split("/api/entities/")[1]
          .split("/taxonomy-tags")[0];

        // Get region and database
        const requestContext = await createRequestContext(request, env);
        const region = requestContext.region || "US";
        const db = DataRouter.getDatabaseForRegion(
          region,
          env,
          request,
          session?.userId,
        );

        // Verify entity exists in caller's tenant
        const entity = await (db.entity.findFirst({
          where: { id: entityId, tenantId },
          select: { id: true },
        }) as unknown as Promise<{ id: string } | null>);

        if (!entity) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Entity not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Get taxonomy handler
        const taxonomyHandler = await createTaxonomyHandler(
          request,
          env,
          region,
        );
        if (!taxonomyHandler) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Get taxonomy tags
        const tags = await taxonomyHandler.getEntityTaxonomyTags(entityId);

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            tags: tags.map((t) => ({
              taxonId: t.taxonId,
              displayName: t.displayName,
              description: t.description,
              category: t.category
                ? {
                    code: t.category.code,
                    displayName: t.category.displayName,
                    dimension: t.category.dimension
                      ? {
                          code: t.category.dimension.code,
                          displayName: t.category.dimension.displayName,
                        }
                      : null,
                  }
                : null,
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return await CorsHandler.addCorsHeaders(response, request, env);
      } catch (error: any) {
        try {
          // Create instances in catch block in case they weren't created
          const logger = getLogger();
          const securityHeaders = new SecurityHeaders(env);
          const validator = new Validator();
          // Log the actual error for debugging
          const errorMessage = error?.message || String(error);
          console.error("[HANDLER ERROR]", errorMessage, error?.stack);
          logger.error("Error getting taxonomy tags for entity:", error);
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: errorMessage }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
          return await CorsHandler.addCorsHeaders(errorResponse, request, env);
        } catch (catchError: any) {
          // If catch block fails, return a basic error response
          console.error(
            "[CATCH BLOCK ERROR]",
            catchError?.message,
            catchError?.stack,
          );
          return new Response(
            JSON.stringify({
              error: catchError?.message || "Internal server error",
            }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }
      }
    },
    middleware: [corsMiddleware()],
    description: "Get taxonomy tags for entity",
  },
];
