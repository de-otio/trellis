// T8 — token at-rest helpers (see push-device-contract.md §1).
//
// The raw platform token is stored AES-GCM encrypted using the EXISTING
// at-rest pattern (mfa/totp-service.ts encryptSecret/decryptSecret, keyed off
// SESSION_SECRET). Because AES-GCM ciphertext is non-deterministic (random
// IV), the dedupe/upsert key is a separate deterministic SHA-256 hex hash of
// the raw token.

export { encryptSecret, decryptSecret } from "../mfa/totp-service.js";

/** Deterministic SHA-256 hex of a raw device token — the dedupe/upsert key. */
export async function hashDeviceToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
