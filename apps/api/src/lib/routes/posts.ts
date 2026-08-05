/**
 * Posts Routes
 */

import { DataRouter } from "../data-router.js";
import { FeedHandler } from "../feed-handler.js";
import { getWrappedDatabase } from "../database-wrapper-helper.js";
import { EntityTaggingError } from "../entity-tagging-errors.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { PostHandler } from "../post-handler.js";
import { RateLimiter } from "../rate-limit.js";
import { createRequestContext } from "../request-context.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { TagSuggestionsHandler } from "../tag-suggestions-handler.js";
import { TaxonomyHandler } from "../taxonomy-handler.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";

export const postsRoutes: Route[] = [
  {
    path: "/api/posts",
    method: "POST",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const validator = new Validator();
      const postHandler = new PostHandler();
      const sessionSecret = env.SESSION_SECRET;
      const session = await sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      // Apply rate limiting: 100 posts per hour per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/posts",
        100, // max requests
        3600, // per hour
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const response = await postHandler.createPost(
          request,
          session,
          env as any,
          requestContext,
          auth.activeTenantId,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error: any) {
        logger.error("Error creating post:", error);

        // Handle entity tagging errors with proper status codes
        if (error instanceof EntityTaggingError) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({
              error: error.code,
              message: error.message,
            }),
            {
              status: error.statusCode,
              headers: { "content-type": "application/json" },
            },
          );
        }

        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Create post",
  },

  {
    path: /^\/api\/posts\/([^/]+)$/,
    method: "DELETE",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const postHandler = new PostHandler();
      const sessionSecret = env.SESSION_SECRET;
      const session = await sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const postId = pathname.split("/api/posts/")[1];
        const response = await postHandler.deletePost(
          postId,
          request,
          session,
          env as any,
          requestContext,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error deleting post:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Delete post",
  },

  // Edit post (PATCH /api/posts/:postId)
  // Requirements: 4.1, 10.1, 10.2
  {
    path: /^\/api\/posts\/([^/]+)$/,
    method: "PATCH",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const validator = new Validator();
      const postHandler = new PostHandler();
      const sessionSecret = env.SESSION_SECRET;
      const session = await sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      // Apply rate limiting: 10 edits per minute per user (Requirement 10.2)
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/posts/:postId/edit",
        10, // max 10 edits
        60, // per minute
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const postId = pathname.split("/api/posts/")[1];
        const response = await postHandler.editPost(
          postId,
          request,
          session,
          env as any,
          requestContext,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error editing post:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Edit post",
  },

  {
    path: /^\/api\/posts\/([^/]+)\/hide$/,
    method: "PATCH",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const postHandler = new PostHandler();
      const sessionSecret = env.SESSION_SECRET;
      const session = await sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const postId = pathname.split("/api/posts/")[1].split("/hide")[0];
        const response = await postHandler.hidePost(
          postId,
          request,
          session,
          env as any,
          requestContext,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error hiding post:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Hide post",
  },

  {
    path: /^\/api\/posts\/([^/]+)\/unhide$/,
    method: "PATCH",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const postHandler = new PostHandler();
      const sessionSecret = env.SESSION_SECRET;
      const session = await sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const postId = pathname.split("/api/posts/")[1].split("/unhide")[0];
        const response = await postHandler.unhidePost(
          postId,
          request,
          session,
          env as any,
          requestContext,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error unhiding post:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Unhide post",
  },

  // Post Taxonomy Tags
  {
    path: /^\/api\/posts\/([^/]+)\/taxonomy-tags$/,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const validator = new Validator();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      if (!requestContext) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request context not available" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      // Apply rate limiting: 100 tag operations per hour per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/posts/:postId/taxonomy-tags",
        100,
        3600,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const postId = pathname
          .split("/api/posts/")[1]
          .split("/taxonomy-tags")[0];

        // Verify post exists and user owns it
        const post = await DataRouter.getPost(
          postId,
          requestContext.region,
          env as any,
          request,
          undefined,
          session.userId,
        );

        if (!post) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        if (post.authorId !== session.userId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }

        // Check request body size (max 10KB for tag operations)
        const contentLength = request.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > 10 * 1024) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Request body too large",
              message: "Maximum request body size is 10KB",
            }),
            { status: 413, headers: { "content-type": "application/json" } },
          );
        }

        // Parse request body
        const body = (await request.json()) as { taxonIds?: string[] };
        if (!body.taxonIds || !Array.isArray(body.taxonIds)) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "taxonIds array is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Validate taxon IDs format
        const taxonIdPattern = /^[a-z-]+:[a-z-]+:[a-z-]+$/;
        const invalidTaxonIds = body.taxonIds.filter(
          (id: string) => typeof id !== "string" || !taxonIdPattern.test(id),
        );
        if (invalidTaxonIds.length > 0) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid taxon ID format",
              invalidTaxonIds,
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Get tenant ID from authenticated JWT
        const auth = await authMiddleware(request, env);
        if (!auth || !auth.activeTenantId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        const tenantId = auth.activeTenantId;

        // Get database and taxonomy handler
        const region = requestContext.region || "US";
        const db = getWrappedDatabase(region, env, request);
        const taxonomyHandler = new TaxonomyHandler(
          db,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );

        // Add taxonomy tags
        await taxonomyHandler.addPostTaxonomyTags(
          postId,
          body.taxonIds as string[],
          session.userId,
        );

        // Get updated tags
        const tags = await taxonomyHandler.getPostTaxonomyTags(postId);

        return securityHeaders.createSecureResponse(
          JSON.stringify({
            tags: tags.map((t) => ({
              taxonId: t.taxonId,
              displayName: t.displayName,
              description: t.description,
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (error: any) {
        logger.error("Error adding taxonomy tags to post:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Add taxonomy tags to post",
  },

  {
    path: /^\/posts\/([^/]+)\/taxonomy-tags$/,
    method: "DELETE",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const validator = new Validator();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      if (!requestContext) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request context not available" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      // Apply rate limiting
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/posts/:postId/taxonomy-tags",
        100,
        3600,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const postId = pathname
          .split("/api/posts/")[1]
          .split("/taxonomy-tags")[0];

        // Verify post exists and user owns it
        const post = await DataRouter.getPost(
          postId,
          requestContext.region,
          env as any,
          request,
          undefined,
          session.userId,
        );

        if (!post) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        if (post.authorId !== session.userId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }

        // Check request body size (max 10KB for tag operations)
        const contentLength = request.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > 10 * 1024) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Request body too large",
              message: "Maximum request body size is 10KB",
            }),
            { status: 413, headers: { "content-type": "application/json" } },
          );
        }

        // Parse request body
        const body = (await request.json()) as { taxonIds?: string[] };
        if (!body.taxonIds || !Array.isArray(body.taxonIds)) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "taxonIds array is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Get tenant ID from authenticated JWT
        const auth = await authMiddleware(request, env);
        if (!auth || !auth.activeTenantId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        const tenantId = auth.activeTenantId;

        // Get database and taxonomy handler
        const region = requestContext.region || "US";
        const db = getWrappedDatabase(region, env, request);
        const taxonomyHandler = new TaxonomyHandler(
          db,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );

        // Remove taxonomy tags
        await taxonomyHandler.removePostTaxonomyTags(
          postId,
          body.taxonIds as string[],
        );

        return securityHeaders.createSecureResponse(
          JSON.stringify({ success: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (error: any) {
        logger.error("Error removing taxonomy tags from post:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Remove taxonomy tags from post",
  },

  {
    path: /^\/posts\/([^/]+)\/taxonomy-tags$/,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
      );

      // Note: GET is public (no auth required) but we check if user owns post for additional info
      if (!requestContext) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request context not available" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const postId = pathname
          .split("/api/posts/")[1]
          .split("/taxonomy-tags")[0];

        // Verify post exists
        const post = await DataRouter.getPost(
          postId,
          requestContext.region,
          env as any,
          request,
          undefined,
          session?.userId,
        );

        if (!post) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        // Get tenant ID from authenticated JWT
        const auth = await authMiddleware(request, env);
        if (!auth || !auth.activeTenantId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        const tenantId = auth.activeTenantId;

        // Get database and taxonomy handler
        const region = requestContext.region || "US";
        const db = getWrappedDatabase(region, env, request);
        const taxonomyHandler = new TaxonomyHandler(
          db,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );

        // Get taxonomy tags
        const tags = await taxonomyHandler.getPostTaxonomyTags(postId);

        return securityHeaders.createSecureResponse(
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
      } catch (error: any) {
        logger.error("Error getting taxonomy tags for post:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get taxonomy tags for post",
  },

  // Tag Suggestions
  {
    path: /^\/api\/posts\/([^/]+)\/tags\/suggestions$/,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
      );

      if (!requestContext) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request context not available" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const postId = pathname
          .split("/api/posts/")[1]
          .split("/tags/suggestions")[0];

        // Verify post exists
        const post = await DataRouter.getPost(
          postId,
          requestContext.region,
          env as any,
          request,
          undefined,
          session?.userId,
        );

        if (!post) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        // Get post text (need to fetch full post)
        const db = DataRouter.getDatabaseForRegion(
          requestContext.region,
          env as any,
          request,
          session?.userId,
        );
        const fullPost = await (db.post.findUnique({
          where: { id: postId },
          select: { text: true },
        }) as unknown as Promise<{ text: string } | null>);

        if (!fullPost) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        // Get tenant ID from authenticated JWT
        const auth = await authMiddleware(request, env);
        if (!auth || !auth.activeTenantId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        const tenantId = auth.activeTenantId;

        // Get database and handlers
        const wrappedDb = getWrappedDatabase(
          requestContext.region || "US",
          env,
          request,
        );
        const taxonomyHandler = new TaxonomyHandler(
          wrappedDb,
          tenantId,
          env.TAXONOMY_CACHE_KV,
        );
        const suggestionsHandler = new TagSuggestionsHandler(taxonomyHandler);

        // Get URL parameters
        const url = new URL(request.url);
        const limit = parseInt(url.searchParams.get("limit") || "10", 10);
        const minConfidence = parseFloat(
          url.searchParams.get("minConfidence") || "0.3",
        );

        // Generate suggestions
        const taxonomySuggestions =
          await suggestionsHandler.suggestTagsFromText(fullPost.text, {
            limit: Math.min(limit, 20), // Max 20 suggestions
            minConfidence,
          });

        // Get popular tags (if requested)
        const includePopular =
          url.searchParams.get("includePopular") === "true";
        const popularTags = includePopular
          ? await suggestionsHandler.getPopularTags(5)
          : [];

        // Get user's frequent tags (if authenticated)
        const includeUserTags =
          url.searchParams.get("includeUserTags") === "true";
        const userTags =
          includeUserTags && session
            ? await suggestionsHandler.getUserFrequentTags(session.userId, 5)
            : [];

        return securityHeaders.createSecureResponse(
          JSON.stringify({
            taxonomySuggestions,
            popularTags,
            userTags,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (error: any) {
        logger.error("Error generating tag suggestions:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get tag suggestions for post",
  },

  // Get single post by ID
  {
    path: /^\/api\/posts\/([^/]+)$/,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const feedHandler = new FeedHandler();
      const sessionSecret = env.SESSION_SECRET;
      const session = await sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      if (!requestContext) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Request context not available" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      // Get tenant ID from authenticated JWT
      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const postId = pathname.replace(/^\/api\/posts\//, "");
        const post = await feedHandler.getPost(
          postId,
          session,
          env as any,
          requestContext,
          auth.activeTenantId,
        );

        if (!post) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Post not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        return securityHeaders.createSecureResponse(
          JSON.stringify(post),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (error: any) {
        logger.error("Error getting post:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get single post by ID",
  },
];
