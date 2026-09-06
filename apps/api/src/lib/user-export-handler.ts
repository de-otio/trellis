import type { KVNamespace, R2Bucket, CloudflareQueue, Queue } from "../types/cloudflare-compat.js";
/**
 * User Data Export Handler
 *
 * Handles exporting all user data in an interchangeable format (JSON)
 * and optionally in AT Protocol-compatible format for PDS migration.
 *
 * This is now an ASYNC job-based system to handle large datasets without
 * impacting live application performance.
 *
 * PREPARATORY: Uses DataRouter for region-aware data operations.
 */

import { DataRouter } from "./data-router.js";
import { getExtensionModelRegistry } from "./extension-model-registry.js";
import { Session } from "./session-cookie.js";
import type { TrellisRequestContext } from "./request-context.js";

import { getLogger, Logger, type LoggerEnv } from "./logger.js";

export interface Env {
  DATABASE_URL: string;
  US_DATABASE_URL?: string;
  EU_DATABASE_URL?: string;
  CN_DATABASE_URL?: string;
  EXPORT_JOBS_KV?: KVNamespace; // KV for job status tracking
  EXPORT_FILES_R2?: R2Bucket; // R2 for storing export files
  EXPORT_QUEUE?: Queue; // Queue for processing export jobs
  DEFAULT_REGION?: string;
}

export interface ExportJob {
  jobId: string;
  userId: string;
  email: string;
  format: "json" | "atproto";
  status: "pending" | "processing" | "completed" | "failed";
  region?: string; // PREPARATORY: User's region for data residency
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
  fileKey?: string; // R2 object key for the export file
  expiresAt?: string; // When the file will be deleted from R2
}

export interface UserExportData {
  // Metadata
  exportedAt: string;
  format: "json" | "atproto";
  version: string;

  // User profile
  user: {
    id: string;
    email: string;
    did?: string | null;
    handle?: string | null;
    createdAt: string;
  };

  // User content
  posts: Array<{
    id: string;
    text: string;
    visibility: string;
    entityRef?: string | null;
    geoData?: any;
    uri?: string | null;
    contentWarnings: string[];
    createdAt: string;
    updatedAt: string;
    media: Array<{
      id: string;
      mediaId: string;
      alt?: string | null;
      order: number;
    }>;
    sentiments: Array<{
      id: string;
      sentiment: string;
      createdAt: string;
    }>;
    comments: Array<{
      id: string;
      text: string;
      postUri?: string | null;
      rootUri?: string | null;
      replyToUri?: string | null;
      createdAt: string;
      media: Array<{
        id: string;
        mediaId: string;
        alt?: string | null;
        order: number;
      }>;
      sentiments: Array<{
        id: string;
        sentiment: string;
        createdAt: string;
      }>;
    }>;
  }>;

  // Comments made by user on others' posts
  commentsOnOthersPosts: Array<{
    id: string;
    postId: string;
    postUri?: string | null;
    text: string;
    rootUri?: string | null;
    replyToUri?: string | null;
    createdAt: string;
    media: Array<{
      id: string;
      mediaId: string;
      alt?: string | null;
      order: number;
    }>;
    sentiments: Array<{
      id: string;
      sentiment: string;
      createdAt: string;
    }>;
  }>;

  // Reactions/sentiments on others' posts
  reactionsOnOthersPosts: Array<{
    id: string;
    postId: string;
    postUri?: string | null;
    sentiment: string;
    createdAt: string;
  }>;

  // Reactions/sentiments on others' comments
  reactionsOnOthersComments: Array<{
    id: string;
    commentId: string;
    commentUri?: string | null;
    sentiment: string;
    createdAt: string;
  }>;

  // Geo-indexed posts (location data)
  geoIndexedPosts: Array<{
    postUri: string;
    entityRef: string | null;
    geohash: string;
    lat: number;
    lng: number;
    place?: string | null;
    labels?: any;
    createdAt: string;
  }>;

  // Friendships (if stored in database - currently in KV)
  friendships?: Array<{
    id: string;
    friendId: string;
    friendEmail: string;
    status: string;
    createdAt: string;
    acceptedAt?: string | null;
  }>;

  // Extension-owned rows where this user is the erasure subject (O-1), keyed by
  // model name. GDPR Art. 15/20 completeness for extension tables — symmetric to
  // deleteUserData's registry-driven erasure (Art. 17). Present only when an
  // extension owns such a table AND the user has rows in it (e.g. a dog's
  // ext_dog__private microchip/passport belong to the keeper who entered them).
  extensionData?: Record<string, unknown[]>;
}

export class UserExportHandler {
  /**
   * Create a new export job (async)
   * Returns job ID immediately, processing happens in background
   *
   * PREPARATORY: Stores user's region for data residency compliance.
   */
  async createExportJob(
    session: Session,
    env: Env,
    format: "json" | "atproto" = "json",
    requestContext?: TrellisRequestContext,
  ): Promise<ExportJob> {
    const jobId = `export-${session.userId}-${Date.now()}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

    // PREPARATORY: Get user's region from requestContext or fallback to default
    // If not provided, we'll need to look it up from the user record during processing
    const region = requestContext?.region || env.DEFAULT_REGION || "EU";

    const job: ExportJob = {
      jobId,
      userId: session.userId,
      email: session.email,
      format,
      status: "pending",
      region, // PREPARATORY: Store region for data residency
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    // Both writes below used to be wrapped in `if (env.X)`, so a deployment
    // missing either binding returned a `pending` job that was never stored
    // and never queued. The caller sees success; `getJobStatus` then reports
    // "not found"; the export never happens. This is the GDPR Art. 15 access
    // right, so reporting an accepted request that does not exist is the one
    // outcome that must not be possible.
    //
    // (The old `else` branch here claimed a "process immediately" fallback for
    // development. There was no fallback — it logged a warning and returned.)
    if (!env.EXPORT_JOBS_KV) {
      getLogger().error(
        "[UserExportHandler] EXPORT_JOBS_KV binding is missing — refusing rather than reporting an export that cannot be tracked.",
      );
      throw new Error("Data export is unavailable. Please try again later.");
    }
    if (!env.EXPORT_QUEUE) {
      getLogger().error(
        "[UserExportHandler] EXPORT_QUEUE binding is missing — refusing rather than reporting an export that will never run.",
      );
      throw new Error("Data export is unavailable. Please try again later.");
    }

    // Store job in KV
    await env.EXPORT_JOBS_KV.put(
      `job:${jobId}`,
      JSON.stringify(job),
      { expirationTtl: 7 * 24 * 60 * 60 }, // 7 days TTL
    );

    // Queue the job for processing. Ordered after the KV write on purpose: a
    // queued job whose status row is missing looks to the user like an export
    // that was never requested.
    await env.EXPORT_QUEUE.send({
      jobId,
      userId: session.userId,
      email: session.email,
      format,
      region, // PREPARATORY: Include region in queue message
    });

    return job;
  }

  /**
   * Get export job status
   */
  async getJobStatus(
    jobId: string,
    userId: string,
    env: Env,
  ): Promise<ExportJob | null> {
    if (!env.EXPORT_JOBS_KV) {
      return null;
    }

    const jobData = await env.EXPORT_JOBS_KV.get(`job:${jobId}`);
    if (!jobData) {
      return null;
    }

    const job: ExportJob = JSON.parse(jobData);

    // Verify job belongs to user
    if (job.userId !== userId) {
      return null;
    }

    return job;
  }

  /**
   * Collect extension-owned rows where the user is the erasure subject (O-1),
   * for GDPR Art. 15/20 export completeness. Symmetric to deleteUserData's
   * registry-driven erasure (Art. 17): any `ext_*` model that declares an
   * `erasureSubjectField` holds that user's personal data and must be exported.
   * Resilient per-model — a single model's failure is logged, never fatal to
   * the whole export. Returns a map of model name → rows (only non-empty ones).
   */
  private async collectExtensionData(
    db: any,
    userId: string,
  ): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    for (const entry of getExtensionModelRegistry()) {
      if (!entry.erasureSubjectField) continue;
      const delegate = db?.[entry.model];
      if (!delegate || typeof delegate.findMany !== "function") continue;
      try {
        const rows = await delegate.findMany({
          where: { [entry.erasureSubjectField]: userId },
        });
        if (Array.isArray(rows) && rows.length > 0) {
          out[entry.model] = rows;
        }
      } catch (error) {
        getLogger().warn(
          `[UserExportHandler] extension export failed for model ${entry.model}`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    }
    return out;
  }

  /**
   * Process export job (called by queue consumer)
   * This is the actual export processing that runs asynchronously
   *
   * PREPARATORY: Uses DataRouter for region-aware data operations.
   */
  async processExportJob(
    jobData: {
      jobId: string;
      userId: string;
      email: string;
      format: "json" | "atproto";
      region?: string;
    },
    env: Env,
  ): Promise<void> {
    const { jobId, userId, format, region: jobRegion } = jobData;

    // PREPARATORY: Get region from job data, or look up from user record, or use default
    let region = jobRegion;
    if (!region) {
      // Try to get region from job stored in KV
      if (env.EXPORT_JOBS_KV) {
        const jobDataStr = await env.EXPORT_JOBS_KV.get(`job:${jobId}`);
        if (jobDataStr) {
          const job: ExportJob = JSON.parse(jobDataStr);
          region = job.region;
        }
      }

      // If still no region, try to get from user record
      if (!region) {
        try {
          const user = await DataRouter.getUser(userId, "US", env); // Try US first
          if (user?.region) {
            region = user.region;
          } else {
            // Try other regions
            for (const r of ["EU", "CN"] as const) {
              const user = await DataRouter.getUser(userId, r, env);
              if (user?.region) {
                region = user.region;
                break;
              }
            }
          }
        } catch (error) {
          getLogger().warn(
            `[UserExportHandler] Could not determine user region for ${userId}, using default`,
          );
        }
      }

      // Final fallback
      region = region || env.DEFAULT_REGION || "EU";
    }

    // PREPARATORY: Use DataRouter to get region-specific database
    const db = DataRouter.getDatabaseForRegion(region, env);

    try {
      // Update job status to processing
      await this.updateJobStatus(jobId, "processing", env, {
        startedAt: new Date().toISOString(),
      });

      // PREPARATORY: Get user profile using DataRouter (validates region)
      const user = await DataRouter.getUser(userId, region, env);

      if (!user) {
        throw new Error("User not found");
      }

      // PREPARATORY: Get all posts by user with dataRegion filter
      const posts = await db.post.findMany({
        where: {
          authorId: userId,
          deletedAt: null,
          // CRITICAL: Only get posts from the correct region
          dataRegion: region,
        },
        include: {
          media: {
            orderBy: { order: "asc" },
          },
          sentiments: true,
          comments: {
            include: {
              media: {
                orderBy: { order: "asc" },
              },
              sentiments: true,
            },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      // PREPARATORY: Get comments made by user on others' posts
      // Comments inherit region from their parent post, so we query the region-specific database
      const commentsOnOthersPosts = await db.postComment.findMany({
        where: {
          authorId: userId,
          post: {
            authorId: { not: userId },
          },
        },
        include: {
          media: {
            orderBy: { order: "asc" },
          },
          sentiments: true,
        },
        orderBy: { createdAt: "desc" },
      });

      // PREPARATORY: Get reactions on others' posts
      const reactionsOnOthersPosts = await db.postSentiment.findMany({
        where: {
          authorId: userId,
          post: {
            authorId: { not: userId },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      // PREPARATORY: Get reactions on others' comments
      const reactionsOnOthersComments = await db.commentSentiment.findMany({
        where: {
          authorId: userId,
          comment: {
            authorId: { not: userId },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      // Get geo-indexed posts
      const geoIndexedPosts = await db.postGeoIndex.findMany({
        where: {
          postUri: {
            in: posts.filter((p) => p.uri).map((p) => p.uri!),
          },
        },
        orderBy: { createdAt: "desc" },
      });

      // Extension-owned data where the user is the erasure subject (O-1 / GDPR
      // Art. 15/20). Empty unless an extension owns such a table (e.g. dogs'
      // ext_dog__private) and the user has rows.
      const extensionData = await this.collectExtensionData(db, userId);

      // Format the export data
      const exportData: UserExportData = {
        exportedAt: new Date().toISOString(),
        format,
        version: "1.0",
        user: {
          id: user.id,
          email: user.email,
          // `did` (AT Protocol DID) is not a User column — this codebase never
          // adopted AT Proto identity; kept `null` for export-shape stability
          // with the legacy `atproto` export format below.
          did: null,
          // `handle`/`createdAt` are real, non-nullable User columns, but
          // DataRouter.getUser()'s declared return type only names id/email/
          // region/dataRegion (the rest falls under its `[key: string]:
          // unknown` index signature) — narrow them here rather than in that
          // shared helper.
          handle: typeof user.handle === "string" ? user.handle : null,
          createdAt:
            user.createdAt instanceof Date
              ? user.createdAt.toISOString()
              : typeof user.createdAt === "string"
                ? new Date(user.createdAt).toISOString()
                : new Date().toISOString(),
        },
        posts: posts.map((post) => ({
          id: post.id,
          text: post.text,
          // `visibility`/`entityRef` are not Post columns (visibility was
          // replaced by `radius`/audience scopes; see data-router.ts — there is
          // no `visibility` column, and `entityRef` was never one). Both were
          // always `undefined` here even before this cast cleanup, which
          // `JSON.stringify` drops silently, so this export field is always
          // absent in practice. Kept as a typed cast (not `any`) so the export
          // shape is unchanged pending a decision on whether to drop these
          // fields from `UserExportData` outright.
          visibility: (post as { visibility?: string }).visibility as string,
          entityRef: (post as { entityRef?: string | null }).entityRef,
          geoData: post.geoData,
          uri: post.uri,
          contentWarnings: post.contentWarnings,
          createdAt: post.createdAt.toISOString(),
          updatedAt: post.updatedAt.toISOString(),
          media: post.media.map((m) => ({
            id: m.id,
            mediaId: m.mediaId,
            alt: m.alt,
            order: m.order,
          })),
          sentiments: post.sentiments.map((s) => ({
            id: s.id,
            sentiment: s.sentiment,
            createdAt: s.createdAt.toISOString(),
          })),
          comments: post.comments.map((c) => ({
            id: c.id,
            text: c.text,
            postUri: c.postUri,
            rootUri: c.rootUri,
            replyToUri: c.replyToUri,
            createdAt: c.createdAt.toISOString(),
            media: c.media.map((m) => ({
              id: m.id,
              mediaId: m.mediaId,
              alt: m.alt,
              order: m.order,
            })),
            sentiments: c.sentiments.map((s) => ({
              id: s.id,
              sentiment: s.sentiment,
              createdAt: s.createdAt.toISOString(),
            })),
          })),
        })),
        commentsOnOthersPosts: commentsOnOthersPosts.map((comment) => ({
          id: comment.id,
          postId: comment.postId,
          postUri: comment.postUri,
          text: comment.text,
          rootUri: comment.rootUri,
          replyToUri: comment.replyToUri,
          createdAt: comment.createdAt.toISOString(),
          media: comment.media.map((m) => ({
            id: m.id,
            mediaId: m.mediaId,
            alt: m.alt,
            order: m.order,
          })),
          sentiments: comment.sentiments.map((s) => ({
            id: s.id,
            sentiment: s.sentiment,
            createdAt: s.createdAt.toISOString(),
          })),
        })),
        reactionsOnOthersPosts: reactionsOnOthersPosts.map(
          (reaction) => ({
            id: reaction.id,
            postId: reaction.postId,
            postUri: reaction.postUri,
            sentiment: reaction.sentiment,
            createdAt: reaction.createdAt.toISOString(),
          }),
        ),
        reactionsOnOthersComments: reactionsOnOthersComments.map(
          (reaction) => ({
            id: reaction.id,
            commentId: reaction.commentId,
            commentUri: reaction.commentUri,
            sentiment: reaction.sentiment,
            createdAt: reaction.createdAt.toISOString(),
          }),
        ),
        geoIndexedPosts: geoIndexedPosts.map((geo) => ({
          postUri: geo.postUri,
          entityRef: geo.entityRef,
          geohash: geo.geohash,
          lat: geo.lat,
          lng: geo.lng,
          place: geo.place,
          labels: geo.labels,
          createdAt: geo.createdAt.toISOString(),
        })),
        ...(Object.keys(extensionData).length > 0 ? { extensionData } : {}),
      };

      // Transform to AT Protocol format if needed
      const finalData =
        format === "atproto"
          ? this.transformToATProtoFormat(exportData)
          : exportData;

      // Serialize to JSON
      const jsonData = JSON.stringify(finalData, null, 2);
      const filename =
        format === "atproto"
          ? `trellis-export-atproto-${new Date().toISOString().split("T")[0]}.json`
          : `trellis-export-json-${new Date().toISOString().split("T")[0]}.json`;

      // Store in R2
      let fileKey: string | undefined;
      if (env.EXPORT_FILES_R2) {
        fileKey = `exports/${userId}/${jobId}/${filename}`;
        await env.EXPORT_FILES_R2.put(fileKey, jsonData, {
          httpMetadata: {
            contentType: "application/json",
            contentDisposition: `attachment; filename="${filename}"`,
          },
          customMetadata: {
            userId,
            format,
            exportedAt: new Date().toISOString(),
          },
        });
      }

      // Update job status to completed
      await this.updateJobStatus(jobId, "completed", env, {
        completedAt: new Date().toISOString(),
        fileKey,
      });

      getLogger().info(
        `[UserExportHandler] Export job ${jobId} completed successfully`,
      );
    } catch (error: any) {
      getLogger().error(
        `[UserExportHandler] Export job ${jobId} failed:`,
        error,
      );
      await this.updateJobStatus(jobId, "failed", env, {
        failedAt: new Date().toISOString(),
        error: error.message || "Unknown error",
      });
      throw error; // Re-throw to trigger queue retry
    }
  }

  /**
   * Update job status in KV
   */
  private async updateJobStatus(
    jobId: string,
    status: ExportJob["status"],
    env: Env,
    updates: Partial<ExportJob>,
  ): Promise<void> {
    if (!env.EXPORT_JOBS_KV) {
      return;
    }

    const existing = await env.EXPORT_JOBS_KV.get(`job:${jobId}`);
    if (!existing) {
      return;
    }

    const job: ExportJob = JSON.parse(existing);
    const updated: ExportJob = {
      ...job,
      status,
      ...updates,
    };

    await env.EXPORT_JOBS_KV.put(
      `job:${jobId}`,
      JSON.stringify(updated),
      { expirationTtl: 7 * 24 * 60 * 60 }, // 7 days TTL
    );
  }

  /**
   * Get export file from R2
   */
  async getExportFile(
    jobId: string,
    userId: string,
    env: Env,
  ): Promise<Response | null> {
    // Verify job belongs to user and is completed
    const job = await this.getJobStatus(jobId, userId, env);
    if (!job || job.status !== "completed" || !job.fileKey) {
      return null;
    }

    if (!env.EXPORT_FILES_R2) {
      return null;
    }

    // Get file from R2
    const object = await env.EXPORT_FILES_R2.get(job.fileKey);
    if (!object) {
      return null;
    }

    // Extract filename from fileKey
    const filename = job.fileKey.split("/").pop() || "export.json";

    // Read the R2 object body as text
    const body = await object.text();

    return new Response(body, {
      headers: {
        "content-type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-cache",
      },
    });
  }

  /**
   * Transform export data to AT Protocol-compatible format.
   *
   * Returns `Record<string, unknown>`, not `UserExportData`: the atproto
   * `posts` shape below ($type/thread/blob refs) is genuinely different from
   * `UserExportData.posts` (id/visibility/media/…) — the old `UserExportData`
   * return type combined with an `as any` on `posts` was papering over that.
   * The only consumer (`getExportedFile`/its caller) immediately
   * `JSON.stringify`s the result, so this is a type-honesty fix with no
   * behavior change.
   */
  private transformToATProtoFormat(
    data: UserExportData,
  ): Record<string, unknown> {
    const atprotoPosts = data.posts.map((post) => ({
      $type: "com.trellis.dog.post",
      text: post.text,
      createdAt: post.createdAt,
      ...(post.uri && { uri: post.uri }),
      ...(post.entityRef && { entityRef: post.entityRef }),
      ...(post.geoData && { geoData: post.geoData }),
      ...(post.contentWarnings.length > 0 && {
        contentWarnings: post.contentWarnings,
      }),
      ...(post.media.length > 0 && {
        media: post.media.map((m) => ({
          $type: "blob",
          ref: m.mediaId,
          alt: m.alt || "",
        })),
      }),
      ...(post.comments.length > 0 && {
        thread: post.comments.map((c) => ({
          $type: "com.trellis.dog.comment",
          text: c.text,
          createdAt: c.createdAt,
          ...(c.postUri && { postUri: c.postUri }),
          ...(c.rootUri && { rootUri: c.rootUri }),
          ...(c.replyToUri && { replyToUri: c.replyToUri }),
        })),
      }),
    }));

    return {
      ...data,
      format: "atproto",
      posts: atprotoPosts,
    };
  }
}
