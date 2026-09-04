/**
 * Content Discovery
 *
 * Provides taxonomy-based content discovery features:
 * - Related content based on taxonomy tags
 * - Trending topics based on taxonomy usage
 * - Content recommendations
 */

import { TaxonomyHandler } from "./taxonomy-handler.js";
import type { PrismaClient } from "@prisma/client";
import { DataRouter } from "./data-router.js";
import type { Env } from "../env.js";

export interface RelatedContentOptions {
  /**
   * Maximum number of results to return
   */
  limit?: number;

  /**
   * Minimum number of matching taxonomy tags required
   */
  minMatchingTags?: number;

  /**
   * The viewing user's id, when the caller is authenticated. Used only to
   * exclude blocked accounts in both directions (M2). Omitted, no block
   * exclusion is applied — which is correct for an anonymous caller and wrong
   * for an authenticated one, so route handlers must pass it.
   */
  viewerUserId?: string;

  /**
   * Whether to include posts from the same author
   */
  includeSameAuthor?: boolean;
}

export interface TrendingTopic {
  taxonId: string;
  displayName: string;
  usageCount: number;
  postCount: number;
  entityCount: number;
  growthRate?: number; // Percentage change from previous period
}

export interface ContentRecommendation {
  postId: string;
  relevanceScore: number;
  matchingTags: string[];
  reason: string;
}

export interface CreatorRecommendation {
  userId: string;
  email: string;
  username?: string;
  relevanceScore: number;
  matchingTags: string[];
  specializationTags: string[]; // Top taxonomy tags this creator specializes in
  postCount: number;
  reason: string;
}

export class ContentDiscovery {
  /**
   * Get related content based on taxonomy tags
   *
   * @param postId - Post ID to find related content for
   * @param tenantId - Tenant ID
   * @param region - Data region
   * @param env - Environment variables
   * @param request - Request object
   * @param options - Discovery options
   * @returns Array of related post IDs with relevance scores
   */
  static async getRelatedContent(
    postId: string,
    tenantId: string,
    region: string,
    env: Env,
    request: Request | undefined,
    options: RelatedContentOptions = {},
  ): Promise<ContentRecommendation[]> {
    const limit = options.limit || 10;
    const minMatchingTags = options.minMatchingTags || 1;

    // Get database
    const db = DataRouter.getDatabaseForRegion(region, env, request);

    // Get taxonomy tags for the post
    const postTags = await (db.postTaxonomyTag.findMany({
      where: { postId },
      include: {
        taxon: {
          select: {
            id: true,
            taxonId: true,
            displayName: true,
          },
        },
      },
    }) as unknown as Promise<
      Array<{ taxon: { id: string; taxonId: string; displayName: string } }>
    >);

    if (postTags.length === 0) {
      return [];
    }

    const taxonIds = postTags.map((pt) => pt.taxon.id);
    const taxonIdStrings = postTags.map((pt) => pt.taxon.taxonId);

    // Get post author to optionally exclude
    const post = await (db.post.findUnique({
      where: { id: postId },
      select: { authorId: true },
    }) as unknown as Promise<{ authorId: string } | null>);

    if (!post) {
      return [];
    }

    // Block exclusion (M2). The viewer is optional on this call — an
    // unauthenticated caller cannot have blocks — but when it is present the
    // same bidirectional set the feed uses applies here too.
    const { resolveMutualBlockIds } = await import("./block-visibility.js");
    const blockedIds = options.viewerUserId
      ? await resolveMutualBlockIds(db as any, tenantId, options.viewerUserId)
      : [];

    // Find posts with matching taxonomy tags
    const relatedPosts = await (db.postTaxonomyTag.findMany({
      where: {
        taxonId: { in: taxonIds },
        postId: { not: postId },
        post: {
          deletedAt: null,
          hiddenByAuthor: false,
          ...(options.includeSameAuthor
            ? {}
            : { authorId: { not: post.authorId } }),
          ...(blockedIds.length > 0
            ? { AND: [{ authorId: { notIn: blockedIds } }] }
            : {}),
        },
      },
      include: {
        post: {
          select: {
            id: true,
            createdAt: true,
          },
        },
        taxon: {
          select: {
            taxonId: true,
          },
        },
      },
    }) as unknown as Promise<
      Array<{
        post: { id: string; createdAt: Date };
        taxon: { taxonId: string };
      }>
    >);

    // Group by post and count matching tags
    const postMatches = new Map<
      string,
      { matchingTags: string[]; createdAt: Date }
    >();

    for (const relatedPost of relatedPosts) {
      const postId = relatedPost.post.id;
      if (!postMatches.has(postId)) {
        postMatches.set(postId, {
          matchingTags: [],
          createdAt: relatedPost.post.createdAt,
        });
      }
      const match = postMatches.get(postId)!;
      if (!match.matchingTags.includes(relatedPost.taxon.taxonId)) {
        match.matchingTags.push(relatedPost.taxon.taxonId);
      }
    }

    // Filter by minimum matching tags and calculate relevance
    const recommendations: ContentRecommendation[] = [];

    for (const [postId, match] of postMatches.entries()) {
      if (match.matchingTags.length >= minMatchingTags) {
        // Calculate relevance score
        // More matching tags = higher score
        // More recent posts = slight boost
        const tagScore = match.matchingTags.length / taxonIdStrings.length;
        const recencyScore =
          (Date.now() - match.createdAt.getTime()) / (1000 * 60 * 60 * 24); // Days ago
        const recencyBoost = Math.max(0, 1 - recencyScore / 30); // Decay over 30 days
        const relevanceScore = tagScore * 0.7 + recencyBoost * 0.3;

        recommendations.push({
          postId,
          relevanceScore,
          matchingTags: match.matchingTags,
          reason: `Matches ${match.matchingTags.length} of ${taxonIdStrings.length} topics`,
        });
      }
    }

    // Sort by relevance and return top results
    return recommendations
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);
  }

  /**
   * Get trending topics based on taxonomy usage
   *
   * @param tenantId - Tenant ID
   * @param region - Data region
   * @param env - Environment variables
   * @param request - Request object
   * @param options - Trending options
   * @returns Array of trending topics
   */
  static async getTrendingTopics(
    tenantId: string,
    region: string,
    env: Env,
    request: Request | undefined,
    options: {
      limit?: number;
      period?: "day" | "week" | "month";
    } = {},
  ): Promise<TrendingTopic[]> {
    const limit = options.limit || 20;
    const period = options.period || "week";
    const periodDays = period === "day" ? 1 : period === "week" ? 7 : 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - periodDays);

    // Get database
    const db = DataRouter.getDatabaseForRegion(region, env, request);

    // Get wrapped database for taxonomy queries
    const { getWrappedDatabase } = await import("./database-wrapper-helper.js");
    if (!request) {
      throw new Error("Request is required for taxonomy queries");
    }
    const wrappedDb = getWrappedDatabase(region, env, request);
    const taxonomyHandler = new TaxonomyHandler(
      wrappedDb,
      tenantId,
      env.TAXONOMY_CACHE_KV,
    );

    // Count taxonomy tag usage in posts
    const postTagCounts = await (db.postTaxonomyTag.groupBy({
      by: ["taxonId"],
      where: {
        post: {
          createdAt: { gte: cutoffDate },
          deletedAt: null,
          hiddenByAuthor: false,
        },
      },
      _count: {
        postId: true,
      },
      orderBy: {
        _count: {
          postId: "desc",
        },
      },
      take: limit * 2, // Get more to filter by tenant
    }) as unknown as Promise<
      Array<{ taxonId: string; _count: { postId: number } }>
    >);

    // Count taxonomy tag usage in entities
    const entityTagCounts = await (db.entityTaxonomyTag.groupBy({
      by: ["taxonId"],
      _count: {
        entityId: true,
      },
    }) as unknown as Promise<
      Array<{ taxonId: string; _count: { entityId: number } }>
    >);

    // Get taxon details and filter by tenant
    const taxonIds = postTagCounts.map((ptc) => ptc.taxonId);
    const taxons = await wrappedDb.taxonomyTaxon.findMany({
      where: {
        id: { in: taxonIds },
        tenantId,
        isActive: true,
      },
      select: {
        id: true,
        taxonId: true,
        displayName: true,
      },
    });

    const taxonMap = new Map(taxons.map((t) => [t.id, t]));
    const entityCountMap = new Map(
      entityTagCounts.map((etc) => [etc.taxonId, etc._count.entityId]),
    );

    // Build trending topics
    const trending: TrendingTopic[] = [];

    for (const postTagCount of postTagCounts) {
      const taxon = taxonMap.get(postTagCount.taxonId);
      if (!taxon) continue; // Skip if taxon not found or not in tenant

      trending.push({
        taxonId: taxon.taxonId,
        displayName: taxon.displayName,
        usageCount: postTagCount._count.postId,
        postCount: postTagCount._count.postId,
        entityCount: entityCountMap.get(postTagCount.taxonId) || 0,
      });
    }

    // Sort by usage count and return top results
    return trending.sort((a, b) => b.usageCount - a.usageCount).slice(0, limit);
  }

  /**
   * Get content recommendations based on user's entity taxonomy tags
   *
   * @param userId - User ID
   * @param tenantId - Tenant ID
   * @param region - Data region
   * @param env - Environment variables
   * @param request - Request object
   * @param options - Recommendation options
   * @returns Array of recommended posts
   */
  static async getContentRecommendations(
    userId: string,
    tenantId: string,
    region: string,
    env: Env,
    request: Request | undefined,
    options: {
      limit?: number;
      entityIds?: string[];
    } = {},
  ): Promise<ContentRecommendation[]> {
    const limit = options.limit || 10;

    // Get user's entity taxonomy tags
    const { FeedPersonalization } = await import("./feed-personalization.js");
    const userEntityTaxonIds = await FeedPersonalization.getEntityTaxonomyTags(
      userId,
      options.entityIds,
      region,
      env,
      request,
      tenantId,
    );

    if (userEntityTaxonIds.length === 0) {
      return [];
    }

    // Get database
    const db = DataRouter.getDatabaseForRegion(region, env, request);

    // Get wrapped database for taxonomy queries
    const { getWrappedDatabase } = await import("./database-wrapper-helper.js");
    if (!request) {
      throw new Error("Request is required for taxonomy queries");
    }
    const wrappedDb = getWrappedDatabase(region, env, request);
    const taxonomyHandler = new TaxonomyHandler(
      wrappedDb,
      tenantId,
      env.TAXONOMY_CACHE_KV,
    );

    // Find taxon IDs
    const taxons = await wrappedDb.taxonomyTaxon.findMany({
      where: {
        tenantId,
        taxonId: { in: userEntityTaxonIds },
        isActive: true,
      },
      select: { id: true },
    });

    if (taxons.length === 0) {
      return [];
    }

    const taxonIds = taxons.map((t) => t.id);

    // Block exclusion (M2): a recommendation surface is a read path, so it is
    // covered by the same bidirectional set as the feed — otherwise blocking
    // someone hides them from the feed and hands them straight back here.
    const { resolveMutualBlockIds } = await import("./block-visibility.js");
    const blockedIds = await resolveMutualBlockIds(
      db as any,
      tenantId,
      userId,
    );

    // Find posts with matching taxonomy tags
    const recommendedPosts = await (db.postTaxonomyTag.findMany({
      where: {
        taxonId: { in: taxonIds },
        post: {
          deletedAt: null,
          hiddenByAuthor: false,
          authorId: {
            not: userId, // Don't recommend own posts
            ...(blockedIds.length > 0 ? { notIn: blockedIds } : {}),
          },
        },
      },
      include: {
        post: {
          select: {
            id: true,
            createdAt: true,
          },
        },
        taxon: {
          select: {
            taxonId: true,
          },
        },
      },
      take: limit * 3, // Get more to calculate relevance
    }) as unknown as Promise<
      Array<{
        post: { id: string; createdAt: Date };
        taxon: { taxonId: string };
      }>
    >);

    // Group by post and calculate relevance
    const postMatches = new Map<
      string,
      { matchingTags: string[]; createdAt: Date }
    >();

    for (const recPost of recommendedPosts) {
      const postId = recPost.post.id;
      if (!postMatches.has(postId)) {
        postMatches.set(postId, {
          matchingTags: [],
          createdAt: recPost.post.createdAt,
        });
      }
      const match = postMatches.get(postId)!;
      if (!match.matchingTags.includes(recPost.taxon.taxonId)) {
        match.matchingTags.push(recPost.taxon.taxonId);
      }
    }

    // Calculate relevance scores
    const recommendations: ContentRecommendation[] = [];

    for (const [postId, match] of postMatches.entries()) {
      // Calculate relevance based on matching tags and recency
      const tagScore = match.matchingTags.length / userEntityTaxonIds.length;
      const recencyScore =
        (Date.now() - match.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      const recencyBoost = Math.max(0, 1 - recencyScore / 30);
      const relevanceScore = tagScore * 0.7 + recencyBoost * 0.3;

      recommendations.push({
        postId,
        relevanceScore,
        matchingTags: match.matchingTags,
        reason: `Matches your dog's interests: ${match.matchingTags.join(", ")}`,
      });
    }

    // Sort by relevance and return top results
    return recommendations
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);
  }

  /**
   * Get creator recommendations based on taxonomy tags
   *
   * Finds creators whose content matches the user's interests based on:
   * - User's entity taxonomy tags
   * - Creators' post taxonomy tags
   * - Creator specialization (most common taxonomy tags in their posts)
   *
   * @param userId - User ID requesting recommendations
   * @param tenantId - Tenant ID
   * @param region - Data region
   * @param env - Environment variables
   * @param request - Request object
   * @param options - Recommendation options
   * @returns Array of recommended creators
   */
  static async getCreatorRecommendations(
    userId: string,
    tenantId: string,
    region: string,
    env: Env,
    request: Request | undefined,
    options: {
      limit?: number;
      entityIds?: string[];
      minPostCount?: number; // Minimum posts required to be recommended
      minMatchingTags?: number; // Minimum matching taxonomy tags
    } = {},
  ): Promise<CreatorRecommendation[]> {
    const limit = options.limit || 10;
    const minPostCount = options.minPostCount || 3;
    const minMatchingTags = options.minMatchingTags || 1;

    // Get user's entity taxonomy tags
    const { FeedPersonalization } = await import("./feed-personalization.js");
    const userEntityTaxonIds = await FeedPersonalization.getEntityTaxonomyTags(
      userId,
      options.entityIds,
      region,
      env,
      request,
      tenantId,
    );

    if (userEntityTaxonIds.length === 0) {
      return [];
    }

    // Get database
    const db = DataRouter.getDatabaseForRegion(region, env, request);

    // Get wrapped database for taxonomy queries
    const { getWrappedDatabase } = await import("./database-wrapper-helper.js");
    if (!request) {
      throw new Error("Request is required for taxonomy queries");
    }
    const wrappedDb = getWrappedDatabase(region, env, request);
    const taxonomyHandler = new TaxonomyHandler(
      wrappedDb,
      tenantId,
      env.TAXONOMY_CACHE_KV,
    );

    // Find taxon IDs
    const taxons = await wrappedDb.taxonomyTaxon.findMany({
      where: {
        tenantId,
        taxonId: { in: userEntityTaxonIds },
        isActive: true,
      },
      select: { id: true, taxonId: true },
    });

    if (taxons.length === 0) {
      return [];
    }

    const taxonIds = taxons.map((t) => t.id);
    const taxonIdMap = new Map(taxons.map((t) => [t.id, t.taxonId]));

    // Block exclusion (M2). Recommending a PERSON is the surface where a
    // missing block reads worst — the product would be suggesting, by name, the
    // account the user just blocked.
    const { resolveMutualBlockIds } = await import("./block-visibility.js");
    const blockedIds = await resolveMutualBlockIds(
      db as any,
      tenantId,
      userId,
    );

    // Find all posts with matching taxonomy tags (grouped by author)
    const postsWithTags = await (db.postTaxonomyTag.findMany({
      where: {
        taxonId: { in: taxonIds },
        post: {
          deletedAt: null,
          hiddenByAuthor: false,
          authorId: {
            not: userId, // Don't recommend self
            ...(blockedIds.length > 0 ? { notIn: blockedIds } : {}),
          },
        },
      },
      include: {
        post: {
          select: {
            id: true,
            authorId: true,
          },
        },
        taxon: {
          select: {
            id: true,
            taxonId: true,
          },
        },
      },
    }) as unknown as Promise<
      Array<{
        post: { id: string; authorId: string };
        taxon: { id: string; taxonId: string };
      }>
    >);

    // Group by creator and collect their taxonomy tags
    const creatorStats = new Map<
      string,
      {
        matchingTags: Set<string>;
        allTags: Map<string, number>; // taxonId -> count
        postIds: Set<string>; // Track unique posts
      }
    >();

    for (const pwt of postsWithTags) {
      const authorId = pwt.post.authorId;
      if (!authorId) continue;

      if (!creatorStats.has(authorId)) {
        creatorStats.set(authorId, {
          matchingTags: new Set(),
          allTags: new Map(),
          postIds: new Set(),
        });
      }

      const stats = creatorStats.get(authorId)!;
      stats.postIds.add(pwt.post.id);

      // Track matching tags
      const taxonIdStr = taxonIdMap.get(pwt.taxon.id);
      if (taxonIdStr && userEntityTaxonIds.includes(taxonIdStr)) {
        stats.matchingTags.add(taxonIdStr);
      }

      // Track all tags for specialization
      const currentCount = stats.allTags.get(pwt.taxon.taxonId) || 0;
      stats.allTags.set(pwt.taxon.taxonId, currentCount + 1);
    }

    // Get all taxonomy tags for each creator's posts to build complete specialization
    for (const [authorId, stats] of creatorStats.entries()) {
      const allPostTags = await (db.postTaxonomyTag.findMany({
        where: {
          postId: { in: Array.from(stats.postIds) },
          post: {
            authorId,
            deletedAt: null,
            hiddenByAuthor: false,
          },
        },
        include: {
          taxon: {
            select: {
              taxonId: true,
            },
          },
        },
      }) as unknown as Promise<Array<{ taxon: { taxonId: string } }>>);

      // Update specialization tags with all tags
      for (const pt of allPostTags) {
        const currentCount = stats.allTags.get(pt.taxon.taxonId) || 0;
        stats.allTags.set(pt.taxon.taxonId, currentCount + 1);
      }
    }

    // Filter creators by minimum post count and matching tags
    const validCreators = Array.from(creatorStats.entries()).filter(
      ([_, stats]) =>
        stats.postIds.size >= minPostCount &&
        stats.matchingTags.size >= minMatchingTags,
    );

    // Get creator user details
    const creatorIds = validCreators.map(([id]) => id);
    const creators = await (db.user.findMany({
      where: {
        id: { in: creatorIds },
        suspended: false,
      },
      select: {
        id: true,
        email: true,
        username: true,
      },
    }) as unknown as Promise<
      Array<{ id: string; email: string; username?: string }>
    >);

    const creatorMap = new Map(creators.map((c) => [c.id, c]));

    // Build recommendations
    const recommendations: CreatorRecommendation[] = [];

    for (const [creatorId, stats] of validCreators) {
      const creator = creatorMap.get(creatorId);
      if (!creator) continue;

      // Calculate relevance score
      // Based on: matching tags ratio, post count, specialization strength
      const matchingRatio = stats.matchingTags.size / userEntityTaxonIds.length;
      const postCount = stats.postIds.size;
      const postCountScore = Math.min(postCount / 20, 1); // Normalize to max 20 posts
      const totalTagCount = Array.from(stats.allTags.values()).reduce(
        (a, b) => a + b,
        0,
      );
      const specializationScore = Math.min(totalTagCount / postCount / 3, 1); // Average tags per post, normalized

      const relevanceScore =
        matchingRatio * 0.5 + postCountScore * 0.3 + specializationScore * 0.2;

      // Get top specialization tags (most common tags in their posts)
      const specializationTags = Array.from(stats.allTags.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tagId]) => tagId);

      recommendations.push({
        userId: creator.id,
        email: creator.email,
        username: creator.username,
        relevanceScore,
        matchingTags: Array.from(stats.matchingTags),
        specializationTags,
        postCount: stats.postIds.size,
        reason: `Creates content about ${specializationTags.slice(0, 3).join(", ")}`,
      });
    }

    // Sort by relevance and return top results
    return recommendations
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);
  }
}
