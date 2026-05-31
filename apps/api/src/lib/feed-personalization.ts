/**
 * Feed Personalization
 *
 * Personalizes feeds based on user's entity (dog) taxonomy tags.
 * This enables users to see content relevant to their dogs' specific needs,
 * life stages, behaviors, and interests.
 */

import { TaxonomyHandler } from "./taxonomy-handler.js";
import type { PrismaClient } from "@prisma/client";
import { DataRouter } from "./data-router.js";
import type { Env } from "../env.js";

export interface PersonalizationOptions {
  /**
   * Whether to enable personalization (default: true)
   */
  enabled?: boolean;

  /**
   * Minimum number of matching taxonomy tags required for a post to be included
   * (default: 1)
   */
  minMatchingTags?: number;

  /**
   * Whether to boost posts with more matching tags (default: true)
   */
  boostByMatchCount?: boolean;

  /**
   * Weight for taxonomy tag matching in relevance scoring (default: 0.3)
   */
  taxonomyWeight?: number;
}

export interface PersonalizedFeedOptions {
  /**
   * Entity IDs to use for personalization (if not provided, uses all user's entities)
   */
  entityIds?: string[];

  /**
   * Personalization options
   */
  personalization?: PersonalizationOptions;
}

export class FeedPersonalization {
  /**
   * Get taxonomy tags from user's entities
   *
   * @param userId - User ID
   * @param entityIds - Optional specific entity IDs (if not provided, gets all user's entities)
   * @param region - Data region
   * @param env - Environment variables
   * @param request - Request object
   * @param tenantId - Tenant ID
   * @returns Array of unique taxon IDs from all entities
   */
  static async getEntityTaxonomyTags(
    userId: string,
    entityIds: string[] | undefined,
    region: string,
    env: Env,
    request: Request | undefined,
    tenantId: string,
  ): Promise<string[]> {
    // Get database
    const db = DataRouter.getDatabaseForRegion(region, env, request, userId);

    // Get user's entities
    let entities;
    if (entityIds && entityIds.length > 0) {
      // Get specific entities
      entities = await (db.entity.findMany({
        where: {
          id: { in: entityIds },
          owners: { some: { userId: userId, status: 'ACTIVE' } },
        },
        select: { id: true },
      }) as unknown as Promise<{ id: string }[]>);
    } else {
      // Get all user's entities
      entities = await (db.entity.findMany({
        where: {
          owners: { some: { userId: userId, status: 'ACTIVE' } },
        },
        select: { id: true },
      }) as unknown as Promise<{ id: string }[]>);
    }

    if (entities.length === 0) {
      return [];
    }

    // Get wrapped database for taxonomy queries
    const { getWrappedDatabase } = await import("./database-wrapper-helper.js");
    if (!request) {
      throw new Error("Request is required for taxonomy queries");
    }
    const wrappedDb = getWrappedDatabase(region, env, request);

    // Get taxonomy handler
    const taxonomyHandler = new TaxonomyHandler(
      wrappedDb,
      tenantId,
      env.TAXONOMY_CACHE_KV,
    );

    // Get taxonomy tags for all entities
    const allTaxonIds = new Set<string>();
    for (const entity of entities) {
      const tags = await taxonomyHandler.getEntityTaxonomyTags(entity.id);
      for (const tag of tags) {
        allTaxonIds.add(tag.taxonId);
      }
    }

    return Array.from(allTaxonIds);
  }

  // Pure scoring functions (calculateTaxonomyRelevance, buildPersonalizedTaxonomyFilter)
  // are provided by extensions via FeedStrategy.personalize(). See extensions/dogs/src/feed-strategy.ts.
}
