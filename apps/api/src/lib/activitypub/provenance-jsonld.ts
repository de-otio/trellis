// Synthetic-content provenance across the federation boundary (AI Act Art. 50).
//
// Pure: no I/O, no Fedify types, no Prisma. Spec: trellis-internal
// analysis/ai-act-transparency/06-federation-and-extensions.md §1.
//
// THE PROBLEM THIS SOLVES
// ----------------------
// A label that does not federate is worse than no label at all. Outbound, a
// tenant's correctly-disclosed AI post reached remote instances STRIPPED of its
// disclosure: the tenant believed it had discharged a legal duty while every
// remote reader saw an undisclosed post. Inbound is the mirror — a remote
// instance that does mark AI content had that marking discarded at our boundary.
// Structurally the same mistake as the ingest pipeline re-encoding away an IPTC
// marking, one layer up.
//
// THE STANDARDS SITUATION, HONESTLY
// ---------------------------------
// There is no settled ActivityStreams vocabulary for this. The options were: a
// namespaced extension property (interoperates with nobody today, unambiguous,
// what everyone shipping this did first); folding it into `summary` or a
// content-warning prefix (renders on Mastodon-family clients, but conflates a
// legal disclosure with a content warning and is not machine-readable); or
// waiting for a FEP, which is not a plan.
//
// We ship the namespaced property and we PRESERVE what arrives. We deliberately
// do NOT fold the label into `summary`: that rewrites the author's own text to
// carry a machine concern, and a receiving client cannot tell our prefix from a
// user's words. If human visibility on non-supporting clients is wanted later, it
// belongs behind explicit tenant configuration, not in this mapper.
//
// AND THE LIMIT
// -------------
// Even done perfectly, a label crossing an instance boundary is a HINT, not a
// guarantee: the receiving instance may ignore it, drop it, or fabricate one. No
// mechanism available to us changes that, which is why the compliance narrative
// must never claim federated disclosure is end-to-end assured.

import { SOURCE_TYPES_BY_STRENGTH } from "../provenance/types.js";
import type { Provenance, SyntheticSourceType } from "../provenance/types.js";

/** Our extension namespace. Versionless: the term semantics are the IPTC ones. */
export const TRELLIS_NS = "https://trellis.de-otio.org/ns#";

export const SOURCE_TYPE_TERM = "syntheticSourceType";
export const BASIS_TERM = "syntheticBasis";

/**
 * The `@context` fragment that defines our terms. Appended to the standard
 * ActivityStreams context, never replacing it.
 */
export const PROVENANCE_CONTEXT = {
  trellis: TRELLIS_NS,
  [SOURCE_TYPE_TERM]: `trellis:${SOURCE_TYPE_TERM}`,
  [BASIS_TERM]: `trellis:${BASIS_TERM}`,
} as const;

const AS_CONTEXT = "https://www.w3.org/ns/activitystreams";

/**
 * Extend an existing `@context` with the provenance terms, tolerating the three
 * shapes a context can arrive in (absent, a bare string, an array) and never
 * duplicating the fragment.
 */
export function withProvenanceContext(
  existing: unknown,
): (string | Record<string, string>)[] {
  const base: (string | Record<string, string>)[] =
    existing === undefined || existing === null
      ? [AS_CONTEXT]
      : Array.isArray(existing)
        ? [...existing]
        : [existing as string];

  const alreadyThere = base.some(
    (entry) =>
      typeof entry === "object" && entry !== null && "trellis" in entry,
  );
  if (alreadyThere) return base;

  return [...base, { ...PROVENANCE_CONTEXT }];
}

/**
 * The properties to merge onto an outbound object for a resolved provenance.
 *
 * Returns an EMPTY object for `UNKNOWN`. Emitting `syntheticSourceType:
 * "UNKNOWN"` would be worse than silence: to a remote reader it is
 * indistinguishable from a positive statement that we checked and found nothing,
 * which is a claim we never made. Absence means absence.
 *
 * The basis IS emitted. It is not a secret — it is the disclosure's own
 * provenance — and a receiving instance deciding how much weight to give a label
 * needs to know whether the author asserted it, a file's metadata carried it, or
 * our own generator produced it.
 */
export function provenanceToJsonLd(
  provenance: Provenance | null | undefined,
): Record<string, string> {
  if (!provenance || provenance.sourceType === "UNKNOWN") return {};
  const out: Record<string, string> = {
    [SOURCE_TYPE_TERM]: provenance.sourceType,
  };
  if (provenance.basis !== null) out[BASIS_TERM] = provenance.basis;
  return out;
}

function isSourceType(value: unknown): value is SyntheticSourceType {
  return (
    typeof value === "string" &&
    (SOURCE_TYPES_BY_STRENGTH as readonly string[]).includes(value)
  );
}

// NOTE: there is deliberately no `isBasis` narrower here. An earlier draft had
// one, and it became dead the moment we decided to DISCARD the inbound basis and
// record `EMBEDDED_METADATA` instead — a remote `AUTHOR_DECLARED` is not a
// declaration made to us, and a remote `PLATFORM_GENERATED` is another instance's
// platform. Since no inbound basis value is ever trusted, none needs validating.
// Removed rather than left in place: an unused validator invites a future reader
// to "fix" the omission by starting to honour the field.

/**
 * Read provenance off an inbound object.
 *
 * Accepts our own term in both its compact (`syntheticSourceType`) and expanded
 * (`https://…/ns#syntheticSourceType`) forms, because whether a relaying instance
 * compacted the document against our context is outside our control.
 *
 * FAIL-CLOSED IN THE SAME DIRECTION AS THE INGEST READER: a remote
 * `HUMAN_CREATED` claim is NOT honoured. Anyone can put any JSON in an
 * ActivityPub object, so honouring it would let a hostile instance stamp "this is
 * a real photo" onto synthetic media — with the added twist that here the forger
 * is a peer server rather than an end user. Disclosure-increasing values are
 * accepted (a remote instance has no incentive to over-declare, and if it does,
 * the cost is an unnecessary label rather than a missing one).
 *
 * The inbound basis is deliberately IGNORED and replaced with
 * `EMBEDDED_METADATA`: a remote `AUTHOR_DECLARED` is not a declaration made to
 * *us*, and a remote `PLATFORM_GENERATED` would be another instance's platform,
 * not ours — storing it as-is would let a peer forge our strongest attestation.
 * What we can honestly record is "this arrived carried in the object's metadata".
 */
export function provenanceFromJsonLd(
  object: unknown,
): Provenance | null {
  if (typeof object !== "object" || object === null) return null;
  const record = object as Record<string, unknown>;

  const raw =
    record[SOURCE_TYPE_TERM] ??
    record[`${TRELLIS_NS}${SOURCE_TYPE_TERM}`] ??
    record[`trellis:${SOURCE_TYPE_TERM}`];

  if (!isSourceType(raw)) return null;
  if (raw === "UNKNOWN" || raw === "HUMAN_CREATED") return null;

  return { sourceType: raw, basis: "EMBEDDED_METADATA" };
}

/**
 * Provenance-ish properties on an inbound object that we do NOT understand.
 *
 * Purpose: not becoming the node that destroys other people's markings. There is
 * no settled vocabulary, so other implementations will use terms we have never
 * heard of, and silently dropping them repeats the ingest-strip mistake at the
 * federation layer.
 *
 * Matched by name rather than by namespace, on purpose — a namespace allowlist
 * would only recognise vocabularies that already exist, which is precisely the set
 * that does not need protecting.
 *
 * NOTE ON WHAT THIS CANNOT DO YET: true round-trip preservation needs somewhere to
 * keep the values, and inbound post ingestion is not implemented
 * (`ActivityProcessor.processCreate` logs and returns — see its "Phase 2" note).
 * Until it is, this feeds observability: it tells an operator that remote
 * instances ARE sending markings we discard, which is the evidence needed to
 * prioritise the store. When ingestion lands, persist this map alongside the post
 * and re-emit it untouched.
 */
export function unknownProvenanceProperties(
  object: unknown,
): Record<string, unknown> {
  if (typeof object !== "object" || object === null) return {};
  const record = object as Record<string, unknown>;

  const known = new Set([
    SOURCE_TYPE_TERM,
    BASIS_TERM,
    `${TRELLIS_NS}${SOURCE_TYPE_TERM}`,
    `${TRELLIS_NS}${BASIS_TERM}`,
    `trellis:${SOURCE_TYPE_TERM}`,
    `trellis:${BASIS_TERM}`,
  ]);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (known.has(key)) continue;
    const local = key.split(/[#:/]/).pop() ?? key;
    if (/^(synthetic|ai|generated|provenance|digitalSourceType)/i.test(local)) {
      out[key] = value;
    }
  }
  return out;
}
