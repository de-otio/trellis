/**
 * Pure builder for the MediaFile upsert arguments (T9).
 *
 * Keeping this out of the route handler makes the dedup-safety invariant
 * directly unit-testable: a within-tenant dedup hit (identical bytes
 * re-uploaded) must NOT transfer ownership (`uploadedBy`) or de-publish the
 * canonical row (`moderationStatus`). Subsequent uploaders get a *reference*
 * (via the post→media relation), never a mutation of the shared row.
 *
 * The shell (media.ts) passes the result straight to
 * `db.mediaFile.upsert(buildMediaUpsertArgs(...))`.
 */

import type { ModerationStatus } from "./moderation-status.js";

export interface MediaUpsertInput {
  tenantId: string;
  contentHash: string;
  originalKey: string;
  mimeType: string;
  size: number;
  uploadedBy: string;
  width?: number;
  height?: number;
  duration?: number;
  /**
   * The moderation verdict for the CANONICAL (first) upload of these bytes.
   * Applied to `create` only — a dedup hit must NOT re-moderate or de-publish
   * the existing canonical row (see module doc + the deliberately-minimal
   * `update` payload). Absent ⇒ the schema default (`PENDING`) stands.
   */
  moderationStatus?: ModerationStatus;
}

/**
 * The `create`/`update`/`where` payload for `db.mediaFile.upsert`.
 *
 * Typed structurally (not against the generated Prisma client) so this pure
 * module never depends on a regenerated client across worktrees. The shell
 * passes it to Prisma, which validates the shape.
 */
export interface MediaUpsertArgs {
  where: { tenantId_contentHash: { tenantId: string; contentHash: string } };
  create: {
    tenantId: string;
    contentHash: string;
    mimeType: string;
    size: number;
    originalKey: string;
    uploadStatus: "COMPLETE";
    uploadedBy: string;
    width?: number;
    height?: number;
    duration?: number;
    moderationStatus?: ModerationStatus;
  };
  update: {
    // DELIBERATELY MINIMAL. See module doc: a dedup hit must not touch
    // `uploadedBy` or `moderationStatus`. We only re-assert COMPLETE so a
    // previously-interrupted upload of the same bytes settles idempotently.
    uploadStatus: "COMPLETE";
  };
}

export function buildMediaUpsertArgs(
  input: MediaUpsertInput,
): MediaUpsertArgs {
  return {
    where: {
      tenantId_contentHash: {
        tenantId: input.tenantId,
        contentHash: input.contentHash,
      },
    },
    create: {
      tenantId: input.tenantId,
      contentHash: input.contentHash,
      mimeType: input.mimeType,
      size: input.size,
      originalKey: input.originalKey,
      uploadStatus: "COMPLETE",
      uploadedBy: input.uploadedBy,
      width: input.width,
      height: input.height,
      duration: input.duration,
      // Present only when the caller resolved a verdict (sync-image path);
      // absent ⇒ the schema default (PENDING) stands. NEVER on `update`.
      ...(input.moderationStatus !== undefined && {
        moderationStatus: input.moderationStatus,
      }),
    },
    update: {
      uploadStatus: "COMPLETE",
    },
  };
}
