// CONTRACT: stable — coordinate changes.
//
// The synthetic-content provenance vocabulary (AI Act Art. 50 transparency).
//
// This module is deliberately Prisma-free: the vocabulary is expressed as TS
// string-literal unions so the pure core (./resolve.ts) typechecks and is
// property-testable without a generated client. The Prisma enums
// `SyntheticSourceType` / `SyntheticBasis` MIRROR these unions — see
// `assertVocabularyAlignment` in ./resolve.ts for the compile-time check that
// keeps them from drifting.
//
// Design rules, from analysis/ai-act-transparency/03-data-model-and-api.md:
//   - NEVER a boolean. "Is it AI?" has at least four answers with different
//     legal weight, and collapsing them is the likeliest way to ship a wrong
//     label.
//   - `UNKNOWN` is the default and means exactly that — NOT "human".
//   - No `confidence` field exists on any type here, now or later: an exposed
//     detector confidence is a queryable oracle for the secret moderation
//     thresholds (media hub D3 anti-oracle rule).

/**
 * What the content is, aligned with the IPTC `DigitalSourceType` vocabulary.
 *
 * `UNKNOWN` is not a synonym for `HUMAN_CREATED`. Absence of a marking is
 * absence of evidence, never evidence of human origin.
 */
export type SyntheticSourceType =
  /** No signal, or a signal we could not interpret. The default. */
  | "UNKNOWN"
  /** Affirmatively declared or attested as not AI-generated. */
  | "HUMAN_CREATED"
  /** AI applied to human-captured content beyond standard editing. */
  | "AI_EDITED"
  /** Human-authored with AI in the loop (IPTC compositeWithTrainedAlgorithmicMedia). */
  | "AI_ASSISTED"
  /** Wholly synthetic (IPTC trainedAlgorithmicMedia). */
  | "AI_GENERATED";

/**
 * How we came to believe the `SyntheticSourceType`. This is what carries the
 * legal weight — an author's declaration is a statement by a deployer, a file's
 * metadata is hearsay from an upstream tool, and a classifier's output is a
 * guess. They must never be collapsed into one another.
 */
export type SyntheticBasis =
  /** The posting author said so. */
  | "AUTHOR_DECLARED"
  /** Our own generation feature produced it. Highest confidence; never downgradable. */
  | "PLATFORM_GENERATED"
  /** Read from IPTC/XMP/C2PA before the ingest metadata strip. */
  | "EMBEDDED_METADATA"
  /** A detector inferred it. Advisory ONLY; never renders as a claim. */
  | "CLASSIFIER_INFERRED";

/** A provenance value together with its basis. `basis` is null only when `sourceType` is UNKNOWN. */
export interface Provenance {
  readonly sourceType: SyntheticSourceType;
  readonly basis: SyntheticBasis | null;
}

/**
 * The API-facing projection.
 *
 * Emits i18n KEYS, never localized strings, and takes no locale: Trellis is
 * headless and the consuming application owns translation
 * (analysis 08 §3). The vocabulary is core's; the wording is the vertical's.
 */
export interface ProvenanceView {
  readonly sourceType: SyntheticSourceType;
  readonly basis: SyntheticBasis | null;
  /** Resolved disclosure obligation. See `toProvenanceView` for the current default. */
  readonly disclosureRequired: boolean;
  /** i18n key, e.g. "provenance.ai_assisted". */
  readonly labelKey: string;
  /**
   * i18n key for the accessible text equivalent. NON-OPTIONAL by design:
   * Art. 50(5) requires conformance with accessibility requirements, and an
   * optional accessible label is one that gets skipped.
   */
  readonly labelDetailKey: string;
}

/** Every source type, in ascending disclosure strength. The ONE ordering. */
export const SOURCE_TYPES_BY_STRENGTH: readonly SyntheticSourceType[] = [
  "UNKNOWN",
  "HUMAN_CREATED",
  "AI_EDITED",
  "AI_ASSISTED",
  "AI_GENERATED",
] as const;

export const SYNTHETIC_BASES: readonly SyntheticBasis[] = [
  "AUTHOR_DECLARED",
  "PLATFORM_GENERATED",
  "EMBEDDED_METADATA",
  "CLASSIFIER_INFERRED",
] as const;
