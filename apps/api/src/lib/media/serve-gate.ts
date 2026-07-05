/**
 * Fail-closed serve gate (T5).
 *
 * The pure functional core behind `serveMediaByHash`: the predicate that decides
 * whether a media object's bytes may be served, and the content-type mapper for
 * the (only) servable case. No I/O, no clock, no Prisma import — exhaustively
 * unit/property-tested. The imperative shell (the route handler) maps the Prisma
 * record to these inputs at the I/O boundary and never re-implements the
 * decision inline.
 */

import type { MediaLifecycle } from "./media-lifecycle.js";

/**
 * The ONLY state that may serve bytes.
 *
 * Flat and viewer-independent — there is **no owner exception**. The owner's
 * optimistic "I can see my own upload" view is a client-local copy (Flutter),
 * never a server URL. Operates on {@link MediaLifecycle} (the hand-written
 * source of truth, T14/AR4 consolidation), mapped from `MediaFile.lifecycle`
 * at the shell boundary.
 *
 * Fail-closed by construction: every lifecycle state except `APPROVED` —
 * including AWAITING_UPLOAD/UPLOADED (bytes present but unmoderated or
 * moderation still in flight / errored / timed out) — denies for every viewer.
 */
export function canServe(status: MediaLifecycle): boolean {
  return status === "APPROVED";
}

/**
 * The full serve decision for a looked-up media record. Returns `true` only when
 * the object is `APPROVED` **and** not hidden **and** not soft-deleted. Every
 * other combination (incl. a missing field) denies.
 *
 * The shell calls this with the fields read from the DB record; a `null` record
 * (not-found) or a thrown query (DB-error) never reaches here — those deny via
 * the uniform placeholder without consulting the predicate, so absence and
 * not-yet-approved are byte-identical to a prober.
 */
export function isServable(record: {
  lifecycle: MediaLifecycle;
  hidden: boolean;
  deletedAt: Date | null;
}): boolean {
  if (record.hidden) {
    return false;
  }
  if (record.deletedAt !== null && record.deletedAt !== undefined) {
    return false;
  }
  return canServe(record.lifecycle);
}

/**
 * Map the canonical re-encode format (T7's `env.media.canonicalFormat`) to the
 * Content-Type emitted on an APPROVED response.
 *
 * Content-type is derived **only** from the canonical format the bytes were
 * re-encoded into — never from `object.httpMetadata.contentType` (attacker-
 * influenced) and never from the stored `mimeType`. In P0a only images reach
 * APPROVED, so the canonical format is always one of the sharp-writable raster
 * formats.
 */
export function canonicalContentType(
  canonicalFormat: "jpeg" | "png" | "webp",
): string {
  switch (canonicalFormat) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      // Exhaustive in the type; defensive fallback keeps this total.
      return "application/octet-stream";
  }
}
