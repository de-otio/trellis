/**
 * Presigned Upload Handler (T14) — the imperative shell for the
 * direct-to-S3 upload flow.
 *
 * Flow (one session == one object == one MediaFile row):
 *
 *   1. `createSession` — validates the declared upload against the pure
 *      presign planner (lib/media/presign-policy.ts), creates the
 *      UploadSession (kind="presigned", status="awaiting-upload") + MediaFile
 *      (lifecycle=AWAITING_UPLOAD) rows, and signs a presigned S3 POST for the
 *      EXACT staging key `pending/{tenantId}/{sessionId}` with a
 *      `content-length-range` byte rail. The client uploads the bytes straight
 *      to S3 — they NEVER pass through this process.
 *
 *   2. (client PUTs/POSTs to S3) — the bucket's OBJECT_CREATED notification on
 *      the `pending/` prefix enqueues the media-processing worker, exactly as
 *      the old proxied path did. Moderation is therefore enqueued by the
 *      BYTES ARRIVING, not by the completion call — a client that never calls
 *      complete cannot keep uploaded bytes out of moderation.
 *
 *   3. `completeSession` — HEAD-verifies the staged object, drives the
 *      MediaFile `bytes-arrived` transition (AWAITING_UPLOAD -> UPLOADED;
 *      idempotent against the worker doing it first), and flips the session to
 *      "uploaded". AUTHZ: the session must belong to the caller — a caller can
 *      neither complete another user's session nor promote anything by
 *      completing (completion never touches cas/ and never sets APPROVED; only
 *      the moderation pipeline can).
 *
 *   4. `abandonSession` — marks the session abandoned, drives the media row to
 *      UPLOAD_FAILED (when still legal), and best-effort deletes the staged
 *      object.
 *
 * Fail-closed invariants:
 *  - The media row is born AWAITING_UPLOAD and can only reach APPROVED through
 *    the moderation pipeline's decision events — nothing in this handler can
 *    set APPROVED or write under cas/.
 *  - Every refusal path leaves the row un-servable (the serve gate approves
 *    APPROVED only).
 */

import type { Env } from "../env.js";
import { getLogger, Logger } from "./logger.js";
import {
  planPresignedUpload,
  type PresignPlanResult,
} from "./media/presign-policy.js";
import {
  nextLifecycle,
  type MediaLifecycle,
} from "./media/media-lifecycle.js";

// ---------------------------------------------------------------------------
// Presign port — the ONLY AWS seam in this module. Injected for tests;
// production uses the s3-presigned-post adapter below.
// ---------------------------------------------------------------------------

/** The signed grant handed to the client (see the frozen contract doc). */
export interface PresignedPostGrant {
  /** The URL the multipart/form-data POST goes to (the bucket endpoint). */
  url: string;
  /**
   * Form fields that MUST be included in the POST body (policy, signature,
   * credential, key, Content-Type, …) — before the `file` field.
   */
  fields: Record<string, string>;
}

export interface PresignPort {
  presignPost(input: {
    bucket: string;
    key: string;
    contentType: string;
    minBytes: number;
    maxBytes: number;
    expirySeconds: number;
  }): Promise<PresignedPostGrant>;
}

/**
 * Production adapter over `@aws-sdk/s3-presigned-post`. The POST policy
 * carries (see AWS "POST Policy", sigv4-HTTPPOSTConstructPolicy):
 *  - an exact `key` condition (prefix-confined single object, no starts-with),
 *  - an exact `Content-Type` condition,
 *  - `["content-length-range", min, max]` — S3 itself rejects any upload whose
 *    size falls outside the range; the bytes never reach the API container.
 */
export function buildS3PresignPort(): PresignPort {
  return {
    async presignPost(input) {
      const [{ createPresignedPost }, { createDefaultS3Client }] =
        await Promise.all([
          import("@aws-sdk/s3-presigned-post"),
          import("@de-otio/saas-foundation/storage"),
        ]);
      const client = createDefaultS3Client();
      const { url, fields } = await createPresignedPost(client, {
        Bucket: input.bucket,
        Key: input.key,
        Conditions: [
          ["content-length-range", input.minBytes, input.maxBytes],
          { "Content-Type": input.contentType },
        ],
        Fields: { "Content-Type": input.contentType },
        Expires: input.expirySeconds,
      });
      return { url, fields };
    },
  };
}

// ---------------------------------------------------------------------------
// Result types (the frozen contract's response shapes)
// ---------------------------------------------------------------------------

export type CreatePresignedResult =
  | {
      ok: true;
      session: {
        sessionId: string;
        mediaId: string;
        status: "awaiting-upload";
        expiresAt: string;
      };
      upload: {
        method: "POST";
        url: string;
        fields: Record<string, string>;
        objectKey: string;
        expiresInSeconds: number;
      };
      constraints: {
        maxBytes: number;
        maxDurationSeconds: number;
      };
    }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
    };

export type CompletePresignedResult =
  | {
      ok: true;
      session: {
        sessionId: string;
        mediaId: string;
        status: "uploaded";
      };
      media: { id: string; lifecycle: MediaLifecycle };
    }
  | { ok: false; status: number; error: string; message: string };

export type AbandonPresignedResult =
  | { ok: true; session: { sessionId: string; status: "abandoned" } }
  | { ok: false; status: number; error: string; message: string };

// Narrow row shapes for the untyped (db: any) reads below — annotated onto
// withQueryTimeoutAndRetry so the generic resolves to a useful type.
interface PresignedSessionRow {
  id: string;
  status: string;
  mediaId: string | null;
  objectKey: string | null;
  expiresAt: Date;
}

interface MediaLifecycleRow {
  id: string;
  lifecycle: MediaLifecycle;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const SESSION_TTL_HOURS = 24;

export class PresignedUploadHandler {
  private logger: Logger;
  private presignPort: PresignPort;

  constructor(env?: Env, presignPort?: PresignPort) {
    this.logger = env ? getLogger() : ({} as Logger);
    this.presignPort = presignPort ?? buildS3PresignPort();
  }

  /**
   * Create a presigned upload session for one video/audio object.
   *
   * The byte rail (`content-length-range` max) and the MIME allowlist come
   * from Env.media (SSM-fed) — never literals. Quota is checked fail-closed
   * against the tenant's stored objects before any row is created.
   */
  async createSession(
    userId: string,
    region: string,
    env: Env,
    input: { mimeType: string; sizeBytes: number },
  ): Promise<CreatePresignedResult> {
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );

    // --- Tenant resolution (same seam as the proxied path). ---
    const { resolveUploadTenantId } = await import("./routes/media.js");
    const tenantId = await resolveUploadTenantId(userId, region, env);
    if (!tenantId) {
      return {
        ok: false,
        status: 500,
        error: "Tenant resolution failed",
        message: "Could not resolve a tenant for this upload.",
      };
    }

    // --- Media class: only async-pending types are presignable. ---
    const isAudio = input.mimeType?.toLowerCase().startsWith("audio/");
    const maxBytes = isAudio
      ? env.media.maxBytes.audio
      : env.media.maxBytes.video;
    const allowlist = isAudio
      ? env.media.allowlist.audio
      : env.media.allowlist.video;

    // --- Quota (fail-closed, mirrors the proxied path). ---
    const quota = await this.checkQuota(
      tenantId,
      userId,
      input.sizeBytes,
      region,
      env,
    );
    if (!quota.ok) {
      return quota;
    }

    // --- Create the session row first: its cuid id IS the uploadId and the ---
    // staging-key segment, so the planner needs it before signing.
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
    let sessionRow: { id: string };
    try {
      sessionRow = await withQueryTimeoutAndRetry<{ id: string }>(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        (db: any) =>
          db.uploadSession.create({
            data: {
              userId,
              kind: "presigned",
              mediaIds: [],
              status: "awaiting-upload",
              expiresAt,
              tenantId,
              declaredMimeType: input.mimeType,
              declaredBytes: input.sizeBytes,
            },
          }),
        QueryTimeoutPresets.STANDARD,
      );
    } catch (error) {
      this.logger.error("presigned.create: session row creation failed", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        status: 500,
        error: "Internal server error",
        message: "Failed to create upload session.",
      };
    }

    // --- Pure plan: type gate, byte rail, exact key, expiry clamp. ---
    const plan: PresignPlanResult = planPresignedUpload({
      tenantId,
      sessionId: sessionRow.id,
      declaredMimeType: input.mimeType,
      declaredBytes: input.sizeBytes,
      maxBytes,
      allowlist,
      expirySeconds: env.media.presignExpirySeconds,
    });
    if (!plan.ok) {
      // Refused: remove the just-created session row (best-effort) and map
      // the refusal to a client error.
      await this.bestEffortDeleteSession(sessionRow.id, region, env);
      return refusalToResult(plan.reason);
    }

    // --- Create the MediaFile row (born AWAITING_UPLOAD, fail-closed) and ---
    // link it onto the session.
    let mediaRow: { id: string };
    try {
      mediaRow = await withQueryTimeoutAndRetry<{ id: string }>(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db: any) => {
          const media = await db.mediaFile.create({
            data: {
              tenantId,
              contentHash: null, // real hash persisted post-transcode by the worker
              mimeType: plan.contentType,
              size: input.sizeBytes,
              originalKey: null, // cas/ key persisted post-transcode by the worker
              uploadId: sessionRow.id,
              uploadedBy: userId,
              // lifecycle defaults to AWAITING_UPLOAD in the schema.
            },
          });
          await db.uploadSession.update({
            where: { id: sessionRow.id },
            data: { mediaId: media.id, objectKey: plan.key },
          });
          return media;
        },
        QueryTimeoutPresets.STANDARD,
      );
    } catch (error) {
      this.logger.error("presigned.create: media row creation failed", {
        sessionId: sessionRow.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.bestEffortDeleteSession(sessionRow.id, region, env);
      return {
        ok: false,
        status: 500,
        error: "Internal server error",
        message: "Failed to create upload session.",
      };
    }

    // --- Sign the grant. ---
    let grant: PresignedPostGrant;
    try {
      grant = await this.presignPort.presignPost({
        bucket: env.MEDIA_BUCKET_NAME,
        key: plan.key,
        contentType: plan.contentType,
        minBytes: plan.contentLengthRange.min,
        maxBytes: plan.contentLengthRange.max,
        expirySeconds: plan.expirySeconds,
      });
    } catch (error) {
      this.logger.error("presigned.create: signing failed", {
        sessionId: sessionRow.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.bestEffortDeleteSession(sessionRow.id, region, env, mediaRow.id);
      return {
        ok: false,
        status: 500,
        error: "Internal server error",
        message: "Failed to sign the upload grant.",
      };
    }

    this.logger.info("presigned.create: grant issued", {
      sessionId: sessionRow.id,
      mediaId: mediaRow.id,
      tenantId,
      contentType: plan.contentType,
      maxBytes: plan.contentLengthRange.max,
      expiresInSeconds: plan.expirySeconds,
    });

    return {
      ok: true,
      session: {
        sessionId: sessionRow.id,
        mediaId: mediaRow.id,
        status: "awaiting-upload",
        expiresAt: expiresAt.toISOString(),
      },
      upload: {
        method: "POST",
        url: grant.url,
        fields: grant.fields,
        objectKey: plan.key,
        expiresInSeconds: plan.expirySeconds,
      },
      constraints: {
        maxBytes: plan.contentLengthRange.max,
        maxDurationSeconds: env.media.maxDurationSeconds,
      },
    };
  }

  /**
   * Complete a presigned session: verify the bytes landed, drive
   * AWAITING_UPLOAD -> UPLOADED (idempotent against the worker's own
   * bytes-arrived transition), flip the session to "uploaded".
   *
   * AUTHZ: looked up by (id, userId, kind) — another user's session id yields
   * the same 404 as a nonexistent one. Completion can never advance the media
   * row beyond UPLOADED: verdicts belong to the moderation pipeline alone.
   */
  async completeSession(
    sessionId: string,
    userId: string,
    region: string,
    env: Env,
  ): Promise<CompletePresignedResult> {
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );

    const session = await withQueryTimeoutAndRetry<PresignedSessionRow | null>(
      sharedDatabaseConnectionManager,
      region,
      env as any,
      (db: any) =>
        db.uploadSession.findFirst({
          where: { id: sessionId, userId, kind: "presigned" },
        }),
      QueryTimeoutPresets.STANDARD,
    );
    if (!session) {
      return notFound();
    }
    // Integrity guard: a presigned session always gets mediaId + objectKey at
    // creation; nulls mean a half-created row (crash between writes). Refuse.
    const mediaId = session.mediaId;
    const objectKey = session.objectKey;
    if (!mediaId || !objectKey) {
      return conflict("Session is incomplete; create a new one.");
    }
    if (session.status === "uploaded") {
      // Idempotent: a retried completion reports the current state.
      const media = await this.readMedia(mediaId, region, env);
      return {
        ok: true,
        session: { sessionId: session.id, mediaId, status: "uploaded" },
        media: media ?? { id: mediaId, lifecycle: "UPLOADED" },
      };
    }
    if (session.status !== "awaiting-upload") {
      return conflict(`Session is ${session.status}.`);
    }
    if (new Date() > session.expiresAt) {
      await this.failSession(session, "expired", region, env);
      return {
        ok: false,
        status: 410,
        error: "Session expired",
        message: "The upload session has expired; create a new one.",
      };
    }

    // --- Verify the bytes actually landed at the exact granted key. ---
    const head = await env.MEDIA_BUCKET_R2.head(objectKey);
    if (!head) {
      return {
        ok: false,
        status: 409,
        error: "Upload not found",
        message:
          "No object at the granted key. Upload the file with the issued grant, then call complete.",
      };
    }
    // Defense in depth: the content-length-range condition already bounded the
    // size at S3; a larger object here means the rail was bypassed somehow.
    // Fail closed: remove the object and fail the session.
    const declaredCap = Math.max(
      env.media.maxBytes.video,
      env.media.maxBytes.audio,
    );
    if (typeof head.size === "number" && head.size > declaredCap) {
      try {
        await env.MEDIA_BUCKET_R2.delete(objectKey);
      } catch {
        /* best-effort */
      }
      await this.failSession(session, "abandoned", region, env);
      return {
        ok: false,
        status: 413,
        error: "Object too large",
        message: "The uploaded object exceeds the size limit.",
      };
    }

    // --- Drive bytes-arrived on the media row (race-safe, machine-checked). ---
    const applied = await withQueryTimeoutAndRetry<MediaLifecycleRow | null>(
      sharedDatabaseConnectionManager,
      region,
      env as any,
      async (db: any) => {
        const media = await db.mediaFile.findUnique({
          where: { id: mediaId },
          select: { id: true, lifecycle: true },
        });
        if (!media) return null;
        const transition = nextLifecycle(media.lifecycle, {
          kind: "bytes-arrived",
        });
        if (!transition.ok) {
          // Media already resolved past UPLOADED (fast pipeline) — completion
          // must NOT rewind it. Report the current state.
          return media;
        }
        if (transition.status !== media.lifecycle) {
          // Conditional write: only flip if still in the pre-transition state,
          // so a racing worker transition is never overwritten backwards.
          await db.mediaFile.updateMany({
            where: { id: media.id, lifecycle: media.lifecycle },
            data: {
              lifecycle: transition.status,
              ...(typeof head.size === "number" ? { size: head.size } : {}),
            },
          });
        }
        const fresh = await db.mediaFile.findUnique({
          where: { id: media.id },
          select: { id: true, lifecycle: true },
        });
        return fresh ?? media;
      },
      QueryTimeoutPresets.STANDARD,
    );
    if (!applied) {
      return {
        ok: false,
        status: 500,
        error: "Internal server error",
        message: "Media record missing for this session.",
      };
    }

    await withQueryTimeoutAndRetry(
      sharedDatabaseConnectionManager,
      region,
      env as any,
      (db: any) =>
        db.uploadSession.update({
          where: { id: session.id },
          data: { status: "uploaded", uploadedAt: new Date() },
        }),
      QueryTimeoutPresets.STANDARD,
    );

    this.logger.info("presigned.complete: session uploaded", {
      sessionId: session.id,
      mediaId,
      lifecycle: applied.lifecycle,
    });

    // NOTE: moderation was already enqueued by the S3 OBJECT_CREATED
    // notification on the pending/ prefix when the bytes landed — completing
    // here neither starts nor skips moderation (fail-closed either way).
    return {
      ok: true,
      session: { sessionId: session.id, mediaId, status: "uploaded" },
      media: { id: applied.id, lifecycle: applied.lifecycle },
    };
  }

  /**
   * Abandon a presigned session: mark it abandoned, drive the media row to
   * UPLOAD_FAILED (when the machine allows), best-effort delete the staged
   * object. Refuses once the pipeline has resolved a verdict.
   */
  async abandonSession(
    sessionId: string,
    userId: string,
    region: string,
    env: Env,
  ): Promise<AbandonPresignedResult> {
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );

    const session = await withQueryTimeoutAndRetry<PresignedSessionRow | null>(
      sharedDatabaseConnectionManager,
      region,
      env as any,
      (db: any) =>
        db.uploadSession.findFirst({
          where: { id: sessionId, userId, kind: "presigned" },
        }),
      QueryTimeoutPresets.STANDARD,
    );
    if (!session) {
      return notFound();
    }
    if (session.status === "abandoned") {
      return { ok: true, session: { sessionId: session.id, status: "abandoned" } };
    }

    const failed = await this.failSession(session, "abandoned", region, env);
    if (!failed) {
      return conflict(
        "The upload has already been processed and can no longer be abandoned.",
      );
    }
    return { ok: true, session: { sessionId: session.id, status: "abandoned" } };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Mark a session failed ("abandoned" | "expired"), drive its media row to
   * UPLOAD_FAILED when the machine allows, and best-effort delete the staged
   * object. Returns false when the media row has already resolved past the
   * point of failure (verdict present) — the caller must refuse.
   */
  private async failSession(
    session: {
      id: string;
      mediaId: string | null;
      objectKey: string | null;
    },
    to: "abandoned" | "expired",
    region: string,
    env: Env,
  ): Promise<boolean> {
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );

    // Drive the media row (if any) through the machine.
    if (session.mediaId) {
      const allowed = await withQueryTimeoutAndRetry<boolean>(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db: any) => {
          const media = await db.mediaFile.findUnique({
            where: { id: session.mediaId },
            select: { id: true, lifecycle: true },
          });
          if (!media) return true; // nothing to fail — session cleanup only
          const transition = nextLifecycle(media.lifecycle, {
            kind: "upload-failed",
          });
          if (!transition.ok) return false; // verdict already resolved — refuse
          await db.mediaFile.updateMany({
            where: { id: media.id, lifecycle: media.lifecycle },
            data: { lifecycle: transition.status },
          });
          return true;
        },
        QueryTimeoutPresets.STANDARD,
      );
      if (!allowed) return false;
    }

    await withQueryTimeoutAndRetry(
      sharedDatabaseConnectionManager,
      region,
      env as any,
      (db: any) =>
        db.uploadSession.update({
          where: { id: session.id },
          data: { status: to },
        }),
      QueryTimeoutPresets.STANDARD,
    );

    // Best-effort staged-object cleanup (pending/ only — never cas/).
    if (session.objectKey && session.objectKey.startsWith("pending/")) {
      try {
        await env.MEDIA_BUCKET_R2.delete(session.objectKey);
      } catch (error) {
        this.logger.warn("presigned.failSession: staged delete tolerated", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return true;
  }

  private async readMedia(
    mediaId: string | null,
    region: string,
    env: Env,
  ): Promise<{ id: string; lifecycle: MediaLifecycle } | null> {
    if (!mediaId) return null;
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );
    try {
      return await withQueryTimeoutAndRetry<MediaLifecycleRow | null>(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        (db: any) =>
          db.mediaFile.findUnique({
            where: { id: mediaId },
            select: { id: true, lifecycle: true },
          }),
        QueryTimeoutPresets.STANDARD,
      );
    } catch {
      return null;
    }
  }

  private async bestEffortDeleteSession(
    sessionId: string,
    region: string,
    env: Env,
    mediaId?: string,
  ): Promise<void> {
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );
    try {
      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db: any) => {
          if (mediaId) {
            await db.mediaFile.deleteMany({
              where: { id: mediaId, lifecycle: "AWAITING_UPLOAD" },
            });
          }
          await db.uploadSession.deleteMany({ where: { id: sessionId } });
        },
        QueryTimeoutPresets.STANDARD,
      );
    } catch (error) {
      this.logger.warn("presigned: session cleanup tolerated", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Quota gate (fail-closed): tenant's current object count + byte sum from
   * the DB; any read failure denies. Mirrors the proxied path's behavior.
   */
  private async checkQuota(
    tenantId: string,
    userId: string,
    sizeBytes: number,
    region: string,
    env: Env,
  ): Promise<
    | { ok: true }
    | { ok: false; status: number; error: string; message: string }
  > {
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );
    const { checkUploadQuota } = await import("./media/quota-check.js");

    let quotaState = { currentObjects: 0, currentBytes: 0 };
    try {
      const raw = await withQueryTimeoutAndRetry<{ count: number; sumBytes: number } | null>(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db: any) => {
          if (!db.mediaFile) return null;
          const [count, sum] = await Promise.all([
            db.mediaFile.count({ where: { tenantId, deletedAt: null } }),
            db.mediaFile.aggregate({
              where: { tenantId, deletedAt: null },
              _sum: { size: true },
            }),
          ]);
          return {
            count: count as number,
            sumBytes: (sum?._sum?.size ?? 0) as number,
          };
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 1,
          context: { operation: "presigned_quotaCheck", userId },
        },
      );
      if (raw) {
        quotaState = { currentObjects: raw.count, currentBytes: raw.sumBytes };
      }
    } catch {
      this.logger.warn("presigned.create: quota read failed — denying", {
        userId,
        tenantId,
      });
      return {
        ok: false,
        status: 503,
        error: "Upload unavailable",
        message: "Upload capacity check failed; try again later.",
      };
    }

    const quotaResult = checkUploadQuota(
      quotaState,
      sizeBytes,
      env.media.uploadQuota,
    );
    if (!quotaResult.allowed) {
      const status = quotaResult.reason === "byte-cap" ? 413 : 429;
      return {
        ok: false,
        status,
        error: "Upload quota exceeded",
        message: "The upload quota for this account has been reached.",
      };
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Small response helpers
// ---------------------------------------------------------------------------

function notFound(): {
  ok: false;
  status: number;
  error: string;
  message: string;
} {
  return {
    ok: false,
    status: 404,
    error: "Not found",
    message: "No such upload session.",
  };
}

function conflict(message: string): {
  ok: false;
  status: number;
  error: string;
  message: string;
} {
  return { ok: false, status: 409, error: "Conflict", message };
}

function refusalToResult(
  reason:
    | "unsupported-type"
    | "invalid-declared-bytes"
    | "declared-bytes-over-cap"
    | "invalid-key-inputs"
    | "invalid-cap",
): { ok: false; status: number; error: string; message: string } {
  switch (reason) {
    case "unsupported-type":
      return {
        ok: false,
        status: 415,
        error: "Unsupported media type",
        message:
          "Only allowlisted video/audio types may use the presigned upload flow.",
      };
    case "invalid-declared-bytes":
      return {
        ok: false,
        status: 400,
        error: "Invalid size",
        message: "sizeBytes must be a positive integer.",
      };
    case "declared-bytes-over-cap":
      return {
        ok: false,
        status: 413,
        error: "File too large",
        message: "The declared size exceeds the upload size limit.",
      };
    case "invalid-key-inputs":
    case "invalid-cap":
    default:
      return {
        ok: false,
        status: 500,
        error: "Internal server error",
        message: "Upload session could not be planned.",
      };
  }
}
