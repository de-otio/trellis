// Per-tenant synthetic-content disclosure posture (AI Act Art. 50, decision D15).
//
// Pure core: no I/O, no clock, no Prisma. Prisma-free for the same reason as
// ./resolve.ts — the vocabulary is a TS union mirrored by the
// `TenantDisclosurePosture` enum, guarded bidirectionally in
// test/unit/provenance/prisma-alignment.test.ts.
//
// Spec: trellis-internal analysis/ai-act-transparency/06-federation-and-extensions.md §3
//
// WHY A POSTURE EXISTS AT ALL
// ---------------------------
// Trellis is explicitly multi-tenant, serving B2C consumers and B2B organisations
// side by side, and Art. 3(4) puts those two populations on OPPOSITE sides of the
// legal line: a B2B tenant posting in a professional capacity is a *deployer* with
// a live Art. 50(4) duty, while a consumer posting personally falls inside the
// personal non-professional carve-out and has no duty at all. One global posture
// is therefore necessarily wrong for one of them.
//
// WHAT THE POSTURE DOES *NOT* DO — read this before adding a parameter
// -------------------------------------------------------------------
// The analysis anticipated that posture would feed `disclosureRequired` in the API
// response. Working through the three postures, it does not, and the difference is
// worth stating rather than quietly implementing:
//
//   * All three postures render IDENTICALLY. `disclosureRequired` is true exactly
//     when the resolved content is synthetic. No posture makes a synthetic label
//     optional (that would be the tenant contracting out of Art. 50, which it
//     cannot do), and no posture requires disclosing HUMAN_CREATED or UNKNOWN
//     (UNKNOWN must render as *nothing* — it is not a claim we ever made).
//   * "REQUIRED_FOR_AI cannot be suppressed" is already guaranteed for every
//     tenant by max-disclosure resolution (D10). It needed no posture.
//
// What actually differs between postures is the WRITE path and the compose hint:
// whether an author may decline to answer. So posture is threaded into validation
// and into a capability hint, and deliberately NOT into `toProvenanceView` — which
// is why that function still takes one argument. Threading a parameter through
// every response site for an identical result would be cost with no behaviour.

/**
 * How a tenant treats the author's provenance declaration.
 *
 * Mirrors the Prisma `TenantDisclosurePosture` enum. A tenant row's column is
 * NULLABLE: null means "no override, use the platform default from env".
 */
export type DisclosurePosture = "OPTIONAL" | "REQUIRED_FOR_AI" | "PROMPTED";

export const DISCLOSURE_POSTURES: readonly DisclosurePosture[] = [
  "OPTIONAL",
  "REQUIRED_FOR_AI",
  "PROMPTED",
] as const;

/**
 * The platform default when neither the tenant column nor env supplies one.
 *
 * `PROMPTED` because it is the honest middle: the compose flow asks, and "prefer
 * not to say" is a valid answer that resolves to `UNKNOWN`. Defaulting to
 * `REQUIRED_FOR_AI` would impose a professional-deployer duty on consumers who do
 * not have one; defaulting to `OPTIONAL` would silently drop the prompt for the
 * B2B tenants who do.
 *
 * NOT a secret threshold — this is published policy, not a detection parameter, so
 * a compiled fallback is appropriate here (contrast CLAUDE.md rule 8, which covers
 * rate limits, detection thresholds, sampling rates and retention windows).
 */
export const DEFAULT_DISCLOSURE_POSTURE: DisclosurePosture = "PROMPTED";

/** Narrow an untrusted string (env var, JSON body) to a posture, or null. */
export function parseDisclosurePosture(
  raw: string | null | undefined,
): DisclosurePosture | null {
  if (raw === null || raw === undefined) return null;
  const candidate = raw.trim().toUpperCase();
  return (DISCLOSURE_POSTURES as readonly string[]).includes(candidate)
    ? (candidate as DisclosurePosture)
    : null;
}

/** The per-tenant override column, shaped so a partial select still typechecks. */
export interface TenantPostureOverride {
  readonly disclosurePosture?: DisclosurePosture | null;
}

/**
 * Resolve the EFFECTIVE posture for a tenant:
 *
 *   effective = tenant.disclosurePosture ?? platformDefault
 *
 * **FAIL-OPEN, by design.** A null/undefined override — or a tenant row that could
 * not be read at all — resolves to the platform default rather than throwing. A
 * posture-lookup failure must never block a post: the posture governs whether we
 * *ask* for a declaration, and refusing the write would convert a policy-lookup
 * blip into an outage. Failing closed on the LABEL is a separate concern and lives
 * in `resolveProvenance` (max disclosure wins), which no posture can override.
 */
export function resolveDisclosurePosture(
  override: TenantPostureOverride | null | undefined,
  platformDefault: DisclosurePosture,
): DisclosurePosture {
  return override?.disclosurePosture ?? platformDefault;
}

/** What the compose UI must do about the declaration field, under this posture. */
export type DeclarationRequirement =
  /** Accept it if offered; never ask, never require. */
  | "none"
  /** Ask, but "prefer not to say" (→ UNKNOWN) is an acceptable answer. */
  | "prompt"
  /** A declaration must be present and must not be UNKNOWN. */
  | "mandatory";

export function declarationRequirement(
  posture: DisclosurePosture,
): DeclarationRequirement {
  switch (posture) {
    case "OPTIONAL":
      return "none";
    case "PROMPTED":
      return "prompt";
    case "REQUIRED_FOR_AI":
      return "mandatory";
  }
}

/** Why a declaration was rejected. Maps to an API error code at the boundary. */
export type DeclarationRejection =
  /** No `provenance` was supplied and the tenant requires one. */
  | "DECLARATION_REQUIRED"
  /** `UNKNOWN` was supplied and the tenant does not accept "prefer not to say". */
  | "DECLARATION_MAY_NOT_BE_UNKNOWN";

/**
 * Validate an author's declaration against the tenant's posture, at write time.
 *
 * `declared` is the source type the author supplied, or `undefined` when the
 * request omitted the field entirely. The two are distinct: under
 * `REQUIRED_FOR_AI`, omitting the field and explicitly answering `UNKNOWN` are
 * both refused, but for different reasons and with different error codes, because
 * a client needs to tell "you forgot to ask" from "the user declined and you must
 * not let them".
 *
 * Returns null when the declaration is acceptable. Pure — the caller maps the
 * rejection onto an HTTP response.
 */
export function validateDeclaration(
  posture: DisclosurePosture,
  declared: string | undefined,
): DeclarationRejection | null {
  if (declarationRequirement(posture) !== "mandatory") return null;
  if (declared === undefined) return "DECLARATION_REQUIRED";
  if (declared === "UNKNOWN") return "DECLARATION_MAY_NOT_BE_UNKNOWN";
  return null;
}
