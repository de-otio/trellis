/**
 * Envelope encryption helpers for OAuth device-authorization records.
 *
 * Pattern:
 *   1. A per-record data-encryption key (DEK) is derived via HKDF-SHA256
 *      from the device_code (held only by the polling agent) and a
 *      KMS-protected wrap key (KEK).
 *   2. The DEK encrypts the payload (Cognito tokens) with AES-256-GCM.
 *   3. The DynamoDB row stores only iv, auth tag, ciphertext, and the
 *      KMS-wrapped KEK reference. A direct GetItem without device_code
 *      cannot derive the DEK and therefore cannot decrypt.
 *
 * The KEK in the MVP path is a 32-byte key fetched from a static SSM
 * parameter / env var; production wraps that fetch in KMS:Decrypt so the
 * key never leaves a memory-only buffer. The DEK derivation salt is
 * random per-record and stored alongside the ciphertext — without
 * device_code the salt + KEK alone are insufficient.
 *
 * Algorithms are pinned. Unit tests assert that swapping device_code at
 * decrypt time fails with an authentication error rather than returning
 * silently truncated plaintext.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** HKDF info string. Versioned so future schema changes are detectable. */
export const DEK_INFO = "trellis-device-auth-dek-v1";

/** Length of the AES-256 DEK in bytes. */
const DEK_LEN = 32;
/** Length of the HKDF salt stored alongside the ciphertext. */
const SALT_LEN = 32;
/** AES-GCM IV length (96 bits is the recommended NIST size). */
const IV_LEN = 12;
/** AES-GCM authentication tag length (16 bytes / 128 bits). */
const TAG_LEN = 16;

export interface SealedEnvelope {
  /** Random per-record HKDF salt, base64url. */
  salt: string;
  /** AES-GCM IV, base64url. */
  iv: string;
  /** AES-GCM authentication tag, base64url. */
  tag: string;
  /** AES-GCM ciphertext, base64url. */
  ciphertext: string;
  /** Algorithm tag — pinned for forward compatibility. */
  alg: "AES-256-GCM+HKDF-SHA256";
  /** Info string used in HKDF; lets us rotate without re-keying. */
  info: string;
  /**
   * KEK version (G4 MEDIUM-1). Forward-compatible field that lets us
   * rotate the wrap key without re-encrypting every record. MVP path
   * writes 1 and `open()` only knows how to dispatch the version-1
   * fetcher; future rotations register additional fetchers via
   * `setKmsKekFetcherForVersion()` and bump the value written by `seal`.
   */
  keyVersion: number;
}

/** Current KEK version written by `seal`. */
export const CURRENT_KEK_VERSION = 1;

function b64url(b: Buffer): string {
  return b.toString("base64url");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/**
 * Derive the per-record DEK from `(deviceCode, kek, salt)` via HKDF-SHA256.
 * The device_code is the IKM; the KEK is mixed in as part of the salt so a
 * stolen DynamoDB row alone cannot derive the DEK.
 */
export function deriveDek(
  deviceCode: string,
  kek: Buffer,
  salt: Buffer,
): Buffer {
  if (!deviceCode || deviceCode.length < 16) {
    throw new Error("device_code too short");
  }
  if (kek.length !== 32) {
    throw new Error("KEK must be 32 bytes");
  }
  if (salt.length !== SALT_LEN) {
    throw new Error(`salt must be ${SALT_LEN} bytes`);
  }
  // HKDF: ikm = device_code; salt = (kek || salt); info = DEK_INFO.
  // Mixing KEK into the salt means the DEK depends on both pieces.
  const combinedSalt = Buffer.concat([kek, salt]);
  const dek = hkdfSync("sha256", deviceCode, combinedSalt, DEK_INFO, DEK_LEN);
  return Buffer.from(dek);
}

/**
 * Seal `plaintext` (UTF-8 string) under a DEK derived from `(deviceCode, kek)`.
 * Returns the storable envelope; ciphertext + iv + tag are sufficient for
 * decryption only when device_code is supplied at open time.
 */
export function seal(
  plaintext: string,
  deviceCode: string,
  kek: Buffer,
): SealedEnvelope {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const dek = deriveDek(deviceCode, kek, salt);

  const cipher = createCipheriv("aes-256-gcm", dek, iv, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Wipe the DEK from our reference. (V8 doesn't guarantee wipe, but at
  // least we don't keep a reachable reference past the call.)
  dek.fill(0);

  return {
    salt: b64url(salt),
    iv: b64url(iv),
    tag: b64url(tag),
    ciphertext: b64url(ct),
    alg: "AES-256-GCM+HKDF-SHA256",
    info: DEK_INFO,
    keyVersion: CURRENT_KEK_VERSION,
  };
}

/**
 * Open an envelope produced by `seal`. Returns the plaintext UTF-8 string.
 * Throws on auth-tag mismatch (wrong device_code, tampered payload).
 *
 * The supplied `kek` parameter is the version-1 KEK. For envelopes
 * stamped with a different `keyVersion`, callers should resolve the
 * matching KEK before invoking this function (see `resolveKekForVersion`).
 * The MVP runs version 1 only; this signature stays compatible for
 * forward-rotation scenarios (G4 MEDIUM-1).
 */
export function open(
  envelope: SealedEnvelope,
  deviceCode: string,
  kek: Buffer,
): string {
  if (envelope.alg !== "AES-256-GCM+HKDF-SHA256") {
    throw new Error(`unsupported envelope alg: ${envelope.alg}`);
  }
  if (envelope.info !== DEK_INFO) {
    throw new Error(`unsupported envelope info: ${envelope.info}`);
  }
  // Reject envelopes from versions we don't yet know how to dispatch.
  // Older envelopes without keyVersion default to version 1 for
  // backward compatibility with rows already written under the old
  // shape — those still decrypt with the version-1 KEK.
  const declaredVersion = envelope.keyVersion ?? 1;
  if (declaredVersion !== 1) {
    throw new Error(`unsupported envelope keyVersion: ${declaredVersion}`);
  }

  const salt = fromB64url(envelope.salt);
  const iv = fromB64url(envelope.iv);
  const tag = fromB64url(envelope.tag);
  const ct = fromB64url(envelope.ciphertext);

  if (salt.length !== SALT_LEN) throw new Error("envelope salt length");
  if (iv.length !== IV_LEN) throw new Error("envelope iv length");
  if (tag.length !== TAG_LEN) throw new Error("envelope tag length");

  const dek = deriveDek(deviceCode, kek, salt);
  const decipher = createDecipheriv("aes-256-gcm", dek, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  let pt: Buffer;
  try {
    pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  } finally {
    dek.fill(0);
  }
  return pt.toString("utf8");
}

/**
 * Resolve the KEK for a given envelope version. The MVP path is a
 * single-version trampoline; future rotations register additional
 * fetchers and dispatch on `version`. Callers reading a previously
 * sealed envelope should call this rather than `resolveKek()` directly
 * (G4 MEDIUM-1).
 */
export async function resolveKekForVersion(version: number): Promise<Buffer> {
  if (version !== 1) {
    throw new Error(`unsupported envelope keyVersion: ${version}`);
  }
  return resolveKek();
}

/**
 * Constant-time compare for two strings expected to be of the same length.
 * Used by callers that need to compare device_code candidates against a
 * stored hash (we don't store the device_code itself, so this is reserved
 * for refresh-jti comparisons).
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve the KEK at runtime. Two paths:
 *   1. process.env.DEVICE_AUTH_KEK_BASE64 — local dev / test fast path.
 *   2. KMS:GenerateDataKey via DEVICE_AUTH_KMS_KEY_ID. Production path.
 *
 * The result is cached for the lifetime of the process. Callers must
 * NOT log the buffer.
 */
let cachedKek: Buffer | undefined;

/**
 * Hook for tests + production wiring. Defaults to a stub that throws,
 * directing callers to install `@aws-sdk/client-kms` and override via
 * `setKmsKekFetcher`. The trellis CDK wires the AWS-SDK-backed fetcher
 * during process bootstrap.
 */
export type KmsKekFetcher = (kmsKeyId: string, region: string) => Promise<Buffer>;

let kmsKekFetcher: KmsKekFetcher = async () => {
  throw new Error(
    "KMS KEK fetcher not configured; call setKmsKekFetcher() at startup or set DEVICE_AUTH_KEK_BASE64",
  );
};

/** Wire the production KMS path. Trellis CDK calls this during bootstrap. */
export function setKmsKekFetcher(fn: KmsKekFetcher): void {
  kmsKekFetcher = fn;
}

export async function resolveKek(): Promise<Buffer> {
  if (cachedKek) return cachedKek;

  const inline = process.env.DEVICE_AUTH_KEK_BASE64;
  if (inline) {
    const b = Buffer.from(inline, "base64");
    if (b.length !== 32) {
      throw new Error("DEVICE_AUTH_KEK_BASE64 must decode to 32 bytes");
    }
    cachedKek = b;
    return cachedKek;
  }

  const kmsKeyId = process.env.DEVICE_AUTH_KMS_KEY_ID;
  if (!kmsKeyId) {
    throw new Error(
      "Device-auth KEK not configured: set DEVICE_AUTH_KEK_BASE64 (dev) or DEVICE_AUTH_KMS_KEY_ID (prod)",
    );
  }

  const region = process.env.AWS_REGION || "us-east-1";
  const plain = await kmsKekFetcher(kmsKeyId, region);
  if (plain.length !== 32) {
    throw new Error("KMS plaintext key wrong length");
  }
  cachedKek = plain;
  return cachedKek;
}

/** Reset the cached KEK. Test-only. */
export function _resetKekCacheForTest(): void {
  cachedKek = undefined;
}

/** Reset the KMS fetcher to its default (test-only). */
export function _resetKmsKekFetcherForTest(): void {
  kmsKekFetcher = async () => {
    throw new Error(
      "KMS KEK fetcher not configured; call setKmsKekFetcher() at startup or set DEVICE_AUTH_KEK_BASE64",
    );
  };
}
