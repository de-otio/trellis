/**
 * Capability tokens and lookup hashing for anonymous email subscriptions.
 *
 * Both the confirm/unsubscribe tokens and the email lookup hash are HMAC-SHA256
 * under purpose-separated sub-keys derived (HKDF) from a single provisioned
 * `EMAIL_SUB_HMAC_SECRET`. Deriving sub-keys means the token signer and the
 * lookup hasher never share the same effective key, from one operator secret.
 *
 * Security properties (see plan §10 SEC-2/SEC-4/SEC-8):
 *   - The `action` string is bound INTO the signed payload, so a "confirm"
 *     token cannot be replayed at the unsubscribe endpoint or vice versa.
 *   - A random per-subscription `nonce` is bound in too; the caller checks it
 *     against the row's current `tokenNonce`, so rotating the nonce single-uses
 *     an outstanding token.
 *   - Verification is constant-time and returns a single boolean shape — the
 *     handler maps every failure to one generic response (no existence oracle).
 *
 * Pure module: no env, no DB, no I/O. The master secret is passed in; a caller
 * that lacks it gets an exception, never a fallback to some ambient secret.
 */

import { deriveSubKey, hmacHex, safeEqual } from "./field-encryption.js";

export type EmailSubscriptionAction = "confirm" | "unsubscribe";

/** Current hash version prefix — lets the HMAC secret rotate later. */
export const EMAIL_HASH_VERSION = 1;

const TOKEN_SUBKEY_INFO = "trellis-email-sub-token-v1";
const HASH_SUBKEY_INFO = "trellis-email-sub-hash-v1";

/** RFC-5321-generous cap; reject absurd inputs before HMACing them (L3). */
export const MAX_EMAIL_LEN = 320;
/** Generous cap on a capability token; anything longer is not one of ours. */
export const MAX_TOKEN_LEN = 4096;

/** Normalize an email for hashing/dedupe: trim + lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Keyed, versioned lookup hash of an email. Deterministic for a given secret,
 * so it dedupes and supports "already subscribed?" without storing plaintext.
 * Returns `"v{n}:{hex}"`.
 */
export function hashEmail(email: string, masterSecret: string): string {
  const normalized = normalizeEmail(email);
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LEN) {
    throw new Error("email-subscription-token: email length out of range");
  }
  const key = deriveSubKey(masterSecret, HASH_SUBKEY_INFO);
  return `v${EMAIL_HASH_VERSION}:${hmacHex(key, normalized)}`;
}

interface TokenFields {
  action: EmailSubscriptionAction;
  subId: string;
  nonce: string;
  /** Absolute expiry, unix seconds. */
  exp: number;
}

function canonical(f: TokenFields): string {
  // base64url of a fixed-order payload; action is first and always present so
  // it is inseparable from the signature.
  const payload = JSON.stringify({
    a: f.action,
    s: f.subId,
    n: f.nonce,
    e: f.exp,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/** Produce a signed capability token `"{payloadB64}.{sigHex}"`. */
export function signToken(fields: TokenFields, masterSecret: string): string {
  const key = deriveSubKey(masterSecret, TOKEN_SUBKEY_INFO);
  const payloadB64 = canonical(fields);
  const sig = hmacHex(key, payloadB64);
  return `${payloadB64}.${sig}`;
}

export type VerifyResult =
  { valid: true; subId: string; nonce: string; exp: number } | { valid: false };

/**
 * Verify a token for a specific expected `action`. Checks (constant-time) the
 * signature, that the embedded action matches, and that it has not expired.
 * Returns the embedded `subId`/`nonce` so the caller can load the row and
 * confirm the nonce is still current (single-use). Any structural problem,
 * signature mismatch, wrong action, or expiry yields `{ valid: false }` — the
 * caller must render an identical response for all of them.
 *
 * `now` (unix seconds) is injectable for deterministic tests.
 */
export function verifyToken(
  token: string,
  opts: {
    expectedAction: EmailSubscriptionAction;
    masterSecret: string;
    now?: number;
  },
): VerifyResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof token !== "string" || token.length > MAX_TOKEN_LEN) {
    return { valid: false };
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { valid: false };
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const key = deriveSubKey(opts.masterSecret, TOKEN_SUBKEY_INFO);
  const expectedSig = hmacHex(key, payloadB64);
  if (!safeEqual(sig, expectedSig)) return { valid: false };

  let parsed: { a?: unknown; s?: unknown; n?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { valid: false };
  }
  if (
    parsed.a !== opts.expectedAction ||
    typeof parsed.s !== "string" ||
    typeof parsed.n !== "string" ||
    typeof parsed.e !== "number"
  ) {
    return { valid: false };
  }
  if (parsed.e <= now) return { valid: false };
  return { valid: true, subId: parsed.s, nonce: parsed.n, exp: parsed.e };
}
