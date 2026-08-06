/**
 * Media Handler
 *
 * Handles media collection operations: listing, details, hide/unhide, delete.
 */

import type { Env } from "../env.js";
import { getLogger, Logger } from "./logger.js";
import { MediaMetrics } from "./media-metrics.js";
import { mediaProvenanceView } from "./provenance/response.js";

export class MediaHandler {
  private logger: Logger;
  private metrics: MediaMetrics;

  constructor(env?: Env) {
    this.logger = env ? getLogger() : ({} as Logger);
    this.metrics = new MediaMetrics(env);
  }

  /**
   * Get API domain consistently across all media operations
   * Respects APP_DOMAIN environment variable, converts www. to api., or uses default
   */
  private static getApiDomain(env: Env): string {
    if (env.APP_DOMAIN) {
      try {
        const url = new URL(env.APP_DOMAIN);
        let hostname = url.hostname;

        // Convert www. to api.
        if (hostname.startsWith("www.")) {
          hostname = hostname.replace("www.", "api.");
        } else if (!hostname.includes("api.")) {
          // If no api. subdomain, add it
          const parts = hostname.split(".");
          if (parts.length >= 2) {
            hostname = `api.${parts.slice(-2).join(".")}`;
          }
        }

        return `${url.protocol}//${hostname}`;
      } catch {
        // Invalid URL, fall through to default
      }
    }

    // Default fallback
    return "https://api.rkm1.de";
  }

  /**
   * Get media grouped by month or year
   */
  async listUserMediaGrouped(
    userId: string,
    groupBy: "month" | "year",
    options: {
      includeHidden?: boolean;
      type?: "photo" | "video" | "all";
      limit?: number;
    },
    env: Env,
    request?: Request,
  ): Promise<{
    groups: Array<{
      period: string;
      displayName: string;
      count: number;
      media: Array<{
        id: string;
        contentHash: string;
        mimeType: string;
        size: number;
        thumbnailUrl: string;
        optimizedUrl: string;
        createdAt: string;
        hidden: boolean;
        postCount: number;
      }>;
    }>;
    warning?: string;
    truncated?: boolean;
  }> {
    const startTime = Date.now();
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );
    const { DataRouter } = await import("./data-router.js");
    const { RegionDetector } = await import("./region-detection.js");

    // Multi-region awareness: detect region from request/session
    const regionDetector = new RegionDetector(env);
    const region = request
      ? await regionDetector.detectRegion(request, undefined, undefined)
      : (env.DEFAULT_REGION as any) || "EU";

    try {
      const db = request
        ? DataRouter.getDatabaseForRegion(region, env, request, userId)
        : DataRouter.getDatabaseForRegion(region, env);

      const includeHidden = options.includeHidden || false;
      const type = options.type || "all";

      // Pagination guardrails: cap limit to prevent excessive load
      const MAX_LIMIT = 10000;
      const DEFAULT_LIMIT = 5000;
      const requestedLimit = options.limit || DEFAULT_LIMIT;
      const fetchLimit = Math.min(requestedLimit, MAX_LIMIT);

      // Warn if limit was truncated (will be logged in response metadata)
      const wasTruncated = requestedLimit > MAX_LIMIT;

      // Get post IDs for the user
      const userPosts = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (dbClient) => {
          return await dbClient.post.findMany({
            where: {
              authorId: userId,
              deletedAt: null,
            },
            select: { id: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "listUserMediaGrouped_userPosts",
            userId,
          },
        },
      );
      const postIds = userPosts.map((p: any) => p.id);
      if (postIds.length === 0) {
        return { groups: [] };
      }

      // Get media IDs for those posts
      const postMedia = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (dbClient) => {
          return await dbClient.postMedia.findMany({
            where: {
              postId: { in: postIds },
            },
            select: { mediaId: true },
            distinct: ["mediaId"],
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "listUserMediaGrouped_postMedia",
            userId,
          },
        },
      );
      const mediaIds = postMedia.map((pm: any) => pm.mediaId);
      if (mediaIds.length === 0) {
        return { groups: [] };
      }

      // Build where clause
      const where: any = {
        id: { in: mediaIds },
        deletedAt: null,
      };

      if (!includeHidden) {
        where.hidden = false;
      }

      if (type === "photo") {
        where.mimeType = { startsWith: "image/" };
      } else if (type === "video") {
        where.mimeType = { startsWith: "video/" };
      }

      // Fetch media (limited to avoid excessive load)
      const media = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (dbClient) => {
          const dbAny = dbClient as any;
          return await dbAny.mediaFile.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: fetchLimit,
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "listUserMediaGrouped_mediaFiles",
            userId,
          },
        },
      );

      if (media.length === 0) {
        return { groups: [] };
      }

      // Precompute post counts for each media
      const mediaWithPostCounts = await Promise.all(
        media.map(async (m: any) => {
          const postCount = await withQueryTimeoutAndRetry(
            sharedDatabaseConnectionManager,
            region,
            env as any,
            async (dbClient) => {
              return await dbClient.postMedia.count({
                where: {
                  mediaId: m.id,
                  post: {
                    authorId: userId,
                    deletedAt: null,
                  },
                },
              });
            },
            {
              ...QueryTimeoutPresets.USER_FACING,
              maxRetries: 3,
              baseDelayMs: 100,
              context: {
                operation: "listUserMediaGrouped_postCount",
                userId,
                mediaId: m.id,
              },
            },
          );

          const apiDomain = MediaHandler.getApiDomain(env);

          return {
            id: m.id,
            contentHash: m.contentHash,
            mimeType: m.mimeType,
            size: m.size,
            thumbnailUrl: `${apiDomain}/api/media/${m.contentHash}?variant=thumbnail`,
            optimizedUrl: `${apiDomain}/api/media/${m.contentHash}?variant=optimized`,
            createdAt: m.createdAt.toISOString(),
            hidden: m.hidden || false,
            postCount,
          };
        }),
      );

      // Group by period
      const groupsMap = new Map<string, typeof mediaWithPostCounts>();
      for (const item of mediaWithPostCounts) {
        const date = new Date(item.createdAt);
        let period: string;
        if (groupBy === "month") {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, "0");
          period = `${year}-${month}`;
        } else {
          period = String(date.getFullYear());
        }

        if (!groupsMap.has(period)) {
          groupsMap.set(period, []);
        }
        groupsMap.get(period)!.push(item);
      }

      // Convert to array and sort newest-first
      const groups = Array.from(groupsMap.entries())
        .map(([period, items]) => {
          const displayName =
            groupBy === "month"
              ? new Date(`${period}-01`).toLocaleDateString("en-US", {
                  month: "long",
                  year: "numeric",
                })
              : period;
          return {
            period,
            displayName,
            count: items.length,
            media: items.sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            ),
          };
        })
        .sort((a, b) => b.period.localeCompare(a.period));

      const result = {
        groups,
        ...(wasTruncated && {
          warning: `Limit was capped at ${MAX_LIMIT} items. Requested limit (${requestedLimit}) exceeded maximum.`,
          truncated: true,
        }),
      };

      const duration = Date.now() - startTime;
      const totalItems = groups.reduce((sum, g) => sum + g.count, 0);

      // Structured logging
      this.logger.info("[MediaHandler] Media grouped", {
        operation: "listUserMediaGrouped",
        userId,
        region,
        duration,
        result: {
          groupCount: groups.length,
          totalItems,
          truncated: wasTruncated,
        },
        metadata: {
          groupBy,
          includeHidden: options.includeHidden || false,
          type: options.type || "all",
          limit: options.limit || 5000,
        },
      });

      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorType = error?.name || "UnknownError";

      // Error logging
      this.logger.error("[MediaHandler] Failed to group media", {
        operation: "listUserMediaGrouped",
        userId,
        region,
        duration,
        error: error?.message,
        errorType,
        metadata: {
          groupBy,
          includeHidden: options.includeHidden || false,
          type: options.type || "all",
        },
      });

      throw error;
    }
  }

  /**
   * Get statistics for a user's media collection
   */
  async getUserMediaStats(
    userId: string,
    options: { includeHidden?: boolean; type?: "photo" | "video" | "all" },
    env: Env,
    request?: Request,
  ): Promise<{
    totalCount: number;
    photoCount: number;
    videoCount: number;
    hiddenCount: number;
    totalSize: number;
    oldestMedia: string | null;
    newestMedia: string | null;
    byMonth: Array<{ period: string; count: number }>;
  }> {
    const startTime = Date.now();
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );
    const { DataRouter } = await import("./data-router.js");
    const { RegionDetector } = await import("./region-detection.js");

    // Multi-region awareness: detect region from request/session
    const regionDetector = new RegionDetector(env);
    const region = request
      ? await regionDetector.detectRegion(request, undefined, undefined)
      : (env.DEFAULT_REGION as any) || "EU";

    try {
      const db = request
        ? DataRouter.getDatabaseForRegion(region, env, request, userId)
        : DataRouter.getDatabaseForRegion(region, env);

      const includeHidden = options.includeHidden || false;
      const type = options.type || "all";

      // Get user's post IDs
      const userPosts = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (dbClient) => {
          return await dbClient.post.findMany({
            where: {
              authorId: userId,
              deletedAt: null,
            },
            select: { id: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "getUserMediaStats_userPosts",
            userId,
          },
        },
      );
      const postIds = userPosts.map((p: any) => p.id);

      // Get media IDs from posts
      const postMedia = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (dbClient) => {
          if (postIds.length === 0) {
            return [];
          }
          return await dbClient.postMedia.findMany({
            where: {
              postId: { in: postIds },
            },
            select: { mediaId: true },
            distinct: ["mediaId"],
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "getUserMediaStats_postMedia",
            userId,
          },
        },
      );
      const mediaIdsFromPosts = postMedia.map((pm: any) => pm.mediaId);

      // Get all Entity avatars owned by the user - with timeout/retry
      const userEntities = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (dbClient) => {
          return await dbClient.entity.findMany({
            where: {
              owners: { some: { userId: userId, status: 'ACTIVE' } },
            },
            select: { metadata: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "getUserMediaStats_userEntities",
            userId,
          },
        },
      );

      // Extract contentHashes and media IDs from Entity avatar URLs
      // Avatar URLs can be stored in multiple formats:
      // 1. Full URL: https://api.rkm1.de/api/media/{contentHash}?variant=...
      // 2. ContentHash: just the hash string
      // 3. Media ID: the media ID (CUID) directly
      const avatarContentHashes = new Set<string>();
      const avatarMediaIdsDirect = new Set<string>();
      for (const entity of userEntities) {
        if (entity.metadata && typeof entity.metadata === "object") {
          const metadata = entity.metadata as any;
          const avatarUrl = metadata.avatar;
          if (typeof avatarUrl === "string" && avatarUrl) {
            // Check if avatar URL is a media ID directly (CUID format: starts with 'c' and has alphanumeric chars)
            // Media IDs are typically CUIDs like 'cmji7uq2l0000l1j23af3r8bo'
            if (/^c[a-z0-9]{24}$/i.test(avatarUrl)) {
              avatarMediaIdsDirect.add(avatarUrl);
              continue;
            }

            // Check if it's a contentHash (hex string, typically 64 chars)
            if (/^[a-f0-9]{32,64}$/i.test(avatarUrl)) {
              avatarContentHashes.add(avatarUrl);
              continue;
            }

            // Extract contentHash from URL format: /api/media/{contentHash}?variant=...
            // Or: https://api.rkm1.de/api/media/{contentHash}?variant=...
            const match = avatarUrl.match(/\/api\/media\/([a-f0-9]+)(?:\?|$)/i);
            if (match && match[1]) {
              avatarContentHashes.add(match[1]);
              continue;
            }

            // Extract media ID from URL format: /api/media/{mediaId}
            // Or: https://api.rkm1.de/api/media/{mediaId}
            const mediaIdMatch = avatarUrl.match(
              /\/api\/media\/([a-z0-9]+)(?:\?|$)/i,
            );
            if (
              mediaIdMatch &&
              mediaIdMatch[1] &&
              /^c[a-z0-9]{24}$/i.test(mediaIdMatch[1])
            ) {
              avatarMediaIdsDirect.add(mediaIdMatch[1]);
            }
          }
        }
      }

      // Get media IDs from avatar contentHashes - with timeout/retry
      const avatarMediaIds: string[] = [...avatarMediaIdsDirect];
      if (avatarContentHashes.size > 0) {
        const avatarMedia = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (dbClient) => {
            const dbAny = dbClient as any;
            return await dbAny.mediaFile.findMany({
              where: {
                contentHash: { in: Array.from(avatarContentHashes) },
                deletedAt: null,
              },
              select: { id: true },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "getUserMediaStats_avatarMedia",
              userId,
            },
          },
        );
        avatarMediaIds.push(...avatarMedia.map((m: any) => m.id));
      }

      // Combine media IDs from posts and avatars
      const allMediaIds = [
        ...new Set([...mediaIdsFromPosts, ...avatarMediaIds]),
      ];

      if (allMediaIds.length === 0) {
        return {
          totalCount: 0,
          photoCount: 0,
          videoCount: 0,
          hiddenCount: 0,
          totalSize: 0,
          oldestMedia: null,
          newestMedia: null,
          byMonth: [],
        };
      }

      const whereBase: any = {
        id: { in: allMediaIds },
        deletedAt: null,
      };

      if (!includeHidden) {
        whereBase.hidden = false;
      }

      // Type filter for top-level total (when requested)
      const applyType = (where: any) => {
        if (type === "photo") {
          where.mimeType = { startsWith: "image/" };
        } else if (type === "video") {
          where.mimeType = { startsWith: "video/" };
        }
        return where;
      };

      // Fetch all media metadata (minimal fields)
      const mediaRows = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (dbClient) => {
          const dbAny = dbClient as any;
          return await dbAny.mediaFile.findMany({
            where: applyType({ ...whereBase }),
            select: {
              id: true,
              mimeType: true,
              size: true,
              hidden: true,
              createdAt: true,
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "getUserMediaStats_mediaRows",
            userId,
          },
        },
      );

      if (mediaRows.length === 0) {
        return {
          totalCount: 0,
          photoCount: 0,
          videoCount: 0,
          hiddenCount: 0,
          totalSize: 0,
          oldestMedia: null,
          newestMedia: null,
          byMonth: [],
        };
      }

      // Aggregate stats
      let totalSize = 0;
      let photoCount = 0;
      let videoCount = 0;
      let hiddenCount = 0;
      let oldestMedia: string | null = null;
      let newestMedia: string | null = null;
      const byMonthMap = new Map<string, number>();

      for (const row of mediaRows) {
        totalSize += row.size || 0;
        if (row.mimeType?.startsWith("image/")) photoCount += 1;
        if (row.mimeType?.startsWith("video/")) videoCount += 1;
        if (row.hidden) hiddenCount += 1;

        const created =
          row.createdAt instanceof Date
            ? row.createdAt
            : new Date(row.createdAt);
        const iso = created.toISOString();
        if (!newestMedia || created > new Date(newestMedia)) {
          newestMedia = iso;
        }
        if (!oldestMedia || created < new Date(oldestMedia)) {
          oldestMedia = iso;
        }

        const period = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, "0")}`;
        byMonthMap.set(period, (byMonthMap.get(period) || 0) + 1);
      }

      const totalCount = mediaRows.length;
      const byMonth = Array.from(byMonthMap.entries())
        .map(([period, count]) => ({ period, count }))
        .sort((a, b) => b.period.localeCompare(a.period));

      const result = {
        totalCount,
        photoCount,
        videoCount,
        hiddenCount,
        totalSize,
        oldestMedia,
        newestMedia,
        byMonth,
      };

      const duration = Date.now() - startTime;

      // Structured logging
      this.logger.info("[MediaHandler] Media stats retrieved", {
        operation: "getUserMediaStats",
        userId,
        region,
        duration,
        result: {
          totalCount,
          photoCount,
          videoCount,
          hiddenCount,
          totalSize,
          monthCount: byMonth.length,
        },
        metadata: {
          includeHidden: options.includeHidden || false,
          type: options.type || "all",
        },
      });

      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorType = error?.name || "UnknownError";

      // Error logging
      this.logger.error("[MediaHandler] Failed to get media stats", {
        operation: "getUserMediaStats",
        userId,
        region,
        duration,
        error: error?.message,
        errorType,
        metadata: {
          includeHidden: options.includeHidden || false,
          type: options.type || "all",
        },
      });

      throw error;
    }
  }

  /**
   * Factory function to create MediaHandler instance
   * Makes testing easier by allowing dependency injection
   */
  static create(env: Env): MediaHandler {
    return new MediaHandler(env);
  }

  /**
   * Get all media files for a user with pagination and filtering
   */
  async listUserMedia(
    userId: string,
    options: {
      limit?: number;
      cursor?: string;
      sort?: "newest" | "oldest";
      includeHidden?: boolean;
      type?: "photo" | "video" | "all";
      includeTotalCount?: boolean;
    },
    env: Env,
    request?: Request,
  ): Promise<{
    media: Array<{
      id: string;
      contentHash: string;
      mimeType: string;
      size: number;
      thumbnailUrl: string;
      optimizedUrl: string;
      originalUrl?: string;
      createdAt: string;
      hidden: boolean;
      postCount: number;
    }>;
    cursor: string | null;
    totalCount?: number;
  }> {
    const startTime = Date.now();
    const { DataRouter } = await import("./data-router.js");
    const { RegionDetector } = await import("./region-detection.js");

    // Multi-region awareness: detect region from request/session
    const regionDetector = new RegionDetector(env);
    const region = request
      ? await regionDetector.detectRegion(request, undefined, undefined)
      : (env.DEFAULT_REGION as any) || "EU";

    try {
      const db = request
        ? DataRouter.getDatabaseForRegion(region, env, request, userId)
        : DataRouter.getDatabaseForRegion(region, env);

      const limit = Math.min(options.limit || 50, 100);
      const sort = options.sort || "newest";
      const includeHidden = options.includeHidden || false;
      const type = options.type || "all";

      // Use timeout/retry for all database queries
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      // Get all post IDs by user - with timeout/retry
      const userPosts = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.post.findMany({
            where: {
              authorId: userId,
              deletedAt: null,
            },
            select: { id: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "listUserMedia_userPosts",
            userId,
          },
        },
      );
      const postIds = userPosts.map((p) => p.id);

      // Get all media IDs from user's posts - with timeout/retry
      const postMedia = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          if (postIds.length === 0) {
            return [];
          }
          return await db.postMedia.findMany({
            where: {
              postId: { in: postIds },
            },
            select: { mediaId: true },
            distinct: ["mediaId"],
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "listUserMedia_postMedia",
            userId,
          },
        },
      );
      const mediaIdsFromPosts = postMedia.map((pm) => pm.mediaId);

      // Get all Entity avatars owned by the user - with timeout/retry
      const userEntities = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.entity.findMany({
            where: {
              owners: { some: { userId: userId, status: 'ACTIVE' } },
            },
            select: { metadata: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "listUserMedia_userEntities",
            userId,
          },
        },
      );

      // Extract contentHashes and media IDs from Entity avatar URLs
      // Avatar URLs can be stored in multiple formats:
      // 1. Full URL: https://api.rkm1.de/api/media/{contentHash}?variant=...
      // 2. ContentHash: just the hash string
      // 3. Media ID: the media ID (CUID) directly
      const avatarContentHashes = new Set<string>();
      const avatarMediaIdsDirect = new Set<string>();
      for (const entity of userEntities) {
        if (entity.metadata && typeof entity.metadata === "object") {
          const metadata = entity.metadata as any;
          const avatarUrl = metadata.avatar;
          if (typeof avatarUrl === "string" && avatarUrl) {
            // Check if avatar URL is a media ID directly (CUID format: starts with 'c' and has alphanumeric chars)
            // Media IDs are typically CUIDs like 'cmji7uq2l0000l1j23af3r8bo'
            if (/^c[a-z0-9]{24}$/i.test(avatarUrl)) {
              avatarMediaIdsDirect.add(avatarUrl);
              continue;
            }

            // Check if it's a contentHash (hex string, typically 64 chars)
            if (/^[a-f0-9]{32,64}$/i.test(avatarUrl)) {
              avatarContentHashes.add(avatarUrl);
              continue;
            }

            // Extract contentHash from URL format: /api/media/{contentHash}?variant=...
            // Or: https://api.rkm1.de/api/media/{contentHash}?variant=...
            const match = avatarUrl.match(/\/api\/media\/([a-f0-9]+)(?:\?|$)/i);
            if (match && match[1]) {
              avatarContentHashes.add(match[1]);
              continue;
            }

            // Extract media ID from URL format: /api/media/{mediaId}
            // Or: https://api.rkm1.de/api/media/{mediaId}
            const mediaIdMatch = avatarUrl.match(
              /\/api\/media\/([a-z0-9]+)(?:\?|$)/i,
            );
            if (
              mediaIdMatch &&
              mediaIdMatch[1] &&
              /^c[a-z0-9]{24}$/i.test(mediaIdMatch[1])
            ) {
              avatarMediaIdsDirect.add(mediaIdMatch[1]);
            }
          }
        }
      }

      // Get media IDs from avatar contentHashes - with timeout/retry
      const avatarMediaIds: string[] = [...avatarMediaIdsDirect];
      if (avatarContentHashes.size > 0) {
        const avatarMedia = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            const dbAny = db as any;
            return await dbAny.mediaFile.findMany({
              where: {
                contentHash: { in: Array.from(avatarContentHashes) },
                deletedAt: null,
              },
              select: { id: true },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "listUserMedia_avatarMedia",
              userId,
            },
          },
        );
        avatarMediaIds.push(...avatarMedia.map((m: any) => m.id));
      }

      // Combine media IDs from posts and avatars
      const allMediaIds = [
        ...new Set([...mediaIdsFromPosts, ...avatarMediaIds]),
      ];

      if (allMediaIds.length === 0) {
        return { media: [], cursor: null };
      }

      // Build where clause
      const where: any = {
        id: { in: allMediaIds },
        deletedAt: null, // Exclude permanently deleted
      };

      if (!includeHidden) {
        where.hidden = false; // Exclude hidden media
      }

      // Filter by type
      if (type === "photo") {
        where.mimeType = { startsWith: "image/" };
      } else if (type === "video") {
        where.mimeType = { startsWith: "video/" };
      }

      // Cursor pagination
      if (options.cursor) {
        const cursorDate = new Date(options.cursor);
        if (sort === "oldest") {
          where.createdAt = { gt: cursorDate };
        } else {
          where.createdAt = { lt: cursorDate };
        }
      }

      // Fetch media - with timeout/retry
      const media = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          const dbAny = db as any;
          return await dbAny.mediaFile.findMany({
            where,
            orderBy: {
              createdAt: sort === "oldest" ? "asc" : "desc",
            },
            take: limit + 1, // Fetch one extra to check if there's more
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "listUserMedia_mediaFiles",
            userId,
          },
        },
      );

      // Check if there's more
      const hasMore = media.length > limit;
      const paginatedMedia = hasMore ? media.slice(0, limit) : media;
      const nextCursor =
        hasMore && paginatedMedia.length > 0
          ? paginatedMedia[paginatedMedia.length - 1].createdAt.toISOString()
          : null;

      // Get post counts for each media - with timeout/retry
      const mediaWithPostCounts = await Promise.all(
        paginatedMedia.map(async (m: any) => {
          const postCount = await withQueryTimeoutAndRetry(
            sharedDatabaseConnectionManager,
            region,
            env as any,
            async (db) => {
              return await db.postMedia.count({
                where: {
                  mediaId: m.id,
                  post: {
                    authorId: userId,
                    deletedAt: null,
                  },
                },
              });
            },
            {
              ...QueryTimeoutPresets.USER_FACING,
              maxRetries: 3,
              baseDelayMs: 100,
              context: {
                operation: "listUserMedia_postCount",
                userId,
                mediaId: m.id,
              },
            },
          );

          // Generate URLs for media variants
          // Always use API domain for media URLs (not frontend domain)
          const apiDomain = MediaHandler.getApiDomain(env);
          const thumbnailUrl = `${apiDomain}/api/media/${m.contentHash}?variant=thumbnail`;
          const optimizedUrl = `${apiDomain}/api/media/${m.contentHash}?variant=optimized`;
          const originalUrl = `${apiDomain}/api/media/${m.contentHash}?variant=original`;

          // Check if this media is used as an Entity avatar (for postCount calculation)
          // Avatar images will have postCount = 0, which is correct
          const isAvatar = avatarContentHashes.has(m.contentHash);

          return {
            id: m.id,
            contentHash: m.contentHash,
            mimeType: m.mimeType,
            size: m.size,
            thumbnailUrl,
            optimizedUrl,
            originalUrl,
            createdAt: m.createdAt.toISOString(),
            hidden: m.hidden || false,
            postCount, // Will be 0 for avatar images, which is correct
          };
        }),
      );

      // Calculate total count if requested
      let totalCount: number | undefined;
      if (options.includeTotalCount) {
        const totalMedia = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            const dbAny = db as any;
            return await dbAny.mediaFile.count({
              where,
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "listUserMedia_totalCount",
              userId,
            },
          },
        );
        totalCount = totalMedia;
      }

      const result = {
        media: mediaWithPostCounts,
        cursor: nextCursor,
        ...(totalCount !== undefined && { totalCount }),
      };

      const duration = Date.now() - startTime;

      // Structured logging
      this.logger.info("[MediaHandler] Media listed", {
        operation: "listUserMedia",
        userId,
        region,
        duration,
        result: {
          mediaCount: result.media.length,
          totalCount: result.totalCount,
          hasMore: result.cursor !== null,
        },
        metadata: {
          includeHidden: options.includeHidden || false,
          type: options.type || "all",
          sort: options.sort || "newest",
          limit: options.limit || 50,
        },
      });

      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorType = error?.name || "UnknownError";

      // Error logging
      this.logger.error("[MediaHandler] Failed to list media", {
        operation: "listUserMedia",
        userId,
        region,
        duration,
        error: error?.message,
        errorType,
        metadata: {
          includeHidden: options.includeHidden || false,
          type: options.type || "all",
          sort: options.sort || "newest",
        },
      });

      throw error;
    }
  }

  /**
   * Get detailed information about a specific media file
   */
  async getMediaDetails(
    mediaId: string,
    userId: string,
    env: Env,
    request?: Request,
  ): Promise<{
    id: string;
    contentHash: string;
    mimeType: string;
    size: number;
    thumbnailUrl: string;
    optimizedUrl: string;
    originalUrl: string;
    width?: number;
    height?: number;
    duration?: number;
    // Metadata fields (filtered based on privacy flags)
    exifData?: unknown;
    iptcData?: unknown;
    videoMetadata?: unknown;
    dateTaken?: string;
    metadataVisible: boolean;
    locationVisible: boolean;
    createdAt: string;
    updatedAt: string;
    hidden: boolean;
    hiddenAt: string | null;
    deletedAt: string | null;
    posts: Array<{
      id: string;
      text: string;
      createdAt: string;
      visibility: "PUBLIC" | "PRIVATE" | "FRIENDS";
      url: string;
    }>;
    canDelete: boolean;
    canHide: boolean;
  }> {
    const startTime = Date.now();
    const { DataRouter } = await import("./data-router.js");
    const { RegionDetector } = await import("./region-detection.js");

    // Multi-region awareness: detect region from request/session
    const regionDetector = new RegionDetector(env);
    const region = request
      ? await regionDetector.detectRegion(request, undefined, undefined)
      : (env.DEFAULT_REGION as any) || "EU";

    try {
      // Use timeout/retry for all database queries
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      // Get media file - with timeout/retry
      const media = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          const dbAny = db as any;
          return await dbAny.mediaFile.findUnique({
            where: { id: mediaId },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "getMediaDetails_findMedia",
            userId,
            mediaId,
          },
        },
      );

      if (!media) {
        throw new Error("Media not found");
      }

      // Verify user owns this media (check if it's in any of their posts OR used as Entity avatar) - with timeout/retry
      const userPosts = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.post.findMany({
            where: {
              authorId: userId,
              deletedAt: null,
            },
            select: { id: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "getMediaDetails_userPosts",
            userId,
            mediaId,
          },
        },
      );
      const postIds = userPosts.map((p) => p.id);

      // Check if media is in user's posts - with timeout/retry
      let isInPosts = false;
      if (postIds.length > 0) {
        const postMedia = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.postMedia.findFirst({
              where: {
                mediaId: media.id,
                postId: { in: postIds },
              },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "getMediaDetails_verifyOwnership",
              userId,
              mediaId,
            },
          },
        );
        isInPosts = !!postMedia;
      }

      // Check if media is used as Entity avatar - with timeout/retry
      const userEntities = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.entity.findMany({
            where: {
              owners: { some: { userId: userId, status: 'ACTIVE' } },
            },
            select: { metadata: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "getMediaDetails_userEntities",
            userId,
            mediaId,
          },
        },
      );

      // Extract contentHashes from Entity avatar URLs
      // Avatar URLs can be stored in multiple formats:
      // 1. Full URL: https://api.rkm1.de/api/media/{contentHash}?variant=...
      // 2. ContentHash: just the hash string
      // 3. Media ID: the media ID (CUID)
      let isAvatar = false;
      for (const entity of userEntities) {
        if (entity.metadata && typeof entity.metadata === "object") {
          const metadata = entity.metadata as any;
          const avatarUrl = metadata.avatar;
          if (typeof avatarUrl === "string" && avatarUrl) {
            // Check if avatar URL matches media ID directly
            if (avatarUrl === media.id) {
              isAvatar = true;
              break;
            }

            // Check if avatar URL matches contentHash directly
            if (avatarUrl === media.contentHash) {
              isAvatar = true;
              break;
            }

            // Extract contentHash from URL format: /api/media/{contentHash}?variant=...
            // Or: https://api.rkm1.de/api/media/{contentHash}?variant=...
            const match = avatarUrl.match(/\/api\/media\/([a-f0-9]+)(?:\?|$)/i);
            if (match && match[1] === media.contentHash) {
              isAvatar = true;
              break;
            }

            // Also check if URL contains media ID (for URLs like /api/media/{mediaId})
            const mediaIdMatch = avatarUrl.match(
              /\/api\/media\/([a-z0-9]+)(?:\?|$)/i,
            );
            if (mediaIdMatch && mediaIdMatch[1] === media.id) {
              isAvatar = true;
              break;
            }
          }
        }
      }

      // User must own the media either through posts OR as Entity avatar
      if (!isInPosts && !isAvatar) {
        throw new Error("Media not found");
      }

      // Get all posts using this media (only user's posts) - with timeout/retry
      // For Entity avatars, postIds will be empty, so return empty array
      const postsWithMedia =
        postIds.length > 0
          ? await withQueryTimeoutAndRetry(
              sharedDatabaseConnectionManager,
              region,
              env as any,
              async (db) => {
                return await db.post.findMany({
                  where: {
                    id: { in: postIds },
                    deletedAt: null,
                    media: {
                      some: {
                        mediaId: media.id,
                      },
                    },
                  },
                  select: {
                    id: true,
                    text: true,
                    createdAt: true,
                    radius: true,
                  },
                });
              },
              {
                ...QueryTimeoutPresets.USER_FACING,
                maxRetries: 3,
                baseDelayMs: 100,
                context: {
                  operation: "getMediaDetails_postsWithMedia",
                  userId,
                  mediaId,
                },
              },
            )
          : [];

      // Check if media is shared with other users' posts - with timeout/retry
      const allPostsWithMedia = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postMedia.findMany({
            where: { mediaId: media.id },
            include: {
              post: {
                select: {
                  authorId: true,
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
            operation: "getMediaDetails_checkShared",
            userId,
            mediaId,
          },
        },
      );

      const otherUsersPosts = allPostsWithMedia.filter(
        (pm: any) => pm.post.authorId !== userId,
      );
      const isShared = otherUsersPosts.length > 0;

      // Generate URLs
      const apiDomain = MediaHandler.getApiDomain(env);
      const thumbnailUrl = `${apiDomain}/api/media/${media.contentHash}?variant=thumbnail`;
      const optimizedUrl = `${apiDomain}/api/media/${media.contentHash}?variant=optimized`;
      const originalUrl = `${apiDomain}/api/media/${media.contentHash}?variant=original`;

      // Privacy flags gate the metadata fields in the response (D13 data-minimization).
      // metadataVisible defaults false — metadata is private unless the owner has
      // explicitly enabled sharing. locationVisible gates any location-bearing fields.
      // The flags themselves are always included so the frontend can render the toggle.
      const metadataVisible = media.metadataVisible ?? false;
      const locationVisible = media.locationVisible ?? false;

      const result = {
        id: media.id,
        contentHash: media.contentHash,
        mimeType: media.mimeType,
        size: media.size,
        thumbnailUrl,
        optimizedUrl,
        originalUrl,
        width: media.width ?? undefined,
        height: media.height ?? undefined,
        duration: media.duration ?? undefined,
        // exifData/iptcData/dateTaken: withheld when metadataVisible is false
        ...(metadataVisible && {
          exifData: media.exifData ?? undefined,
          iptcData: media.iptcData ?? undefined,
          dateTaken: media.dateTaken?.toISOString(),
        }),
        // videoMetadata does not contain privacy-sensitive EXIF; gated separately
        videoMetadata: media.videoMetadata ?? undefined,
        // Art. 50 provenance — DELIBERATELY NOT behind `metadataVisible`. That
        // gate protects privacy-sensitive metadata (EXIF/GPS/camera identity);
        // provenance is the opposite kind of thing, a disclosure meant to be
        // seen. Intrinsic reading only: an author's declaration belongs to a
        // *use* of the bytes (PostMedia), not to the bytes.
        provenance: mediaProvenanceView(media),
        metadataVisible,
        locationVisible,
        createdAt: media.createdAt.toISOString(),
        updatedAt: media.updatedAt.toISOString(),
        hidden: media.hidden || false,
        hiddenAt: media.hiddenAt?.toISOString() || null,
        deletedAt: media.deletedAt?.toISOString() || null,
        posts: postsWithMedia.map((post: any) => ({
          id: post.id,
          text: post.text || "",
          createdAt: post.createdAt.toISOString(),
          visibility: post.visibility,
          url: `/posts/${post.id}`,
        })),
        canDelete: !isShared && !media.deletedAt, // Can delete if not shared and not already deleted
        canHide: !media.hidden && !media.deletedAt, // Can hide if not already hidden/deleted
      };

      const duration = Date.now() - startTime;

      // Structured logging
      this.logger.info("[MediaHandler] Media details retrieved", {
        operation: "getMediaDetails",
        userId,
        region,
        duration,
        result: {
          mediaId,
          postCount: result.posts.length,
          isShared,
          canDelete: result.canDelete,
          canHide: result.canHide,
        },
      });

      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorType = error?.name || "UnknownError";

      // Error logging
      this.logger.error("[MediaHandler] Failed to get media details", {
        operation: "getMediaDetails",
        userId,
        region,
        duration,
        mediaId,
        error: error?.message,
        errorType,
      });

      throw error;
    }
  }

  /**
   * Hide a media file
   */
  async hideMedia(
    mediaId: string,
    userId: string,
    env: Env,
    request?: Request,
  ): Promise<{
    id: string;
    hidden: boolean;
    hiddenAt: string;
  }> {
    const startTime = Date.now();
    const { RegionDetector } = await import("./region-detection.js");
    const regionDetector = new RegionDetector(env);
    const region = request
      ? await regionDetector.detectRegion(request, undefined, undefined)
      : (env.DEFAULT_REGION as any) || "EU";

    try {
      // Verify ownership and get media
      const details = await this.getMediaDetails(mediaId, userId, env, request);

      if (details.deletedAt) {
        throw new Error("Cannot hide deleted media");
      }

      if (details.hidden) {
        throw new Error("Media is already hidden");
      }

      // Update media - with timeout/retry
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );
      const { TrellisAuditLogger } = await import("./audit-composer.js");

      const auditLogger = new TrellisAuditLogger(env);
      const updated = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          const dbAny = db as any;
          return await dbAny.mediaFile.update({
            where: { id: mediaId },
            data: {
              hidden: true,
              hiddenAt: new Date(),
              hiddenBy: userId,
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "hideMedia",
            userId,
            mediaId,
          },
        },
      );

      // Audit logging
      try {
        const ipAddress =
          request?.headers.get("CF-Connecting-IP") ||
          request?.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
          undefined;
        const userAgent = request?.headers.get("User-Agent") || undefined;

        await auditLogger.log(
          {
            type: "data_update",
            action: "media_hidden",
            resource: "media",
            resourceId: mediaId,
            userId,
            region,
            ipAddress,
            userAgent,
            metadata: { mediaId, hidden: true },
            severity: "low",
            success: true,
          },
          env,
        );
      } catch (auditError) {
        // Don't fail the operation if audit logging fails
        this.logger.warn("[MediaHandler] Audit logging failed for hideMedia", {
          error: auditError,
        });
      }

      const duration = Date.now() - startTime;
      const result = {
        id: updated.id,
        hidden: updated.hidden,
        hiddenAt: updated.hiddenAt.toISOString(),
      };

      // Structured logging
      this.logger.info("[MediaHandler] Media hidden", {
        operation: "hideMedia",
        userId,
        region,
        duration,
        result: {
          mediaId,
          hidden: result.hidden,
        },
      });

      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorType = error?.name || "UnknownError";

      // Error logging
      this.logger.error("[MediaHandler] Failed to hide media", {
        operation: "hideMedia",
        userId,
        region,
        duration,
        mediaId,
        error: error?.message,
        errorType,
      });

      throw error;
    }
  }

  /**
   * Unhide a media file
   */
  async unhideMedia(
    mediaId: string,
    userId: string,
    env: Env,
    request?: Request,
  ): Promise<{
    id: string;
    hidden: boolean;
    hiddenAt: string | null;
  }> {
    const startTime = Date.now();
    const { RegionDetector } = await import("./region-detection.js");
    const regionDetector = new RegionDetector(env);
    const region = request
      ? await regionDetector.detectRegion(request, undefined, undefined)
      : (env.DEFAULT_REGION as any) || "EU";

    try {
      // Verify ownership and get media
      const details = await this.getMediaDetails(mediaId, userId, env, request);

      if (details.deletedAt) {
        throw new Error("Cannot unhide deleted media");
      }

      if (!details.hidden) {
        throw new Error("Media is not hidden");
      }

      // Update media - with timeout/retry
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );
      const { TrellisAuditLogger } = await import("./audit-composer.js");

      const auditLogger = new TrellisAuditLogger(env);
      const updated = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          const dbAny = db as any;
          return await dbAny.mediaFile.update({
            where: { id: mediaId },
            data: {
              hidden: false,
              hiddenAt: null,
              hiddenBy: null,
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "unhideMedia",
            userId,
            mediaId,
          },
        },
      );

      // Audit logging
      try {
        const ipAddress =
          request?.headers.get("CF-Connecting-IP") ||
          request?.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
          undefined;
        const userAgent = request?.headers.get("User-Agent") || undefined;

        await auditLogger.log(
          {
            type: "data_update",
            action: "media_unhidden",
            resource: "media",
            resourceId: mediaId,
            userId,
            region,
            ipAddress,
            userAgent,
            metadata: { mediaId, hidden: false },
            severity: "low",
            success: true,
          },
          env,
        );
      } catch (auditError) {
        // Don't fail the operation if audit logging fails
        this.logger.warn(
          "[MediaHandler] Audit logging failed for unhideMedia",
          { error: auditError },
        );
      }

      const duration = Date.now() - startTime;
      const result = {
        id: updated.id,
        hidden: updated.hidden,
        hiddenAt: null,
      };

      // Structured logging
      this.logger.info("[MediaHandler] Media unhidden", {
        operation: "unhideMedia",
        userId,
        region,
        duration,
        result: {
          mediaId,
          hidden: result.hidden,
        },
      });

      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorType = error?.name || "UnknownError";

      // Error logging
      this.logger.error("[MediaHandler] Failed to unhide media", {
        operation: "unhideMedia",
        userId,
        region,
        duration,
        mediaId,
        error: error?.message,
        errorType,
      });

      throw error;
    }
  }

  /**
   * Delete a media file (soft delete)
   */
  async deleteMedia(
    mediaId: string,
    userId: string,
    env: Env,
    request?: Request,
  ): Promise<void> {
    const startTime = Date.now();
    const { RegionDetector } = await import("./region-detection.js");
    const regionDetector = new RegionDetector(env);
    const region = request
      ? await regionDetector.detectRegion(request, undefined, undefined)
      : (env.DEFAULT_REGION as any) || "EU";

    try {
      // Verify ownership and get media
      const details = await this.getMediaDetails(mediaId, userId, env, request);

      if (details.deletedAt) {
        throw new Error("Media is already deleted");
      }

      // Check if shared with other users - with timeout/retry
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );
      const { TrellisAuditLogger } = await import("./audit-composer.js");

      const auditLogger = new TrellisAuditLogger(env);
      const allPostsWithMedia = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.postMedia.findMany({
            where: { mediaId },
            include: {
              post: {
                select: {
                  authorId: true,
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
            operation: "deleteMedia_checkShared",
            userId,
            mediaId,
          },
        },
      );

      const otherUsersPosts = allPostsWithMedia.filter(
        (pm: any) => pm.post.authorId !== userId,
      );

      if (otherUsersPosts.length > 0) {
        // If shared, hide instead of delete
        await this.hideMedia(mediaId, userId, env, request);

        // Audit logging for hide (instead of delete)
        try {
          const ipAddress =
            request?.headers.get("CF-Connecting-IP") ||
            request?.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
            undefined;
          const userAgent = request?.headers.get("User-Agent") || undefined;

          await auditLogger.log(
            {
              type: "data_update",
              action: "media_delete_attempted_shared",
              resource: "media",
              resourceId: mediaId,
              userId,
              region,
              ipAddress,
              userAgent,
              metadata: {
                mediaId,
                action: "hidden_instead_of_deleted",
                reason: "shared_with_other_users",
                otherUsersCount: otherUsersPosts.length,
              },
              severity: "medium",
              success: true,
            },
            env,
          );
        } catch (auditError) {
          this.logger.warn(
            "[MediaHandler] Audit logging failed for deleteMedia (shared)",
            { error: auditError },
          );
        }

        throw new Error(
          "Media is used by other users. It has been hidden instead of deleted.",
        );
      }

      // Soft delete - with timeout/retry
      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          const dbAny = db as any;
          return await dbAny.mediaFile.update({
            where: { id: mediaId },
            data: {
              deletedAt: new Date(),
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "deleteMedia",
            userId,
            mediaId,
          },
        },
      );

      // Audit logging
      try {
        const ipAddress =
          request?.headers.get("CF-Connecting-IP") ||
          request?.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
          undefined;
        const userAgent = request?.headers.get("User-Agent") || undefined;

        await auditLogger.log(
          {
            type: "data_delete",
            action: "media_deleted",
            resource: "media",
            resourceId: mediaId,
            userId,
            region,
            ipAddress,
            userAgent,
            metadata: { mediaId, softDelete: true },
            severity: "medium",
            success: true,
          },
          env,
        );
      } catch (auditError) {
        // Don't fail the operation if audit logging fails
        this.logger.warn(
          "[MediaHandler] Audit logging failed for deleteMedia",
          { error: auditError },
        );
      }

      const duration = Date.now() - startTime;

      // Structured logging
      this.logger.info("[MediaHandler] Media deleted", {
        operation: "deleteMedia",
        userId,
        region,
        duration,
        result: {
          mediaId,
          softDelete: true,
        },
      });

      // R2 object deletion is handled by MediaCleanupHandler scheduled job
      // See: apps/api/src/lib/media-cleanup-handler.ts
      // Runs daily at 3:00 AM UTC with 7-day grace period
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorType = error?.name || "UnknownError";

      // Error logging
      this.logger.error("[MediaHandler] Failed to delete media", {
        operation: "deleteMedia",
        userId,
        region,
        duration,
        mediaId,
        error: error?.message,
        errorType,
      });

      throw error;
    }
  }
}
