/**
 * Pure builder for the MediaFile upsert arguments (T9, reworked for the
 * T14/AR4 lifecycle consolidation).
 *
 * Keeping this out of the route handler makes the dedup-safety invariant
 * directly unit-testable: a within-tenant dedup hit (identical bytes
 * re-uploaded) must NOT transfer ownership (`uploadedBy`) or de-publish /
 * re-publish the canonical row (`lifecycle`). Subsequent uploaders get a
 * *reference* (via the post→media relation), never a mutation of the shared
 * row.
 *
 * The shell (media.ts) passes the result straight to
 * `db.mediaFile.upsert(buildMediaUpsertArgs(...))`.
 */

import type { SyntheticSourceType } from "../provenance/types.js";
import type { MediaLifecycle } from "./media-lifecycle.js";

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
   * The resolved lifecycle state for the CANONICAL (first) upload of these
   * bytes. The sync-image path creates rows directly at their verdict
   * (APPROVED/REVIEW/QUARANTINED) — bytes and verdict are known atomically.
   * Applied to `create` only — a dedup hit must NOT re-moderate or de-publish
   * the existing canonical row (see module doc + the deliberately-empty
   * `update` payload). Absent ⇒ the schema default (`AWAITING_UPLOAD`,
   * fail-closed) stands.
   */
  lifecycle?: MediaLifecycle;
  /**
   * Intrinsic Art. 50 provenance read from the ORIGINAL bytes before the T7
   * re-encode stripped them (lib/metadata/provenance-reader.ts).
   *
   * Applied to `create` only, like `lifecycle` — the `update` payload stays
   * empty so a dedup hit never mutates the shared row. A dedup hit that carries
   * a STRONGER marking is raised by a separate, atomic guarded update at the
   * call site; it cannot be expressed as a max() in an upsert payload.
   */
  embeddedSourceType?: SyntheticSourceType;
  /** True when the bytes were examined for a provenance container, whatever it said. */
  provenanceExamined?: boolean;
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
    uploadedBy: string;
    width?: number;
    height?: number;
    duration?: number;
    lifecycle?: MediaLifecycle;
  };
  update: {
    // DELIBERATELY EMPTY. See module doc: a dedup hit must not touch
    // `uploadedBy` or `lifecycle` — the canonical row's verdict and ownership
    // stand; the re-uploader only gains a reference. (The pre-T14 builder
    // re-asserted `uploadStatus: "COMPLETE"` here; with the lifecycle
    // consolidation there is no separate upload column left to settle, and a
    // sync-image canonical row is only ever created at a final verdict.)
    [key: string]: never;
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
      uploadedBy: input.uploadedBy,
      width: input.width,
      height: input.height,
      duration: input.duration,
      // Present only when the caller resolved a verdict (sync-image path);
      // absent ⇒ the schema default (AWAITING_UPLOAD) stands. NEVER on `update`.
      ...(input.lifecycle !== undefined && {
        lifecycle: input.lifecycle,
      }),
      // Art. 50 provenance — `create` only, same rule as `lifecycle`. NEVER on
      // `update`: an unconditional write there could LOWER an existing marking.
      ...(input.embeddedSourceType !== undefined && {
        embeddedSourceType: input.embeddedSourceType,
      }),
      ...(input.provenanceExamined !== undefined && {
        provenanceExamined: input.provenanceExamined,
      }),
    },
    update: {},
  };
}
