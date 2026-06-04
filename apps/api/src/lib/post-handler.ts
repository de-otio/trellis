import type { KVNamespace, R2Bucket, CloudflareQueue } from "../types/cloudflare-compat.js";
/**
 * Post Handler
 *
 * Handles post creation, deletion, and hiding.
 *
 * PREPARATORY: Uses DataRouter for region-aware data operations.
 */


import { DataRouter } from "./data-router.js";
import { getLogger, generateRequestId, Logger, type LoggerEnv } from "./logger.js";
import { ModerationHandler } from "./moderation-handler.js";
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
  FRIENDS_KV?: KVNamespace;
  CACHE_KV?: KVNamespace;
  TAXONOMY_CACHE_KV?: KVNamespace;
  LINK_CHECK_QUEUE?: any; // Cloudflare Queue binding for link checks
  DEFAULT_REGION?: string;
}

export interface CreatePostRequest {
  text: string;
  visibility?: "public" | "friends-only" | "private"; // Legacy — use radius instead
  radius?: string; // PostRadius: SHOUT | LOUD | NORMAL | WHISPER
  entityRefs?: string[];
  taxonomyTags?: string[];
  geoData?: {
    lat: number;
    lng: number;
    place?: string;
  };
  contentWarnings?: string[];
  media?: Array<{
    file: File | Blob;
    alt?: string;
    mimeType: string;
  }>;
}

export class PostHandler {
  private moderationHandler: ModerationHandler;
  private logger: Logger;

  constructor(env?: LoggerEnv) {
    this.moderationHandler = new ModerationHandler();
    this.logger = getLogger();
  }

  /**
   * Create a new post
   *
   * PREPARATORY: Uses DataRouter for region-aware post creation.
   */
  async createPost(
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      // PREPARATORY: Check if post creation is enabled for this region
      // Note: Post creation is always enabled by default, but can be disabled via feature flags
      // This is a placeholder for future feature flag checks (e.g., offlineMode, content moderation)

      // Validate request body with Zod schema
      const { validateRequest } = await import("./validate-request.js");
      const { createPostSchema } = await import("./schemas.js");

      const validation = await validateRequest(request, createPostSchema);
      if (!validation.success) {
        return validation.error;
      }
      const body = validation.data;

      // Check if public posting is enabled globally
      if (body.visibility === "public") {
        const { FeatureToggleService } = await import(
          "./feature-toggle-service.js"
        );
        const { createPrisma } = await import("../db.js");
        const db = createPrisma(env);
        const toggleService = new FeatureToggleService(db);
        const publicPostingEnabled = await toggleService.isEnabled(
          "global_public_posting_enabled",
        );

        if (!publicPostingEnabled) {
          return new Response(
            JSON.stringify({
              error: "PUBLIC_POSTING_DISABLED",
              message:
                'Public posting is currently disabled. Please use "Friends Only" or "Private" visibility.',
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }
      }

      // Check if content moderation is enabled via feature toggle
      const { FeatureToggleService } = await import("./feature-toggle-service.js");
      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);
      const toggleService = new FeatureToggleService(db, env as any);
      const moderationEnabled = await toggleService.isEnabled(
        "content_moderation_enabled",
      );

      // Moderate text content (if moderation is enabled)
      if (moderationEnabled) {
        const moderationResult = await this.moderationHandler.moderateText(
          body.text,
          env as any,
        );

        // Debug: Log Perspective API result (safely handle serialization)
        try {
          const debugData = {
            approved: moderationResult.approved,
            score: moderationResult.score,
            details: moderationResult.details,
            error: moderationResult.error,
            text: body.text.substring(0, 100), // First 100 chars for context
          };
          getLogger().debug(
            "[PostHandler] Moderation API result:",
            JSON.stringify(debugData),
          );
        } catch (debugError) {
          // If serialization fails, log a simpler version
          getLogger().debug(
            "[PostHandler] Moderation API result (simplified):",
            {
              approved: moderationResult.approved,
              score: moderationResult.score,
              hasDetails: !!moderationResult.details,
              hasError: !!moderationResult.error,
            },
          );
        }

        if (!moderationResult.approved) {
          return new Response(
            JSON.stringify({
              error: "CONTENT_REJECTED",
              message:
                "Your post contains inappropriate content. Please be more constructive.",
              score: moderationResult.score,
              details: moderationResult.details,
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      } else {
        getLogger().debug(
          "[PostHandler] Content moderation is disabled via feature toggle",
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
          this.logger.warn(`Blocked dangerous URL in post: ${url}`, {
            reason: validation.reason,
            userId: session.userId,
          });
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

      // Block post creation if dangerous links detected
      if (hasBlockedLinks) {
        return new Response(
          JSON.stringify({
            error: "DANGEROUS_LINKS_DETECTED",
            message:
              "Your post contains dangerous or blocked links. Please remove them and try again.",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // PREPARATORY: Use DataRouter for region-aware operations
      const requestId = generateRequestId();
      const region = requestContext.region;

      // OPTIMIZATION: Use upsert directly instead of getUser + createUser
      // This eliminates an unnecessary database query and is faster
      // DataRouter.createUser uses upsert, so it handles both create and update cases
      const user = await DataRouter.createUser(
        {
          id: session.userId,
          email: session.email,
        },
        region,
        env,
        request,
        requestId,
      );

      // Sanitize user input to prevent XSS
      const { InputSanitizer } = await import("./input-sanitizer.js");
      const sanitizedText = InputSanitizer.sanitizeText(body.text);

      // Get entityRefs (validation happens in DataRouter within transaction)
      const entityRefs = body.entityRefs || [];

      // Get taxonomy tags (optional)
      const taxonomyTags = body.taxonomyTags || [];

      // Validate media ownership and existence
      if (body.media && body.media.length > 0) {
        const mediaIds = body.media.map((m) => m.id);

        // Debug: Log media IDs being validated
        this.logger.debug("[PostHandler] Validating media IDs", {
          mediaIds,
          userId: session.userId,
          count: mediaIds.length,
        });

        // Import database helpers for media validation
        const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
          "./db-query-helper.js"
        );
        const { sharedDatabaseConnectionManager } = await import(
          "./database-connection-manager.js"
        );

        // Verify all media files exist and belong to user
        // Note: mediaIds can be either contentHash (SHA-256) or CUID
        // We search by contentHash first (preferred), then fall back to id
        const mediaFiles = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.mediaFile.findMany({
              where: {
                OR: [
                  { contentHash: { in: mediaIds } },
                  { id: { in: mediaIds } },
                ],
                uploadedBy: session.userId,
                deletedAt: null,
              },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 2,
            context: {
              operation: "createPost_validateMedia",
              userId: session.userId,
            },
          },
        );

        // Debug: Log validation results
        this.logger.debug("[PostHandler] Media validation results", {
          requestedCount: mediaIds.length,
          foundCount: mediaFiles.length,
          foundIds: mediaFiles.map((m: any) => m.id),
          foundContentHashes: mediaFiles.map((m: any) => m.contentHash),
          missingIds: mediaIds.filter(
            (id) =>
              !mediaFiles.find((m: any) => m.id === id || m.contentHash === id),
          ),
        });

        // Check if all media IDs are valid
        if (mediaFiles.length !== mediaIds.length) {
          // Diagnostic: query WITHOUT uploadedBy filter to determine root cause
          let diagnosticInfo: any = {};
          try {
            const allMatches = await withQueryTimeoutAndRetry(
              sharedDatabaseConnectionManager,
              region,
              env as any,
              async (db) => {
                return await db.mediaFile.findMany({
                  where: {
                    OR: [
                      { contentHash: { in: mediaIds } },
                      { id: { in: mediaIds } },
                    ],
                  },
                  select: {
                    id: true,
                    contentHash: true,
                    uploadedBy: true,
                    deletedAt: true,
                    uploadStatus: true,
                    createdAt: true,
                  },
                });
              },
              {
                ...QueryTimeoutPresets.USER_FACING,
                maxRetries: 1,
                context: { operation: "createPost_mediaDebug" },
              },
            );
            diagnosticInfo = {
              recordsWithoutOwnerFilter: allMatches.length,
              records: allMatches.map((m: any) => ({
                id: m.id,
                contentHash: m.contentHash?.substring(0, 12) + "...",
                uploadedBy: m.uploadedBy,
                deletedAt: m.deletedAt,
                uploadStatus: m.uploadStatus,
                createdAt: m.createdAt,
              })),
            };
          } catch (e: any) {
            diagnosticInfo = { diagnosticQueryError: e.message };
          }

          console.log("[PostHandler] INVALID_MEDIA diagnostic", {
            requestedIds: mediaIds,
            userId: session.userId,
            region,
            foundWithOwnerFilter: mediaFiles.length,
            ...diagnosticInfo,
          });

          this.logger.warn("[PostHandler] Media validation failed", {
            requestedIds: mediaIds,
            foundIds: mediaFiles.map((m: any) => m.id),
            foundContentHashes: mediaFiles.map((m: any) => m.contentHash),
            userId: session.userId,
          });

          return new Response(
            JSON.stringify({
              error: "INVALID_MEDIA",
              message: "One or more media files not found or not owned by user",
              details: {
                requested: mediaIds.length,
                found: mediaFiles.length,
                ...diagnosticInfo,
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Create a mapping from contentHash/id to database ID
        // This ensures we use the correct database ID when creating PostMedia records
        const mediaIdMap = new Map<string, string>();
        for (const file of mediaFiles) {
          mediaIdMap.set(file.contentHash, file.id);
          mediaIdMap.set(file.id, file.id);
        }

        // Remap media IDs to database IDs
        body.media = body.media.map((m) => ({
          ...m,
          id: mediaIdMap.get(m.id) || m.id,
        }));
      }

      // Convert visibility to Prisma enum format
      // API accepts: "public", "friends-only", "private"
      // Prisma expects: "PUBLIC", "FRIENDS", "PRIVATE"
      let visibility = (body.visibility || "public").toUpperCase();
      if (visibility === "FRIENDS-ONLY" || visibility === "FRIENDS_ONLY") {
        visibility = "FRIENDS";
      }

      // Create post using DataRouter (enforces dataRegion)
      // Note: Entity tagging validation happens within transaction in DataRouter
      const post = await DataRouter.createPost(
        {
          authorId: session.userId,
          text: sanitizedText.trim(),
          visibility,
          tenantId: activeTenantId,
          entityRefs: entityRefs.length > 0 ? entityRefs : undefined,
          geoData: body.geoData,
          contentWarnings: body.contentWarnings || [],
          hasBlockedLinks: hasBlockedLinks,
          media: body.media, // NEW: Pass media to DataRouter
        },
        region,
        env,
        request,
        requestId,
        session, // Pass session for entity tagging validation
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
                // LinkCheck inherits the owning post's tenant.
                tenantId: (post as any).tenantId,
                postId: post.id,
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
                this.logger.warn(
                  "Failed to queue threat intel check:",
                  queueError,
                );
              }
            }

            return check;
          });

          await Promise.all(linkCheckPromises);
        } catch (error) {
          // Log error but don't fail post creation if link checks fail
          this.logger.error("Error creating link checks:", error);
        }
      }

      // Add taxonomy tags if provided
      if (taxonomyTags.length > 0) {
        try {
          const { TaxonomyHandler } = await import("./taxonomy-handler.js");
          const { getWrappedDatabase } = await import(
            "./database-wrapper-helper.js"
          );

          // Get database and taxonomy handler scoped to caller's active tenant
          const db = getWrappedDatabase(region, env, request);
          const taxonomyHandler = new TaxonomyHandler(
            db,
            activeTenantId,
            env.TAXONOMY_CACHE_KV,
          );

          // Add taxonomy tags
          await taxonomyHandler.addPostTaxonomyTags(
            post.id,
            taxonomyTags,
            session.userId,
          );
        } catch (error: any) {
          // Log error but don't fail post creation if taxonomy tagging fails
          this.logger.error("Error adding taxonomy tags to post:", error);
          // Continue with post creation - taxonomy tags are optional
        }
      }

      // Graph sync: dual-write post to graph database
      try {
        const { createGraphServiceFromEnv } = await import("./graph/index.js");
        const graphService = await createGraphServiceFromEnv(env);

        await graphService.syncPost({
          id: post.id,
          authorId: session.userId,
          radius: body.radius || "NORMAL",
          createdAt: (post as any).createdAt || new Date(),
        });

        if (entityRefs.length > 0) {
          await graphService.syncPostSubjects({
            postId: post.id,
            entityIds: entityRefs,
            primaryEntityId: entityRefs[0],
          });

          for (const entityId of entityRefs) {
            await graphService.recordInteraction({
              userId: session.userId,
              targetType: "entity",
              targetId: entityId,
              interactionType: "content_creation",
              metadata: { postId: post.id },
            });
          }
        }
      } catch (graphError: any) {
        this.logger.error("[PostHandler] Graph sync failed for post creation (non-fatal):", {
          postId: post.id,
          message: graphError?.message,
        });
      }

      // Note: AT Protocol integration removed
      // Generate post URI for response
      const baseUrl = new URL(request.url).origin;
      let postUri: string = `${baseUrl}/api/posts/${post.id}`;

      // Create ActivityPub activity for the post (async, don't block response)
      // Only create if author has ActivityPub fields set
      // Import database helpers once for this function
      const dbHelpers = await import("./db-query-helper.js");
      const dbManager = await import("./database-connection-manager.js");
      const { sharedDatabaseConnectionManager } = dbManager;
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = dbHelpers;

      // Fetch full post and author with ActivityPub fields
      const postWithAuthor = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.post.findUnique({
            where: { id: post.id },
            include: {
              author: {
                select: {
                  id: true,
                  username: true,
                  actorUri: true,
                  inboxUrl: true,
                  outboxUrl: true,
                  publicKey: true,
                },
              },
            },
          });
        },
        {
          ...QueryTimeoutPresets.STANDARD,
          maxRetries: 2,
          baseDelayMs: 100,
          defaultValue: null,
          context: {
            operation: "createPost_fetchForActivityPub",
            userId: session.userId,
            postId: post.id,
          },
        },
      );

      // Create ActivityPub activity if author has ActivityPub fields
      if (postWithAuthor?.author?.actorUri && postWithAuthor.author.publicKey) {
        // Run ActivityPub activity creation asynchronously (don't block response)
        // Use a separate async operation to avoid blocking the response
        (async () => {
          try {
            const { PostActivityServiceFedify } = await import(
              "./activitypub/services/post-service-fedify.js"
            );
            const { DeliveryService } = await import(
              "./activitypub/delivery-service.js"
            );
            const { fedifyCreateToActivityStreams } = await import(
              "./activitypub/services/fedify-converters.js"
            );
            const { UserActorDispatcher } = await import(
              "./activitypub/dispatchers/user-actor.js"
            );

            // Create activity using Fedify and store in outbox
            await withQueryTimeoutAndRetry(
              sharedDatabaseConnectionManager,
              region,
              env as any,
              async (db) => {
                // Use Fedify service for type-safe activity creation
                const fedifyActivity =
                  await PostActivityServiceFedify.createPostActivity(
                    db,
                    postWithAuthor,
                    postWithAuthor.author as any,
                    env as any,
                    request.url,
                  );

                // Convert Fedify Create to ActivityStreamsActivity format for delivery service
                // (Delivery service stores activities in database, which requires plain objects)
                // Re-create the note and get URIs to pass to converter (Fedify doesn't expose properties directly)
                const note = await PostActivityServiceFedify.createNote(
                  postWithAuthor,
                  postWithAuthor.author as any,
                  env as any,
                  request.url,
                );
                const uris = PostActivityServiceFedify.generatePostUris(
                  postWithAuthor.id,
                  env as any,
                  request.url,
                );
                const actorUri = UserActorDispatcher.generateActorUri(
                  postWithAuthor.author.username || "",
                  env as any,
                );
                const activityForDelivery = fedifyCreateToActivityStreams(
                  fedifyActivity,
                  note,
                  actorUri,
                  uris.activityId.toString(),
                  uris.objectId.toString(),
                );

                // Deliver to recipients (async, don't block)
                DeliveryService.deliverPost(
                  db,
                  activityForDelivery,
                  postWithAuthor,
                  postWithAuthor.author as any,
                  env as any,
                  request.url,
                  this.logger,
                ).catch((error) => {
                  // Log error but don't fail
                  this.logger.error(
                    "[PostHandler] ActivityPub delivery failed:",
                    error,
                  );
                });
              },
              {
                ...QueryTimeoutPresets.STANDARD,
                maxRetries: 2,
                baseDelayMs: 100,
                context: {
                  operation: "createPost_activityPub",
                  userId: session.userId,
                  postId: post.id,
                },
              },
            );
          } catch (error: any) {
            // Log error but don't fail post creation if ActivityPub fails
            this.logger.error(
              "[PostHandler] ActivityPub activity creation failed:",
              error,
            );
          }
        })();
      }

      // Invalidate feed cache
      await this.invalidateFeedCache(env);

      // Fetch tagged entities for response
      let taggedEntities:
        | Array<{
            id: string;
            name: string;
            entityType?: string;
          }>
        | undefined;
      if (entityRefs.length > 0) {
        const db = DataRouter.getDatabaseForRegion(
          region,
          env,
          request,
          session.userId,
        );
        // Fetch tagged entities with timeout/retry
        // Use already imported helpers

        const postWithEntities = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.post.findUnique({
              where: { id: post.id },
              include: {
                subjectEntities: {
                  include: {
                    entity: {
                      select: {
                        id: true,
                        name: true,
                        entityType: true,
                      },
                    },
                  },
                },
              },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "createPost_fetchTaggedEntities",
              userId: session.userId,
              postId: post.id,
            },
          },
        );

        if (postWithEntities?.subjectEntities) {
          taggedEntities = postWithEntities.subjectEntities.map((te: any) => ({
            id: te.entity.id,
            name: te.entity.name,
            entityType: te.entity.entityType || undefined,
          }));
        }
      }

      // Fetch media for response
      let mediaResponse:
        | Array<{
            id: string;
            mediaId: string;
            alt: string | null;
            order: number;
            file: {
              id: string;
              contentHash: string;
              mimeType: string;
              originalKey: string;
              thumbnailKey: string | null;
              optimizedKey: string | null;
              width: number | null;
              height: number | null;
            };
          }>
        | undefined;
      if (body.media && body.media.length > 0) {
        const postWithMedia = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.post.findUnique({
              where: { id: post.id },
              include: {
                media: {
                  include: {
                    media: true,
                  },
                  orderBy: {
                    order: "asc",
                  },
                },
              },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "createPost_fetchMedia",
              userId: session.userId,
              postId: post.id,
            },
          },
        );

        if (postWithMedia?.media) {
          mediaResponse = postWithMedia.media.map((pm: any) => ({
            id: pm.id,
            mediaId: pm.mediaId,
            alt: pm.alt || null,
            order: pm.order,
            file: {
              id: pm.media.id,
              contentHash: pm.media.contentHash,
              mimeType: pm.media.mimeType,
              originalKey: pm.media.originalKey,
              thumbnailKey: pm.media.thumbnailKey || null,
              optimizedKey: pm.media.optimizedKey || null,
              width: pm.media.width || null,
              height: pm.media.height || null,
            },
          }));
        }
      }

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
            where: { postId: post.id },
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
          this.logger.error("Error fetching link checks for response:", error);
        }
      }

      // Fetch taxonomy tags for response
      let taxonomyTagsResponse:
        | Array<{
            taxonId: string;
            displayName: string;
            description: string | null;
          }>
        | undefined;
      if (taxonomyTags.length > 0) {
        try {
          const { TaxonomyHandler } = await import("./taxonomy-handler.js");
          const { getWrappedDatabase } = await import(
            "./database-wrapper-helper.js"
          );

          const db = getWrappedDatabase(region, env, request);
          const taxonomyHandler = new TaxonomyHandler(
            db,
            activeTenantId,
            env.TAXONOMY_CACHE_KV,
          );

          const tags = await taxonomyHandler.getPostTaxonomyTags(post.id);
          taxonomyTagsResponse = tags.map((t) => ({
            taxonId: t.taxonId,
            displayName: t.displayName,
            description: t.description,
          }));
        } catch (error: any) {
          // If fetching tags fails, just continue without them
          this.logger.error(
            "Error fetching taxonomy tags for response:",
            error,
          );
        }
      }

      // Note: post.createdAt may not be available from DataRouter return type
      // We'll use current timestamp as fallback
      const createdAt = (post as any).createdAt
        ? new Date((post as any).createdAt).toISOString()
        : new Date().toISOString();

      // Fetch author information for response - with timeout/retry
      // Use already imported helpers

      const author = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.user.findUnique({
            where: { id: session.userId },
            select: {
              id: true,
              email: true,
              username: true,
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "createPost_fetchAuthor",
            userId: session.userId,
          },
        },
      );

      // Build response with all required fields for PostModel
      const responseData: any = {
        id: post.id,
        uri: postUri, // PostModel requires uri to be a non-null string
        text: body.text.trim(),
        visibility: body.visibility,
        createdAt, // ISO 8601 string format
        author: author
          ? {
              actorUri: author.id, // PostModel expects actorUri, not did
              handle: author.username || author.email.split("@")[0],
            }
          : {
              actorUri: session.userId, // PostModel expects actorUri, not did
              handle: session.email.split("@")[0],
            },
        sentimentCounts: {
          joy: 0,
          love: 0,
          calm: 0,
          sad: 0,
          angry: 0,
          fear: 0,
          surprise: 0,
          disgust: 0,
          neutral: 0,
          excited: 0,
          grateful: 0,
        },
        commentCount: 0,
        contentWarnings: body.contentWarnings || [],
      };

      // Add optional fields if present
      if (taggedEntities && taggedEntities.length > 0) {
        responseData.taggedEntities = taggedEntities;
      }
      if (taxonomyTagsResponse && taxonomyTagsResponse.length > 0) {
        responseData.taxonomyTags = taxonomyTagsResponse;
      }
      if (body.geoData) {
        responseData.geoData = body.geoData;
      }
      if (linksResponse && linksResponse.length > 0) {
        responseData.links = linksResponse;
      }
      if (mediaResponse && mediaResponse.length > 0) {
        responseData.media = mediaResponse;
      }

      // Log response data for debugging (always log in dev, use info level so it shows up)
      try {
        const responseBody = JSON.stringify(responseData);

        // Log full response in dev environment for debugging
        if ((env as any).ENVIRONMENT === "dev") {
          this.logger.info("[PostHandler] Post creation response:", {
            postId: responseData.id,
            hasAuthor: !!responseData.author,
            hasSentimentCounts: !!responseData.sentimentCounts,
            uri: responseData.uri,
            responseSize: responseBody.length,
            fullResponse: responseBody, // Log full response for debugging
          });
        }

        return new Response(responseBody, {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      } catch (serializationError: any) {
        this.logger.error("[PostHandler] Failed to serialize response:", {
          message: serializationError.message,
          stack: serializationError.stack,
          responseDataKeys: Object.keys(responseData),
          postId: responseData.id,
        });
        // Return error response instead of throwing
        return new Response(
          JSON.stringify({
            error: "Failed to serialize response",
            postId: responseData.id,
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    } catch (error: any) {
      // Safely log error (handle Symbols and non-serializable values)
      try {
        const errorMessage = error?.message || String(error);
        const errorStack = error?.stack;
        this.logger.error("Error creating post:", {
          message: errorMessage,
          stack: errorStack,
          name: error?.name,
          code: error?.code,
        });
      } catch (logError) {
        // If even logging fails, use a fallback
        this.logger.error("Error creating post: [Unable to serialize error]");
      }

      // Handle entity tagging errors with proper status codes
      const { EntityTaggingError } = await import("./entity-tagging-errors.js");
      if (error instanceof EntityTaggingError) {
        return new Response(
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

      // Generic error handling
      // In dev/test environments, include error details for debugging
      const environment = (
        (env as any).ENVIRONMENT ||
        (env as any).DEPLOY_ENV ||
        "dev"
      ).toLowerCase();
      const isDevOrTest =
        environment === "dev" ||
        environment === "test" ||
        (env as any).CI === "true";

      const errorResponse: any = { error: "Failed to create post" };
      if (isDevOrTest) {
        // Include error details in dev/test for debugging
        errorResponse.details = {
          message: error?.message || String(error),
          name: error?.name,
          code: error?.code,
          // Don't include stack trace in response (security)
        };
      }

      return new Response(JSON.stringify(errorResponse), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Delete a post (soft delete)
   *
   * PREPARATORY: Uses DataRouter to validate region before deletion.
   */
  async deletePost(
    postId: string,
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const requestId = generateRequestId();
      const region = requestContext.region;

      // PREPARATORY: Verify post exists in correct region using DataRouter
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

      if (post.authorId !== session.userId) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }

      // Use DataRouter to get database for region, then update directly
      // (DataRouter doesn't have update methods yet, but we've validated region)
      const db = DataRouter.getDatabaseForRegion(
        region,
        env,
        request,
        session?.userId,
      );

      // Check if already deleted - with timeout/retry
      const dbHelpers = await import("./db-query-helper.js");
      const dbManager = await import("./database-connection-manager.js");
      const { sharedDatabaseConnectionManager } = dbManager;
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = dbHelpers;

      const existingPost = await withQueryTimeoutAndRetry(
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
            operation: "deletePost_checkDeleted",
            userId: session.userId,
            postId,
          },
        },
      );

      if (existingPost?.deletedAt) {
        return new Response(JSON.stringify({ error: "Post already deleted" }), {
          status: 410,
          headers: { "content-type": "application/json" },
        });
      }

      // Soft delete - with timeout/retry
      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.post.update({
            where: { id: postId },
            data: { deletedAt: new Date() },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "deletePost",
            userId: session.userId,
            postId,
          },
        },
      );

      // Note: AT Protocol integration removed

      // Graph sync: remove post from graph database
      try {
        const { createGraphServiceFromEnv } = await import("./graph/index.js");
        const graphService = await createGraphServiceFromEnv(env);
        await graphService.removePost(postId);
      } catch (graphError: any) {
        this.logger.error("[PostHandler] Graph sync failed for post deletion (non-fatal):", {
          postId,
          message: graphError?.message,
        });
      }

      // Invalidate feed cache
      await this.invalidateFeedCache(env);

      return new Response(
        JSON.stringify({ success: true, message: "Post deleted successfully" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      this.logger.error("Error deleting post:", error);
      return new Response(JSON.stringify({ error: "Failed to delete post" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Edit an existing post
   *
   * PREPARATORY: Uses DataRouter to validate region before editing.
   *
   * Requirements:
   * - 4.1: PATCH /api/posts/:postId endpoint
   * - 4.2: Update post text and media
   * - 4.3: Set editedAt timestamp
   * - 4.4, 4.5: Validate input (text required, max 3000 chars)
   * - 4.6: Return 401 if not authenticated
   * - 4.7: Return 403 if not post owner
   * - 4.8: Return 404 if post not found
   * - 5.1-5.4: Content moderation on edited content
   * - 6.1-6.4: ActivityPub sync for public posts
   * - 7.1-7.3: Cache invalidation
   */
  async editPost(
    postId: string,
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      // Validate request body with Zod schema
      const { validateRequest } = await import("./validate-request.js");
      const { editPostSchema } = await import("./schemas.js");

      const validation = await validateRequest(request, editPostSchema);
      if (!validation.success) {
        return validation.error;
      }
      const body = validation.data;

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

      // Authorization check - only post owner can edit
      if (post.authorId !== session.userId) {
        return new Response(
          JSON.stringify({
            error: "Forbidden",
            message: "You can only edit your own posts",
          }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Check if post is deleted
      if ((post as any).deletedAt) {
        return new Response(
          JSON.stringify({ error: "Cannot edit a deleted post" }),
          {
            status: 410,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Check if content moderation is enabled via feature toggle
      const { FeatureToggleService } = await import("./feature-toggle-service.js");
      const { createPrisma } = await import("../db.js");
      const db = createPrisma(env);
      const toggleService = new FeatureToggleService(db, env as any);
      const moderationEnabled = await toggleService.isEnabled(
        "content_moderation_enabled",
      );

      // Content moderation on edited text (if moderation is enabled)
      if (moderationEnabled) {
        const moderationResult = await this.moderationHandler.moderateText(
          body.text,
          env as any,
        );

        if (!moderationResult.approved) {
          return new Response(
            JSON.stringify({
              error: "CONTENT_REJECTED",
              message:
                "Your edited post contains inappropriate content. Please be more constructive.",
              score: moderationResult.score,
              details: moderationResult.details,
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      } else {
        getLogger().debug(
          "[PostHandler] Content moderation is disabled via feature toggle (edit post)",
        );
      }

      // Check for malicious links in edited content
      const { LinkSecurityHandler, LinkStatus } = await import(
        "./link-security-handler.js"
      );
      const linkSecurityHandler = new LinkSecurityHandler(env as any);
      const urls = linkSecurityHandler.extractUrls(body.text);
      let hasBlockedLinks = false;

      for (const url of urls) {
        const linkValidation = linkSecurityHandler.validateUrlSync(url);
        if (linkValidation.status === LinkStatus.BLOCKED) {
          hasBlockedLinks = true;
          this.logger.warn(`Blocked dangerous URL in post edit: ${url}`, {
            reason: linkValidation.reason,
            userId: session.userId,
            postId,
          });
          break;
        }
      }

      if (hasBlockedLinks) {
        return new Response(
          JSON.stringify({
            error: "DANGEROUS_LINKS_DETECTED",
            message:
              "Your edited post contains dangerous or blocked links. Please remove them and try again.",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Sanitize user input to prevent XSS
      const { InputSanitizer } = await import("./input-sanitizer.js");
      const sanitizedText = InputSanitizer.sanitizeText(body.text);

      // Update post in database with timeout/retry
      const dbHelpers = await import("./db-query-helper.js");
      const dbManager = await import("./database-connection-manager.js");
      const { sharedDatabaseConnectionManager } = dbManager;
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = dbHelpers;

      const updatedPost = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          const updateData: any = {
            text: sanitizedText.trim(),
            editedAt: new Date(),
            hasBlockedLinks: false, // Reset since we validated
          };

          // Update visibility if provided
          if (body.visibility) {
            // Convert visibility to Prisma enum format
            // API accepts: "public", "friends-only", "private"
            // Prisma expects: "PUBLIC", "FRIENDS", "PRIVATE"
            let visibility = body.visibility.toUpperCase();
            if (
              visibility === "FRIENDS-ONLY" ||
              visibility === "FRIENDS_ONLY"
            ) {
              visibility = "FRIENDS";
            }
            updateData.visibility = visibility;
          }

          return await db.post.update({
            where: { id: postId },
            data: updateData,
            include: {
              author: {
                select: {
                  id: true,
                  email: true,
                  username: true,
                  actorUri: true,
                  publicKey: true,
                },
              },
              media: {
                include: {
                  media: true,
                },
              },
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "editPost",
            userId: session.userId,
            postId,
          },
        },
      );

      // ActivityPub sync for public posts only
      if (
        updatedPost.radius === "SHOUT" &&
        updatedPost.author?.actorUri &&
        updatedPost.author?.publicKey
      ) {
        // Run ActivityPub update asynchronously (don't block response)
        (async () => {
          try {
            const { PostActivityServiceFedify } = await import(
              "./activitypub/services/post-service-fedify.js"
            );
            const { DeliveryService } = await import(
              "./activitypub/delivery-service.js"
            );

            // Send Update activity to followers
            await withQueryTimeoutAndRetry(
              sharedDatabaseConnectionManager,
              region,
              env as any,
              async (db) => {
                // Create Update activity for the edited post
                await PostActivityServiceFedify.createUpdateActivity(
                  db,
                  updatedPost,
                  updatedPost.author as any,
                  env as any,
                  request.url,
                );
              },
              {
                ...QueryTimeoutPresets.STANDARD,
                maxRetries: 2,
                baseDelayMs: 100,
                context: {
                  operation: "editPost_activityPub",
                  userId: session.userId,
                  postId,
                },
              },
            );
          } catch (error: any) {
            // Log error but don't fail the edit if ActivityPub fails
            this.logger.error(
              "[PostHandler] ActivityPub update failed for edited post:",
              error,
            );
          }
        })();
      }

      // Invalidate caches
      await this.invalidateFeedCache(env);
      await this.invalidatePostCache(postId, env);

      // Fetch sentiment counts for the post
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
          maxRetries: 2,
          baseDelayMs: 50,
          context: {
            operation: "editPost_getSentiments",
            postId,
          },
        },
      );

      const sentimentCounts: Record<string, number> = {
        joy: 0,
        love: 0,
        calm: 0,
        sad: 0,
        angry: 0,
        fear: 0,
        surprise: 0,
        disgust: 0,
        neutral: 0,
        excited: 0,
        grateful: 0,
      };

      for (const s of sentiments) {
        sentimentCounts[s.sentiment] = s._count;
      }

      // Fetch comment count for the post
      const commentCount = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postComment.count({
            where: { postId },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 2,
          baseDelayMs: 50,
          context: {
            operation: "editPost_getCommentCount",
            postId,
          },
        },
      );

      // Build response with all required fields for PostModel
      const responseData = {
        id: updatedPost.id,
        uri: updatedPost.uri || "",
        text: updatedPost.text,
        visibility: updatedPost.radius?.toLowerCase() || "normal",
        createdAt: updatedPost.createdAt.toISOString(),
        editedAt: updatedPost.editedAt?.toISOString() || null,
        author: {
          actorUri:
            updatedPost.author?.actorUri ||
            updatedPost.author?.id ||
            session.userId,
          handle:
            updatedPost.author?.username ||
            updatedPost.author?.email?.split("@")[0] ||
            session.email.split("@")[0],
        },
        sentimentCounts: {
          joy: sentimentCounts.joy || 0,
          love: sentimentCounts.love || 0,
          calm: sentimentCounts.calm || 0,
          sad: sentimentCounts.sad || 0,
          angry: sentimentCounts.angry || 0,
          fear: sentimentCounts.fear || 0,
          surprise: sentimentCounts.surprise || 0,
          disgust: sentimentCounts.disgust || 0,
          neutral: sentimentCounts.neutral || 0,
          excited: sentimentCounts.excited || 0,
          grateful: sentimentCounts.grateful || 0,
        },
        commentCount,
        contentWarnings: updatedPost.contentWarnings || [],
        media:
          updatedPost.media?.map((pm: any) => ({
            id: pm.id,
            mediaId: pm.mediaId,
            alt: pm.alt || null,
            order: pm.order,
            file: {
              id: pm.media.id,
              contentHash: pm.media.contentHash,
              mimeType: pm.media.mimeType,
              originalKey: pm.media.originalKey,
              thumbnailKey: pm.media.thumbnailKey || null,
              optimizedKey: pm.media.optimizedKey || null,
              width: pm.media.width || null,
              height: pm.media.height || null,
            },
          })) || [],
      };

      return new Response(JSON.stringify(responseData), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      this.logger.error("Error editing post:", error);
      return new Response(JSON.stringify({ error: "Failed to edit post" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Invalidate post-specific cache entries
   */
  private async invalidatePostCache(postId: string, env: Env): Promise<void> {
    const kv = env.FEED_CACHE_KV;
    if (!kv) return;

    try {
      // Delete post-specific cache entries
      const keys = [
        `post:${postId}`,
        `post:${postId}:reactions`,
        `post:${postId}:comments`,
      ];

      await Promise.all(keys.map((key) => kv.delete(key)));
    } catch (error) {
      this.logger.error("Error invalidating post cache:", error);
    }
  }

  /**
   * Hide a post
   *
   * PREPARATORY: Uses DataRouter to validate region before hiding.
   */
  async hidePost(
    postId: string,
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const requestId = generateRequestId();
      const region = requestContext.region;

      // PREPARATORY: Verify post exists in correct region using DataRouter
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

      if (post.authorId !== session.userId) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }

      // Update post with timeout/retry
      const dbHelpers = await import("./db-query-helper.js");
      const dbManager = await import("./database-connection-manager.js");
      const { sharedDatabaseConnectionManager } = dbManager;
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = dbHelpers;

      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.post.update({
            where: { id: postId },
            data: { hiddenByAuthor: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "hidePost",
            userId: session.userId,
            postId,
          },
        },
      );

      await this.invalidateFeedCache(env);

      return new Response(
        JSON.stringify({ success: true, message: "Post hidden successfully" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      this.logger.error("Error hiding post:", error);
      return new Response(JSON.stringify({ error: "Failed to hide post" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Unhide a post
   *
   * PREPARATORY: Uses DataRouter to validate region before unhiding.
   */
  async unhidePost(
    postId: string,
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const requestId = generateRequestId();
      const region = requestContext.region;

      // PREPARATORY: Verify post exists in correct region using DataRouter
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

      if (post.authorId !== session.userId) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }

      // Update post with timeout/retry
      const dbHelpers = await import("./db-query-helper.js");
      const dbManager = await import("./database-connection-manager.js");
      const { sharedDatabaseConnectionManager } = dbManager;
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = dbHelpers;

      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.post.update({
            where: { id: postId },
            data: { hiddenByAuthor: false },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "unhidePost",
            userId: session.userId,
            postId,
          },
        },
      );

      await this.invalidateFeedCache(env);

      return new Response(
        JSON.stringify({
          success: true,
          message: "Post unhidden successfully",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      this.logger.error("Error unhiding post:", error);
      return new Response(JSON.stringify({ error: "Failed to unhide post" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Invalidate feed cache by incrementing version
   * Uses cache versioning: all cache keys include a version number,
   * and incrementing the version makes all old cache entries invalid.
   */
  private async invalidateFeedCache(env: Env): Promise<void> {
    const kv = env.FEED_CACHE_KV;
    if (!kv) return;

    try {
      // Get current version
      const versionStr = await kv.get("feed:cache:version", "text");
      const currentVersion = versionStr ? parseInt(versionStr, 10) : 1;

      // Increment version - this invalidates all existing cache entries
      // (they use old version in their keys)
      const newVersion = currentVersion + 1;
      await kv.put("feed:cache:version", newVersion.toString());
    } catch (error) {
      this.logger.error("Error invalidating feed cache:", error);
    }
  }
}
