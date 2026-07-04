/**
 * Media Routes
 *
 * Handles media file uploads (images, videos) for posts and profiles.
 * Implements content-addressed storage (CAS) with SHA-256 hashing for deduplication.
 */

import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { CorsHandler } from "../cors-handler.js";
import { sharedDatabaseConnectionManager } from "../database-connection-manager.js";
import {
  QueryTimeoutPresets,
  withQueryTimeoutAndRetry,
} from "../db-query-helper.js";
import { getLogger, Logger } from "../logger.js";
import { casKey, isCasKeyError, pendingKey, processingKey, validateContentHash } from "../media/cas-keys.js";
import { buildMediaUpsertArgs } from "../media/media-upsert.js";
import { checkUploadQuota } from "../media/quota-check.js";
import { decisionToStatus } from "../media/moderation-status.js";
import type { ModerationStatus } from "../media/moderation-status.js";
import { getMediaModerationProvider } from "../media/request-moderation.js";
import {
  canonicalContentType,
  isServable,
} from "../media/serve-gate.js";
import { resolveMediaTenantId } from "../media/tenant-resolution.js";
import { routeUpload } from "../media/route-upload.js";
import { MediaHandler } from "../media-handler.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import {
  REENCODABLE_IMAGE_TYPES,
  reencodeImage,
} from "../services/image-normalizer.js";
import type { Route } from "./types.js";

/**
 * Resolve the tenant id that scopes a media upload (T9 / D18) — the imperative
 * shell around the pure `resolveMediaTenantId` decision.
 *
 * Reads the ambient tenant (auth seam ALS); with `TENANT_SCOPE_MODE="off"` (the
 * default) no ambient tenant is set, so we load the uploader's
 * `personalTenantId` from the DB and fall back to it. Returns null when no
 * tenant can be resolved (caller fails closed). See media/tenant-resolution.ts
 * for the recorded assumption.
 */
async function resolveUploadTenantId(
  userId: string,
  region: string,
  env: any,
): Promise<string | null> {
  const { getCurrentTenantId } = await import(
    "@de-otio/saas-foundation/tenant"
  );
  const { resolveTenantScopeMode } = await import("../tenant-scope.js");
  const scopeMode = resolveTenantScopeMode();
  const ambient = getCurrentTenantId();

  // Only hit the DB for the personal-tenant fallback when scope is off and
  // there is no ambient tenant (the common dev/default case).
  let personalTenantId: string | null = null;
  if (!ambient && scopeMode === "off") {
    try {
      personalTenantId = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env,
        async (db) => {
          const user = await db.user.findUnique({
            where: { id: userId },
            select: { personalTenantId: true },
          });
          return user?.personalTenantId ?? null;
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 1,
          context: { operation: "media_resolve_tenant", userId },
        },
      );
    } catch {
      personalTenantId = null;
    }
  }

  const resolution = resolveMediaTenantId(ambient, personalTenantId, scopeMode);
  return resolution.ok ? resolution.tenantId : null;
}

/**
 * Generate a CUID v1-shaped upload ID suitable for `pendingKey`.
 *
 * Uses `node:crypto` randomBytes — the ONLY source of non-determinism allowed
 * in this module (imperative shell; not a pure-core unit). The shape
 * `c[a-z0-9]{24}` matches the UPLOAD_ID_RE used by `pendingKey`.
 */
function generateUploadId(): string {
  // 12 random bytes → 24 lowercase hex chars → prepend 'c' = 25-char cuid-shaped id
  // matching UPLOAD_ID_RE = /^c[a-z0-9]{24}$/ in cas-keys.ts.
  const hex = cryptoRandomBytes(12).toString("hex"); // exactly 24 [0-9a-f] chars
  return `c${hex}`;
}

/**
 * Generate SHA-256 content hash for content-addressed storage
 */
async function generateContentHash(file: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", file);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMimeType(mimeType: string): string {
  const mimeMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  return mimeMap[mimeType] || "bin";
}

/**
 * Validate magic numbers (file signatures) to ensure file type matches declared MIME type
 */
function validateMagicNumbers(
  bytes: Uint8Array,
  declaredMimeType: string,
): boolean {
  // JPEG: FF D8 FF
  if (declaredMimeType === "image/jpeg" || declaredMimeType === "image/jpg") {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return true;
    }
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (declaredMimeType === "image/png") {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return true;
    }
  }

  // GIF: 47 49 46 38 (GIF8)
  if (declaredMimeType === "image/gif") {
    if (
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    ) {
      return true;
    }
  }

  // WebP: RIFF ... WEBP
  if (declaredMimeType === "image/webp") {
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes.length >= 12 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return true;
    }
  }

  // MP4: ftyp box at offset 4
  if (declaredMimeType === "video/mp4") {
    // MP4 files start with ftyp box: bytes 4-7 should be "ftyp"
    if (
      bytes.length >= 8 &&
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    ) {
      return true;
    }
  }

  // WebM: starts with 1A 45 DF A3
  if (declaredMimeType === "video/webm") {
    if (
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    ) {
      return true;
    }
  }

  // QuickTime: ftyp box (similar to MP4)
  if (declaredMimeType === "video/quicktime") {
    if (
      bytes.length >= 8 &&
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    ) {
      return true;
    }
  }

  // HEIC/HEIF: ISO Base Media File Format with ftyp box
  if (declaredMimeType === "image/heic" || declaredMimeType === "image/heif") {
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x00 &&
      bytes[1] === 0x00 &&
      bytes[2] === 0x00 &&
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    ) {
      return true;
    }
  }

  return false;
}

/**
 * The single, byte-identical "deny" response (T5 anti-oracle).
 *
 * EVERY non-APPROVED outcome — PENDING/REVIEW/QUARANTINED/REJECTED, not-found,
 * DB-error, hidden, soft-deleted, and the unexpected-error/catch path — returns
 * exactly this: the same status code, the same byte-identical body, and the
 * same fixed minimal viewer-independent header set. No `contentHash`, no
 * `variant`, no `userId`, no `source`, no `error.message`, no `codeVersion`, no
 * `X-Debug-*`, no per-user `Cache-Key`. A prober cannot distinguish "absent"
 * from "exists-but-not-approved" from "DB down" — they are the same bytes.
 *
 * The body and header set are constants (no `Date.now()`, no request-derived
 * values beyond the constant CORS reflection applied uniformly below), so two
 * deny outcomes are indistinguishable at the byte level.
 */
const MEDIA_DENY_BODY = JSON.stringify({ error: "Media not found" });

async function mediaDenyResponse(
  request: Request,
  env: any,
): Promise<Response> {
  const response = new Response(MEDIA_DENY_BODY, {
    status: 404,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
  return CorsHandler.addCorsHeaders(response, request, env);
}

/**
 * Serve media file by content hash (T5: fail-closed APPROVED-only gate).
 *
 * Shared function used by both /api/media/:mediaId and /api/media/:hash routes.
 *
 * Decision flow (functional core in `media/serve-gate.ts`):
 *  1. Validate the inbound URL hash via `validateContentHash` BEFORE any lookup.
 *  2. Look up the DB record (the ONLY source of a servable key — the no-DB
 *     storage-probe maze was deleted in T9; storage is never probed for
 *     un-recorded bytes).
 *  3. `isServable` gate: serve ONLY when `moderationStatus === "APPROVED"` AND
 *     not `hidden` AND not soft-deleted — for EVERY viewer incl. the owner.
 *  4. Every other outcome (incl. not-found / DB-error / invalid-hash / error
 *     path) returns the single byte-identical {@link mediaDenyResponse}.
 *
 * `variant` is retained for call-site compatibility but never influences the
 * gate; the served key is always the canonical `originalKey` from the DB record.
 */
export async function serveMediaByHash(
  contentHash: string,
  variant: string,
  request: Request,
  env: any,
  session: { userId: string },
): Promise<Response> {
  const logger = getLogger();

  try {
    // (1) Validate the inbound URL hash BEFORE any lookup. A malformed hash is
    // indistinguishable from a not-found object — same deny response.
    const normalizedHash = validateContentHash(contentHash);
    if (isCasKeyError(normalizedHash)) {
      return mediaDenyResponse(request, env);
    }

    // (2) Look up the DB record. A null record (not-found) or a thrown query
    // (DB-error) both resolve to `mediaFile = null` and deny identically — no
    // separate I/O shape on either branch (no extra audit/DB write).
    let mediaFile: {
      moderationStatus: ModerationStatus;
      hidden: boolean;
      deletedAt: Date | null;
      originalKey: string | null;
    } | null = null;
    const region = "US"; // TODO: derive from session/request residency

    // Media is tenant-scoped (D18): the canonical identity is
    // (tenantId, contentHash), so a bare hash is NOT a unique key. Scope the
    // lookup to the VIEWER's resolved tenant — fail-closed and isolation-safe:
    // a wrong-tenant hash simply misses -> uniform deny, never a cross-tenant
    // read. NOTE (P0c design decision): cross-tenant "social" viewing by bare
    // hash is intentionally NOT supported here; that read-addressing belongs to
    // the P0c tenant-aware delivery seam (per-tenant domains, D9) or a
    // mediaId/post-scoped lookup that carries the owner's tenant.
    const viewerTenantId = await resolveUploadTenantId(
      session.userId,
      region,
      env,
    );
    if (!viewerTenantId) {
      return mediaDenyResponse(request, env);
    }

    try {
      mediaFile = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env,
        async (db) => {
          const dbAny = db as any;
          if (dbAny.mediaFile) {
            return await dbAny.mediaFile.findUnique({
              where: {
                tenantId_contentHash: {
                  tenantId: viewerTenantId,
                  contentHash: normalizedHash,
                },
              },
            });
          }
          return null;
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: { operation: "media_get" },
        },
      );
    } catch {
      // DB-error: deny exactly like not-found (anti-oracle). No error detail
      // leaks to the caller; logging stays internal and carries no per-viewer
      // identity.
      logger.warn("Failed to query MediaFile; serving uniform deny");
      mediaFile = null;
    }

    // (3) Fail-closed gate. No record → deny. Record present → serve ONLY when
    // APPROVED and not hidden and not soft-deleted. Owner-vs-other never changes
    // this decision (no owner exception). With no P0b worker, video/audio remain
    // PENDING and are denied here.
    if (
      !mediaFile ||
      !isServable({
        moderationStatus: mediaFile.moderationStatus,
        hidden: mediaFile.hidden,
        deletedAt: mediaFile.deletedAt,
      })
    ) {
      return mediaDenyResponse(request, env);
    }

    // The canonical key is the DB record's originalKey (== cas/{tenantId}/{hash}).
    // No key → not servable (deny), never a storage probe.
    const r2Key = mediaFile.originalKey;
    if (!r2Key) {
      return mediaDenyResponse(request, env);
    }

    const r2Bucket = (env as any).MEDIA_BUCKET_R2 || (env as any).R2_BUCKET;
    if (!r2Bucket) {
      // Misconfiguration is also a non-serve outcome: deny uniformly rather than
      // emit a distinguishing 503 (which would itself be an oracle).
      return mediaDenyResponse(request, env);
    }

    const object = await r2Bucket.get(r2Key);
    if (!object) {
      // DB says APPROVED but the bytes are absent: still deny uniformly.
      return mediaDenyResponse(request, env);
    }

    // (4) APPROVED serve. Content-Disposition: attachment (same-origin until
    // P0c's isolated CloudFront origin). Content-type derives ONLY from the
    // re-encoded canonical format (T7) — NEVER from object.httpMetadata or the
    // stored mimeType (attacker-influenced).
    const response = new Response(object.body, {
      headers: {
        "Content-Type": canonicalContentType(env.media.canonicalFormat),
        "Content-Disposition": "attachment",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
    return CorsHandler.addCorsHeaders(response, request, env);
  } catch {
    // Any unexpected error returns the SAME placeholder — no message, no source,
    // no contentHash, no codeVersion.
    logger.error("SERVE MEDIA BY HASH: serving uniform deny on error");
    return mediaDenyResponse(request, env);
  }
}

/**
 * Check for suspicious patterns in file content
 */
function checkSuspiciousContent(bytes: Uint8Array, mimeType: string): string[] {
  const suspicious: string[] = [];

  // Check for executable patterns (MZ header = Windows executable)
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    suspicious.push("Executable header detected");
  }

  // Check for script patterns in first 1KB
  if (bytes.length > 1024) {
    const text = new TextDecoder("utf-8", {
      fatal: false,
      ignoreBOM: true,
    }).decode(bytes.slice(0, 1024));
    if (text.includes("<?php") || text.includes("<script")) {
      suspicious.push("Script content detected");
    }
  }

  // Check for unusually large metadata sections in JPEG
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    let metadataSize = 0;
    let offset = 2; // Skip FF D8
    while (offset < bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1];
      if (marker >= 0xe0 && marker <= 0xef) {
        // APP segment
        if (offset + 3 < bytes.length) {
          const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
          metadataSize += segmentLength;
          offset += segmentLength + 2;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    if (metadataSize > 64 * 1024) {
      suspicious.push("Excessive metadata detected");
    }
  }

  return suspicious;
}

export const mediaRoutes: Route[] = [
  {
    path: "/api/media/upload",
    method: "POST",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();

      // Check authentication
      const authHeader = request.headers.get("Authorization");
      logger.debug("[Media Upload] Attempting to get session", {
        hasCookie: !!request.headers.get("Cookie"),
        hasAuthHeader: !!authHeader,
        authHeaderPreview: authHeader?.substring(0, 50) || "none",
      });

      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        logger.warn("[Media Upload] Unauthorized - no valid session", {
          hasCookie: !!request.headers.get("Cookie"),
          hasAuthHeader: !!authHeader,
        });
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Apply rate limiting: uploads per minute per user (from env.media.rateLimits)
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/upload",
        env.media.rateLimits.uploadPerMin,
        60,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        // Parse multipart form data
        let formData: FormData;
        try {
          formData = await request.formData();
        } catch (error: any) {
          logger.error("Media upload failed: Error parsing form data", {
            userId: session.userId,
            error: error.message,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid request format",
              message: "Failed to parse multipart form data",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        const file = formData.get("file") as File | null;

        if (!file) {
          logger.warn("Media upload failed: No file provided", {
            userId: session.userId,
            formDataKeys: Array.from(formData.keys()),
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "No file provided",
              message: "File field is required in multipart form data",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Check if file is empty
        if (file.size === 0) {
          logger.warn("Media upload failed: Empty file", {
            userId: session.userId,
            fileName: file.name,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Empty file",
              message: "File cannot be empty",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Validate file type.
        // Image allowlist is the sharp-re-encodable set (REENCODABLE_IMAGE_TYPES).
        // HEIC/HEIF are excluded because sharp write support requires the optional
        // libheif native module (absent in this build); full HEIC support is P1/D12.
        // SVG is excluded — no safe raster transcode.
        // Video is accepted (stored PENDING, served only after P0b worker approves).
        const allowedImageTypes = Array.from(REENCODABLE_IMAGE_TYPES);
        const allowedVideoTypes = env.media.allowlist.video.length > 0
          ? env.media.allowlist.video
          : ["video/mp4", "video/webm", "video/quicktime"];

        // Read file bytes first to detect MIME type if not provided
        let fileBuffer: ArrayBuffer;
        try {
          fileBuffer = await file.arrayBuffer();
        } catch (error: any) {
          logger.error("Media upload failed: Error reading file", {
            userId: session.userId,
            fileName: file.name,
            fileSize: file.size,
            error: error.message,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "File read error",
              message: "Failed to read file data",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        if (fileBuffer.byteLength === 0) {
          logger.warn("Media upload failed: File buffer is empty", {
            userId: session.userId,
            fileName: file.name,
            fileSize: file.size,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Empty file",
              message: "File data is empty",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        const bytes = new Uint8Array(fileBuffer);

        // Always detect MIME type from magic numbers (trust the file, not the declared type)
        // This handles cases where the frontend compresses/converts images
        let detectedMimeType = "application/octet-stream";
        if (
          bytes.length >= 3 &&
          bytes[0] === 0xff &&
          bytes[1] === 0xd8 &&
          bytes[2] === 0xff
        ) {
          detectedMimeType = "image/jpeg";
        } else if (
          bytes.length >= 8 &&
          bytes[0] === 0x89 &&
          bytes[1] === 0x50 &&
          bytes[2] === 0x4e &&
          bytes[3] === 0x47
        ) {
          detectedMimeType = "image/png";
        } else if (
          bytes.length >= 4 &&
          bytes[0] === 0x47 &&
          bytes[1] === 0x49 &&
          bytes[2] === 0x46 &&
          bytes[3] === 0x38
        ) {
          detectedMimeType = "image/gif";
        } else if (
          bytes.length >= 12 &&
          bytes[0] === 0x52 &&
          bytes[1] === 0x49 &&
          bytes[2] === 0x46 &&
          bytes[3] === 0x46 &&
          bytes[8] === 0x57 &&
          bytes[9] === 0x45 &&
          bytes[10] === 0x42 &&
          bytes[11] === 0x50
        ) {
          detectedMimeType = "image/webp";
        } else if (
          bytes.length >= 8 &&
          bytes[0] === 0x00 &&
          bytes[1] === 0x00 &&
          bytes[2] === 0x00 &&
          bytes[4] === 0x66 &&
          bytes[5] === 0x74 &&
          bytes[6] === 0x79 &&
          bytes[7] === 0x70
        ) {
          // ISO Base Media File Format (ftyp box). The container is shared by
          // MP4/QuickTime *video* and HEIC/HEIF *images*, so disambiguate by the
          // major brand (bytes 8-11) instead of assuming HEIC — otherwise every
          // mp4 is misdetected as image/heic and rejected once HEIC leaves the
          // re-encodable image allowlist (T7).
          const brand =
            bytes.length >= 12
              ? String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
              : "";
          const heifBrands = new Set([
            "heic",
            "heix",
            "hevc",
            "hevx",
            "heim",
            "heis",
            "hevm",
            "hevs",
            "mif1",
            "msf1",
          ]);
          if (heifBrands.has(brand)) {
            detectedMimeType = "image/heic";
          } else if (brand === "qt  ") {
            detectedMimeType = "video/quicktime";
          } else {
            // Default ISO-BMFF container (isom/iso2/mp41/mp42/avc1/…, or a
            // brand-less minimal ftyp) → MP4-family video.
            detectedMimeType = "video/mp4";
          }
        }

        // Use detected type if we found one, otherwise fall back to declared type
        const declaredMimeType = file.type || "application/octet-stream";
        let mimeType =
          detectedMimeType !== "application/octet-stream"
            ? detectedMimeType
            : declaredMimeType;

        // Log if declared type doesn't match detected type (frontend may have converted the image)
        if (
          declaredMimeType !== "application/octet-stream" &&
          detectedMimeType !== "application/octet-stream" &&
          declaredMimeType !== detectedMimeType
        ) {
          logger.info(
            "Media upload: Declared MIME type differs from detected type",
            {
              userId: session.userId,
              fileName: file.name,
              declaredMimeType,
              detectedMimeType,
              usingDetectedType: true,
            },
          );
        }

        const isImage = allowedImageTypes.includes(mimeType);
        const isVideo = allowedVideoTypes.includes(mimeType);

        if (!isImage && !isVideo) {
          logger.warn("Media upload failed: Invalid file type", {
            userId: session.userId,
            fileName: file.name,
            declaredMimeType: file.type,
            detectedMimeType: mimeType,
            fileSize: file.size,
            firstBytes:
              bytes.length > 0
                ? Array.from(bytes.slice(0, 8))
                    .map((b) => `0x${b.toString(16).padStart(2, "0")}`)
                    .join(" ")
                : "empty",
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid file type",
              message:
                "Only JPEG, PNG, GIF, WebP, HEIC images and MP4, WebM, QuickTime videos are supported",
              details: {
                declaredType: file.type || "not provided",
                detectedType: mimeType,
                fileName: file.name,
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Validate file size (from env.media.maxBytes config)
        const maxSize = isImage ? env.media.maxBytes.image : env.media.maxBytes.video;

        if (file.size > maxSize) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "File too large",
              message: isImage
                ? "Image must be 10MB or less"
                : "Video must be 100MB or less",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // File buffer already read above for MIME type detection
        // Reuse the bytes array

        // Validate magic numbers (file signatures)
        // Since we always detect from magic numbers and use the detected type,
        // we should always validate to ensure the file is what we think it is
        if (
          mimeType !== "application/octet-stream" &&
          !validateMagicNumbers(bytes, mimeType)
        ) {
          logger.warn("Media upload failed: Invalid file signature", {
            userId: session.userId,
            fileName: file.name,
            declaredMimeType: declaredMimeType,
            detectedMimeType: detectedMimeType,
            usingMimeType: mimeType,
            fileSize: file.size,
            firstBytes:
              bytes.length > 0
                ? Array.from(bytes.slice(0, 12))
                    .map((b) => `0x${b.toString(16).padStart(2, "0")}`)
                    .join(" ")
                : "empty",
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid file signature",
              message:
                "File signature does not match detected file type. File may be corrupted or malicious.",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Check for suspicious patterns. For types that are not re-encoded in
        // P0a (video/audio whose transcode is P0b), any suspicious pattern is
        // an immediate reject. For re-encodable images the re-encode pipeline
        // below strips the payload, but we still reject pre-encode to avoid
        // storing the raw polyglot bytes even briefly.
        const suspicious = checkSuspiciousContent(bytes, mimeType);
        if (suspicious.length > 0) {
          logger.warn("Suspicious file detected — rejecting", {
            userId: session.userId,
            fileName: file.name,
            mimeType,
            suspicious,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Suspicious content detected",
              message: "The uploaded file contains unexpected content patterns.",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Resolve the tenant that scopes this media object (T9 / D18).
        // Moved before quota check and route decision so both use the same
        // resolved tenantId.
        const uploadRegion = "US"; // TODO: Get from session or request
        const tenantId = await resolveUploadTenantId(
          session.userId,
          uploadRegion,
          env,
        );
        if (!tenantId) {
          logger.error("[Media Upload] No tenant context for upload", {
            userId: session.userId,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Tenant resolution failed",
              message: "Could not resolve a tenant for this upload.",
            }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Quota check (P0b): count + size-sum for the tenant from the DB.
        // ASSUMPTION: quota usage = all non-deleted MediaFile rows for the
        // tenant (count = currentObjects, sum(size) = currentBytes).
        // checkUploadQuota is fail-closed: any bad number => denied.
        {
          let quotaState = { currentObjects: 0, currentBytes: 0 };
          try {
            const raw = await withQueryTimeoutAndRetry(
              sharedDatabaseConnectionManager,
              uploadRegion,
              env as any,
              async (db) => {
                const dbAny = db as any;
                if (!dbAny.mediaFile) return null;
                const [countResult, sumResult] = await Promise.all([
                  dbAny.mediaFile.count({
                    where: { tenantId, deletedAt: null },
                  }),
                  dbAny.mediaFile.aggregate({
                    where: { tenantId, deletedAt: null },
                    _sum: { size: true },
                  }),
                ]);
                return { count: countResult as number, sumBytes: (sumResult?._sum?.size ?? 0) as number };
              },
              {
                ...QueryTimeoutPresets.USER_FACING,
                maxRetries: 1,
                context: { operation: "mediaUpload_quotaCheck", userId: session.userId },
              },
            );
            if (raw) {
              quotaState = { currentObjects: raw.count, currentBytes: raw.sumBytes };
            }
          } catch {
            // Quota DB read failure — fail-closed: deny the upload.
            logger.warn("[Media Upload] Quota check DB query failed — denying upload", {
              userId: session.userId,
              tenantId,
            });
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Upload unavailable" }),
              { status: 503, headers: { "content-type": "application/json" } },
            );
            return CorsHandler.addCorsHeaders(errorResponse, request, env);
          }

          const quotaResult = checkUploadQuota(
            quotaState,
            file.size,
            env.media.uploadQuota,
          );
          if (!quotaResult.allowed) {
            logger.warn("[Media Upload] Quota exceeded", {
              userId: session.userId,
              tenantId,
              reason: quotaResult.reason,
            });
            // Use 413 for byte-cap (payload too large) and 429 for object-cap
            // (too many requests semantically — too many objects stored).
            const quotaStatus = quotaResult.reason === "byte-cap" ? 413 : 429;
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Upload quota exceeded" }),
              { status: quotaStatus, headers: { "content-type": "application/json" } },
            );
            return CorsHandler.addCorsHeaders(errorResponse, request, env);
          }
        }

        // Route the upload: sync-image (P0a re-encode path) vs async-pending
        // (video/audio → land in pending/ staging, P0b worker picks it up) vs
        // reject (fail-closed — unknown type not caught by earlier type check).
        const ingestRoute = routeUpload(mimeType);

        if (ingestRoute.kind === "reject") {
          // Should not normally reach here (type check above is stricter), but
          // routeUpload is the authoritative gate — honor it fail-closed.
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unsupported media type" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        if (ingestRoute.kind === "async-pending") {
          // --- Async-pending path (video / audio) --------------------------------
          // 1. Write RAW bytes to pending/{tenantId}/{uploadId} in R2.
          // 2. Create a MediaFile DB row: moderationStatus=PENDING,
          //    originalKey=null, uploadId=<generated>.
          // No inline hashing, no transcoding, no moderation — the P0b worker
          // picks up the staged object via the S3 trigger on the pending/ prefix.
          const uploadId = generateUploadId();
          const stagingKey = pendingKey(tenantId, uploadId);
          if (isCasKeyError(stagingKey)) {
            logger.error("[Media Upload] Failed to build pending key", {
              userId: session.userId,
              kind: stagingKey.kind,
            });
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Upload error" }),
              { status: 500, headers: { "content-type": "application/json" } },
            );
            return CorsHandler.addCorsHeaders(errorResponse, request, env);
          }

          const r2Bucket = (env as any).MEDIA_BUCKET_R2 || (env as any).R2_BUCKET;
          if (!r2Bucket) {
            logger.error("[Media Upload] No R2 bucket configured for pending write", {
              userId: session.userId,
            });
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Upload unavailable" }),
              { status: 503, headers: { "content-type": "application/json" } },
            );
            return CorsHandler.addCorsHeaders(errorResponse, request, env);
          }

          try {
            await r2Bucket.put(stagingKey, fileBuffer, {
              httpMetadata: { contentType: mimeType },
            });
          } catch (r2Error: any) {
            logger.error("[Media Upload] R2 pending write failed", {
              userId: session.userId,
              error: r2Error.message,
            });
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Upload failed" }),
              { status: 500, headers: { "content-type": "application/json" } },
            );
            return CorsHandler.addCorsHeaders(errorResponse, request, env);
          }

          // Create the MediaFile row: PENDING + null originalKey + uploadId.
          // The row exists immediately so the client can track the upload by
          // uploadId; originalKey is filled by the P0b worker after transcoding.
          try {
            await withQueryTimeoutAndRetry(
              sharedDatabaseConnectionManager,
              uploadRegion,
              env as any,
              async (db) => {
                const dbAny = db as any;
                if (!dbAny.mediaFile) throw new Error("mediaFile model unavailable");
                return await dbAny.mediaFile.create({
                  data: {
                    tenantId,
                    // contentHash is null until known: the P0b worker computes
                    // the real SHA-256 of the transcoded bytes and sets it via
                    // persistCleanedContent. The within-tenant unique tolerates
                    // many NULL content_hash rows (distinct NULLs in Postgres).
                    contentHash: null,
                    mimeType,
                    size: file.size,
                    originalKey: null,
                    uploadId,
                    uploadStatus: "PENDING",
                    uploadedBy: session.userId,
                    // moderationStatus defaults to PENDING in the schema.
                  },
                });
              },
              {
                ...QueryTimeoutPresets.USER_FACING,
                maxRetries: 1,
                context: { operation: "mediaUpload_createPendingRecord", userId: session.userId },
              },
            );
          } catch (dbError: any) {
            logger.error("[Media Upload] Pending DB record creation failed", {
              uploadId,
              error: dbError.message,
            });
            // Best-effort: attempt to remove the orphaned R2 object so the
            // pending/ prefix stays clean. Non-fatal if this fails.
            try { await r2Bucket.delete(stagingKey); } catch { /* ignore */ }
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Database error" }),
              { status: 500, headers: { "content-type": "application/json" } },
            );
            return CorsHandler.addCorsHeaders(errorResponse, request, env);
          }

          logger.info("[Media Upload] Async-pending upload accepted", {
            userId: session.userId,
            uploadId,
            stagingKey,
            mimeType,
            size: file.size,
          });

          const pendingResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              uploadId,
              status: "pending",
            }),
            { status: 202, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(pendingResponse, request, env);
        }

        // --- Sync-image path (ingestRoute.kind === "sync-image") ---------------
        // Re-encode images to canonical safe raster format (T7).
        // This is the polyglot + pixel-bomb defense: re-encoding strips any
        // embedded script payload, bakes EXIF orientation into pixels, and
        // drops all metadata (EXIF/GPS/ICC/maker-notes). The hash is computed
        // from the re-encoded bytes so the CAS key is of clean output only.
        // uploadBuffer is re-typed to ArrayBuffer for the upload service;
        // Buffer (a Uint8Array subclass) is structurally compatible at runtime
        // with all consumers (crypto.subtle.digest, R2 put, etc.).
        let uploadBuffer: ArrayBuffer = fileBuffer;
        try {
          const reencoded = await reencodeImage(fileBuffer, env);
          // Buffer is a Uint8Array subclass — cast is safe for all consumers.
          uploadBuffer = reencoded.buffer as unknown as ArrayBuffer;
          // Use the canonical MIME type from the re-encode output
          mimeType = reencoded.canonicalMimeType;
          logger.info("image_reencode.completed", {
            userId: session.userId,
            canonicalMimeType: mimeType,
            inputSize: fileBuffer.byteLength,
            outputSize: reencoded.buffer.byteLength,
          });
        } catch (reencodeError: any) {
          logger.warn("image_reencode.failed — rejecting upload", {
            userId: session.userId,
            fileName: file.name,
            error: reencodeError.message,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Image processing failed",
              message:
                "The uploaded image could not be processed. It may be corrupt, " +
                "an unsupported format, or exceed the maximum image dimensions.",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Extract metadata (best effort, non-fatal).
        // Extraction runs on the re-encoded bytes for images so we get
        // dimensions from the clean output (EXIF orientation already baked).
        let extracted: any = {};
        try {
          const { MetadataExtractor } = await import(
            "../metadata/metadata-extractor.js"
          );
          const extractor = new MetadataExtractor(env);
          extracted = await extractor.extractAll(uploadBuffer, mimeType);
        } catch (metaError: any) {
          logger.warn("[Media Upload] Metadata extraction failed", {
            userId: session.userId,
            mimeType,
            errorType: metaError?.name,
            code: metaError?.code,
            error: metaError?.message,
          });
        }

        // Prepare metadata for upload service
        const metadata = {
          width: extracted?.exifData?.width || extracted?.videoMetadata?.width,
          height:
            extracted?.exifData?.height || extracted?.videoMetadata?.height,
          duration: extracted?.videoMetadata?.duration,
        };

        // --- STAGE → MODERATE → PROMOTE-ON-APPROVE -----------------------------
        // Synchronous image moderation. The cleaned (re-encoded) bytes are
        // written to a STAGING key first, moderated, and only PROMOTED to the
        // canonical `cas/` key when the verdict is APPROVED. `cas/` therefore
        // only ever holds approved bytes; REVIEW/QUARANTINED bytes stay at
        // staging out of the serve path (the gate is APPROVED-only). FAIL-CLOSED
        // throughout — any uncertainty resolves to REVIEW, never APPROVED.

        // 1. Hash the CLEANED output bytes so the CAS key addresses clean bytes
        //    (SHA-256 hex of the buffer).
        const hashBuffer = await crypto.subtle.digest("SHA-256", uploadBuffer);
        const contentHash = Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        // 2. Build the canonical cas/ key (final serve location) and the
        //    processing/ staging key (pre-promotion location).
        const uploadOriginalKey = casKey(tenantId, contentHash);
        const stagingKey = processingKey(tenantId, contentHash);
        if (isCasKeyError(uploadOriginalKey) || isCasKeyError(stagingKey)) {
          logger.error("[Media Upload] Failed to build CAS/staging key", {
            userId: session.userId,
            kind: isCasKeyError(uploadOriginalKey)
              ? uploadOriginalKey.kind
              : (stagingKey as { kind: string }).kind,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Database error",
              message:
                "Failed to register uploaded media. Please try again.",
            }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        const mediaBucket =
          (env as any).MEDIA_BUCKET_R2 || (env as any).R2_BUCKET;
        if (!mediaBucket) {
          // No object store to stage into — fail closed (cannot moderate, must
          // not serve). Mirrors the async-pending path's 503.
          logger.error("[Media Upload] No media bucket configured for staging", {
            userId: session.userId,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Upload unavailable" }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // 3. Write the cleaned bytes to STAGING (NOT cas/). cas/ is written only
        //    on APPROVED, below.
        try {
          await mediaBucket.put(stagingKey, uploadBuffer, {
            httpMetadata: { contentType: mimeType },
          });
        } catch (stageError: any) {
          logger.error("[Media Upload] Staging write failed", {
            userId: session.userId,
            error: stageError?.message,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Upload failed" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // 4. Moderate the STAGED object via the injected provider. FAIL-CLOSED:
        //    any throw/timeout is treated as `review` (→ REVIEW, never promoted).
        //    The provider owns all thresholds (threshold-secrecy); core passes no
        //    numbers.
        // The bucket handle the moderation ref carries is the RESOLVED media
        // bucket name from the env — identical to what MEDIA_BUCKET_R2 (the
        // binding the staging write went to) wraps, including the
        // `${stage}-${appName}-media` fallback. Reading it back from the env
        // (never re-deriving the name or fallback here) guarantees the staging
        // WRITE and the moderation READ point at the same bucket, so it is never
        // empty. The injected provider uses {bucket, key} to locate the STAGED
        // object.
        const moderationBucketName = (env as any).MEDIA_BUCKET_NAME;
        let decision: ModerationStatus;
        try {
          const verdict = await getMediaModerationProvider().moderateImage({
            bucket: moderationBucketName,
            key: stagingKey,
          });
          decision = decisionToStatus(verdict.decision);
        } catch (moderationError: any) {
          logger.warn(
            "[Media Upload] Image moderation failed — failing closed to REVIEW",
            {
              userId: session.userId,
              error: moderationError?.message,
            },
          );
          decision = "REVIEW";
        }

        // 5. PROMOTE on APPROVED: copy staging → cas/ (the cleaned bytes we
        //    already hold in memory), then best-effort delete the staging copy.
        //    Anything else (REVIEW/QUARANTINED/REJECTED) leaves the bytes at
        //    staging and NEVER writes cas/.
        if (decision === "APPROVED") {
          try {
            await mediaBucket.put(uploadOriginalKey, uploadBuffer, {
              httpMetadata: { contentType: mimeType },
            });
          } catch (promoteError: any) {
            // Promotion failed — the bytes are still safely at staging and the
            // row has not been written. Fail the upload so the client retries
            // rather than recording an APPROVED row with no servable cas/ object.
            logger.error("[Media Upload] CAS promotion failed", {
              userId: session.userId,
              error: promoteError?.message,
            });
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Upload failed" }),
              { status: 500, headers: { "content-type": "application/json" } },
            );
            return CorsHandler.addCorsHeaders(errorResponse, request, env);
          }
          // Best-effort staging cleanup — cas/ is what serves, so a leftover
          // staging object is harmless (lifecycle-expired) and never fatal.
          try {
            await mediaBucket.delete(stagingKey);
          } catch (deleteError: any) {
            logger.warn("[Media Upload] Staging delete tolerated", {
              userId: session.userId,
              error: deleteError?.message,
            });
          }
        }

        // 6. Create the MediaFile DB record synchronously so post creation can
        //    reference it immediately. Dedup is within-tenant via
        //    @@unique([tenantId, contentHash]) (D18).
        try {
          await withQueryTimeoutAndRetry(
            sharedDatabaseConnectionManager,
            uploadRegion,
            env as any,
            async (db) => {
              // T9: a within-tenant dedup hit (identical bytes re-uploaded)
              // must NOT transfer ownership or de-publish the canonical row.
              // buildMediaUpsertArgs guarantees the `update` payload touches
              // neither uploadedBy nor moderationStatus — subsequent uploaders
              // get a reference (via the post→media relation), not a mutation
              // of the shared row. The verdict applies to the `create` only.
              return await db.mediaFile.upsert(
                buildMediaUpsertArgs({
                  tenantId,
                  contentHash,
                  mimeType,
                  size: file.size,
                  originalKey: uploadOriginalKey,
                  uploadedBy: session.userId,
                  width: metadata?.width,
                  height: metadata?.height,
                  duration: metadata?.duration,
                  moderationStatus: decision,
                }),
              );
            },
            {
              ...QueryTimeoutPresets.USER_FACING,
              maxRetries: 1,
              context: {
                operation: "mediaUpload_createRecord",
                userId: session.userId,
              },
            },
          );
        } catch (dbError: any) {
          // DB record is required for post creation to validate media ownership.
          // If this fails, the upload must fail so the frontend can retry.
          logger.error(
            "[Media Upload] Synchronous DB record creation failed",
            {
              contentHash,
              error: dbError.message,
            },
          );
          const dbErrorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Database error",
              message:
                "Failed to register uploaded media. Please try again.",
            }),
            {
              status: 500,
              headers: { "content-type": "application/json" },
            },
          );
          return CorsHandler.addCorsHeaders(dbErrorResponse, request, env);
        }

        logger.debug("[Media Upload] DB record created successfully", {
          contentHash,
          uploadedBy: session.userId,
          originalKey: uploadOriginalKey,
          moderationStatus: decision,
          uploadRegion,
        });

        logger.info("Media upload successful", {
          userId: session.userId,
          fileName: file.name,
          fileSize: file.size,
          mimeType,
          contentHash,
          moderationStatus: decision,
        });

        // Reconstruct the client serve URL. This is the public API URL the
        // client GETs by hash — NOT a storage key (the serve gate resolves the
        // storage key from the DB row, never by interpolating the hash; see
        // serve-maze-removed.test.ts).
        const apiDomain =
          env.ENVIRONMENT === "prod"
            ? "https://api.example.com"
            : "https://api.rkm1.de";
        const serveUrl = `${apiDomain}/api/media/${encodeURIComponent(contentHash)}`;
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            url: serveUrl,
            mediaKey: contentHash,
            contentHash,
            status: decision === "APPROVED" ? "approved" : "pending",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("Error handling media upload:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Failed to upload media",
            message: error.message || "An unexpected error occurred",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description:
      "Upload media file (image or video) with content-addressed storage",
  },
  {
    // AR16: the legacy batch-upload path is intentionally NOT implemented.
    //
    // It used to write bytes straight to the approved `cas/{tenant}/{hash}`
    // prefix via MediaUploadService with NO moderation and NO video re-encode,
    // then enqueued to the (stub) media-reconciliation worker — violating the
    // core media-safety invariant that `cas/` holds only approved, cleaned
    // bytes that came through the moderated pipeline (stage → moderate →
    // promote-on-APPROVED; see the single-upload route above).
    //
    // If batch semantics are wanted post-beta, they get rebuilt on the
    // presigned direct-to-S3 upload flow — not patched onto a direct-write
    // path. Until then this route fails loudly instead of smuggling bytes.
    path: "/api/media/upload/batch",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const response = securityHeaders.createSecureResponse(
        JSON.stringify({
          error: "Not implemented",
          message:
            "Batch upload is not available. Upload files individually via /api/media/upload.",
        }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
      return CorsHandler.addCorsHeaders(response, request, env);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description:
      "Batch media upload (not implemented — removed: bypassed moderation)",
  },
  {
    path: "/api/media/grouped",
    method: "GET",
    handler: async (request, env) => {
      const startTime = Date.now();
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const mediaHandler = MediaHandler.create(env);
      const { MediaMetrics } = await import("../media-metrics.js");
      const { RegionDetector } = await import("../region-detection.js");
      const metrics = new MediaMetrics(env);

      // Check authentication
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Apply rate limiting: serve requests per minute per user (from env.media.rateLimits)
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/grouped",
        env.media.rateLimits.servePerMin,
        60,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const url = new URL(request.url);
        const groupBy = (url.searchParams.get("groupBy") ||
          url.searchParams.get("groupby") ||
          "month") as "month" | "year";

        if (!["month", "year"].includes(groupBy)) {
          const duration = Date.now() - startTime;
          const regionDetector = new RegionDetector(env);
          const region = await regionDetector.detectRegion(
            request,
            undefined,
            undefined,
          );
          metrics.trackOperation({
            operation: "grouped",
            endpoint: "/api/media/grouped",
            duration,
            statusCode: 400,
            errorType: "ValidationError",
            userId: session.userId,
            region,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid groupBy",
              message: 'groupBy must be "month" or "year"',
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        const includeHidden = url.searchParams.get("includeHidden") === "true";
        const type =
          (url.searchParams.get("type") as "photo" | "video" | "all") || "all";
        const limit = url.searchParams.get("limit")
          ? parseInt(url.searchParams.get("limit")!, 10)
          : undefined;

        // Validate limit if provided
        if (limit !== undefined && (limit < 1 || limit > 10000)) {
          const duration = Date.now() - startTime;
          const regionDetector = new RegionDetector(env);
          const region = await regionDetector.detectRegion(
            request,
            undefined,
            undefined,
          );
          metrics.trackOperation({
            operation: "grouped",
            endpoint: "/api/media/grouped",
            duration,
            statusCode: 400,
            errorType: "ValidationError",
            userId: session.userId,
            region,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid limit",
              message: "Limit must be between 1 and 10000",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        const result = await mediaHandler.listUserMediaGrouped(
          session.userId,
          groupBy,
          {
            includeHidden,
            type,
            limit,
          },
          env,
          request,
        );

        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );

        // Calculate total items across all groups
        const totalItems = result.groups.reduce(
          (sum, group) => sum + group.media.length,
          0,
        );

        // Track metrics
        metrics.trackGrouped(
          "/api/media/grouped",
          duration,
          result.groups.length,
          totalItems,
          200,
          region,
          session.userId,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(result),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(response, request, env);
      } catch (error: any) {
        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );
        const statusCode = error.message === "Media not found" ? 404 : 500;

        // Track error metrics
        metrics.trackOperation({
          operation: "grouped",
          endpoint: "/api/media/grouped",
          duration,
          statusCode,
          errorType: error?.name || "UnknownError",
          userId: session?.userId,
          region,
        });

        logger.error("Error grouping user media:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Failed to group media",
            message: error.message || "An unexpected error occurred",
          }),
          {
            status: statusCode,
            headers: { "content-type": "application/json" },
          },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "List user media grouped by month or year",
  },
  {
    path: "/api/media/stats",
    method: "GET",
    handler: async (request, env) => {
      const startTime = Date.now();
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const mediaHandler = MediaHandler.create(env);
      const { MediaMetrics } = await import("../media-metrics.js");
      const { RegionDetector } = await import("../region-detection.js");
      const metrics = new MediaMetrics(env);

      // Check authentication
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Apply rate limiting: serve requests per minute per user (from env.media.rateLimits)
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/stats",
        env.media.rateLimits.servePerMin,
        60,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const url = new URL(request.url);
        const includeHidden = url.searchParams.get("includeHidden") === "true";
        const type =
          (url.searchParams.get("type") as "photo" | "video" | "all") || "all";

        const result = await mediaHandler.getUserMediaStats(
          session.userId,
          { includeHidden, type },
          env,
          request,
        );

        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );

        // Track metrics
        metrics.trackStats(
          "/api/media/stats",
          duration,
          result.totalCount,
          200,
          region,
          session.userId,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(result),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(response, request, env);
      } catch (error: any) {
        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );
        const statusCode = error.message === "Media not found" ? 404 : 500;

        // Track error metrics
        metrics.trackOperation({
          operation: "stats",
          endpoint: "/api/media/stats",
          duration,
          statusCode,
          errorType: error?.name || "UnknownError",
          userId: session?.userId,
          region,
        });

        logger.error("Error getting media stats:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Failed to get media stats",
            message: error.message || "An unexpected error occurred",
          }),
          {
            status: statusCode,
            headers: { "content-type": "application/json" },
          },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "Get media statistics",
  },
  {
    path: "/api/media/:mediaId",
    method: "GET",
    handler: async (request, env, context) => {
      const startTime = Date.now();
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      logger.debug("MEDIA ROUTE: /api/media/:mediaId GET handler called", {
        url: request.url,
        mediaId: context.params?.mediaId,
      });
      const rateLimiter = new RateLimiter();
      const mediaHandler = MediaHandler.create(env);
      const { MediaMetrics } = await import("../media-metrics.js");
      const { RegionDetector } = await import("../region-detection.js");
      const metrics = new MediaMetrics(env);

      // Check authentication
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Apply rate limiting: serve requests per minute per user (from env.media.rateLimits)
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/:mediaId",
        env.media.rateLimits.servePerMin,
        60,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const mediaId = context.params?.mediaId;
        if (!mediaId) {
          const duration = Date.now() - startTime;
          const regionDetector = new RegionDetector(env);
          const region = await regionDetector.detectRegion(
            request,
            undefined,
            undefined,
          );
          metrics.trackOperation({
            operation: "details",
            endpoint: "/api/media/:mediaId",
            duration,
            statusCode: 400,
            errorType: "ValidationError",
            userId: session.userId,
            region,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid request",
              message: "Media ID is required",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Check if this is actually a content hash request (64-char hex)
        // Content hashes are hex strings and typically 64 characters
        // If it looks like a content hash, delegate to shared hash handler
        const url = new URL(request.url);
        const variant = url.searchParams.get("variant");

        logger.debug("MEDIA DEBUG: Checking content hash", {
          mediaId,
          mediaIdLength: mediaId.length,
          isHex: /^[0-9a-f]+$/i.test(mediaId),
          variant,
          url: request.url,
        });

        if (mediaId.length === 64 && /^[0-9a-f]+$/i.test(mediaId)) {
          logger.debug(
            "MEDIA DEBUG: Detected content hash, delegating to serveMediaByHash",
            {
              mediaId,
              variant: variant || "original", // Changed default from 'optimized' to 'original'
            },
          );

          // This is a content hash request - use shared hash serving function
          const duration = Date.now() - startTime;
          const regionDetector = new RegionDetector(env);
          const region = await regionDetector.detectRegion(
            request,
            undefined,
            undefined,
          );
          metrics.trackOperation({
            operation: "details",
            endpoint: "/api/media/:mediaId",
            duration,
            statusCode: 200,
            errorType: undefined,
            userId: session.userId,
            region,
          });
          // CRITICAL FIX: Default to 'original' variant instead of 'optimized'
          // This ensures media is always accessible even if optimized versions don't exist yet
          return serveMediaByHash(
            mediaId,
            variant || "original",
            request,
            env,
            session,
          );
        }

        logger.debug(
          "MEDIA DEBUG: Not a content hash, proceeding with regular media details",
          {
            mediaId,
          },
        );

        // Get media details
        const result = await mediaHandler.getMediaDetails(
          mediaId,
          session.userId,
          env,
          request,
        );

        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );

        // Track metrics
        metrics.trackMediaAction(
          "details",
          "/api/media/:mediaId",
          duration,
          200,
          mediaId,
          region,
          session.userId,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(result),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "private, max-age=300", // Cache for 5 minutes, private to this user
              pragma: "no-cache",
              expires: new Date(Date.now() + 5 * 60 * 1000).toUTCString(),
            },
          },
        );
        return CorsHandler.addCorsHeaders(response, request, env);
      } catch (error: any) {
        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );

        let status = 500;
        let message = "Failed to get media details";
        let errorType = error?.name || "UnknownError";

        if (error.message === "Media not found") {
          status = 404;
          message = "Media not found";
          errorType = "NotFoundError";
        } else if (error.message.includes("permission")) {
          status = 403;
          message = "Forbidden";
          errorType = "ForbiddenError";
        }

        // Track error metrics
        metrics.trackMediaAction(
          "details",
          "/api/media/:mediaId",
          duration,
          status,
          context.params?.mediaId || "unknown",
          region,
          session?.userId,
          errorType,
        );

        logger.error("Error getting media details:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: message,
            message: error.message || "An unexpected error occurred",
            source: "mediaId-route-catch",
          }),
          { status, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "Get detailed information about a media file",
  },
  {
    path: "/api/media/:hash",
    method: "GET",
    handler: async (request, env, { params }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // Check authentication
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      try {
        const contentHash = params.hash;
        if (!contentHash) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Missing content hash",
              source: "hash-route",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Parse variant from query params (thumbnail, optimized, original)
        const url = new URL(request.url);
        const variant = url.searchParams.get("variant") || "original"; // Changed default from 'optimized' to 'original'

        logger.debug("HASH ROUTE: Serving media", {
          contentHash,
          variant,
          hasVariantParam: url.searchParams.has("variant"),
        });

        // Use shared function to serve media by hash
        return serveMediaByHash(contentHash, variant, request, env, session);
      } catch (error: any) {
        logger.error("Error serving media:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Failed to serve media",
            message: error.message || "An unexpected error occurred",
            source: "hash-route-catch",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "Serve media file by content hash with variant support",
  },
  {
    path: "/api/media",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const mediaHandler = MediaHandler.create(env);
      const { MediaMetrics } = await import("../media-metrics.js");
      const { RegionDetector } = await import("../region-detection.js");
      const metrics = new MediaMetrics(env);
      const startTime = Date.now();

      // Check authentication
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const duration = Date.now() - startTime;
        metrics.trackOperation({
          operation: "list",
          endpoint: "/api/media",
          duration,
          statusCode: 401,
          errorType: "unauthorized",
        });
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Apply rate limiting: serve requests per minute per user (from env.media.rateLimits)
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media",
        env.media.rateLimits.servePerMin,
        60,
        session.userId,
      );
      if (rateLimitResponse) {
        const duration = Date.now() - startTime;
        metrics.trackRateLimit("/api/media", session.userId, undefined, 60, 60);
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        // Parse query parameters
        const url = new URL(request.url);
        const limit = url.searchParams.get("limit")
          ? parseInt(url.searchParams.get("limit")!, 10)
          : 50;
        const cursor = url.searchParams.get("cursor") || undefined;
        const sort =
          (url.searchParams.get("sort") as "newest" | "oldest") || "newest";
        const includeHidden = url.searchParams.get("includeHidden") === "true";
        const type =
          (url.searchParams.get("type") as "photo" | "video" | "all") || "all";
        const includeTotalCount =
          url.searchParams.get("includeTotalCount") === "true";

        // Validate limit
        if (limit < 1 || limit > 100) {
          const duration = Date.now() - startTime;
          metrics.trackOperation({
            operation: "list",
            endpoint: "/api/media",
            duration,
            statusCode: 400,
            errorType: "invalid_request",
            userId: session.userId,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid limit",
              message: "Limit must be between 1 and 100",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Get user media
        const result = await mediaHandler.listUserMedia(
          session.userId,
          {
            limit,
            cursor,
            sort,
            includeHidden,
            type,
            includeTotalCount,
          },
          env,
          request,
        );

        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );

        // Track metrics
        metrics.trackList(
          "/api/media",
          duration,
          result.media.length,
          200,
          region,
          session.userId,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(result),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(response, request, env);
      } catch (error: any) {
        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );
        const statusCode = error.message === "Media not found" ? 404 : 500;

        // Track error metrics
        metrics.trackOperation({
          operation: "list",
          endpoint: "/api/media",
          duration,
          statusCode,
          errorType: error?.name || "UnknownError",
          userId: session?.userId,
          region,
        });

        logger.error("Error listing user media:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Failed to list media",
            message: error.message || "An unexpected error occurred",
          }),
          {
            status: statusCode,
            headers: { "content-type": "application/json" },
          },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "List user media with pagination, sorting, and filtering",
  },
  {
    path: "/api/media/:mediaId/hide",
    method: "POST",
    handler: async (request, env, context) => {
      const startTime = Date.now();
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const mediaHandler = MediaHandler.create(env);
      const { MediaMetrics } = await import("../media-metrics.js");
      const { RegionDetector } = await import("../region-detection.js");
      const metrics = new MediaMetrics(env);

      // Check authentication
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Apply rate limiting: 10 requests per minute per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/:mediaId/hide",
        10,
        60,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const mediaId = context.params?.mediaId;
        if (!mediaId) {
          const duration = Date.now() - startTime;
          const regionDetector = new RegionDetector(env);
          const region = await regionDetector.detectRegion(
            request,
            undefined,
            undefined,
          );
          metrics.trackOperation({
            operation: "hide",
            endpoint: "/api/media/:mediaId/hide",
            duration,
            statusCode: 400,
            errorType: "ValidationError",
            userId: session.userId,
            region,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid request",
              message: "Media ID is required",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Hide media
        const result = await mediaHandler.hideMedia(
          mediaId,
          session.userId,
          env,
          request,
        );

        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );

        // Track metrics
        metrics.trackMediaAction(
          "hide",
          "/api/media/:mediaId/hide",
          duration,
          200,
          mediaId,
          region,
          session.userId,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            media: result,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(response, request, env);
      } catch (error: any) {
        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );

        let status = 500;
        let message = "Failed to hide media";
        let errorType = error?.name || "UnknownError";

        if (error.message === "Media not found") {
          status = 404;
          message = "Media not found";
          errorType = "NotFoundError";
        } else if (error.message.includes("permission")) {
          status = 403;
          message = "Forbidden";
          errorType = "ForbiddenError";
        } else if (
          error.message.includes("already hidden") ||
          error.message.includes("deleted")
        ) {
          status = 400;
          message = error.message;
          errorType = "ValidationError";
        }

        // Track error metrics
        metrics.trackMediaAction(
          "hide",
          "/api/media/:mediaId/hide",
          duration,
          status,
          context.params?.mediaId || "unknown",
          region,
          session?.userId,
          errorType,
        );

        logger.error("Error hiding media:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: message,
            message: error.message || "An unexpected error occurred",
          }),
          { status, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Hide a media file from all posts",
  },
  {
    path: "/api/media/:mediaId/unhide",
    method: "POST",
    handler: async (request, env, context) => {
      const startTime = Date.now();
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const mediaHandler = MediaHandler.create(env);
      const { MediaMetrics } = await import("../media-metrics.js");
      const { RegionDetector } = await import("../region-detection.js");
      const metrics = new MediaMetrics(env);

      // Check authentication
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Apply rate limiting: 10 requests per minute per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/:mediaId/unhide",
        10,
        60,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const mediaId = context.params?.mediaId;
        if (!mediaId) {
          const duration = Date.now() - startTime;
          const regionDetector = new RegionDetector(env);
          const region = await regionDetector.detectRegion(
            request,
            undefined,
            undefined,
          );
          metrics.trackOperation({
            operation: "unhide",
            endpoint: "/api/media/:mediaId/unhide",
            duration,
            statusCode: 400,
            errorType: "ValidationError",
            userId: session.userId,
            region,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid request",
              message: "Media ID is required",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Unhide media
        const result = await mediaHandler.unhideMedia(
          mediaId,
          session.userId,
          env,
          request,
        );

        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );

        // Track metrics
        metrics.trackMediaAction(
          "unhide",
          "/api/media/:mediaId/unhide",
          duration,
          200,
          mediaId,
          region,
          session.userId,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            media: result,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(response, request, env);
      } catch (error: any) {
        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );

        let status = 500;
        let message = "Failed to unhide media";
        let errorType = error?.name || "UnknownError";

        if (error.message === "Media not found") {
          status = 404;
          message = "Media not found";
          errorType = "NotFoundError";
        } else if (error.message.includes("permission")) {
          status = 403;
          message = "Forbidden";
          errorType = "ForbiddenError";
        } else if (
          error.message.includes("not hidden") ||
          error.message.includes("deleted")
        ) {
          status = 400;
          message = error.message;
          errorType = "ValidationError";
        }

        // Track error metrics
        metrics.trackMediaAction(
          "unhide",
          "/api/media/:mediaId/unhide",
          duration,
          status,
          context.params?.mediaId || "unknown",
          region,
          session?.userId,
          errorType,
        );

        logger.error("Error unhiding media:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: message,
            message: error.message || "An unexpected error occurred",
          }),
          { status, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Unhide a media file (make it visible again)",
  },
  {
    path: "/api/media/:mediaId",
    method: "DELETE",
    handler: async (request, env, context) => {
      const startTime = Date.now();
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const mediaHandler = MediaHandler.create(env);
      const { MediaMetrics } = await import("../media-metrics.js");
      const { RegionDetector } = await import("../region-detection.js");
      const metrics = new MediaMetrics(env);

      // Check authentication
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Apply rate limiting: 10 requests per minute per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/:mediaId",
        10,
        60,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        const mediaId = context.params?.mediaId;
        if (!mediaId) {
          const duration = Date.now() - startTime;
          const regionDetector = new RegionDetector(env);
          const region = await regionDetector.detectRegion(
            request,
            undefined,
            undefined,
          );
          metrics.trackOperation({
            operation: "delete",
            endpoint: "/api/media/:mediaId",
            duration,
            statusCode: 400,
            errorType: "ValidationError",
            userId: session.userId,
            region,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid request",
              message: "Media ID is required",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        // Delete media
        try {
          await mediaHandler.deleteMedia(mediaId, session.userId, env, request);

          const duration = Date.now() - startTime;
          const regionDetector = new RegionDetector(env);
          const region = await regionDetector.detectRegion(
            request,
            undefined,
            undefined,
          );

          // Track metrics
          metrics.trackMediaAction(
            "delete",
            "/api/media/:mediaId",
            duration,
            200,
            mediaId,
            region,
            session.userId,
          );

          const response = securityHeaders.createSecureResponse(
            JSON.stringify({
              success: true,
              message: "Media deleted successfully",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(response, request, env);
        } catch (deleteError: any) {
          const duration = Date.now() - startTime;
          const regionDetector = new RegionDetector(env);
          const region = await regionDetector.detectRegion(
            request,
            undefined,
            undefined,
          );

          // Check if it's a "shared media" error (should hide instead)
          if (
            deleteError.message.includes("used by other users") ||
            deleteError.message.includes("hidden instead")
          ) {
            // Track as conflict (media was hidden instead)
            metrics.trackMediaAction(
              "delete",
              "/api/media/:mediaId",
              duration,
              409,
              mediaId,
              region,
              session.userId,
              "ConflictError",
            );

            const response = securityHeaders.createSecureResponse(
              JSON.stringify({
                success: false,
                error: "Media is shared with other users",
                message: deleteError.message,
                action: "hidden", // Media was hidden instead of deleted
              }),
              { status: 409, headers: { "content-type": "application/json" } },
            );
            return CorsHandler.addCorsHeaders(response, request, env);
          }
          throw deleteError;
        }
      } catch (error: any) {
        const duration = Date.now() - startTime;
        const regionDetector = new RegionDetector(env);
        const region = await regionDetector.detectRegion(
          request,
          undefined,
          undefined,
        );

        let status = 500;
        let message = "Failed to delete media";
        let errorType = error?.name || "UnknownError";

        if (error.message === "Media not found") {
          status = 404;
          message = "Media not found";
          errorType = "NotFoundError";
        } else if (error.message.includes("permission")) {
          status = 403;
          message = "Forbidden";
          errorType = "ForbiddenError";
        } else if (error.message.includes("already deleted")) {
          status = 400;
          message = error.message;
          errorType = "ValidationError";
        }

        // Track error metrics
        metrics.trackMediaAction(
          "delete",
          "/api/media/:mediaId",
          duration,
          status,
          context.params?.mediaId || "unknown",
          region,
          session?.userId,
          errorType,
        );

        logger.error("Error deleting media:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: message,
            message: error.message || "An unexpected error occurred",
          }),
          { status, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Delete a media file (soft delete)",
  },
];
