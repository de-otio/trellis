/**
 * Taxonomy Handler Factory
 *
 * Factory function for creating TaxonomyHandler instances.
 * Extracted to a separate module for better testability.
 */

import type { Env } from "../env.js";
import { authMiddleware } from "./auth/auth-middleware.js";
import { getWrappedDatabase } from "./database-wrapper-helper.js";
import { TaxonomyHandler } from "./taxonomy-handler.js";

/**
 * Create a TaxonomyHandler instance for the given request context.
 * Returns null when the request has no authenticated tenant context — caller
 * must respond 401 in that case rather than fall back to a default tenant.
 *
 * @param request - The incoming request
 * @param env - The environment configuration
 * @param region - The region for database routing
 * @returns A configured TaxonomyHandler instance or null if unauthenticated.
 */
export async function createTaxonomyHandler(
  request: Request,
  env: Env,
  region: string,
): Promise<TaxonomyHandler | null> {
  const auth = await authMiddleware(request, env);
  if (!auth || !auth.activeTenantId) return null;
  const wrappedDb = getWrappedDatabase(region, env, request);
  return new TaxonomyHandler(wrappedDb, auth.activeTenantId, env.TAXONOMY_CACHE_KV);
}
