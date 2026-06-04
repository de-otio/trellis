/**
 * Media Routes
 *
 * Handles media file uploads (images, videos) for posts and profiles.
 * Implements content-addressed storage (CAS) with SHA-256 hashing for deduplication.
 */

import { CorsHandler } from "../cors-handler.js";
import { sharedDatabaseConnectionManager } from "../database-connection-manager.js";
import {
  QueryTimeoutPresets,
  withQueryTimeoutAndRetry,
} from "../db-query-helper.js";
import { getLogger, Logger } from "../logger.js";
import { MediaHandler } from "../media-handler.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { ImageNormalizer } from "../services/image-normalizer.js";
import { MediaUploadService } from "../services/media-upload-service.js";
import type { Route } from "./types.js";

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
 * Serve media file by content hash with variant support
 * Shared function used by both /api/media/:mediaId and /api/media/:hash routes
 */
async function serveMediaByHash(
  contentHash: string,
  variant: string,
  request: Request,
  env: any,
  session: { userId: string },
): Promise<Response> {
  const logger = getLogger();
  logger.debug("SERVE MEDIA BY HASH: Starting", {
    contentHash,
    variant,
    userId: session.userId,
  });

  const securityHeaders = new SecurityHeaders(env);

  try {
    // Wrap entire function in try-catch to catch any unexpected errors
    logger.debug("SERVE MEDIA: Inside try block");

    // Find media file in database - using retry logic
    let mediaFile: any = null;
    try {
      const region = "US"; // TODO: Get from session or request
      // Using retry logic with exponential backoff for connection resilience
      mediaFile = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env,
        async (db) => {
          const dbAny = db as any;
          if (dbAny.mediaFile) {
            return await dbAny.mediaFile.findUnique({
              where: { contentHash },
            });
          }
          return null;
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "media_get",
            contentHash,
          },
        },
      );
      if (!mediaFile) {
        logger.debug(
          "MediaFile not found in database, using fallback key lookup",
          {
            contentHash,
            variant,
          },
        );
      } else {
        logger.debug("MediaFile found in database", {
          contentHash,
          variant,
          originalKey: mediaFile.originalKey,
          optimizedKey: mediaFile.optimizedKey,
          thumbnailKey: mediaFile.thumbnailKey,
        });
      }
    } catch (error: any) {
      logger.warn("Failed to query MediaFile, using fallback key lookup", {
        error: error.message,
        contentHash,
        variant,
      });
    }

    // Fetch from R2
    const r2Bucket = (env as any).MEDIA_BUCKET_R2 || (env as any).R2_BUCKET;
    if (!r2Bucket) {
      const errorResponse = securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Media storage not configured" }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
      return CorsHandler.addCorsHeaders(errorResponse, request, env);
    }

    // Determine which R2 key to serve
    let r2Key: string | null = null;
    let contentType: string = "application/octet-stream";

    if (mediaFile) {
      logger.debug("SERVE MEDIA: Found database record", {
        contentHash,
        variant,
        hasOriginalKey: !!mediaFile.originalKey,
        hasOptimizedKey: !!mediaFile.optimizedKey,
        hasThumbnailKey: !!mediaFile.thumbnailKey,
        originalKey: mediaFile.originalKey,
        optimizedKey: mediaFile.optimizedKey,
        thumbnailKey: mediaFile.thumbnailKey,
      });

      switch (variant) {
        case "thumbnail":
          r2Key =
            mediaFile.thumbnailKey ||
            mediaFile.optimizedKey ||
            mediaFile.originalKey;
          contentType =
            mediaFile.thumbnailKey || mediaFile.optimizedKey
              ? "image/webp"
              : mediaFile.mimeType || "application/octet-stream";
          break;
        case "optimized":
          // For optimized variant, prefer optimized but ALWAYS fall back to original
          r2Key = mediaFile.optimizedKey || mediaFile.originalKey;
          // If still no key, this is a data integrity issue - log and continue to fallback
          if (!r2Key) {
            logger.error("SERVE MEDIA: Database record has no keys!", {
              contentHash,
              mediaFileId: (mediaFile as any).id,
            });
          }
          contentType = mediaFile.optimizedKey
            ? "image/webp"
            : mediaFile.mimeType || "application/octet-stream";
          break;
        case "original":
          r2Key = mediaFile.originalKey;
          contentType = mediaFile.mimeType || "application/octet-stream";
          break;
        default:
          // Default to optimized with fallback to original
          r2Key = mediaFile.optimizedKey || mediaFile.originalKey;
          contentType = mediaFile.optimizedKey
            ? "image/webp"
            : mediaFile.mimeType || "application/octet-stream";
      }

      logger.debug("SERVE MEDIA: Using database record", {
        contentHash,
        variant,
        r2Key,
        contentType,
        hasOptimized: !!mediaFile.optimizedKey,
        hasOriginal: !!mediaFile.originalKey,
      });

      // CRITICAL FIX: If r2Key is still null after using database record,
      // fall back to R2 key lookup
      if (!r2Key) {
        logger.debug(
          "SERVE MEDIA: Database record has no keys, falling back to R2 lookup",
          {
            contentHash,
            variant,
          },
        );
        // Set mediaFile to null to trigger fallback logic
        mediaFile = null;
      }
    }

    if (!mediaFile) {
      // Fallback: construct key from hash and variant
      logger.debug("SERVE MEDIA: Using R2 fallback key lookup", {
        contentHash,
        variant,
      });

      const commonExtensions = ["jpg", "jpeg", "png", "webp", "gif"];

      // First, try to find the original file with any extension
      let foundOriginalKey: string | null = null;
      let foundContentType: string = "image/jpeg";

      for (const ext of commonExtensions) {
        const testKey = `media/${contentHash}.${ext}`;
        logger.debug("SERVE MEDIA: Trying R2 key", { testKey });
        try {
          const testObject = await r2Bucket.head(testKey);
          if (testObject) {
            foundOriginalKey = testKey;
            foundContentType = `image/${ext === "jpg" ? "jpeg" : ext}`;
            logger.debug("SERVE MEDIA: Found media file in R2 fallback", {
              contentHash,
              key: testKey,
              contentType: foundContentType,
            });
            break;
          }
        } catch (error: any) {
          // head() can throw errors, continue trying other extensions
          logger.debug("SERVE MEDIA: R2 head() failed for key", {
            key: testKey,
            error: error.message,
          });
        }
      }

      logger.debug("SERVE MEDIA: Original file search complete", {
        foundOriginalKey,
        foundContentType,
      });

      // Now determine which key to use based on variant
      if (variant === "thumbnail") {
        // Try thumbnail first
        let foundThumb = false;
        for (const ext of ["webp", ...commonExtensions]) {
          const testKey = `media/${contentHash}_thumb.${ext}`;
          try {
            const testObject = await r2Bucket.head(testKey);
            if (testObject) {
              r2Key = testKey;
              contentType = "image/webp";
              foundThumb = true;
              break;
            }
          } catch (error: any) {
            // head() can throw errors, continue trying other extensions
            logger.debug("R2 head() failed for thumbnail key", {
              key: testKey,
              error: error.message,
            });
          }
        }
        // Fall back to optimized if no thumbnail
        if (!foundThumb) {
          for (const ext of ["webp", ...commonExtensions]) {
            const testKey = `media/${contentHash}_opt.${ext}`;
            try {
              const testObject = await r2Bucket.head(testKey);
              if (testObject) {
                r2Key = testKey;
                contentType = "image/webp";
                foundThumb = true;
                break;
              }
            } catch (error: any) {
              // head() can throw errors, continue trying other extensions
              logger.debug("R2 head() failed for optimized key", {
                key: testKey,
                error: error.message,
              });
            }
          }
        }
        // Fall back to original if no thumbnail or optimized
        if (!foundThumb && foundOriginalKey) {
          r2Key = foundOriginalKey;
          contentType = foundContentType;
        }
      } else if (variant === "optimized") {
        // Try optimized first
        logger.debug("SERVE MEDIA: Looking for optimized variant", {
          contentHash,
        });
        let foundOpt = false;
        for (const ext of ["webp", ...commonExtensions]) {
          const testKey = `media/${contentHash}_opt.${ext}`;
          logger.debug("SERVE MEDIA: Trying optimized key", { testKey });
          try {
            const testObject = await r2Bucket.head(testKey);
            if (testObject) {
              r2Key = testKey;
              contentType = "image/webp";
              foundOpt = true;
              logger.debug("SERVE MEDIA: Found optimized variant", { testKey });
              break;
            }
          } catch (error: any) {
            // head() can throw errors, continue trying other extensions
            logger.debug("SERVE MEDIA: R2 head() failed for optimized key", {
              key: testKey,
              error: error.message,
            });
          }
        }
        // Fall back to original if no optimized version
        // ALWAYS fall back to original if we didn't find an optimized version
        if (!foundOpt) {
          if (foundOriginalKey) {
            r2Key = foundOriginalKey;
            contentType = foundContentType;
            logger.debug(
              "SERVE MEDIA: Falling back to original for optimized variant",
              {
                r2Key,
                contentType,
              },
            );
          } else {
            // If we still haven't found the original, log it for debugging
            logger.debug(
              "SERVE MEDIA: No optimized version found and foundOriginalKey is null",
              {
                contentHash,
                variant,
              },
            );
          }
        }
      } else {
        // Original variant or any other variant: use the found original key
        if (foundOriginalKey) {
          r2Key = foundOriginalKey;
          contentType = foundContentType;
        }
      }
    }

    logger.debug("SERVE MEDIA: Final R2 key selection", {
      r2Key,
      contentType,
      variant,
      contentHash,
      hasMediaFile: !!mediaFile,
    });

    // CRITICAL FIX: If r2Key is still null at this point, try one more fallback
    // This handles edge cases where the database record exists but has null keys,
    // or the fallback R2 lookup failed for some reason
    if (!r2Key) {
      logger.debug("SERVE MEDIA: r2Key is null, attempting final fallback", {
        contentHash,
        variant,
      });

      // Try to find the file with common extensions
      const commonExtensions = ["png", "jpg", "jpeg", "webp", "gif"];
      for (const ext of commonExtensions) {
        const testKey = `media/${contentHash}.${ext}`;
        logger.debug("SERVE MEDIA: Final fallback trying key", { testKey });
        try {
          const testObject = await r2Bucket.head(testKey);
          if (testObject) {
            r2Key = testKey;
            contentType = `image/${ext === "jpg" ? "jpeg" : ext}`;
            logger.debug("SERVE MEDIA: Final fallback found file", {
              r2Key,
              contentType,
            });
            break;
          }
        } catch (error: any) {
          logger.debug("SERVE MEDIA: Final fallback head() failed", {
            key: testKey,
            error: error.message,
          });
        }
      }
    }

    if (!r2Key) {
      logger.debug("SERVE MEDIA: No R2 key found, returning 404", {
        contentHash,
        variant,
        hasMediaFile: !!mediaFile,
      });

      // In dev, return detailed debug info
      const debugInfo =
        env.ENVIRONMENT === "dev"
          ? {
              contentHash,
              variant,
              hasMediaFile: !!mediaFile,
              mediaFileKeys: mediaFile
                ? {
                    original: mediaFile.originalKey,
                    optimized: mediaFile.optimizedKey,
                    thumbnail: mediaFile.thumbnailKey,
                  }
                : null,
              codeVersion: "v2-with-debug",
            }
          : undefined;

      const errorResponse = securityHeaders.createSecureResponse(
        JSON.stringify({
          error: "Media not found",
          source: "serveMediaByHash-noKey",
          ...(debugInfo && { debug: debugInfo }),
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
      return CorsHandler.addCorsHeaders(errorResponse, request, env);
    }

    const object = await r2Bucket.get(r2Key);
    if (!object) {
      logger.debug("SERVE MEDIA: R2 object not found", {
        r2Key,
        contentHash,
        variant,
      });

      // In dev, return detailed debug info
      const debugInfo =
        env.ENVIRONMENT === "dev"
          ? {
              r2Key,
              contentHash,
              variant,
              message: "R2 object not found at key",
              codeVersion: "v2-with-debug",
            }
          : undefined;

      const errorResponse = securityHeaders.createSecureResponse(
        JSON.stringify({
          error: "Media not found",
          source: "serveMediaByHash",
          ...(debugInfo && { debug: debugInfo }),
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
      return CorsHandler.addCorsHeaders(errorResponse, request, env);
    }

    // Get content type from object metadata or use determined type
    const objectContentType = object.httpMetadata?.contentType || contentType;

    // Return file with appropriate cache headers
    const response = new Response(object.body, {
      headers: {
        "Content-Type": objectContentType,
        "Cache-Control": `no-cache, no-store, must-revalidate`,
        Pragma: "no-cache",
        Expires: "0",
        "Cache-Key": `media:${session.userId}:${contentHash}:${variant}`,
        "X-Content-Type-Options": "nosniff",
        "X-Debug-Variant": variant, // Simple debug header
        "X-Debug-Timestamp": Date.now().toString(), // Unique per request
      },
    });
    return CorsHandler.addCorsHeaders(response, request, env);
  } catch (unexpectedError: any) {
    // Catch any unexpected errors in serveMediaByHash
    logger.error("SERVE MEDIA BY HASH: Unexpected error", {
      error: unexpectedError.message,
      stack: unexpectedError.stack,
      contentHash,
      variant,
    });

    const errorResponse = securityHeaders.createSecureResponse(
      JSON.stringify({
        error: "Internal server error",
        message: unexpectedError.message || "An unexpected error occurred",
        source: "serveMediaByHash-unexpected",
        contentHash,
        variant,
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
    return CorsHandler.addCorsHeaders(errorResponse, request, env);
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

      // Apply rate limiting: 10 uploads per 60s per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/upload",
        10,
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

        // Validate file type
        const allowedImageTypes = [
          "image/jpeg",
          "image/jpg",
          "image/png",
          "image/gif",
          "image/webp",
          "image/heic",
          "image/heif",
        ];
        const allowedVideoTypes = [
          "video/mp4",
          "video/webm",
          "video/quicktime",
        ];

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
          // HEIC/HEIF: ISO Base Media File Format with ftyp box
          detectedMimeType = "image/heic";
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

        // Validate file size (per documentation: 10MB for images, 100MB for videos)
        const maxImageSize = 10 * 1024 * 1024; // 10MB
        const maxVideoSize = 100 * 1024 * 1024; // 100MB
        const maxSize = isImage ? maxImageSize : maxVideoSize;

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

        // Check for suspicious patterns
        const suspicious = checkSuspiciousContent(bytes, mimeType);
        if (suspicious.length > 0) {
          logger.warn("Suspicious file detected", {
            userId: session.userId,
            fileName: file.name,
            mimeType,
            suspicious,
          });
          // For now, log but don't reject (can be made stricter later)
          // In production, you might want to reject or quarantine
        }

        // Get extension from MIME type
        const ext = getExtensionFromMimeType(mimeType);

        // Extract metadata (best effort, non-fatal)
        let extracted: any = {};
        try {
          const { MetadataExtractor } = await import(
            "../metadata/metadata-extractor.js"
          );
          const extractor = new MetadataExtractor(env);
          extracted = await extractor.extractAll(fileBuffer, mimeType);
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

        // Use MediaUploadService for eventual consistency upload
        // Pass the already-read fileBuffer to avoid a second file.arrayBuffer() call.
        // On Cloudflare Workers, File objects from FormData may not support
        // reliable re-reads of arrayBuffer(), causing a different contentHash.
        const uploadService = new MediaUploadService(env);
        const result = await uploadService.uploadSingle(
          file,
          session.userId,
          metadata,
          fileBuffer,
        );

        // Normalize images to sRGB (non-blocking, best effort)
        let optimizedKey: string | null = null;
        if (mimeType.startsWith("image/")) {
          if (env.IMAGES && env.MEDIA_BUCKET_R2) {
            const normalizer = new ImageNormalizer(
              env.IMAGES,
              env.MEDIA_BUCKET_R2,
            );
            const startTime = Date.now();
            logger.info("image_normalization.started", {
              contentHash: result.contentHash,
              mimeType,
            });
            optimizedKey = await normalizer.normalize(
              `media/${result.contentHash}.${getExtensionFromMimeType(mimeType)}`,
              result.contentHash,
            );
            const durationMs = Date.now() - startTime;
            if (optimizedKey) {
              logger.info("image_normalization.completed", {
                contentHash: result.contentHash,
                optimizedKey,
                durationMs,
              });
            } else {
              logger.warn("image_normalization.failed", {
                contentHash: result.contentHash,
                durationMs,
              });
            }
          } else {
            logger.info("image_normalization.skipped", {
              contentHash: result.contentHash,
              reason: "images_binding_not_available",
            });
          }
        } else {
          logger.info("image_normalization.skipped", {
            contentHash: result.contentHash,
            reason: "not_image",
          });
        }

        // Create MediaFile DB record synchronously so post creation can
        // reference it immediately (reconciliation will enrich it later)
        const uploadOriginalKey = `media/${result.contentHash}.${getExtensionFromMimeType(mimeType)}`;
        const uploadRegion = "US"; // TODO: Get from session or request
        try {
          await withQueryTimeoutAndRetry(
            sharedDatabaseConnectionManager,
            uploadRegion,
            env as any,
            async (db) => {
              return await db.mediaFile.upsert({
                where: { contentHash: result.contentHash },
                create: {
                  contentHash: result.contentHash,
                  mimeType: mimeType,
                  size: file.size,
                  originalKey: uploadOriginalKey,
                  optimizedKey: optimizedKey ?? undefined,
                  uploadStatus: "COMPLETE",
                  uploadedBy: session.userId,
                  width: metadata?.width,
                  height: metadata?.height,
                  duration: metadata?.duration,
                },
                update: {
                  // If record already exists (e.g. re-upload), update status and ownership
                  // Clear deletedAt so previously-deleted media can be reused
                  uploadStatus: "COMPLETE",
                  uploadedBy: session.userId,
                  optimizedKey: optimizedKey ?? undefined,
                  deletedAt: null,
                },
              });
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
              contentHash: result.contentHash,
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
          contentHash: result.contentHash,
          uploadedBy: session.userId,
          originalKey: uploadOriginalKey,
          uploadRegion,
        });

        logger.info("Media upload successful", {
          userId: session.userId,
          fileName: file.name,
          fileSize: file.size,
          mimeType,
          contentHash: result.contentHash,
          status: result.status,
        });

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            url: result.url,
            mediaKey: result.contentHash,
            contentHash: result.contentHash,
            status: result.status,
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
    path: "/api/media/upload/batch",
    method: "POST",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();

      // Check authentication
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        logger.warn("[Media Batch Upload] Unauthorized");
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }

      // Apply rate limiting: 5 batch uploads per 60s per user (stricter than single)
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/upload/batch",
        5,
        60,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        // Parse multipart form data
        const formData = await request.formData();
        const files: File[] = [];

        // Collect all files from form data
        for (const [key, value] of formData.entries()) {
          if (
            key.startsWith("files[") &&
            value &&
            typeof value === "object" &&
            "name" in value
          ) {
            files.push(value as File);
          } else if (
            key === "file" &&
            value &&
            typeof value === "object" &&
            "name" in value
          ) {
            // Also support single 'file' field for compatibility
            files.push(value as File);
          }
        }

        if (files.length === 0) {
          logger.warn("[Media Batch Upload] No files provided", {
            userId: session.userId,
            formDataKeys: Array.from(formData.keys()),
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "No files provided",
              message: "At least one file is required",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        if (files.length > 20) {
          logger.warn("[Media Batch Upload] Too many files", {
            userId: session.userId,
            fileCount: files.length,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Too many files",
              message: "Maximum 20 files per batch",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(errorResponse, request, env);
        }

        logger.info("[Media Batch Upload] Processing batch", {
          userId: session.userId,
          fileCount: files.length,
        });

        // Use MediaUploadService for batch upload
        const uploadService = new MediaUploadService(env);
        const results = await uploadService.uploadBatch(files, session.userId);

        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.filter((r) => !r.success).length;

        logger.info("[Media Batch Upload] Batch complete", {
          userId: session.userId,
          total: files.length,
          successful: successCount,
          failed: failureCount,
        });

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            results,
            summary: {
              total: files.length,
              successful: successCount,
              failed: failureCount,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[Media Batch Upload] Error:", error);

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Failed to upload media batch",
            message: error.message || "An unexpected error occurred",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Upload multiple media files in a single batch request",
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

      // Apply rate limiting: 60 requests per minute per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/grouped",
        60,
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

      // Apply rate limiting: 60 requests per minute per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/stats",
        60,
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

      // Apply rate limiting: 120 requests per minute per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media/:mediaId",
        120,
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

      // Apply rate limiting: 60 requests per minute per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/api/media",
        60,
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
