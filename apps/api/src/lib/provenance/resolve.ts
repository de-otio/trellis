// The pure core of synthetic-content provenance. No I/O, no clock, no Prisma —
// which is why every function here is property-testable
// (test/unit/provenance/resolve.test.ts).
//
// Spec: analysis/ai-act-transparency/03-data-model-and-api.md
// Plan: plans/ai-act-transparency/00-parallel-execution-plan.md (T0.2)

import {
  SOURCE_TYPES_BY_STRENGTH,
  type Provenance,
  type ProvenanceView,
  type SyntheticBasis,
  type SyntheticSourceType,
} from "./types.js";

/**
 * Disclosure strength — THE single ordering, consumed by the dedup merge (T1),
 * the edit-monotonicity check (T2), and `resolveProvenance` below. A second copy
 * anywhere else will drift; import this one.
 *
 * Note `HUMAN_CREATED` ranks above `UNKNOWN`: a positive claim by the author
 * outranks silence, so "I said it's human" may not be walked back to "unknown"
 * on an edit (that would erase a statement).
 */
export function disclosureStrength(sourceType: SyntheticSourceType): number {
  const i = SOURCE_TYPES_BY_STRENGTH.indexOf(sourceType);
  // Defensive: an unmapped value must not silently read as "no disclosure".
  // Treat it as maximal so a future enum addition fails closed.
  return i === -1 ? SOURCE_TYPES_BY_STRENGTH.length : i;
}

/** True for the source types that constitute a synthetic-content disclosure. */
export function isSynthetic(sourceType: SyntheticSourceType): boolean {
  return (
    sourceType === "AI_EDITED" ||
    sourceType === "AI_ASSISTED" ||
    sourceType === "AI_GENERATED"
  );
}

/** Tie-break order when two inputs carry the same disclosure strength. Lower wins. */
const BASIS_PRECEDENCE: Record<SyntheticBasis, number> = {
  PLATFORM_GENERATED: 0,
  AUTHOR_DECLARED: 1,
  EMBEDDED_METADATA: 2,
  CLASSIFIER_INFERRED: 3,
};

function basisRank(basis: SyntheticBasis | null): number {
  return basis === null ? Number.MAX_SAFE_INTEGER : BASIS_PRECEDENCE[basis];
}

/**
 * Resolve the one provenance value to render, from the author's declaration
 * (`PostMedia`/`Post`) and the intrinsic reading of the bytes (`MediaFile`).
 *
 * **Rule: maximum disclosure wins; basis precedence only breaks ties.**
 *
 * This deliberately resolves a tension in the analysis. Doc 03 §3.1 gave basis
 * precedence as the deciding factor (a deployer's declaration outranks a tool's
 * metadata), while §2.1 requires we "fail closed on the label" and never assert
 * human origin we cannot support. Pure basis precedence would let an author
 * declare `HUMAN_CREATED` over an embedded `AI_GENERATED` marking and suppress
 * the disclosure — a laundering path. Max-disclosure closes it, and costs
 * nothing in the normal case because `PLATFORM_GENERATED` is always an `AI_*`
 * value and therefore already maximal. Recorded as decision **D10**.
 *
 * An absent or `UNKNOWN` declaration never masks a known embedded marking.
 */
export function resolveProvenance(
  declared: Provenance | null,
  embedded: Provenance | null,
): Provenance {
  const candidates: Provenance[] = [];
  if (declared !== null && declared.sourceType !== "UNKNOWN") {
    candidates.push(declared);
  }
  if (embedded !== null && embedded.sourceType !== "UNKNOWN") {
    candidates.push(embedded);
  }
  if (candidates.length === 0) return { sourceType: "UNKNOWN", basis: null };

  return candidates.reduce((best, next) => {
    const byStrength =
      disclosureStrength(next.sourceType) - disclosureStrength(best.sourceType);
    if (byStrength > 0) return next;
    if (byStrength < 0) return best;
    return basisRank(next.basis) < basisRank(best.basis) ? next : best;
  });
}

/**
 * Project a resolved provenance into its API shape.
 *
 * `disclosureRequired` currently derives from a **single global default**:
 * disclosure is required exactly when the content is synthetic. Per-tenant
 * posture (`OPTIONAL` / `REQUIRED_FOR_AI` / `PROMPTED`, analysis 06 §3) is
 * deliberately NOT built yet — see plan §0. When it lands, it overrides here and
 * nowhere else, which is why callers must not compute this themselves.
 */
export function toProvenanceView(resolved: Provenance): ProvenanceView {
  const slug = resolved.sourceType.toLowerCase();
  return {
    sourceType: resolved.sourceType,
    basis: resolved.basis,
    disclosureRequired: isSynthetic(resolved.sourceType),
    labelKey: `provenance.${slug}`,
    labelDetailKey: `provenance.${slug}.detail`,
  };
}

/**
 * Monotonic merge, for the two places a provenance value can be written twice:
 *
 *  1. **CAS dedup** (T1) — `contentHash` is computed from the RE-ENCODED bytes,
 *     so two different originals (one AI-marked, one not) can hash identically
 *     and dedup onto the same `MediaFile` row. The marking must survive
 *     whichever upload lands second.
 *  2. **Re-attachment** (T2) — `PostMedia` rows are destroyed and recreated by
 *     edits, so a re-attached asset must inherit any stronger prior declaration
 *     rather than resetting to `UNKNOWN`.
 *
 * Never lowers. Never writes `UNKNOWN` over a recognised value.
 */
export function mergeProvenance(
  existing: Provenance | null,
  incoming: Provenance | null,
): Provenance {
  return resolveProvenance(existing, incoming);
}

// --- Drift guard: where it lives, and why not here --------------------------
//
// The vocabulary is declared twice on purpose — as TS unions in ./types.ts and
// as Prisma enums in prisma/schema.prisma — so drift needs a guard. That guard
// deliberately does NOT live in this module.
//
// The house pattern for a hand-written union mirrored by a Prisma enum is
// `lib/media/media-lifecycle.ts`, which keeps "zero dependency on the
// Prisma-generated client so the serve gate and worker code can compile in
// worktrees that have not regenerated the client". Importing `@prisma/client`
// here to assert alignment would reintroduce exactly that coupling and make this
// pure core un-compilable on a fresh checkout.
//
// So the assertion lives in `test/unit/provenance/prisma-alignment.test.ts`,
// where importing the generated client is free. A failing test is as good a gate
// as a failing compile, and it costs the core module nothing.
