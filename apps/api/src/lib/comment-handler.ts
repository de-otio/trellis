import type { KVNamespace, R2Bucket, CloudflareQueue } from "../types/cloudflare-compat.js";
/**
 * Comment Handler
 *
 * Handles comment creation, retrieval, and hiding.
 *
 * PREPARATORY: Uses DataRouter for region-aware data operations.
 */


import { DataRouter } from "./data-router.js";
import { FeedHandler } from "./feed-handler.js";
import { getLogger, Logger, generateRequestId } from "./logger.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { Session } from "./session-cookie.js";

export interface Env {
  DATABASE_URL: string;
  US_DATABASE_URL?: string;
  EU_DATABASE_URL?: string;
  CN_DATABASE_URL?: string;
  GOOGLE_API_KEY?: string; // Google API key for Perspective API (text moderation)
  MODERATION_CACHE_KV?: KVNamespace;
  FEED_CACHE_KV?: KVNamespace;
  COMMENTS_KV?: KVNamespace;
  LINK_CHECK_QUEUE?: any; // Cloudflare Queue binding for link checks
  DEFAULT_REGION?: string;
}

export interface CreateCommentRequest {
  text: string;
  media?: Array<{
    file: File | Blob;
    alt?: string;
    mimeType: string;
  }>;
}

export class CommentHandler {
  // No need to create FeedHandler instance - use static methods to avoid circular dependency

  constructor() {}

  /**
   * Create a comment on a post
   *
   * PREPARATORY: Uses DataRouter for region-aware operations.
   */
  async createComment(
    postId: string,
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
    activeTenantId: string,
    parentCommentId?: string,
  ): Promise<Response> {
    try {
      // Validate request body with Zod schema
      const { validateRequest } = await import("./validate-request.js");
      const { createCommentSchema } = await import("./schemas.js");

      const validation = await validateRequest(request, createCommentSchema);
      if (!validation.success) {
        return validation.error;
      }
      const body = validation.data;

      // Check rate limits BEFORE any other operations
      const { commentRateLimit } = await import(
        "./middleware/comment-rate-limit.js"
      );
      const rateLimitResult = await commentRateLimit(
        session.userId,
        postId,
        env as any,
      );

      if (!rateLimitResult.allowed) {
        return new Response(
          JSON.stringify({
            error: "RATE_LIMITED",
            message: "You're commenting too quickly. Please wait a moment.",
            retryAfter: rateLimitResult.retryAfter,
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "Retry-After": (rateLimitResult.retryAfter || 30).toString(),
            },
          },
        );
      }

      // PREPARATORY: Use DataRouter for region-aware operations
      const requestId = generateRequestId();
      const region = requestContext.region;

      // Verify post exists in correct region using DataRouter
      const post = await DataRouter.getPost(
        postId,
        region,
        env,
        request,
        requestId,
        session.userId,
      );

      if (!post) {
        return new Response(JSON.stringify({ error: "Post not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // Check if post is deleted (need to query database for deletedAt) - with timeout/retry
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
            operation: "createComment_checkDeleted",
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

      // Check if content moderation is enabled via feature toggle
      const { FeatureToggleService } = await import("./feature-toggle-service.js");
      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);
      const toggleService = new FeatureToggleService(db);
      // Fail-closed-to-ENABLED (AR-SEC T4 / F1): a missing/unseeded row or a
      // toggle-read error must MODERATE, never silently skip the gate. Only an
      // explicit `content_moderation_enabled = false` disables (escape hatch).
      const moderationEnabled = await toggleService.isEnabledFailClosed(
        "content_moderation_enabled",
      );

      // Moderate text content (if moderation is enabled) through the
      // fail-closed TextModerationProvider seam (quarantine → 400,
      // review/fault → 503; only affirmative approval proceeds).
      if (moderationEnabled) {
        const { gateTextOrRespond } = await import("./text-moderation-gate.js");
        const gateResponse = await gateTextOrRespond(
          body.text,
          "Your comment contains inappropriate content. Please be more constructive.",
        );
        if (gateResponse) {
          return gateResponse;
        }
      } else {
        getLogger().debug(
          "[CommentHandler] Content moderation is disabled via feature toggle",
        );
      }

      // Check for malicious links
      const { LinkSecurityHandler, LinkStatus } = await import(
        "./link-security-handler.js"
      );
      const linkSecurityHandler = new LinkSecurityHandler(env as any);
      const urls = linkSecurityHandler.extractUrls(body.text);
      let hasBlockedLinks = false;
      const linkChecks: Array<{
        originalUrl: string;
        normalizedUrl: string;
        domain: string;
        status: string;
      }> = [];

      for (const url of urls) {
        const validation = linkSecurityHandler.validateUrlSync(url);

        if (validation.status === LinkStatus.BLOCKED) {
          hasBlockedLinks = true;
          getLogger().warn(
            `Blocked dangerous URL in comment: ${url}`,
            {
              reason: validation.reason,
              userId: session.userId,
              postId,
            },
          );
        }

        if (validation.normalizedUrl) {
          linkChecks.push({
            originalUrl: url,
            normalizedUrl: validation.normalizedUrl.normalized,
            domain: validation.normalizedUrl.domain,
            status: validation.status,
          });
        }
      }

      // Block comment creation if dangerous links detected
      if (hasBlockedLinks) {
        return new Response(
          JSON.stringify({
            error: "DANGEROUS_LINKS_DETECTED",
            message:
              "Your comment contains dangerous or blocked links. Please remove them and try again.",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Sanitize user input to prevent XSS
      const { InputSanitizer } = await import("./input-sanitizer.js");
      const sanitizedText = InputSanitizer.sanitizeText(body.text);

      // Handle threading for replies
      let rootUri: string | null = null;
      let replyToUri: string | null = null;

      if (parentCommentId) {
        // Fetch parent comment to get thread context
        const parentComment = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.postComment.findFirst({
              where: { id: parentCommentId, tenantId: activeTenantId },
              select: {
                id: true,
                postId: true,
                postUri: true,
                rootUri: true,
                replyToUri: true,
                deletedAt: true,
              },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 2,
            baseDelayMs: 100,
            context: {
              operation: "createComment_getParentComment",
              userId: session.userId,
              parentCommentId,
            },
          },
        );

        // Validate parent comment exists
        if (!parentComment) {
          return new Response(
            JSON.stringify({ error: "Parent comment not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        // Validate parent is not deleted
        if (parentComment.deletedAt) {
          return new Response(
            JSON.stringify({ error: "Cannot reply to deleted comment" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Validate parent is in the same post
        if (parentComment.postId !== postId) {
          return new Response(
            JSON.stringify({ error: "Parent comment not in this post" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Set threading URIs
        // If parent has rootUri, inherit it (nested reply)
        // Otherwise, use parent's postUri as root (top-level reply)
        rootUri = parentComment.rootUri || parentComment.postUri || null;

        // Build replyToUri pointing to parent comment
        // For now, use the parent's postUri or a simple reference
        replyToUri = parentComment.postUri || `comment:${parentComment.id}`;
      }

      // Check for duplicate comments (same user, same post, same text within 5 minutes)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const recentDuplicate = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.findFirst({
            where: {
              postId: post.id,
              tenantId: activeTenantId,
              authorId: session.userId,
              text: sanitizedText.trim(),
              createdAt: { gte: fiveMinutesAgo },
              deletedAt: null, // Don't match deleted comments
            },
            orderBy: { createdAt: "desc" },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 2,
          baseDelayMs: 100,
          context: {
            operation: "createComment_checkDuplicate",
            userId: session.userId,
            postId: post.id,
          },
        },
      );

      if (recentDuplicate) {
        getLogger().info(
          `[CommentHandler] Duplicate comment detected for user ${session.userId} on post ${post.id}`,
          {
            commentId: recentDuplicate.id,
            originalCreatedAt: recentDuplicate.createdAt,
          },
        );

        // Return existing comment with duplicate flag (200, not 201)
        return new Response(
          JSON.stringify({
            id: recentDuplicate.id,
            text: recentDuplicate.text,
            authorId: recentDuplicate.authorId,
            createdAt: recentDuplicate.createdAt.toISOString(),
            editedAt: recentDuplicate.editedAt?.toISOString() || null,
            deletedAt: recentDuplicate.deletedAt?.toISOString() || null,
            sentimentCounts: {},
            links: [],
            rootUri: recentDuplicate.rootUri || null,
            replyToUri: recentDuplicate.replyToUri || null,
            duplicate: true,
            message: "This comment was already posted",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Create comment in database (comments inherit region from post) - with timeout/retry
      const comment = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.create({
            data: {
              postId: post.id,
              postUri: (post as any).uri || null,
              authorId: session.userId,
              text: sanitizedText.trim(),
              hasBlockedLinks: hasBlockedLinks,
              rootUri: rootUri,
              replyToUri: replyToUri,
              tenantId: activeTenantId,
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "createComment",
            userId: session.userId,
            postId: post.id,
          },
        },
      );

      // Create LinkCheck records and queue threat intel checks
      if (linkChecks.length > 0) {
        try {
          const { createPrisma } = await import("../db.js");
          const db = createPrisma(env);

          // Ensure domain reputation records exist
          const domains = [...new Set(linkChecks.map((lc) => lc.domain))];
          for (const domain of domains) {
            await db.domainReputation.upsert({
              where: { domain },
              create: {
                domain,
                reputation: 0,
                status: "unknown",
              },
              update: {},
            });
          }

          // Create LinkCheck records
          const linkCheckPromises = linkChecks.map(async (linkCheck) => {
            const check = await db.linkCheck.create({
              data: {
                // LinkCheck inherits the owning comment's tenant.
                tenantId: activeTenantId,
                commentId: comment.id,
                originalUrl: linkCheck.originalUrl,
                normalizedUrl: linkCheck.normalizedUrl,
                domain: linkCheck.domain,
                status: linkCheck.status,
                checkType: "async",
              },
            });

            // Queue threat intel check if queue is available
            if (env.LINK_CHECK_QUEUE) {
              try {
                await env.LINK_CHECK_QUEUE.send({
                  linkCheckId: check.id,
                  url: linkCheck.normalizedUrl,
                  domain: linkCheck.domain,
                });
              } catch (queueError) {
                getLogger().warn(
                  "Failed to queue threat intel check:",
                  queueError,
                );
              }
            }

            return check;
          });

          await Promise.all(linkCheckPromises);
        } catch (error) {
          // Log error but don't fail comment creation if link checks fail
          getLogger().error(
            "Error creating link checks:",
            error,
          );
        }
      }

      // Note: AT Protocol integration removed
      let commentUri: string | undefined;

      // Invalidate comment cache
      await this.invalidateCommentCache(postId, env);

      // Invalidate feed cache (feeds include comment counts)
      await FeedHandler.invalidateFeedCache(env as any);

      // Fetch link checks for response
      let linksResponse:
        | Array<{
            id: string;
            originalUrl: string;
            normalizedUrl: string;
            domain: string;
            status: string;
          }>
        | undefined;
      if (linkChecks.length > 0) {
        try {
          const { getWrappedDatabase } = await import(
            "./database-wrapper-helper.js"
          );
          const db = getWrappedDatabase(region, env, request);
          const linkChecksFromDb = await db.linkCheck.findMany({
            where: { commentId: comment.id },
            select: {
              id: true,
              originalUrl: true,
              normalizedUrl: true,
              domain: true,
              status: true,
            },
          });
          linksResponse = linkChecksFromDb.map((lc) => ({
            id: lc.id,
            originalUrl: lc.originalUrl,
            normalizedUrl: lc.normalizedUrl,
            domain: lc.domain,
            status: lc.status,
          }));
        } catch (error: any) {
          // If fetching link checks fails, just continue without them
          getLogger().error(
            "Error fetching link checks for response:",
            error,
          );
        }
      }

      const responseData: any = {
        id: comment.id,
        uri: commentUri,
        text: comment.text,
        authorId: comment.authorId,
        createdAt: comment.createdAt.toISOString(),
        editedAt: comment.editedAt?.toISOString() || null,
        deletedAt: comment.deletedAt?.toISOString() || null,
        sentimentCounts: {},
        links: linksResponse || [],
        rootUri: comment.rootUri || null,
        replyToUri: comment.replyToUri || null,
      };

      return new Response(JSON.stringify(responseData), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      getLogger().error("Error creating comment:", error);
      return new Response(
        JSON.stringify({ error: "Failed to create comment" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Create a reply to an existing comment
   * Uses the existing createComment() logic with parentCommentId
   */
  async createReply(
    parentCommentId: string,
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      // Fetch parent comment to get postId and validate it exists
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );
      const region = requestContext.region;

      const parentComment = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.findFirst({
            where: { id: parentCommentId, tenantId: activeTenantId },
            select: { postId: true, deletedAt: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 2,
          baseDelayMs: 100,
          context: {
            operation: "createReply_getParentComment",
            userId: session.userId,
            parentCommentId,
          },
        },
      );

      if (!parentComment) {
        return new Response(
          JSON.stringify({ error: "Parent comment not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      if (parentComment.deletedAt) {
        return new Response(
          JSON.stringify({ error: "Cannot reply to deleted comment" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Delegate to createComment() with parentCommentId
      return this.createComment(
        parentComment.postId,
        request,
        session,
        env,
        requestContext,
        activeTenantId,
        parentCommentId,
      );
    } catch (error: any) {
      getLogger().error("Error creating reply:", error);
      return new Response(
        JSON.stringify({ error: "Failed to create reply" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Get comments for a post
   *
   * PREPARATORY: Uses DataRouter for region-aware operations.
   */
  async getComments(
    postId: string,
    request: Request,
    session: Session,
    options: { limit?: number; cursor?: string },
    env: Env,
    requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      // PREPARATORY: Use DataRouter to get region-specific database
      const region = requestContext.region;
      const limit = Math.min(options.limit || 20, 100);
      const cursor = options.cursor ? new Date(options.cursor) : undefined;

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

      // Fetch comments (excluding hidden ones) - with timeout/retry
      // Comments are linked to posts, so they inherit the post's region
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      const comments = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.findMany({
            where: {
              postId,
              tenantId: activeTenantId,
              hiddenByPostOwner: false,
              deletedAt: null, // Filter out soft-deleted comments
              ...(cursor && { createdAt: { lt: cursor } }),
            },
            orderBy: { createdAt: "desc" },
            take: limit + 1,
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "getComments",
            userId: session?.userId,
            postId,
          },
        },
      );

      const hasMore = comments.length > limit;
      const result = hasMore ? comments.slice(0, limit) : comments;
      const nextCursor =
        hasMore && result.length > 0
          ? result[result.length - 1].createdAt.toISOString()
          : undefined;

      // Get sentiment counts for each comment - with timeout/retry
      const commentIds = result.map((c) => c.id);
      const sentiments = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.commentSentiment.groupBy({
            by: ["commentId", "sentiment"],
            where: { commentId: { in: commentIds } },
            _count: true,
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "getComments_sentiments",
            userId: session?.userId,
            postId,
          },
        },
      );

      const sentimentCounts: Record<string, Record<string, number>> = {};
      for (const s of sentiments) {
        if (!sentimentCounts[s.commentId]) {
          sentimentCounts[s.commentId] = {};
        }
        sentimentCounts[s.commentId][s.sentiment] = s._count;
      }

      // Fetch link checks for all comments
      const commentLinkChecks: Record<
        string,
        Array<{
          id: string;
          originalUrl: string;
          normalizedUrl: string;
          domain: string;
          status: string;
        }>
      > = {};

      if (commentIds.length > 0) {
        try {
          const { getWrappedDatabase } = await import(
            "./database-wrapper-helper.js"
          );
          const db = getWrappedDatabase(region, env, request);
          const allLinkChecks = await db.linkCheck.findMany({
            where: { commentId: { in: commentIds } },
            select: {
              id: true,
              commentId: true,
              originalUrl: true,
              normalizedUrl: true,
              domain: true,
              status: true,
            },
          });

          for (const lc of allLinkChecks) {
            if (!lc.commentId) continue;
            if (!commentLinkChecks[lc.commentId]) {
              commentLinkChecks[lc.commentId] = [];
            }
            commentLinkChecks[lc.commentId].push({
              id: lc.id,
              originalUrl: lc.originalUrl,
              normalizedUrl: lc.normalizedUrl,
              domain: lc.domain,
              status: lc.status,
            });
          }
        } catch (error: any) {
          // If fetching link checks fails, just continue without them
          getLogger().error(
            "Error fetching link checks for comments:",
            error,
          );
        }
      }

      return new Response(
        JSON.stringify({
          comments: result.map((c) => {
            const commentData: any = {
              id: c.id,
              uri: c.postUri,
              text: c.text,
              authorId: c.authorId,
              createdAt: c.createdAt.toISOString(),
              replyToUri: c.replyToUri,
              sentimentCounts: sentimentCounts[c.id] || {},
            };

            if (commentLinkChecks[c.id] && commentLinkChecks[c.id].length > 0) {
              commentData.links = commentLinkChecks[c.id];
            }

            return commentData;
          }),
          cursor: nextCursor,
          hasMore,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      getLogger().error("Error getting comments:", error);
      return new Response(JSON.stringify({ error: "Failed to get comments" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Hide a comment
   *
   * PREPARATORY: Uses DataRouter for region-aware operations.
   */
  async hideComment(
    commentId: string,
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      // PREPARATORY: Use DataRouter to get region-specific database
      const region = requestContext.region;

      // Verify comment exists and user is post owner - with timeout/retry
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
          return await db.postComment.findFirst({
            where: { id: commentId, tenantId: activeTenantId },
            include: { post: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "hideComment_findComment",
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

      // PREPARATORY: Verify post is in correct region
      if (comment.post.dataRegion && comment.post.dataRegion !== region) {
        return new Response(JSON.stringify({ error: "Post not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      if (comment.post.authorId !== session.userId) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }

      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.update({
            where: { id: commentId },
            data: { hiddenByPostOwner: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "hideComment_update",
            userId: session.userId,
            commentId,
          },
        },
      );

      await this.invalidateCommentCache(comment.postId, env);

      // Invalidate feed cache (feeds include comment counts)
      await FeedHandler.invalidateFeedCache(env as any);

      return new Response(
        JSON.stringify({
          success: true,
          message: "Comment hidden successfully",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      getLogger().error("Error hiding comment:", error);
      return new Response(JSON.stringify({ error: "Failed to hide comment" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Unhide a comment
   *
   * PREPARATORY: Uses DataRouter for region-aware operations.
   */
  async unhideComment(
    commentId: string,
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      // PREPARATORY: Use DataRouter to get region-specific database
      const region = requestContext.region;

      // Verify comment exists and user is post owner - with timeout/retry
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
          return await db.postComment.findFirst({
            where: { id: commentId, tenantId: activeTenantId },
            include: { post: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "unhideComment_findComment",
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

      // PREPARATORY: Verify post is in correct region
      if (comment.post.dataRegion && comment.post.dataRegion !== region) {
        return new Response(JSON.stringify({ error: "Post not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      if (comment.post.authorId !== session.userId) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }

      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.update({
            where: { id: commentId },
            data: { hiddenByPostOwner: false },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "unhideComment_update",
            userId: session.userId,
            commentId,
          },
        },
      );

      await this.invalidateCommentCache(comment.postId, env);

      // Invalidate feed cache (feeds include comment counts)
      await FeedHandler.invalidateFeedCache(env as any);

      return new Response(
        JSON.stringify({
          success: true,
          message: "Comment unhidden successfully",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      getLogger().error("Error unhiding comment:", error);
      return new Response(
        JSON.stringify({ error: "Failed to unhide comment" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Edit a comment (15-minute window)
   *
   * PREPARATORY: Uses DataRouter for region-aware operations.
   */
  async editComment(
    commentId: string,
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      // Validate request body
      const { validateRequest } = await import("./validate-request.js");
      const { z } = await import("zod");
      // .trim() runs BEFORE .min()/.max() so whitespace-only text fails
      // length validation instead of passing min(1) and then trimming to ""
      // downstream (fail-closed: reject at the schema boundary, never
      // persist empty content).
      const editCommentSchema = z.object({
        text: z.string().trim().min(1).max(3000),
      });

      const validation = await validateRequest(request, editCommentSchema);
      if (!validation.success) {
        return validation.error;
      }
      const body = validation.data;

      const region = requestContext.region;
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      // Get comment with post info
      const comment = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.findFirst({
            where: { id: commentId, tenantId: activeTenantId },
            include: { post: { select: { id: true, authorId: true } } },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "editComment_findComment",
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

      // Check ownership
      if (comment.authorId !== session.userId) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }

      // Check if comment is deleted
      if (comment.deletedAt) {
        return new Response(
          JSON.stringify({ error: "Cannot edit deleted comment" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Check edit window (15 minutes)
      const minutesOld = (Date.now() - comment.createdAt.getTime()) / 1000 / 60;
      if (minutesOld > 15) {
        return new Response(
          JSON.stringify({
            error: "EDIT_WINDOW_EXPIRED",
            message: "Comments can only be edited within 15 minutes of posting",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Sanitize new text
      const { InputSanitizer } = await import("./input-sanitizer.js");
      const sanitizedText = InputSanitizer.sanitizeText(body.text);

      // Check if content moderation is enabled
      const { FeatureToggleService } = await import("./feature-toggle-service.js");
      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);
      const toggleService = new FeatureToggleService(db);
      // Fail-closed-to-ENABLED (AR-SEC T4 / F1): a missing/unseeded row or a
      // toggle-read error must MODERATE, never silently skip the gate. Only an
      // explicit `content_moderation_enabled = false` disables (escape hatch).
      const moderationEnabled = await toggleService.isEnabledFailClosed(
        "content_moderation_enabled",
      );

      // Re-run moderation if enabled, through the fail-closed
      // TextModerationProvider seam (quarantine → 400, review/fault → 503;
      // only affirmative approval proceeds).
      if (moderationEnabled) {
        const { gateTextOrRespond } = await import("./text-moderation-gate.js");
        const gateResponse = await gateTextOrRespond(
          sanitizedText,
          "Your comment contains inappropriate content. Please be more constructive.",
        );
        if (gateResponse) {
          return gateResponse;
        }
      }

      // Update comment
      const updatedComment = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.update({
            where: { id: commentId },
            data: {
              text: sanitizedText.trim(),
              editedAt: new Date(),
              // Preserve original text on first edit
              originalText: comment.originalText || comment.text,
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "editComment_update",
            userId: session.userId,
            commentId,
          },
        },
      );

      // Invalidate cache
      await this.invalidateCommentCache(comment.post.id, env);
      await FeedHandler.invalidateFeedCache(env as any);

      return new Response(
        JSON.stringify({
          id: updatedComment.id,
          text: updatedComment.text,
          editedAt: updatedComment.editedAt?.toISOString(),
          message: "Comment updated successfully",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      getLogger().error("Error editing comment:", error);
      return new Response(JSON.stringify({ error: "Failed to edit comment" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Delete a comment (soft delete)
   *
   * Author or post owner can delete.
   * PREPARATORY: Uses DataRouter for region-aware operations.
   */
  async deleteComment(
    commentId: string,
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      const region = requestContext.region;
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      // Get comment with post info
      const comment = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.findFirst({
            where: { id: commentId, tenantId: activeTenantId },
            include: {
              post: { select: { id: true, authorId: true } },
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "deleteComment_findComment",
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

      // Check if already deleted
      if (comment.deletedAt) {
        return new Response(
          JSON.stringify({ error: "Comment already deleted" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Check authorization (comment author OR post owner)
      const isAuthor = comment.authorId === session.userId;
      const isPostOwner = comment.post.authorId === session.userId;

      if (!isAuthor && !isPostOwner) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }

      // Soft delete
      const deletedComment = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.update({
            where: { id: commentId },
            data: {
              deletedAt: new Date(),
              deletedBy: session.userId,
              text: "[deleted]",
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "deleteComment_update",
            userId: session.userId,
            commentId,
          },
        },
      );

      // Invalidate cache
      await this.invalidateCommentCache(comment.post.id, env);
      await FeedHandler.invalidateFeedCache(env as any);

      return new Response(
        JSON.stringify({
          id: deletedComment.id,
          message: "Comment deleted successfully",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      getLogger().error("Error deleting comment:", error);
      return new Response(
        JSON.stringify({ error: "Failed to delete comment" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Invalidate comment cache
   */
  private async invalidateCommentCache(
    postId: string,
    env: Env,
  ): Promise<void> {
    const kv = env.COMMENTS_KV || env.FEED_CACHE_KV;
    if (!kv) return;

    try {
      await kv.delete(`comments:${postId}`);
    } catch (error) {
      getLogger().error(
        "Error invalidating comment cache:",
        error,
      );
    }
  }
}
