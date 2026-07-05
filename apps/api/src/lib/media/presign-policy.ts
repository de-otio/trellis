/**
 * presign-policy.ts — pure functional-core planner for a presigned
 * direct-to-S3 upload grant (T14).
 *
 * Decides — from validated, env-sourced inputs only — WHAT grant the shell may
 * sign: the exact staging key, the exact Content-Type, the byte guardrail
 * (`content-length-range`), and the expiry. The shell
 * (lib/presigned-upload-handler.ts) turns the plan into a real S3 presigned
 * POST via `@aws-sdk/s3-presigned-post`; this module never touches AWS.
 *
 * Security posture (AR-SEC review surface — keep these properties intact):
 *  - PREFIX-CONFINED: the grant is for ONE exact key,
 *    `pending/{tenantId}/{sessionId}` — always under the `pending/` staging
 *    prefix, never `cas/` (the CDN-served prefix), never a `starts-with`
 *    wildcard. Key parts are validated by the cas-keys anchored allowlists.
 *  - BYTE-RAILED: the plan always carries `content-length-range`
 *    [1, maxBytes] with maxBytes sourced from Env.media.maxBytes (SSM-fed;
 *    never a literal here — this file ships in the public tarball).
 *  - TYPE-PINNED: Content-Type is an exact-match condition on the normalized
 *    declared MIME type, which must pass BOTH the operator allowlist
 *    (Env.media.allowlist) AND routeUpload's async-pending routing (video/
 *    audio only — images keep the proxied sync path).
 *  - SHORT-LIVED: expiry is clamped to [MIN_EXPIRY, MAX_EXPIRY] seconds.
 *
 * Fail-closed: every uncertainty returns a typed refusal, never a grant.
 * Pure and total: no I/O, no clock, no exceptions.
 */

import { pendingKey, isCasKeyError } from "./cas-keys.js";
import { routeUpload } from "./route-upload.js";

/** Hard clamp bounds for the grant expiry (seconds). Structural bounds on a
 * security property (like MAX_KEYS_PER_BATCH in staging-object-cleanup), not
 * an operational threshold — the operative value arrives via env. */
export const MIN_PRESIGN_EXPIRY_SECONDS = 60;
export const MAX_PRESIGN_EXPIRY_SECONDS = 3600;

/** Everything the planner needs. All values arrive from the shell (session
 * row + Env.media); none are read from process.env here. */
export interface PresignPlanInput {
  /** Owning tenant (validated cuid — becomes the key's first segment). */
  readonly tenantId: string;
  /** The UploadSession id (cuid — becomes uploadId + the key's last segment). */
  readonly sessionId: string;
  /** Client-declared MIME type of the object to be uploaded. */
  readonly declaredMimeType: string;
  /** Client-declared object size in bytes. */
  readonly declaredBytes: number;
  /** The byte cap for this media class (Env.media.maxBytes.video/audio). */
  readonly maxBytes: number;
  /** Operator MIME allowlist for this media class (Env.media.allowlist). */
  readonly allowlist: readonly string[];
  /** Grant lifetime in seconds (Env.media.presignExpirySeconds). */
  readonly expirySeconds: number;
}

/** A refused plan. The `reason` is safe to surface to the client. */
export type PresignRefusal = {
  readonly ok: false;
  readonly reason:
    | "unsupported-type" // not video/audio, or not in the operator allowlist
    | "invalid-declared-bytes" // not a positive finite integer
    | "declared-bytes-over-cap" // declared size exceeds the byte cap
    | "invalid-key-inputs" // tenantId/sessionId failed the anchored allowlists
    | "invalid-cap"; // maxBytes not a positive finite integer (misconfig)
};

/** An approved plan — everything the shell needs to sign the POST policy. */
export type PresignPlan = {
  readonly ok: true;
  /** The exact staging object key: pending/{tenantId}/{sessionId}. */
  readonly key: string;
  /** The normalized MIME type pinned as an exact Content-Type condition. */
  readonly contentType: string;
  /** The content-length-range condition: [min, max] inclusive bytes. */
  readonly contentLengthRange: { readonly min: number; readonly max: number };
  /** Clamped grant lifetime in seconds. */
  readonly expirySeconds: number;
};

export type PresignPlanResult = PresignPlan | PresignRefusal;

/** Normalize a MIME type: strip parameters, trim, lowercase. Mirrors
 * routeUpload's normalization so both gates see the same value. */
export function normalizeMimeType(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  return raw.split(";")[0].trim().toLowerCase();
}

/**
 * Plan a presigned upload grant. See module doc for the security posture.
 */
export function planPresignedUpload(
  input: PresignPlanInput,
): PresignPlanResult {
  // --- Type gate: async-pending (video/audio) AND operator-allowlisted. ---
  const mime = normalizeMimeType(input.declaredMimeType);
  const route = routeUpload(mime);
  if (route.kind !== "async-pending") {
    // Images (sync path) and everything unknown refuse here — fail-closed.
    return { ok: false, reason: "unsupported-type" };
  }
  const allowlisted = input.allowlist.some(
    (t) => normalizeMimeType(t) === mime,
  );
  if (!allowlisted) {
    return { ok: false, reason: "unsupported-type" };
  }

  // --- Byte rail: cap must be sane; declared size must be a positive ---
  // integer within the cap. (The cap itself is the enforced maximum; the
  // declared size is a client honesty check, cheap to verify here.)
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1
  ) {
    return { ok: false, reason: "invalid-cap" };
  }
  if (
    !Number.isSafeInteger(input.declaredBytes) ||
    input.declaredBytes < 1
  ) {
    return { ok: false, reason: "invalid-declared-bytes" };
  }
  if (input.declaredBytes > input.maxBytes) {
    return { ok: false, reason: "declared-bytes-over-cap" };
  }

  // --- Exact key, confined to pending/ via the anchored allowlists. ---
  const key = pendingKey(input.tenantId, input.sessionId);
  if (isCasKeyError(key)) {
    return { ok: false, reason: "invalid-key-inputs" };
  }

  // --- Expiry clamp. A non-finite/absurd env value degrades to the minimum ---
  // (shortest-lived grant), never to "no expiry".
  const rawExpiry = input.expirySeconds;
  const expirySeconds = Number.isFinite(rawExpiry)
    ? Math.min(
        Math.max(Math.trunc(rawExpiry), MIN_PRESIGN_EXPIRY_SECONDS),
        MAX_PRESIGN_EXPIRY_SECONDS,
      )
    : MIN_PRESIGN_EXPIRY_SECONDS;

  return {
    ok: true,
    key,
    contentType: mime,
    contentLengthRange: { min: 1, max: input.maxBytes },
    expirySeconds,
  };
}
