import type { KVNamespace, R2Bucket, CloudflareQueue } from "../types/cloudflare-compat.js";
/**
 * Reaction Handler
 *
 * Handles sentiment reactions on posts and comments.
 *
 * PREPARATORY: Uses DataRouter for region-aware data operations.
 */


import { DataRouter } from "./data-router.js";
import type { Session } from "./session-cookie.js";
import type { TrellisRequestContext } from "./request-context.js";
import { FeedHandler } from "./feed-handler.js";
import { getLogger, generateRequestId } from "./logger.js";
import { Logger, type LoggerEnv } from "./logger.js";

export interface Env {
  DATABASE_URL: string;
  US_DATABASE_URL?: string;
  EU_DATABASE_URL?: string;
  CN_DATABASE_URL?: string;
  FEED_CACHE_KV?: KVNamespace;
  DEFAULT_REGION?: string;
}

const VALID_SENTIMENTS = [
  "joy",
  "gratitude",
  "calm",
  "love",
  "hope",
  "compassion",
  "awe",
  "sadness",
  "anger",
  "fear",
  "insightful",
];

/**
 * The single refusal for `GET /api/posts/:id/sentiments` (H3).
 *
 * "No such post", "another tenant's post" and "not in that post's audience" are
 * byte-identical — the same rule the ActivityPub object routes adopted, for the
 * same reason: a refusal that says which one it was is an existence oracle for
 * private post ids. This is the body the not-found branch already returned.
 */
function postSentimentsDenyResponse(): Response {
  return new Response(JSON.stringify({ error: "Post not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The single refusal for `GET /api/v1/posts/:id/sentiments/users` (H3).
 *
 * Same rule as above, in this endpoint's problem+json shape. `traceId` varies
 * per request, but identically on both branches, so it distinguishes nothing.
 * The wording ("does not exist or has been deleted") is the one the not-found
 * branch already returned and must stay unchanged: making it accurate for the
 * refusal case is precisely what would leak.
 */
function sentimentUsersDenyResponse(
  postId: string,
  requestId: string,
): Response {
  return new Response(
    JSON.stringify({
      type: "https://api.example.com/errors/not-found",
      title: "Post Not Found",
      status: 404,
      detail: `Post with ID '${postId}' does not exist or has been deleted`,
      instance: `/api/v1/posts/${postId}/sentiments/users`,
      traceId: requestId,
    }),
    {
      status: 404,
      headers: { "content-type": "application/problem+json" },
    },
  );
}

export class ReactionHandler {
  // No need to create FeedHandler instance - use static methods to avoid circular dependency

  /**
   * Add or update sentiment reaction on a post
   *
   * PREPARATORY: Uses DataRouter for region-aware operations.
   */
  async addPostSentiment(
    postId: string,
    sentiment: string,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      if (!VALID_SENTIMENTS.includes(sentiment)) {
        return new Response(JSON.stringify({ error: "Invalid sentiment" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      // PREPARATORY: Use DataRouter for region-aware operations
      const requestId = generateRequestId();
      const region = requestContext.region;

      // Verify post exists in correct region using DataRouter
      const post = await DataRouter.getPost(
        postId,
        region,
        env,
        undefined,
        requestId,
        session.userId,
      );

      if (!post) {
        return new Response(JSON.stringify({ error: "Post not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // Check if post is deleted - with timeout/retry
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      const postWithDeleted = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.post.findUnique({
            where: { id: postId },
            select: { deletedAt: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "addPostSentiment_checkDeleted",
            userId: session.userId,
            postId,
          },
        },
      );

      if (postWithDeleted?.deletedAt) {
        return new Response(JSON.stringify({ error: "Post not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // Upsert sentiment reaction (sentiments inherit region from post) - with timeout/retry
      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postSentiment.upsert({
            where: {
              postId_authorId: {
                postId,
                authorId: session.userId,
              },
            },
            create: {
              // Sentiment inherits the owning post's tenant.
              tenantId: (post as any).tenantId,
              postId: post.id,
              postUri: (post as any).uri || null,
              authorId: session.userId,
              sentiment,
            },
            update: {
              sentiment,
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "addPostSentiment",
            userId: session.userId,
            postId,
          },
        },
      );

      // Invalidate sentiment cache
      await this.invalidateSentimentCache(postId, env);

      // Invalidate feed cache (feeds include sentiment counts)
      await FeedHandler.invalidateFeedCache(env as any);

      return new Response(JSON.stringify({ success: true, sentiment }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      getLogger().error("Error adding post sentiment:", error);
      return new Response(
        JSON.stringify({ error: "Failed to add sentiment" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Remove sentiment reaction from a post
   *
   * PREPARATORY: Uses DataRouter for region-aware operations.
   */
  async removePostSentiment(
    postId: string,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      // PREPARATORY: Use DataRouter to get region-specific database
      const region = requestContext.region;

      // PREPARATORY: Verify post exists in correct region first
      const requestId = generateRequestId();
      const post = await DataRouter.getPost(
        postId,
        region,
        env,
        undefined,
        requestId,
      );
      if (!post) {
        return new Response(JSON.stringify({ error: "Post not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // Delete sentiment reaction - with timeout/retry
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postSentiment.deleteMany({
            where: {
              postId,
              authorId: session.userId,
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "removePostSentiment",
            userId: session.userId,
            postId,
          },
        },
      );

      await this.invalidateSentimentCache(postId, env);

      // Invalidate feed cache (feeds include sentiment counts)
      await FeedHandler.invalidateFeedCache(env as any);

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      getLogger().error("Error removing post sentiment:", error);
      return new Response(
        JSON.stringify({ error: "Failed to remove sentiment" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Get sentiment counts for a post
   *
   * PREPARATORY: Uses DataRouter for region-aware operations.
   *
   * H3: reaction counts are an attachment of the post and must not be more
   * readable than it. This previously required no session at all and tested only
   * that the post row existed, so the reaction activity on a WHISPER post was
   * readable by anyone — including an anonymous caller — who knew the id.
   * `session` and `activeTenantId` are now required.
   */
  async getPostSentiments(
    postId: string,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      // PREPARATORY: Use DataRouter to get region-specific database
      const region = requestContext.region;

      // AUTHORIZATION first — same decision as the single-post read.
      const { canReadPost } = await import("./post-read-authorizer.js");
      const permitted = await canReadPost({
        postId,
        viewerUserId: session?.userId ?? "",
        tenantId: activeTenantId,
        region,
        env: env as any,
      });
      if (!permitted) {
        return postSentimentsDenyResponse();
      }

      // Cross-region check + data-access audit, after the gate and refusing
      // with the identical body.
      const requestId = generateRequestId();
      const post = await DataRouter.getPost(
        postId,
        region,
        env,
        undefined,
        requestId,
        session?.userId,
      );
      if (!post) {
        return postSentimentsDenyResponse();
      }

      // Import database helpers
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      // Try to get from cache first
      const cacheKey = `sentiments:${postId}`;
      let sentimentCounts: Record<string, number> = {};

      if (env.FEED_CACHE_KV) {
        try {
          const cached = await env.FEED_CACHE_KV.get(cacheKey);
          if (cached) {
            sentimentCounts = JSON.parse(cached);
          }
        } catch (error) {
          getLogger().warn(
            "Error reading sentiment cache, falling back to database",
            error,
          );
        }
      }

      // If not in cache, fetch from database
      if (Object.keys(sentimentCounts).length === 0) {

        const sentiments = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.postSentiment.groupBy({
              by: ["sentiment"],
              where: { postId },
              _count: true,
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "getPostSentiments_counts",
              userId: session?.userId,
              postId,
            },
          },
        );

        for (const s of sentiments) {
          sentimentCounts[s.sentiment] = s._count;
        }

        // Cache the results for 30 seconds
        if (env.FEED_CACHE_KV) {
          try {
            await env.FEED_CACHE_KV.put(
              cacheKey,
              JSON.stringify(sentimentCounts),
              { expirationTtl: 30 },
            );
          } catch (error) {
            getLogger().warn(
              "Error writing sentiment cache",
              error,
            );
          }
        }
      }

      // Get user's sentiment if authenticated - with timeout/retry
      let userSentiment: string | undefined;
      if (session) {
        const userReaction = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.postSentiment.findUnique({
              where: {
                postId_authorId: {
                  postId,
                  authorId: session.userId,
                },
              },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "getPostSentiments_userReaction",
              userId: session.userId,
              postId,
            },
          },
        );
        userSentiment = userReaction?.sentiment;
      }

      return new Response(
        JSON.stringify({
          sentimentCounts,
          userSentiment,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            // MUST NOT be `public`. This body is now audience-gated AND carries
            // `userSentiment`, which is per-viewer — a shared cache storing it
            // would hand one viewer's reaction to another and would serve a
            // private post's reaction counts to callers the gate refused,
            // defeating the check above for the TTL.
            "cache-control": "private, no-store",
            Vary: "Authorization, Cookie",
          },
        },
      );
    } catch (error: any) {
      getLogger().error("Error getting post sentiments:", error);
      return new Response(
        JSON.stringify({ error: "Failed to get sentiments" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Add or update sentiment reaction on a comment
   *
   * PREPARATORY: Uses DataRouter for region-aware operations.
   */
  async addCommentSentiment(
    commentId: string,
    sentiment: string,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      if (!VALID_SENTIMENTS.includes(sentiment)) {
        return new Response(JSON.stringify({ error: "Invalid sentiment" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      // PREPARATORY: Use DataRouter to get region-specific database
      const region = requestContext.region;

      // Verify comment exists (comments inherit region from post) - with timeout/retry
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      const comment = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.findUnique({
            where: { id: commentId },
            include: { post: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "addCommentSentiment_findComment",
            userId: session.userId,
            commentId,
          },
        },
      );

      if (!comment) {
        return new Response(JSON.stringify({ error: "Comment not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // PREPARATORY: Verify comment's post is in correct region
      if (comment.post.dataRegion && comment.post.dataRegion !== region) {
        return new Response(JSON.stringify({ error: "Comment not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // Upsert sentiment reaction - with timeout/retry
      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.commentSentiment.upsert({
            where: {
              commentId_authorId: {
                commentId,
                authorId: session.userId,
              },
            },
            create: {
              commentId: comment.id,
              commentUri: (comment as any).postUri || null,
              authorId: session.userId,
              sentiment,
            },
            update: {
              sentiment,
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "addCommentSentiment",
            userId: session.userId,
            commentId,
          },
        },
      );

      // Invalidate comment sentiment cache
      await this.invalidateCommentSentimentCache(commentId, env);

      return new Response(JSON.stringify({ success: true, sentiment }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      getLogger().error("Error adding comment sentiment:", error);
      return new Response(
        JSON.stringify({ error: "Failed to add sentiment" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Remove sentiment reaction from a comment
   *
   * PREPARATORY: Uses DataRouter for region-aware operations.
   */
  async removeCommentSentiment(
    commentId: string,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      // PREPARATORY: Use DataRouter to get region-specific database
      const region = requestContext.region;

      // PREPARATORY: Verify comment exists in correct region first - with timeout/retry
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      const comment = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.findUnique({
            where: { id: commentId },
            include: { post: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "removeCommentSentiment_findComment",
            userId: session.userId,
            commentId,
          },
        },
      );

      if (!comment) {
        return new Response(JSON.stringify({ error: "Comment not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // PREPARATORY: Verify comment's post is in correct region
      if (comment.post.dataRegion && comment.post.dataRegion !== region) {
        return new Response(JSON.stringify({ error: "Comment not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // Delete sentiment reaction - with timeout/retry
      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.commentSentiment.deleteMany({
            where: {
              commentId,
              authorId: session.userId,
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "removeCommentSentiment",
            userId: session.userId,
            commentId,
          },
        },
      );

      // Invalidate comment sentiment cache
      await this.invalidateCommentSentimentCache(commentId, env);

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      getLogger().error("Error removing comment sentiment:", error);
      return new Response(
        JSON.stringify({ error: "Failed to remove sentiment" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Get sentiment counts for a comment
   *
   * PREPARATORY: Uses DataRouter for region-aware operations.
   */
  async getCommentSentiments(
    commentId: string,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      // PREPARATORY: Use DataRouter to get region-specific database
      const region = requestContext.region;

      // PREPARATORY: Verify comment exists in correct region first - with timeout/retry
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      const comment = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.findUnique({
            where: { id: commentId },
            include: { post: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "getCommentSentiments_findComment",
            commentId,
          },
        },
      );

      if (!comment) {
        return new Response(JSON.stringify({ error: "Comment not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // PREPARATORY: Verify comment's post is in correct region
      if (comment.post.dataRegion && comment.post.dataRegion !== region) {
        return new Response(JSON.stringify({ error: "Comment not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // Try to get from cache first
      const cacheKey = `sentiments:comment:${commentId}`;
      let sentimentCounts: Record<string, number> = {};

      if (env.FEED_CACHE_KV) {
        try {
          const cached = await env.FEED_CACHE_KV.get(cacheKey);
          if (cached) {
            sentimentCounts = JSON.parse(cached);
          }
        } catch (error) {
          getLogger().warn(
            "Error reading comment sentiment cache, falling back to database",
            error,
          );
        }
      }

      // If not in cache, fetch from database
      if (Object.keys(sentimentCounts).length === 0) {
        const sentiments = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.commentSentiment.groupBy({
              by: ["sentiment"],
              where: { commentId },
              _count: true,
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "getCommentSentiments_counts",
              commentId,
            },
          },
        );

        for (const s of sentiments) {
          sentimentCounts[s.sentiment] = s._count;
        }

        // Cache the results for 30 seconds
        if (env.FEED_CACHE_KV) {
          try {
            await env.FEED_CACHE_KV.put(
              cacheKey,
              JSON.stringify(sentimentCounts),
              { expirationTtl: 30 },
            );
          } catch (error) {
            getLogger().warn(
              "Error writing comment sentiment cache",
              error,
            );
          }
        }
      }

      return new Response(JSON.stringify({ sentimentCounts }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=30, stale-while-revalidate=60",
        },
      });
    } catch (error: any) {
      getLogger().error("Error getting comment sentiments:", error);
      return new Response(
        JSON.stringify({ error: "Failed to get sentiments" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Invalidate sentiment cache
   */
  private async invalidateSentimentCache(
    postId: string,
    env: Env,
  ): Promise<void> {
    const kv = env.FEED_CACHE_KV;
    if (!kv) return;

    try {
      await kv.delete(`sentiments:${postId}`);
    } catch (error) {
      getLogger().error(
        "Error invalidating sentiment cache:",
        error,
      );
    }
  }

  /**
   * Invalidate comment sentiment cache
   */
  private async invalidateCommentSentimentCache(
    commentId: string,
    env: Env,
  ): Promise<void> {
    const kv = env.FEED_CACHE_KV;
    if (!kv) return;

    try {
      await kv.delete(`sentiments:comment:${commentId}`);
    } catch (error) {
      getLogger().error(
        "Error invalidating comment sentiment cache:",
        error,
      );
    }
  }

  /**
   * Get users who reacted to a post ("who reacted" feature)
   *
   * Two modes:
   * 1. Summary mode (sentiment = null): Returns counts + top 3 users per sentiment
   * 2. Detailed mode (sentiment provided): Returns paginated list of users for that sentiment
   *
   * Uses window functions for optimal performance (eliminates N+1 queries)
   *
   * H3: this discloses WHO reacted — identities, not just counts — and it
   * previously required no session and applied no tenant or audience predicate,
   * so the reader list of a WHISPER post was public to anyone with the id.
   * `session` and `activeTenantId` are now required.
   */
  async getPostSentimentUsers(
    postId: string,
    sentiment: string | null,
    limit: number,
    cursor: string | null,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    const logger = getLogger();
    const startTime = Date.now();

    try {
      const region = requestContext.region;
      const requestId = generateRequestId();

      // AUTHORIZATION first — same decision as the single-post read.
      const { canReadPost } = await import("./post-read-authorizer.js");
      const permitted = await canReadPost({
        postId,
        viewerUserId: session?.userId ?? "",
        tenantId: activeTenantId,
        region,
        env: env as any,
      });
      if (!permitted) {
        return sentimentUsersDenyResponse(postId, requestId);
      }

      // Cross-region check + data-access audit, after the gate and refusing
      // with the identical body.
      const post = await DataRouter.getPost(
        postId,
        region,
        env,
        undefined,
        requestId,
        session?.userId,
      );

      if (!post) {
        return sentimentUsersDenyResponse(postId, requestId);
      }

      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      if (!sentiment) {
        // Summary mode: Get counts + top 3 users per sentiment using window function
        const results = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.$queryRaw<
              Array<{
                sentiment: string;
                totalCount: number;
                userId: string;
                handle: string | null;
                displayName: string | null;
                avatar: string | null;
              }>
            >`
              WITH RankedReactions AS (
                SELECT
                  ps.sentiment,
                  ps.created_at,
                  u.id AS "userId",
                  u.handle,
                  u.email AS "displayName",
                  '' AS avatar,
                  ROW_NUMBER() OVER (
                    PARTITION BY ps.sentiment
                    ORDER BY ps.created_at DESC
                  ) AS rn,
                  COUNT(*) OVER (
                    PARTITION BY ps.sentiment
                  ) AS "totalCount"
                FROM post_sentiments ps
                JOIN users u ON ps.author_id = u.id
                WHERE ps.post_id = ${postId}
              )
              SELECT
                sentiment,
                "totalCount",
                "userId",
                handle,
                "displayName",
                avatar
              FROM RankedReactions
              WHERE rn <= 3
              ORDER BY "totalCount" DESC, sentiment
            `;
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "getPostSentimentUsers_summary",
              userId: session?.userId,
              postId,
            },
          },
        );

        // Group by sentiment
        const summary = new Map<
          string,
          {
            sentiment: string;
            count: number;
            topUsers: Array<{
              userId: string;
              handle: string | null;
              displayName: string | null;
              avatar: string | null;
            }>;
            hasMore: boolean;
          }
        >();

        for (const row of results) {
          if (!summary.has(row.sentiment)) {
            summary.set(row.sentiment, {
              sentiment: row.sentiment,
              count: row.totalCount,
              topUsers: [],
              hasMore: row.totalCount > 3,
            });
          }

          summary.get(row.sentiment)!.topUsers.push({
            userId: row.userId,
            handle: row.handle,
            displayName: row.displayName,
            avatar: row.avatar,
          });
        }

        // Calculate total count (sum of unique sentiment counts)
        const totalCount = Array.from(summary.values()).reduce(
          (sum, s) => sum + s.count,
          0,
        );

        const duration = Date.now() - startTime;
        logger.info("Sentiment users fetched (summary mode)", {
          postId,
          sentimentCount: summary.size,
          totalCount,
          duration,
          traceId: requestId,
        });

        return new Response(
          JSON.stringify({
            summary: Array.from(summary.values()),
            totalCount,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=30, stale-while-revalidate=60",
              "x-ratelimit-limit": "60",
              "x-ratelimit-remaining": "59",
              "x-ratelimit-reset": String(
                Math.floor(Date.now() / 1000) + 60,
              ),
            },
          },
        );
      } else {
        // Detailed mode: Get paginated users for specific sentiment
        const decodedCursor = cursor
          ? JSON.parse(atob(cursor))
          : null;

        const users = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.postSentiment.findMany({
              where: {
                postId,
                sentiment,
                ...(decodedCursor && {
                  OR: [
                    { createdAt: { lt: new Date(decodedCursor.lastCreatedAt) } },
                    {
                      AND: [
                        { createdAt: new Date(decodedCursor.lastCreatedAt) },
                        { id: { lt: decodedCursor.lastId } },
                      ],
                    },
                  ],
                }),
              },
              include: {
                post: {
                  select: {
                    id: true,
                    authorId: true,
                  },
                },
              },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: limit + 1,
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "getPostSentimentUsers_detailed",
              userId: session?.userId,
              postId,
              sentiment,
            },
          },
        );

        const hasMore = users.length > limit;
        const items = users.slice(0, limit);

        // Get total count for this sentiment
        const totalCount = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.postSentiment.count({
              where: { postId, sentiment },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "getPostSentimentUsers_count",
              postId,
              sentiment,
            },
          },
        );

        // Fetch user details for each reaction
        const userIds = items.map((item) => item.authorId);
        const userDetails = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.user.findMany({
              where: { id: { in: userIds } },
              select: {
                id: true,
                handle: true,
                email: true,
              },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "getPostSentimentUsers_userDetails",
              userIds: userIds.length,
            },
          },
        );

        const userMap = new Map(userDetails.map((u) => [u.id, u]));

        const responseUsers = items.map((item) => {
          const user = userMap.get(item.authorId);
          return {
            userId: item.authorId,
            handle: user?.handle || null,
            displayName: user?.email || null,
            avatar: null,
            reactedAt: item.createdAt.toISOString(),
          };
        });

        const nextCursor = hasMore
          ? btoa(
              JSON.stringify({
                lastId: items[items.length - 1].id,
                lastCreatedAt: items[items.length - 1].createdAt.toISOString(),
              }),
            )
          : null;

        const duration = Date.now() - startTime;
        logger.info("Sentiment users fetched (detailed mode)", {
          postId,
          sentiment,
          userCount: responseUsers.length,
          hasMore,
          duration,
          traceId: requestId,
        });

        return new Response(
          JSON.stringify({
            sentiment,
            totalCount,
            users: responseUsers,
            hasMore,
            nextCursor,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=30, stale-while-revalidate=60",
              "x-ratelimit-limit": "60",
              "x-ratelimit-remaining": "59",
              "x-ratelimit-reset": String(
                Math.floor(Date.now() / 1000) + 60,
              ),
            },
          },
        );
      }
    } catch (error: any) {
      const duration = Date.now() - startTime;
      logger.error("Error getting sentiment users:", {
        error: error.message,
        postId,
        sentiment,
        duration,
      });

      return new Response(
        JSON.stringify({
          type: "https://api.example.com/errors/internal-server-error",
          title: "Internal Server Error",
          status: 500,
          detail: "Failed to fetch sentiment users",
          instance: `/api/v1/posts/${postId}/sentiments/users`,
          traceId: generateRequestId(),
        }),
        {
          status: 500,
          headers: { "content-type": "application/problem+json" },
        },
      );
    }
  }
}
