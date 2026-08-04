// Observability for synthetic-content provenance (AI Act Art. 50).
//
// Pure: metric NAMES, dimension shapes, and the counter derivation. No emission —
// callers pass the result to whatever `MetricsPort` they hold
// (lib/workers/metrics-port.ts), so this module works identically under the EMF
// adapter on Lambda, the OTLP/Cockpit adapter in the container, and `noopMetrics`
// in tests.
//
// WHY A SHARED MODULE FOR SIX STRINGS. There are three emission sites that must
// agree — the image ingest path, the media-processing worker, and the correction
// route — and a metric name typo'd at one of them produces a dashboard that is
// quietly wrong rather than a failure. Alert rules are written against these
// names; they belong in one place.
//
// WHAT THE ALERTS ARE FOR, and why the thresholds are NOT here:
//
//   * `provenance.discarded` > 0 means the pipeline read a marking and threw it
//     away — the consuming application has not implemented
//     `recordEmbeddedProvenance`. This is the one that says "the compliance
//     mechanism is installed but not connected", so it should page rather than
//     sit on a dashboard.
//   * `provenance.read_failed` rising means originals are becoming unreadable —
//     a storage-adapter or range-support regression.
//   * `provenance.recognised` going to zero after being non-zero is the silent
//     failure: the reader stopped working and nothing errored.
//
// The trigger VALUES are deliberately absent from this file. Thresholds are
// runtime config (CLAUDE.md rule 8) and this package's tarball is public, so a
// compiled threshold is a published threshold. The alert rules live in the
// deployment repo alongside the other Cockpit/CloudWatch rules.

import type { SyntheticBasis, SyntheticSourceType } from "./types.js";

/** The metric names. Alert rules key off these strings — do not rename casually. */
export const PROVENANCE_METRICS = {
  /** A marking was found and mapped to a source type. */
  recognised: "provenance.recognised",
  /** A provenance container was found but carried nothing we could use. */
  unrecognised: "provenance.unrecognised",
  /** A marking was read but could not be persisted. Should page. */
  discarded: "provenance.discarded",
  /** The read itself failed (unreadable original, storage error). */
  readFailed: "provenance.read_failed",
  /** A declaration was raised by an author. */
  declared: "provenance.declared",
  /** A staff correction was applied. `reduced` dimension distinguishes direction. */
  corrected: "provenance.corrected",
} as const;

export type ProvenanceMetricName =
  (typeof PROVENANCE_METRICS)[keyof typeof PROVENANCE_METRICS];

/** One Count datum, matching `MetricDatum` in lib/workers/metrics-port.ts. */
export interface ProvenanceMetricDatum {
  readonly name: string;
  readonly value: number;
}

export interface ProvenanceMetricEmission {
  readonly dimensions: Readonly<Record<string, string>>;
  readonly metrics: readonly ProvenanceMetricDatum[];
}

/**
 * The event kinds a caller reports. Deliberately closed: a free-form string would
 * let a call site invent a name that no alert rule matches.
 */
export type ProvenanceEvent =
  | {
      readonly kind: "recognised";
      readonly sourceType: SyntheticSourceType;
      readonly basis: SyntheticBasis;
      readonly mediaKind: "image" | "timed-media" | "text";
    }
  | {
      readonly kind: "unrecognised";
      readonly container: "xmp" | "c2pa";
      readonly mediaKind: "image" | "timed-media";
    }
  | {
      readonly kind: "discarded";
      readonly reason: "no-persistence-port";
      readonly mediaKind: "image" | "timed-media";
    }
  | { readonly kind: "read-failed"; readonly mediaKind: "image" | "timed-media" }
  | {
      readonly kind: "declared";
      readonly sourceType: SyntheticSourceType;
      readonly surface: "post" | "comment" | "attachment";
    }
  | { readonly kind: "corrected"; readonly reduced: boolean };

/**
 * Derive the metric emission for one provenance event.
 *
 * NOTE ON WHAT IS *NOT* A DIMENSION: no tenant id, no user id, no media id, no
 * post id. Metric dimensions are high-cardinality-hostile *and* this is a
 * disclosure-adjacent signal — a per-tenant AI-content counter is exactly the kind
 * of derived dataset that turns an Art. 50 mechanism into surveillance of which
 * organisations post AI content. Dimensions stay categorical: the vocabulary
 * values and the surface. Correlating a specific object with its provenance is
 * what the audit log is for, under access control.
 */
export function provenanceMetric(
  event: ProvenanceEvent,
): ProvenanceMetricEmission {
  switch (event.kind) {
    case "recognised":
      return {
        dimensions: {
          sourceType: event.sourceType,
          basis: event.basis,
          mediaKind: event.mediaKind,
        },
        metrics: [{ name: PROVENANCE_METRICS.recognised, value: 1 }],
      };
    case "unrecognised":
      return {
        dimensions: {
          container: event.container,
          mediaKind: event.mediaKind,
        },
        metrics: [{ name: PROVENANCE_METRICS.unrecognised, value: 1 }],
      };
    case "discarded":
      return {
        dimensions: { reason: event.reason, mediaKind: event.mediaKind },
        metrics: [{ name: PROVENANCE_METRICS.discarded, value: 1 }],
      };
    case "read-failed":
      return {
        dimensions: { mediaKind: event.mediaKind },
        metrics: [{ name: PROVENANCE_METRICS.readFailed, value: 1 }],
      };
    case "declared":
      return {
        dimensions: {
          sourceType: event.sourceType,
          surface: event.surface,
        },
        metrics: [{ name: PROVENANCE_METRICS.declared, value: 1 }],
      };
    case "corrected":
      return {
        // Boolean-as-string because dimension values are strings; `reduced=true`
        // is the one worth alerting on, since it removes a published disclosure.
        dimensions: { reduced: String(event.reduced) },
        metrics: [{ name: PROVENANCE_METRICS.corrected, value: 1 }],
      };
  }
}
