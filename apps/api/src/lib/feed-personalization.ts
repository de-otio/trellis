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

/**
 * Personalization is a FILTER, not a score. The no-covert-engagement-ordering
 * invariant (see apps/api/src/lib/REPRODUCIBILITY.md, Section 2, and
 * feed-pagination.ts's ALLOWED_SORT_FIELDS) forbids any option here that
 * would rank or weight posts by a relevance/match score — the feed's only
 * ordering is `createdAt DESC` under FEED_RANKING_VERSION. Personalization
 * may narrow *which* posts appear (via a taxonomy WHERE filter — see
 * feed-handler.ts's `taxonomyFilter`) but must never change the *order* of
 * the posts it returns.
 *
 * Do not add a scoring-shaped option (weight, boost, score, rank, relevance)
 * to this interface. A previous version declared `boostByMatchCount` and
 * `taxonomyWeight`; neither was ever implemented in feed-handler.ts (which
 * only builds a filter), and both were removed as dead surface that
 * contradicted the invariant they sat next to. See
 * feed-personalization-options.test.ts for the guard test.
 */
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
}

/**
 * Runtime mirror of `keyof PersonalizationOptions`, used only so
 * feed-personalization-options.test.ts can check the option names for a
 * scoring shape at runtime (a TS `interface` has no runtime representation
 * to inspect). The `satisfies` clause below fails the build if this array
 * ever drifts from the interface it mirrors — add/remove a field in both
 * places together.
 */
export const PERSONALIZATION_OPTION_KEYS = [
  "enabled",
  "minMatchingTags",
] as const satisfies readonly (keyof PersonalizationOptions)[];

// Compile-time completeness check, the other direction from `satisfies`
// above: every key the interface DOES declare must appear in the array.
// `npm run lint` (`tsc --build`) fails this line if a field is added to
// PersonalizationOptions without being added here too.
type _MissingFromKeyList = Exclude<
  keyof PersonalizationOptions,
  (typeof PERSONALIZATION_OPTION_KEYS)[number]
>;
const _assertNoMissingKeys: _MissingFromKeyList extends never
  ? true
  : ["PERSONALIZATION_OPTION_KEYS is missing a key — see feed-personalization.ts"] = true;
void _assertNoMissingKeys;

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

  // NOTE: an earlier design routed taxonomy *scoring* (relevance weighting,
  // match-count boosting) through an extension-provided `FeedStrategy`. That
  // extension point was removed in the feed redesign and nothing replaced
  // it — the extension-api surface wired today (see AGENTS.md's "What core
  // actually invokes") has no `feedStrategy` field. `getEntityTaxonomyTags`
  // above is the only thing this class does: it returns tag IDs for a
  // caller to use as a WHERE filter (see feed-handler.ts's `taxonomyFilter`
  // and content-discovery.ts). No scoring function belongs in this file —
  // see the invariant note on `PersonalizationOptions` above.
}
