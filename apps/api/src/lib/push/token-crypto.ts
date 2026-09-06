// T8 — token at-rest helpers (see push-device-contract.md §1).
//
// The raw platform token is stored AES-GCM encrypted via `lib/at-rest-secret.ts`
// under the "push" keyring: `PUSH_TOKEN_ENC_KEY` when provisioned, else a key
// HKDF-derived from SESSION_SECRET with a push-specific label (never the raw
// session secret — DP-3). Rows written by the previous raw-key wrap are still
// readable and are re-sealed on their next successful open. Because the
// ciphertext is non-deterministic (random IV), the dedupe/upsert key is a
// separate deterministic SHA-256 hex hash of the raw token.

export {
  needsReseal,
  openSecret,
  resolveKeyring,
  sealSecret,
  type Keyring,
} from "../at-rest-secret.js";

/**
 * @deprecated LEGACY raw-key wrap, re-exported so tests can produce rows in
 * the pre-DP-3 format. Nothing in the API writes it any more.
 */
export { encryptSecret, decryptSecret } from "../mfa/totp-service.js";

/** Deterministic SHA-256 hex of a raw device token — the dedupe/upsert key. */
export async function hashDeviceToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
