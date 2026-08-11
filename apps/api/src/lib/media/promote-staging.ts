/**
 * promote-staging.ts — the version-pinned staging→CAS promotion, extracted so
 * every path that can make bytes servable goes through ONE implementation.
 *
 * There are two such paths: the automatic one (both moderation tracks approve)
 * and the human one (a moderator approves a REVIEW item). They must agree, and
 * before this module existed only the automatic one was pinned. That asymmetry
 * is the whole reason this is a module rather than a private helper:
 *
 *   A pin is captured when moderation STARTS, on the exact bytes that were
 *   scanned. Promotion copies THAT version. It never resolves "the current
 *   bytes at the staging key", because between the scan and the approval the
 *   object at that key may not be the object that was scanned — and an approval
 *   that copies whatever is there now is an approval of bytes nobody looked at.
 *
 * FAIL-CLOSED: when the pinned version cannot be resolved and no previously
 * promoted CAS object exists, this module reports `none` and the caller must
 * refuse to promote. Doubt holds in review; doubt never serves.
 */

import type { StoragePort } from "./media-ports.js";

/**
 * Where the servable bytes may legitimately come from.
 *
 * - `staging` — the pinned version the classifier actually scanned.
 * - `cas`     — an object already at the CAS key from a PRIOR pinned promote;
 *               those bytes were themselves pin-copied, so their provenance is
 *               intact and re-copying from staging would only risk adopting
 *               post-moderation bytes.
 * - `none`    — nothing certifiable. Callers must not promote.
 */
export type PromoteSource =
  | { readonly kind: "staging"; readonly versionId: string }
  | { readonly kind: "cas" }
  | { readonly kind: "none" };

/** Minimal logging seam; every call site already has one of this shape. */
export interface PromoteLog {
  info?: (msg: string, data?: unknown) => void;
  warn?: (msg: string, data?: unknown) => void;
  error?: (msg: string, data?: unknown) => void;
}

/**
 * Resolve which source, if any, may serve these bytes.
 *
 * Order matters: the pinned staging version is preferred (it is the freshest
 * certified copy), then an existing CAS object. A null/empty pin is NOT
 * degraded into an unpinned head of the staging key — that degradation is
 * exactly the TOCTOU this module exists to prevent — so an unpinned row can
 * only ever be satisfied by an already-promoted CAS object.
 */
export async function resolvePromoteSource(args: {
  readonly storage: StoragePort;
  readonly stagingKey: string;
  readonly casKey: string;
  readonly stagingVersionId: string | null | undefined;
}): Promise<PromoteSource> {
  const pinnedVersion =
    typeof args.stagingVersionId === "string" &&
    args.stagingVersionId.length > 0
      ? args.stagingVersionId
      : null;

  if (pinnedVersion !== null) {
    const pinnedHead = await args.storage.headObject(args.stagingKey, {
      versionId: pinnedVersion,
    });
    if (pinnedHead.exists) {
      return { kind: "staging", versionId: pinnedVersion };
    }
  }

  if ((await args.storage.headObject(args.casKey)).exists) {
    return { kind: "cas" };
  }

  return { kind: "none" };
}

/**
 * Copy the certified bytes to the CAS key and clean up the transient copies.
 *
 * - `staging` source ⇒ a version-pinned copy.
 * - `cas` source ⇒ no copy at all; the object is already there and re-copying
 *   from staging could adopt bytes that arrived after moderation.
 * - `none` ⇒ this function must not have been called; it throws rather than
 *   quietly doing nothing, because a silent no-op here reads at the call site
 *   as a successful promotion.
 *
 * Cleanup of the raw original and the staging copy is BEST-EFFORT: the CAS copy
 * is what serves, so a leftover transient object is storage noise rather than a
 * safety hole, and letting a delete failure fail the promotion would strand an
 * approved object un-servable.
 */
export async function promotePinned(args: {
  readonly storage: StoragePort;
  readonly source: PromoteSource;
  readonly stagingKey: string;
  readonly casKey: string;
  /** Transient keys to remove after the copy (raw original, staging, poster). */
  readonly cleanupKeys: ReadonlyArray<string>;
  readonly log?: PromoteLog;
  /** Correlation data for the tolerated-delete log lines. */
  readonly logContext?: Record<string, unknown>;
}): Promise<void> {
  if (args.source.kind === "none") {
    throw new Error(
      "promotePinned called with no certifiable source — the caller must check resolvePromoteSource first",
    );
  }

  if (args.source.kind === "staging") {
    await args.storage.copyObject(args.stagingKey, args.casKey, {
      fromVersionId: args.source.versionId,
    });
  }

  for (const key of args.cleanupKeys) {
    try {
      await args.storage.deleteObject(key);
    } catch (err) {
      args.log?.warn?.("promote: transient-object delete tolerated", {
        ...args.logContext,
        key,
        error: String(err),
      });
    }
  }
}
