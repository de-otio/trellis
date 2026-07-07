/**
 * Generic authenticated field encryption for PII stored at rest (e.g. an email
 * address on `EmailSubscription`). Modeled on the OAuth `envelope-crypto.ts`
 * pattern but keyed by a single KEK rather than a per-request device_code:
 *
 *   1. A per-record data-encryption key (DEK) is derived via HKDF-SHA256 from
 *      the KEK (the secret) and a random per-record salt. One KEK compromise
 *      still forces the attacker through per-record derivation; rotating the
 *      KEK is a `keyVersion` bump, not a flag-day re-encrypt.
 *   2. The DEK encrypts the plaintext with AES-256-GCM (authenticated).
 *   3. The stored string is compact and self-describing:
 *        "v{keyVersion}:{salt}.{iv}.{tag}.{ciphertext}"   (each component base64url)
 *
 * The KEK is passed IN as a 32-byte Buffer — this module never reads env and has
 * NO fallback (a caller that cannot supply a key gets an exception, never a
 * silent downgrade to some ambient secret). Algorithms are pinned; a tampered or
 * wrong-key ciphertext throws on the GCM auth-tag check rather than returning
 * truncated plaintext.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** HKDF info string for the field DEK. Versioned so changes are detectable. */
const FIELD_DEK_INFO = "trellis-field-enc-dek-v1";
/** Current key version stamped into the serialized ciphertext. */
export const FIELD_ENC_VERSION = 1;

const DEK_LEN = 32; // AES-256
const SALT_LEN = 32;
const IV_LEN = 12; // 96-bit GCM nonce (NIST-recommended)
const TAG_LEN = 16; // 128-bit GCM tag

function b64url(b: Buffer): string {
  return b.toString("base64url");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/**
 * Assert the KEK is exactly 32 bytes. Throwing here (rather than padding or
 * hashing an arbitrary-length secret) forces callers to provision a real
 * 256-bit key instead of, say, reusing a short session secret.
 */
export function assertKek(kek: Buffer): void {
  if (!Buffer.isBuffer(kek) || kek.length !== 32) {
    throw new Error("field-encryption: KEK must be a 32-byte Buffer");
  }
}

function deriveFieldDek(kek: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", kek, salt, FIELD_DEK_INFO, DEK_LEN));
}

/** Encrypt `plaintext` under a per-record DEK derived from `kek`. */
export function encryptField(plaintext: string, kek: Buffer): string {
  assertKek(kek);
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const dek = deriveFieldDek(kek, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", dek, iv, {
      authTagLength: TAG_LEN,
    });
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v${FIELD_ENC_VERSION}:${b64url(salt)}.${b64url(iv)}.${b64url(tag)}.${b64url(ct)}`;
  } finally {
    dek.fill(0);
  }
}

/**
 * Decrypt a string produced by `encryptField`. Throws on a malformed value, an
 * unknown key version, a bad component length, or an auth-tag mismatch (wrong
 * key or tampered ciphertext) — never returns partial plaintext.
 */
/** Generous upper bound on a serialized field ciphertext, to reject junk early. */
const MAX_ENC_LEN = 8192;

export function decryptField(enc: string, kek: Buffer): string {
  assertKek(kek);
  if (typeof enc !== "string" || enc.length > MAX_ENC_LEN) {
    throw new Error("field-encryption: malformed ciphertext");
  }
  const m = /^v(\d+):([^.]+)\.([^.]+)\.([^.]+)\.([^.]+)$/.exec(enc);
  if (!m) throw new Error("field-encryption: malformed ciphertext");
  // Exact-string version match rejects non-canonical aliases (v01, v001) (L2).
  if (m[1] !== String(FIELD_ENC_VERSION)) {
    throw new Error(`field-encryption: unsupported keyVersion ${m[1]}`);
  }
  const salt = fromB64url(m[2]);
  const iv = fromB64url(m[3]);
  const tag = fromB64url(m[4]);
  const ct = fromB64url(m[5]);
  if (salt.length !== SALT_LEN || iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error("field-encryption: bad component length");
  }
  const dek = deriveFieldDek(kek, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, iv, {
      authTagLength: TAG_LEN,
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Keyed-HMAC primitives (used for lookup hashes and capability tokens). Kept
// here so all field crypto lives in one reviewed module.
// ---------------------------------------------------------------------------

/**
 * Derive a purpose-specific sub-key from a master secret via HKDF, so a single
 * provisioned secret can safely back multiple HMAC uses (token signing vs.
 * lookup hashing) with cryptographic domain separation.
 */
export function deriveSubKey(masterSecret: string, info: string): Buffer {
  // Strength floor, symmetric with the 32-byte KEK assertion: refuse to derive
  // token/hash sub-keys from a short, guessable secret (M1). 32 chars of a
  // high-entropy secret is the minimum we accept for the HMAC master.
  if (!masterSecret || masterSecret.length < 32) {
    throw new Error("field-encryption: master secret must be at least 32 characters");
  }
  return Buffer.from(hkdfSync("sha256", masterSecret, Buffer.alloc(0), info, 32));
}

/** HMAC-SHA256 of `data` under `key`, hex-encoded. */
export function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/** Constant-time string compare (equal-length-safe). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
