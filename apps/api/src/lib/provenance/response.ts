// Response projection for synthetic-content provenance (AI Act Art. 50).
//
// THE CHOKE POINT. This codebase has no shared post serializer — every response
// site hand-shapes its own object — so without a single place to compute the
// provenance view, each site would re-derive it and they would drift. Call these
// two functions; do not inline `resolveProvenance` at a response site.
//
// Pure functions: no I/O, no clock, no Prisma types. They accept the loosest
// structural shape that carries the columns, so a site that selects extra fields
// or fewer relations still typechecks.
//
// Spec: trellis-internal analysis/ai-act-transparency/03-data-model-and-api.md §4

import { resolveProvenance, toProvenanceView } from "./resolve.js";
import type {
  C2paManifestView,
  MediaProvenanceView,
  Provenance,
  ProvenanceView,
  SyntheticBasis,
  SyntheticSourceType,
} from "./types.js";

/**
 * The text-provenance columns as they arrive from a `Post` OR a `PostComment` row.
 *
 * The two models carry the same column pair by design (D14), so one projection
 * serves both. Keeping separate `post…`/`comment…` functions would have been two
 * bodies to keep identical, which is how the post and comment paths drift.
 */
export interface TextProvenanceColumns {
  readonly textSourceType?: SyntheticSourceType | null;
  readonly textBasis?: SyntheticBasis | null;
}

/**
 * The C2PA sidecar summary columns as they arrive from a `MediaFile` row.
 * All optional: a caller that did not select them degrades to "no manifest",
 * which is the right failure mode for a disclosure field.
 */
export interface C2paSidecarColumnsView {
  readonly c2paManifestPresent?: boolean | null;
  readonly c2paContainer?: string | null;
  readonly c2paSidecarKey?: string | null;
  readonly c2paSidecarBytes?: number | null;
  readonly c2paSidecarSha256?: string | null;
}

/** The provenance columns as they arrive from a `PostMedia` row + its `MediaFile`. */
export interface AttachmentProvenanceColumns {
  readonly declaredSourceType?: SyntheticSourceType | null;
  readonly declaredBasis?: SyntheticBasis | null;
  readonly media?: {
    readonly embeddedSourceType?: SyntheticSourceType | null;
  } | null;
}

/**
 * Normalise a possibly-unselected column pair into a `Provenance` or null.
 *
 * `undefined` means the column was NOT SELECTED by the caller's query, which is
 * different from `UNKNOWN` (selected, nothing known). Both resolve to "no
 * signal" here, but keeping the distinction in mind matters: a site that forgets
 * to select the column silently degrades to UNKNOWN rather than throwing, which
 * is the right failure mode for a disclosure field (never block a response) but
 * means the join audit in the plan (T3.0) is what actually guarantees coverage.
 */
function toProvenance(
  sourceType: SyntheticSourceType | null | undefined,
  basis: SyntheticBasis | null | undefined,
): Provenance | null {
  if (sourceType === null || sourceType === undefined) return null;
  return { sourceType, basis: basis ?? null };
}

/**
 * Provenance of the TEXT of a post or a comment. Media provenance is
 * per-attachment — see {@link attachmentProvenanceView} — because one post can mix
 * a human photo with an AI-generated one.
 *
 * Text has no embedded metadata to read, so the `embedded` side of the resolution
 * is always null: the value is only ever what the author declared or what our own
 * generator minted.
 */
export function textProvenanceView(
  row: TextProvenanceColumns,
): ProvenanceView {
  return toProvenanceView(
    resolveProvenance(toProvenance(row.textSourceType, row.textBasis), null),
  );
}

/**
 * Provenance of a `MediaFile` on its own, with no post context — the media-detail
 * response. Intrinsic reading only: there is no author declaration to resolve
 * against, because a declaration belongs to a *use* of the bytes (a `PostMedia`
 * row), not to the bytes themselves.
 *
 * NOT gated behind `metadataVisible`. That gate exists for privacy-sensitive
 * metadata (EXIF, GPS, camera identity); provenance is the opposite kind of thing
 * — a disclosure that is meant to be seen. Hiding it would defeat its purpose.
 */
export function mediaProvenanceView(
  media: {
    readonly embeddedSourceType?: SyntheticSourceType | null;
  } & C2paSidecarColumnsView,
): MediaProvenanceView {
  return {
    ...toProvenanceView(
      resolveProvenance(
        null,
        toProvenance(media.embeddedSourceType, "EMBEDDED_METADATA"),
      ),
    ),
    c2pa: c2paManifestView(media),
  };
}

/**
 * The C2PA manifest summary, or null when the file carried none (or predates
 * the sidecar — the two are indistinguishable on an old row, and both correctly
 * mean "we have no manifest for these bytes").
 *
 * `verified` IS A HARD-CODED FALSE, not a column read. Trellis extracts the
 * manifest and never checks its signature; there is deliberately no stored
 * field that a later change could set to true without implementing verification
 * first. If that day comes, the compiler will point at this literal.
 *
 * Sits inside the media `provenance` object rather than beside it: a client
 * already reads provenance to decide what to render, and a second top-level
 * field is a second thing to forget.
 */
function c2paManifestView(row: C2paSidecarColumnsView): C2paManifestView | null {
  if (row.c2paManifestPresent !== true) return null;
  return {
    present: true,
    container: row.c2paContainer ?? "unidentified",
    sidecarKey: row.c2paSidecarKey ?? null,
    byteLength: row.c2paSidecarBytes ?? null,
    sha256: row.c2paSidecarSha256 ?? null,
    verified: false,
  };
}

/**
 * Provenance of ONE attachment: the author's declaration on the `PostMedia` join
 * row, resolved against the intrinsic reading on the shared `MediaFile` row.
 *
 * Resolution is `resolveProvenance`'s job (max disclosure wins, D10) — notably,
 * an author cannot suppress an embedded AI marking by declaring `HUMAN_CREATED`.
 */
export function attachmentProvenanceView(
  attachment: AttachmentProvenanceColumns,
): ProvenanceView {
  return toProvenanceView(
    resolveProvenance(
      toProvenance(attachment.declaredSourceType, attachment.declaredBasis),
      toProvenance(attachment.media?.embeddedSourceType, "EMBEDDED_METADATA"),
    ),
  );
}
