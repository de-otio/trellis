/**
 * Taxonomy Routes
 *
 * API endpoints for taxonomy management:
 * - List dimensions
 * - Get dimension by code
 * - Search taxons
 * - Get taxon by ID
 */

import { z } from "zod";
import type { Env } from "../../env.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { getWrappedDatabase } from "../database-wrapper-helper.js";
import { InputSanitizer } from "../input-sanitizer.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { detectRegionSync } from "../region-detection.js";
import { TaxonomyHandler } from "../taxonomy-handler.js";
import { TaxonomySearchMetrics } from "../taxonomy-search-metrics.js";
import type { Route } from "./types.js";

/**
 * Resolve the caller's active tenant from the JWT. Returns null if the
 * request is not authenticated or no tenant claim is present; the caller
 * should respond 401.
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

/**
 * Taxonomy routes
 */
export const taxonomyRoutes: Route[] = [
  // List dimensions
  {
    path: "/api/taxonomy/dimensions",
    method: "GET",
    handler: async (request, env) => {
      try {
        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();
        const region = detectRegionSync(request, env);
        const db = getWrappedDatabase(region, env, request);
        const handler = new TaxonomyHandler(
          db,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );

        const includeCategories = request.url.includes(
          "includeCategories=true",
        );
        const includeTaxons = request.url.includes("includeTaxons=true");

        const dimensions = await handler.getDimensions({
          includeCategories,
          includeTaxons,
        });

        return new Response(JSON.stringify({ dimensions }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error: any) {
        getLogger().error("Error listing dimensions:", error);
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
    description: "List all taxonomy dimensions",
  },

  // Get dimension by code
  {
    path: "/api/taxonomy/dimensions/:dimensionCode",
    method: "GET",
    handler: async (request, env, params) => {
      try {
        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();
        const region = detectRegionSync(request, env);
        const db = getWrappedDatabase(region, env, request);
        const handler = new TaxonomyHandler(
          db,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );

        const dimensionCode = params?.params?.dimensionCode;
        if (!dimensionCode) {
          return new Response(
            JSON.stringify({ error: "Dimension code required" }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Validate dimension code format
        if (!/^[a-z-]+$/.test(dimensionCode)) {
          return new Response(
            JSON.stringify({
              error: "Invalid dimension code format",
              message:
                "Dimension code must contain only lowercase letters and hyphens",
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          );
        }

        const includeCategories = request.url.includes(
          "includeCategories=true",
        );
        const includeTaxons = request.url.includes("includeTaxons=true");
        const dimension = await handler.getDimensionByCode(dimensionCode, {
          includeCategories,
          includeTaxons,
        });

        if (!dimension) {
          return new Response(
            JSON.stringify({ error: "Dimension not found" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        return new Response(JSON.stringify({ dimension }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error: any) {
        getLogger().error("Error getting dimension:", error);
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
    description: "Get dimension by code with categories and taxons",
  },

  // Search taxons
  {
    path: "/api/taxonomy/taxons/search",
    method: "GET",
    handler: async (request, env) => {
      const startTime = Date.now();
      let searchMetrics: any = null;

      try {
        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();
        const region = detectRegionSync(request, env);
        const db = getWrappedDatabase(region, env, request);
        const handler = new TaxonomyHandler(
          db,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );

        const url = new URL(request.url);

        // Validate query parameters using Zod schema
        const searchQuerySchema = z.object({
          q: z
            .string()
            .min(1)
            .max(200)
            .describe("Search query (1-200 characters)"),
          dimension: z
            .string()
            .regex(/^[a-z-]+$/)
            .optional()
            .describe("Dimension code (lowercase letters and hyphens only)"),
          category: z
            .string()
            .regex(/^[a-z-]+$/)
            .optional()
            .describe("Category code (lowercase letters and hyphens only)"),
          limit: z.coerce
            .number()
            .int()
            .min(1)
            .transform((val) => Math.min(val, 50))
            .default(20)
            .describe("Result limit (1-50, capped at 50)"),
        });

        const params: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
          params[key] = value;
        });

        let validatedParams: any;
        try {
          validatedParams = searchQuerySchema.parse(params);
        } catch (error: any) {
          if (error.issues) {
            return new Response(
              JSON.stringify({
                error: "Invalid query parameters",
                details: error.issues.map((e: any) => ({
                  path: e.path.join("."),
                  message: e.message,
                })),
              }),
              {
                status: 400,
                headers: { "content-type": "application/json" },
              },
            );
          }
          return new Response(
            JSON.stringify({ error: "Invalid query parameters" }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          );
        }

        const { q: query, dimension, category, limit } = validatedParams;

        // Check query complexity (prevent DoS via complex queries)
        // Count special characters that could make queries expensive
        const specialCharCount = (query.match(/[^\w\s-]/g) || []).length;
        if (specialCharCount > 20) {
          return new Response(
            JSON.stringify({
              error: "Query contains too many special characters",
              message: "Please simplify your search query",
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Sanitize query (prevent XSS)
        const sanitizedQuery = InputSanitizer.sanitizeText(query.trim());

        if (sanitizedQuery.length === 0) {
          return new Response(JSON.stringify({ error: "Invalid query" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        // Apply rate limiting
        const rateLimiter = new RateLimiter();
        const rateLimitResponse = await rateLimiter.applyRateLimitKV(
          env as any,
          request,
          "/api/taxonomy/taxons/search",
          100, // 100 searches per hour
          3600,
        );
        if (rateLimitResponse) {
          return rateLimitResponse;
        }

        // Execute search with timeout
        const searchPromise = handler.searchTaxons(sanitizedQuery, {
          dimension,
          category,
          limit: Math.min(limit, 50), // Max 50 results
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("Search query timeout"));
          }, 5000); // 5 second timeout
        });

        const taxons = await Promise.race([searchPromise, timeoutPromise]);

        // Track metrics
        const metrics = new TaxonomySearchMetrics(
          (env as any).SEARCH_METRICS_KV,
          true,
        );

        searchMetrics = {
          query: sanitizedQuery,
          resultCount: taxons.length,
          timestamp: Date.now(),
          dimension,
          category,
          tenantId,
        };

        await metrics.trackSearch(searchMetrics);

        // Sanitize output
        const sanitizedTaxons = taxons.map((taxon) => ({
          id: taxon.id,
          taxonId: taxon.taxonId,
          displayName: InputSanitizer.sanitizeText(taxon.displayName),
          description: taxon.description
            ? InputSanitizer.sanitizeText(taxon.description)
            : null,
          category: taxon.category
            ? {
                code: taxon.category.code,
                displayName: InputSanitizer.sanitizeText(
                  taxon.category.displayName,
                ),
                dimension: taxon.category.dimension
                  ? {
                      code: taxon.category.dimension.code,
                      displayName: InputSanitizer.sanitizeText(
                        taxon.category.dimension.displayName,
                      ),
                    }
                  : null,
              }
            : null,
        }));

        const responseTime = Date.now() - startTime;

        return new Response(
          JSON.stringify({
            taxons: sanitizedTaxons,
            query: sanitizedQuery,
            count: sanitizedTaxons.length,
            responseTime,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "X-Response-Time": `${responseTime}ms`,
            },
          },
        );
      } catch (error: any) {
        const responseTime = Date.now() - startTime;

        // Track error metrics if we have the query
        if (searchMetrics) {
          try {
            const metrics = new TaxonomySearchMetrics(
              (env as any).SEARCH_METRICS_KV,
              true,
            );
            await metrics.trackSearch({
              ...searchMetrics,
              resultCount: 0,
              error: error.message,
            });
          } catch (metricsError) {
            getLogger().error(
              "Error tracking search error metrics:",
              metricsError,
            );
          }
        }

        getLogger().error("Error searching taxons:", error);

        // Don't expose internal error details
        const errorMessage =
          error.message === "Search query timeout"
            ? "Search query timeout"
            : "Internal server error";

        return new Response(
          JSON.stringify({
            error: errorMessage,
            responseTime,
          }),
          {
            status: error.message === "Search query timeout" ? 504 : 500,
            headers: {
              "content-type": "application/json",
              "X-Response-Time": `${responseTime}ms`,
            },
          },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Search taxonomy taxons by query string with full-text search",
  },

  // Get taxon by taxonId
  {
    path: "/api/taxonomy/taxons/:taxonId",
    method: "GET",
    handler: async (request, env, params) => {
      try {
        const tenantId = await getTenantId(request, env);
        if (!tenantId) return unauthorizedResponse();
        const region = detectRegionSync(request, env);
        const db = getWrappedDatabase(region, env, request);
        const handler = new TaxonomyHandler(
          db,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );

        const taxonId = params?.params?.taxonId;
        if (!taxonId) {
          return new Response(JSON.stringify({ error: "Taxon ID required" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        // Validate taxon ID format
        if (!/^[a-z-]+:[a-z-]+:[a-z-]+$/.test(taxonId)) {
          return new Response(
            JSON.stringify({
              error: "Invalid taxon ID format",
              message: "Taxon ID must be in format: dimension:category:taxon",
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          );
        }

        const taxon = await handler.getTaxonByTaxonId(taxonId);

        if (!taxon) {
          return new Response(JSON.stringify({ error: "Taxon not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ taxon }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error: any) {
        getLogger().error("Error getting taxon:", error);
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
    description: "Get taxon by taxonId",
  },
];
