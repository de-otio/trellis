/**
 * ActivityPub Cryptographic Key Management
 *
 * Handles RSA key pair generation and encryption for ActivityPub actors.
 * Private keys are encrypted at rest.
 *
 * ## What changed and why (F7)
 *
 * The KEK was `SHA-256(ACTIVITYPUB_KEY_ENCRYPTION_KEY)`, falling back to
 * `SHA-256(SESSION_SECRET)`. Three problems, in order of seriousness:
 *
 *   1. **Secret reuse.** Falling back to `SESSION_SECRET` meant the key that
 *      signs sessions also wrapped every actor's federation private key. One
 *      secret, two unrelated trust domains: disclosure of the session secret
 *      (or a rotation of it) reached straight into federation identity. There
 *      is now NO fallback — a caller that cannot supply a real key gets an
 *      exception, never a silent downgrade to some ambient secret.
 *   2. **No domain separation and no salt.** A bare SHA-256 of a passphrase is
 *      not a KDF. Derivation is now HKDF-SHA256 with a distinct `info` label
 *      and a random per-record salt, so two records never share a DEK and the
 *      label prevents the same secret deriving the same key for another use.
 *   3. **No version tag.** Rotating the KEK meant a flag-day re-encrypt with
 *      no way to tell old ciphertext from new. The serialized form now carries
 *      a version.
 *
 * This mirrors `field-encryption.ts`, which the security review names as the
 * reference implementation in this repo: 32-byte KEK assertion, HKDF per-record
 * DEK, random salt + IV, pinned algorithms, exact component-length checks, DEK
 * zeroization.
 *
 * ## Migration
 *
 * `decryptPrivateKey` still reads the LEGACY format (a JSON blob of
 * `{iv, authTag, encrypted}`) when a legacy KEK is available, so existing
 * wrapped keys keep working across the deploy. `needsRewrap()` reports whether
 * a stored value is legacy, and `rewrapPrivateKey()` converts one to the
 * current format. Run the backfill, then set
 * `ACTIVITYPUB_LEGACY_KEY_DECRYPT=false` to close the legacy read path.
 */

import * as crypto from "crypto";
import type { Env } from "../../env.js";

/** HKDF info label for the actor-key DEK. Versioned so changes are detectable. */
const AP_DEK_INFO = "trellis-activitypub-actorkey-dek-v1";

/** Current key version stamped into the serialized ciphertext. */
export const AP_KEY_ENC_VERSION = 1;

const DEK_LEN = 32; // AES-256
const SALT_LEN = 32;
const IV_LEN = 12; // 96-bit GCM nonce (NIST-recommended)
const TAG_LEN = 16; // 128-bit GCM tag

/** Generous upper bound on a serialized wrapped key, to reject junk early. */
const MAX_ENC_LEN = 16384;

function b64url(b: Buffer): string {
  return b.toString("base64url");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/**
 * Service for managing cryptographic keys for ActivityPub actors
 */
export class KeyPairService {
  /**
   * Generate RSA key pair for ActivityPub actor
   * Uses 2048-bit keys as per ActivityPub best practices
   */
  static generateKeyPair(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: "spki",
        format: "pem",
      },
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
      },
    });

    return { publicKey, privateKey };
  }

  /**
   * Encrypt a private key for storage.
   *
   * Format: `v{version}:{salt}.{iv}.{tag}.{ciphertext}` (each component
   * base64url) — compact and self-describing, same shape as
   * `field-encryption.ts`.
   *
   * @param privateKey - Private key in PEM format
   * @param env - Environment carrying ACTIVITYPUB_KEY_ENCRYPTION_KEY
   * @returns Serialized wrapped key
   */
  static encryptPrivateKey(privateKey: string, env: Env): string {
    const kek = this.getEncryptionKey(env);
    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const dek = this.deriveDek(kek, salt);
    try {
      const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv, {
        authTagLength: TAG_LEN,
      });
      const ct = Buffer.concat([
        cipher.update(privateKey, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return `v${AP_KEY_ENC_VERSION}:${b64url(salt)}.${b64url(iv)}.${b64url(tag)}.${b64url(ct)}`;
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Decrypt a stored private key.
   *
   * Accepts the current versioned format and, while migration is in flight,
   * the legacy JSON format. Throws on a malformed value, an unknown version, a
   * bad component length, or an auth-tag mismatch — never returns partial
   * plaintext.
   *
   * @param encryptedKey - Stored wrapped key
   * @param env - Environment carrying the encryption key(s)
   * @returns Decrypted private key in PEM format
   */
  static decryptPrivateKey(encryptedKey: string, env: Env): string {
    if (typeof encryptedKey !== "string" || encryptedKey.length > MAX_ENC_LEN) {
      throw new Error("activitypub-crypto: malformed wrapped key");
    }

    if (this.isLegacyFormat(encryptedKey)) {
      return this.decryptLegacy(encryptedKey, env);
    }

    const m = /^v(\d+):([^.]+)\.([^.]+)\.([^.]+)\.([^.]+)$/.exec(encryptedKey);
    if (!m) throw new Error("activitypub-crypto: malformed wrapped key");
    // Exact-string version match rejects non-canonical aliases (v01, v001).
    if (m[1] !== String(AP_KEY_ENC_VERSION)) {
      throw new Error(`activitypub-crypto: unsupported keyVersion ${m[1]}`);
    }

    const salt = fromB64url(m[2]);
    const iv = fromB64url(m[3]);
    const tag = fromB64url(m[4]);
    const ct = fromB64url(m[5]);
    if (
      salt.length !== SALT_LEN ||
      iv.length !== IV_LEN ||
      tag.length !== TAG_LEN
    ) {
      throw new Error("activitypub-crypto: bad component length");
    }

    const dek = this.deriveDek(this.getEncryptionKey(env), salt);
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", dek, iv, {
        authTagLength: TAG_LEN,
      });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
        "utf8",
      );
    } finally {
      dek.fill(0);
    }
  }

  /**
   * True when a stored value is in the legacy format and should be rewrapped.
   *
   * @param encryptedKey - Stored wrapped key
   */
  static needsRewrap(encryptedKey: string): boolean {
    return this.isLegacyFormat(encryptedKey);
  }

  /**
   * Convert one legacy-wrapped key to the current format.
   *
   * Migration step: read with the legacy KEK, write with the new one. Returns
   * the value unchanged when it is already current, so a backfill can run
   * idempotently.
   *
   * @param encryptedKey - Stored wrapped key
   * @param env - Environment carrying both keys during migration
   * @returns The key wrapped in the current format
   */
  static rewrapPrivateKey(encryptedKey: string, env: Env): string {
    if (!this.needsRewrap(encryptedKey)) return encryptedKey;
    const plaintext = this.decryptLegacy(encryptedKey, env);
    try {
      return this.encryptPrivateKey(plaintext, env);
    } finally {
      // Best effort: the string itself is immutable, but do not keep a
      // reference alive any longer than needed.
    }
  }

  /** HKDF-SHA256 per-record DEK. */
  private static deriveDek(kek: Buffer, salt: Buffer): Buffer {
    return Buffer.from(
      crypto.hkdfSync("sha256", kek, salt, AP_DEK_INFO, DEK_LEN),
    );
  }

  /** Legacy values are a JSON object, so they start with `{`. */
  private static isLegacyFormat(value: string): boolean {
    return value.trimStart().startsWith("{");
  }

  /**
   * Read a legacy `{iv, authTag, encrypted}` blob wrapped under
   * `SHA-256(secret)`.
   *
   * Gated on `ACTIVITYPUB_LEGACY_KEY_DECRYPT` so the path can be closed once
   * the backfill has run. Defaults to enabled: turning it off before the
   * backfill completes would lock actors out of their own keys.
   */
  private static decryptLegacy(encryptedKey: string, env: Env): string {
    if ((env as any).ACTIVITYPUB_LEGACY_KEY_DECRYPT === "false") {
      throw new Error(
        "activitypub-crypto: legacy wrapped key found but the legacy read path is disabled — run the rewrap backfill before setting ACTIVITYPUB_LEGACY_KEY_DECRYPT=false",
      );
    }

    const legacyKek = this.getLegacyEncryptionKey(env);

    let combined: { iv?: string; authTag?: string; encrypted?: string };
    try {
      combined = JSON.parse(encryptedKey);
    } catch {
      throw new Error("activitypub-crypto: malformed legacy wrapped key");
    }
    if (!combined.iv || !combined.authTag || !combined.encrypted) {
      throw new Error("activitypub-crypto: malformed legacy wrapped key");
    }

    const iv = Buffer.from(combined.iv, "base64");
    const authTag = Buffer.from(combined.authTag, "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", legacyKek, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(combined.encrypted, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  /**
   * Resolve the 32-byte KEK.
   *
   * REQUIRES a dedicated `ACTIVITYPUB_KEY_ENCRYPTION_KEY`, and asserts it is
   * genuinely 256 bits of key material (64 hex chars, or base64/base64url
   * decoding to 32 bytes). There is deliberately NO `SESSION_SECRET` fallback
   * and no "hash whatever you gave me into 32 bytes" convenience: both let a
   * short or reused secret masquerade as a real key, which is exactly the
   * finding.
   */
  private static getEncryptionKey(env: Env): Buffer {
    const raw = (env as any).ACTIVITYPUB_KEY_ENCRYPTION_KEY;
    if (!raw || typeof raw !== "string") {
      throw new Error(
        "activitypub-crypto: ACTIVITYPUB_KEY_ENCRYPTION_KEY is required (32 bytes, hex or base64). There is no SESSION_SECRET fallback — federation keys must not share the session secret.",
      );
    }

    const decoded = decodeKeyMaterial(raw);
    if (!decoded || decoded.length !== 32) {
      throw new Error(
        "activitypub-crypto: ACTIVITYPUB_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars, or base64/base64url of 32 bytes)",
      );
    }
    return decoded;
  }

  /**
   * The KEK that legacy ciphertext was written under: `SHA-256(secret)`, with
   * the old `ACTIVITYPUB_KEY_ENCRYPTION_KEY`-then-`SESSION_SECRET` preference.
   *
   * This exists ONLY to read old records during migration. It is never used to
   * write.
   */
  private static getLegacyEncryptionKey(env: Env): Buffer {
    const explicit = (env as any).ACTIVITYPUB_LEGACY_KEY_ENCRYPTION_KEY;
    if (explicit && typeof explicit === "string") {
      return crypto.createHash("sha256").update(explicit).digest();
    }

    const activityPubKey = (env as any).ACTIVITYPUB_KEY_ENCRYPTION_KEY;
    if (activityPubKey && typeof activityPubKey === "string") {
      return crypto.createHash("sha256").update(activityPubKey).digest();
    }

    const sessionSecret = env.SESSION_SECRET;
    if (!sessionSecret) {
      throw new Error(
        "activitypub-crypto: cannot read legacy wrapped key — set ACTIVITYPUB_LEGACY_KEY_ENCRYPTION_KEY to the secret it was written under",
      );
    }
    return crypto.createHash("sha256").update(sessionSecret).digest();
  }
}

/**
 * Decode key material supplied as hex, base64 or base64url.
 *
 * Returns null when the string is not a recognisable encoding. Note we do NOT
 * fall back to treating the raw UTF-8 bytes as the key: a 32-character
 * passphrase is not 32 bytes of entropy, and silently accepting one is the
 * weakness this replaces.
 */
function decodeKeyMaterial(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  if (/^[A-Za-z0-9+/]{43}=?$/.test(trimmed)) {
    return Buffer.from(trimmed, "base64");
  }
  if (/^[A-Za-z0-9\-_]{43}$/.test(trimmed)) {
    return Buffer.from(trimmed, "base64url");
  }
  return null;
}
