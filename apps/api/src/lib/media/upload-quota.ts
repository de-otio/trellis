// Injection seam for the optional per-user upload quota. Mirrors
// setMediaModerationProvider: a consuming app registers its adapter once at
// startup. With nothing registered the upload flow is exactly as before — there
// is deliberately NO default adapter and no default limit here.

import type { UploadQuotaPort } from "./media-ports.js";

let injected: UploadQuotaPort | undefined;

/** Register the quota adapter. Re-exported from `@de-otio/trellis`. */
export function setUploadQuotaPort(port: UploadQuotaPort | undefined): void {
  injected = port;
}

/** The registered adapter, or `undefined` when none was wired. */
export function getUploadQuotaPort(): UploadQuotaPort | undefined {
  return injected;
}

/**
 * The quota "kind" for a requested mime type. Images are the only `image`;
 * everything else that can be presigned (video, and audio, which rides the same
 * async pipeline) is `video`, because `UploadQuotaPort` has no other kind.
 */
export function uploadQuotaKind(mimeType: string): "image" | "video" {
  return typeof mimeType === "string" && mimeType.trim().toLowerCase().startsWith("image/")
    ? "image"
    : "video";
}
