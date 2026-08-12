/**
 * routeUpload — pure functional-core routing decision for an inbound upload.
 *
 * Maps a `Content-Type` header value to one of three ingest routes:
 *
 * - `sync-image`    — the file is a re-encodable raster image (image/*,
 *                     matching the P0a `REENCODABLE_IMAGE_TYPES` set); handled
 *                     synchronously in the upload handler.
 * - `async-pending` — the file is video/*; stored PENDING and handed off to the
 *                     async processing worker.
 * - `reject`        — anything else, including empty, malformed, or unknown
 *                     types (fail-closed), and audio-only uploads.
 *
 * Design invariants:
 * - Pure and total: no I/O, no exceptions. Returns one of the three union
 *   members for every input including null/undefined.
 * - Case-insensitive: "Image/JPEG" and "image/jpeg" both route to sync-image.
 * - Parameters stripped: "image/jpeg; charset=utf-8" is treated as
 *   "image/jpeg".
 * - Fail-closed: uncertainty → reject, never sync-image/async-pending.
 * - No operational thresholds (no size caps, no rate limits) — those are
 *   imperative-shell concerns.
 */

/**
 * The three ingest routes for an uploaded object.
 *
 * - `sync-image`    — re-encode synchronously, then determine
 *                     APPROVED/REVIEW/QUARANTINED via the injected
 *                     moderateImage provider; the handler stages the cleaned
 *                     bytes and promotes them to cas/ only on APPROVED.
 * - `async-pending` — store as-is, record as PENDING, fan out to the async
 *                     processing worker.
 * - `reject`        — refuse the upload at the type-routing boundary (before
 *                     bytes are read / stored). Caller must return an error.
 *                     `reason` distinguishes "we do not accept this kind of
 *                     file" from "we do not accept audio", so the caller can
 *                     say something true rather than something generic.
 */
export type IngestRejectReason = "unsupported-type" | "audio-not-supported";

export type IngestRoute =
  | { readonly kind: "sync-image" }
  | { readonly kind: "async-pending" }
  | { readonly kind: "reject"; readonly reason: IngestRejectReason };

// Singleton values avoid allocating a new object on every call.
const SYNC_IMAGE: IngestRoute = { kind: "sync-image" };
const ASYNC_PENDING: IngestRoute = { kind: "async-pending" };
const REJECT: IngestRoute = { kind: "reject", reason: "unsupported-type" };
const REJECT_AUDIO: IngestRoute = {
  kind: "reject",
  reason: "audio-not-supported",
};

/**
 * Route an inbound upload by its declared Content-Type (MIME type).
 *
 * Accepts the raw Content-Type string as sent by the browser/client.
 * Parameters (`;` and everything after) are stripped before matching so
 * "image/png; q=0.9" routes identically to "image/png".
 *
 * The image set mirrors `REENCODABLE_IMAGE_TYPES` from the P0a
 * image-normalizer exactly: jpeg/jpg/png/webp/gif. SVG, HEIC/HEIF, TIFF, and
 * all other image/* sub-types route to reject (fail-closed).
 *
 * @param contentType - The raw Content-Type header value. Accepts null/undefined
 *   (both route to reject).
 * @returns The routing decision — never throws.
 */
export function routeUpload(contentType: string): IngestRoute {
  // Guard: null/undefined/empty → reject.
  if (!contentType || typeof contentType !== "string") {
    return REJECT;
  }

  // Strip parameters ("; charset=utf-8", "; boundary=…", etc.) and normalise
  // to lowercase for case-insensitive matching.
  const base = contentType.split(";")[0].trim().toLowerCase();

  if (!base) {
    return REJECT;
  }

  // --- image/* ---------------------------------------------------------------
  // Only the re-encodable set (mirrors REENCODABLE_IMAGE_TYPES from
  // apps/api/src/lib/services/image-normalizer.ts).  Other image/* sub-types
  // (svg+xml, heic, heif, tiff, bmp, …) are rejected.
  switch (base) {
    case "image/jpeg":
    case "image/jpg": // alias; normalised to image/jpeg downstream
    case "image/png":
    case "image/webp":
    case "image/gif": // static raster in P0a (animated → first frame only)
      return SYNC_IMAGE;
  }

  // --- audio/* ---------------------------------------------------------------
  // Refused at the boundary, deterministically and with a reason.
  //
  // The async pipeline moderates a VISUAL track and an AUDIO track derived from
  // a video. An audio-only object has no visual track for the pipeline to
  // resolve, so accepting one would store bytes that no verdict can ever settle
  // — a row that sits un-servable and un-rejected indefinitely, invisible to
  // both the uploader and the review queue. Saying no at intake is the honest
  // answer: the client gets an immediate, specific error instead of an upload
  // that appears to succeed and then silently never completes.
  if (base.startsWith("audio/")) {
    return REJECT_AUDIO;
  }

  // --- video/* ---------------------------------------------------------------
  // Stored PENDING; transcoded and moderated by the async worker.
  if (base.startsWith("video/")) {
    // Require a non-empty sub-type: "video/" (bare slash, no sub-type) is
    // malformed and goes to reject.
    const subType = base.slice(base.indexOf("/") + 1);
    if (subType) {
      return ASYNC_PENDING;
    }
    return REJECT;
  }

  // Everything else (application/*, text/*, unknown, etc.) → fail-closed.
  return REJECT;
}
