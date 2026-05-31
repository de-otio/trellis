/**
 * Product Taxonomy Routes
 *
 * API endpoints for managing taxonomy tags on products.
 * Note: Products are synced from Shopify and identified by productId strings.
 */

import type { Env } from "../../env.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { CorsHandler } from "../cors-handler.js";
import { getWrappedDatabase } from "../database-wrapper-helper.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { detectRegionSync } from "../region-detection.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { TaxonomyHandler } from "../taxonomy-handler.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";

/**
 * Resolve the caller's active tenant from the JWT.
 */
async function getTenantId(request: Request, env: Env): Promise<string | null> {
  const auth = await authMiddleware(request, env);
  if (!auth || !auth.activeTenantId) return null;
  return auth.activeTenantId;
}

function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized" }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

export const productTaxonomyRoutes: Route[] = [
  // Add taxonomy tags to product
  {
    path: /^\/products\/([^/]+)\/taxonomy-tags$/,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
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
        "/products/:productId/taxonomy-tags",
        100,
        3600,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const productId = pathname
          .split("/products/")[1]
          .split("/taxonomy-tags")[0];

        // Get tenant ID from authenticated JWT
        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();

        // Get database and taxonomy handler
        const region = detectRegionSync(request, env);
        const db = getWrappedDatabase(region, env, request);
        const taxonomyHandler = new TaxonomyHandler(
          db,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );

        // Parse and validate request body
        const body = (await request.json()) as { taxonIds?: string[] };
        const taxonIds = validator.validateTaxonIds(body.taxonIds);

        // Add taxonomy tags
        await taxonomyHandler.addProductTaxonomyTags(productId, taxonIds);

        // Return updated tags
        const tags = await taxonomyHandler.getProductTaxonomyTags(productId);

        return securityHeaders.createSecureResponse(
          JSON.stringify({
            tags: tags.map((tag) => ({
              id: tag.id,
              taxonId: tag.taxonId,
              displayName: tag.displayName,
              description: tag.description,
              category: tag.category
                ? {
                    code: tag.category.code,
                    displayName: tag.category.displayName,
                    dimension: tag.category.dimension
                      ? {
                          code: tag.category.dimension.code,
                          displayName: tag.category.dimension.displayName,
                        }
                      : null,
                  }
                : null,
            })),
            count: tags.length,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      } catch (error: any) {
        const validator = new Validator();
        getLogger().error(
          "Error adding product taxonomy tags:",
          error,
        );
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          {
            status: error.message?.includes("not found") ? 404 : 500,
            headers: { "content-type": "application/json" },
          },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Add taxonomy tags to product (admin/merchant only)",
  },

  // Remove taxonomy tags from product
  {
    path: /^\/products\/([^/]+)\/taxonomy-tags$/,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
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
        "/products/:productId/taxonomy-tags",
        100,
        3600,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const productId = pathname
          .split("/products/")[1]
          .split("/taxonomy-tags")[0];

        // Get tenant ID from authenticated JWT
        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();

        // Get database and taxonomy handler
        const region = detectRegionSync(request, env);
        const db = getWrappedDatabase(region, env, request);
        const taxonomyHandler = new TaxonomyHandler(
          db,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );

        // Parse and validate request body
        const body = (await request.json()) as { taxonIds?: string[] };
        const taxonIds = validator.validateTaxonIds(body.taxonIds);

        // Remove taxonomy tags
        await taxonomyHandler.removeProductTaxonomyTags(productId, taxonIds);

        return securityHeaders.createSecureResponse(
          JSON.stringify({ success: true }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      } catch (error: any) {
        const validator = new Validator();
        getLogger().error(
          "Error removing product taxonomy tags:",
          error,
        );
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          {
            status: error.message?.includes("not found") ? 404 : 500,
            headers: { "content-type": "application/json" },
          },
        );
        return await CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Remove taxonomy tags from product (admin/merchant only)",
  },

  // Get taxonomy tags for product
  {
    path: /^\/products\/([^/]+)\/taxonomy-tags$/,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      try {
        const productId = pathname
          .split("/products/")[1]
          .split("/taxonomy-tags")[0];

        // Get tenant ID
        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();

        // Get database and taxonomy handler
        const region = detectRegionSync(request, env);
        const db = getWrappedDatabase(region, env, request);
        const taxonomyHandler = new TaxonomyHandler(
          db,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );

        // Get taxonomy tags
        const tags = await taxonomyHandler.getProductTaxonomyTags(productId);

        return new Response(
          JSON.stringify({
            tags: tags.map((tag: any) => ({
              id: tag.id,
              taxonId: tag.taxonId,
              displayName: tag.displayName,
              description: tag.description,
              category: tag.category
                ? {
                    code: tag.category.code,
                    displayName: tag.category.displayName,
                    dimension: tag.category.dimension
                      ? {
                          code: tag.category.dimension.code,
                          displayName: tag.category.dimension.displayName,
                        }
                      : null,
                  }
                : null,
            })),
            count: tags.length,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      } catch (error: any) {
        getLogger().error(
          "Error getting product taxonomy tags:",
          error,
        );
        return new Response(
          JSON.stringify({ error: error.message || "Internal server error" }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get taxonomy tags for product",
  },
];
