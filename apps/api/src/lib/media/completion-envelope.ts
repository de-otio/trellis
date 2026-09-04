/**
 * completion-envelope.ts — the provider-neutral shape a moderation backend
 * publishes when an async job finishes, plus a total parser for it.
 *
 * WHY A CANONICAL SHAPE. The completion queue used to speak exactly one
 * vendor's wire format, which meant "implement the moderation seam" quietly
 * also meant "emit that vendor's notification JSON". The canonical envelope is
 * the small, documented thing an adapter can actually produce:
 *
 *     { "track": "VISUAL" | "AUDIO", "jobId": "<the id you returned>" }
 *
 * The historical shapes still parse (see {@link parseCompletionEnvelope}), so a
 * backend already publishing them keeps working and in-flight messages are not
 * stranded by a deploy.
 *
 * THE ENVELOPE IS UNTRUSTED, AND `track` IS THE SHARP EDGE. Anything that can
 * write to the queue chooses this JSON, so `track` is a ROUTING HINT and never
 * an authority. The worker resolves the job row by `jobId` and compares the
 * claimed track against the row's own track; a mismatch is unroutable and is
 * dropped WITHOUT claiming the dedupe key — because claiming it would let a
 * forged message burn the dedupe slot that the genuine completion needs, and a
 * completion that can be pre-emptively silenced is a completion that can be
 * made to never arrive. The body's own verdict fields, if any, are ignored
 * entirely: only the job id survives parsing.
 *
 * PURE AND TOTAL: no I/O, no clock, no throw, for any input at all.
 */

import type { Track } from "./track-verdict.js";

/**
 * The parsed pointer: which track finished, and the provider job id to re-fetch
 * authoritative state with. Deliberately carries nothing else.
 */
export interface ModerationCompletionEnvelope {
  readonly track: Track;
  readonly jobId: string;
}

/**
 * Largest message body this parser will look at, in bytes.
 *
 * A ROBUSTNESS BOUND, not an operational threshold: it caps the work a single
 * hostile message can cause (a multi-megabyte string, a deeply nested object
 * that turns `JSON.parse` into the expensive part of the worker), and it is
 * deliberately far above any legitimate completion notification. Nothing about
 * moderation policy is expressed here, so it belongs in code rather than in
 * operator config.
 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Longest provider-supplied string this module will hand onward.
 *
 * Job ids come from outside and end up in log lines and metric dimensions. A
 * bound plus a control-character strip keeps a hostile id from injecting line
 * breaks into a log stream or blowing up a metrics backend's cardinality.
 */
const MAX_PROVIDER_STRING = 256;

/** Valid track values. An unrecognised value is never defaulted — it is null. */
const TRACKS: ReadonlySet<string> = new Set<Track>(["VISUAL", "AUDIO"]);

/**
 * Bound and de-fang a provider-supplied string before it reaches a log line, a
 * metric dimension, or a database lookup. Strips C0/C1 control characters
 * (including the newlines that would forge log records) and truncates.
 */
export function sanitizeProviderString(value: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  return stripped.length > MAX_PROVIDER_STRING
    ? stripped.slice(0, MAX_PROVIDER_STRING)
    : stripped;
}

/** A non-empty string value, sanitized; `null` for anything else. */
function pickString(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const clean = sanitizeProviderString(v);
  return clean.length > 0 ? clean : null;
}

/** Byte length of a string without allocating a Buffer copy of the whole body. */
function tooLarge(value: string): boolean {
  // A JS string is at most 3 bytes/char in UTF-8 for the BMP and 4 for
  // astral pairs (which cost 2 chars), so `length * 4` bounds the encoded size
  // from above — cheap, and it only ever over-estimates, so nothing legitimate
  // is rejected that a precise measure would accept at this margin.
  if (value.length * 4 <= MAX_BODY_BYTES) return false;
  return Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES;
}

/** Parse JSON into an object, or null. Never throws. */
function parseObject(raw: string): Record<string, unknown> | null {
  if (tooLarge(raw)) return null;
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return null;
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    return null;
  }
  return root as Record<string, unknown>;
}

/**
 * Parse an untrusted completion body into a canonical envelope.
 *
 * Resolution order, and why:
 *
 *  1. **Canonical wins.** If the body carries a `track` field at all, the
 *     message is treated as canonical: a valid track plus a usable `jobId`
 *     parses, and anything else about it (an unknown track, a missing id)
 *     returns `null` rather than falling through. A message that ALSO carries
 *     legacy fields is therefore unambiguous — it cannot be steered down the
 *     compat path by adding a second job id under a different key.
 *  2. **Compat fallbacks**, for backends still publishing their native
 *     notification shapes: an audio transcription job name (directly or under
 *     an event-envelope `detail`), then a visual job id (directly or inside a
 *     notification's JSON-string `Message`).
 *
 * Returns `null` for anything unrecognised. The caller drops such a message
 * rather than retrying it — a permanently-malformed pointer that is retried is
 * a message that loops until it reaches a dead-letter queue, and nothing about
 * re-reading the same bytes will make them parse.
 */
export function parseCompletionEnvelope(
  body: string,
): ModerationCompletionEnvelope | null {
  if (typeof body !== "string" || body.length === 0) return null;

  const obj = parseObject(body);
  if (obj === null) return null;

  // --- 1. Canonical: { track, jobId } ---
  if (obj.track !== undefined) {
    const track = typeof obj.track === "string" ? obj.track : "";
    if (!TRACKS.has(track)) return null;
    const jobId = pickString(obj.jobId);
    if (jobId === null) return null;
    return { track: track as Track, jobId };
  }

  // --- 2a. Compat: audio transcription completion ---
  const detail =
    typeof obj.detail === "object" && obj.detail !== null
      ? (obj.detail as Record<string, unknown>)
      : undefined;
  const transcriptionName =
    pickString(detail?.TranscriptionJobName) ??
    pickString(obj.TranscriptionJobName);
  if (transcriptionName !== null) {
    return { track: "AUDIO", jobId: transcriptionName };
  }

  // --- 2b. Compat: visual moderation completion ---
  const directJobId = pickString(obj.JobId);
  if (directJobId !== null) {
    return { track: "VISUAL", jobId: directJobId };
  }

  // A notification service wraps the real payload in a JSON *string*, and the
  // size cap applies to that inner string too. The outer cap already binds (the
  // inner string is a substring of the outer body), so this is defence in depth
  // rather than a distinct gate: it keeps the bound in force if the outer check
  // is ever relaxed or an inner payload arrives by another route.
  const wrapped = pickStringUnsanitized(obj.Message);
  if (wrapped !== null) {
    const inner = parseObject(wrapped);
    if (inner !== null) {
      const innerJobId = pickString(inner.JobId);
      if (innerJobId !== null) {
        return { track: "VISUAL", jobId: innerJobId };
      }
    }
  }

  return null;
}

/**
 * The wrapped payload is JSON that must survive intact to be re-parsed, so it
 * is NOT run through the control-character strip — sanitizing happens to the
 * job id extracted from it, after the inner parse.
 */
function pickStringUnsanitized(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Build the canonical body an adapter should publish. Exported so a provider
 * implementor has an exact, testable target instead of a prose description, and
 * so core's own tests round-trip against the same producer the docs point at.
 */
export function completionEnvelopeBody(
  envelope: ModerationCompletionEnvelope,
): string {
  return JSON.stringify({ track: envelope.track, jobId: envelope.jobId });
}
