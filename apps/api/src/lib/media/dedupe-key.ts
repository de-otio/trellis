// Pure functional-core unit. No I/O, no clock, no random.
//
// Derives a collision-resistant, injection-safe dedupe key for a (contentHash,
// jobId, track) tuple. Used by the processing worker to idempotently fan-out /
// fan-in async per-track moderation jobs without double-processing.
//
// COLLISION RESISTANCE: a naive delimiter join ("a:b:c") is vulnerable when
// jobId is provider-controlled and may contain the delimiter. This module hashes
// the canonical tuple with SHA-256 so that distinct tuples always yield distinct
// keys regardless of delimiter characters in any field.
//
// Ships in the PUBLIC npm tarball: NO thresholds, secrets, or real-category
// vocabulary here. node:crypto createHash is allowed (deterministic, CPU-only).

import { createHash } from "node:crypto";
import type { Track } from "./track-verdict.js";
import type { DedupeKeyInput } from "./processing-types.js";

// Re-export for call-site convenience.
export type { DedupeKeyInput };

/**
 * Derive a stable, collision-resistant dedupe key for one (contentHash, jobId,
 * track) tuple.
 *
 * Implementation: encode the three fields as a length-prefixed canonical form,
 * then SHA-256 hash it. Length-prefix encoding ensures that distinct tuples
 * cannot be made to collide by crafting delimiter-containing field values
 * (e.g. a jobId that itself contains a colon, slash, or any other separator).
 *
 * Format fed to SHA-256:
 *   `<len(contentHash)>:<contentHash>|<len(jobId)>:<jobId>|<len(track)>:<track>`
 *
 * The hash output is lowercased hex — 64 characters, safe as a map key, a
 * DynamoDB attribute value, or a Redis key.
 *
 * Properties (all property-tested):
 *   - Deterministic (idempotent): same tuple → same key on every call.
 *   - Injective: distinct tuples → distinct keys, even when jobId contains
 *     delimiters (`|`, `:`), Unicode, NUL bytes, or embedded length-prefix
 *     strings that would fool a naive join.
 *   - Total: never throws, returns a non-empty string for any input.
 *
 * @param input - The (contentHash, jobId, track) triple.
 * @returns A 64-character lowercase hex SHA-256 digest.
 */
export function deriveDedupeKey(input: DedupeKeyInput): string {
  const { contentHash, jobId, track } = input;

  // Length-prefixed encoding prevents injection: a field value that contains
  // the separator cannot silently absorb a neighbouring field's value.
  const canonical =
    `${contentHash.length}:${contentHash}` +
    `|${jobId.length}:${jobId}` +
    `|${track.length}:${track}`;

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
