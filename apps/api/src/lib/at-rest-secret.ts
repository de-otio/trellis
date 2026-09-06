/**
 * At-rest wrapping for small per-user secrets (TOTP seeds, push device tokens).
 *
 * ## What this replaces (DP-3)
 *
 * `mfa/totp-service.ts` built its AES-GCM key from the first 32 *characters*
 * of `SESSION_SECRET` (`padEnd(32, "0").slice(0, 32)` as UTF-8 bytes) and
 * `push/token-crypto.ts` re-exported it. Three problems:
 *
 *   1. **Secret reuse.** The key that seals session cookies also wrapped every
 *      MFA seed and every push token — one secret, three trust domains.
 *   2. **No KDF.** Characters are not bytes: a hex or base64 session secret
 *      yields 4–6 bits per character, so a "256-bit" AES key carried
 *      128–192 bits of entropy.
 *   3. **No rotation path.** Nothing tagged the ciphertext and nothing read
 *      `SESSION_SECRET_FALLBACK`, so rotating the session secret locked every
 *      MFA user out (decrypt throws) and orphaned every push registration.
 *
 * ## What this does
 *
 * A {@link Keyring} is resolved once per request from env, per purpose:
 *
 *   - If a dedicated key is provisioned (`MFA_ENC_KEY`, `PUSH_TOKEN_ENC_KEY`;
 *     base64 of exactly 32 bytes), values are sealed with
 *     `field-encryption.ts` — HKDF per-record DEK, `v1:` prefix — under it.
 *   - Otherwise the key is HKDF-SHA256-derived from `SESSION_SECRET` with a
 *     purpose-specific `info` label (domain separation, real bytes), and the
 *     ciphertext carries an `h1:` prefix. `SESSION_SECRET_FALLBACK` is tried
 *     on decrypt, so the session-secret rotation ceremony now covers these
 *     stores too.
 *   - The LEGACY unprefixed format (bare base64 of iv‖ct under the raw-bytes
 *     key) is still read, under the current secret and then the fallback, so
 *     no existing enrollment or device breaks. Readers that own a write path
 *     re-seal such values on the next successful open (see `needsReseal`).
 *
 * Backup codes get the same treatment: a keyed HMAC (`k1:` prefix) under the
 * purpose key instead of an unsalted SHA-256 of a 40-bit code (DP-8), with the
 * legacy hash still matched for rows written before this change.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "crypto";
import type { Env } from "../env.js";
import { decryptField, encryptField } from "./field-encryption.js";
import {
  decryptSecret as legacyDecryptSecret,
  hashBackupCode as legacyHashBackupCode,
} from "./mfa/totp-service.js";

/** Which store a keyring protects. Each purpose derives a distinct key. */
export type AtRestPurpose = "mfa" | "push";

/** Resolved key material for one purpose. Build it with {@link resolveKeyring}. */
export interface Keyring {
  readonly purpose: AtRestPurpose;
  /** Dedicated 32-byte KEK when provisioned; null → session-derived mode. */
  readonly kek: Buffer | null;
  /** HKDF(SESSION_SECRET, info=purpose) — always present. */
  readonly derived: Buffer;
  /** HKDF(SESSION_SECRET_FALLBACK, info=purpose) when a fallback is set. */
  readonly derivedFallback: Buffer | null;
  /** Raw session secret(s), only for reading the legacy unprefixed format. */
  readonly legacyMaster: string;
  readonly legacyFallback: string | null;
}

const DEDICATED_KEY_VAR: Record<AtRestPurpose, "MFA_ENC_KEY" | "PUSH_TOKEN_ENC_KEY"> = {
  mfa: "MFA_ENC_KEY",
  push: "PUSH_TOKEN_ENC_KEY",
};

const DERIVE_INFO: Record<AtRestPurpose, string> = {
  mfa: "trellis-mfa-at-rest-v1",
  push: "trellis-push-token-at-rest-v1",
};

const BACKUP_HMAC_INFO = "trellis-mfa-backup-code-v1";

const IV_LEN = 12;
const TAG_LEN = 16;
const DEK_LEN = 32;

/**
 * Decode a dedicated key var. Returns null when unset; throws when set but
 * not base64 of exactly 32 bytes (a passphrase is not a key — same rule as
 * `EMAIL_SUB_ENC_KEY` and `ACTIVITYPUB_KEY_ENCRYPTION_KEY`).
 */
export function decodeDedicatedKey(
  name: "MFA_ENC_KEY" | "PUSH_TOKEN_ENC_KEY",
  raw: string | undefined,
): Buffer | null {
  if (raw === undefined || raw === "") return null;
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(
      `${name} must be base64 of exactly 32 bytes, got ${key.length} — a passphrase is not a key`,
    );
  }
  return key;
}

function deriveFromSecret(secret: string, purpose: AtRestPurpose): Buffer {
  // No salt: the session secret is already high-entropy and the info label
  // is the domain separator. Mirrors `deriveSubKey` in field-encryption.ts.
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), DERIVE_INFO[purpose], DEK_LEN));
}

/** Resolve the keyring for a purpose from env. Cheap; call per request. */
export function resolveKeyring(env: Env, purpose: AtRestPurpose): Keyring {
  const master = env.SESSION_SECRET;
  if (typeof master !== "string" || master.length < 32) {
    throw new Error("at-rest-secret: SESSION_SECRET must be at least 32 characters");
  }
  const fallback =
    typeof env.SESSION_SECRET_FALLBACK === "string" && env.SESSION_SECRET_FALLBACK.length >= 32
      ? env.SESSION_SECRET_FALLBACK
      : null;
  const varName = DEDICATED_KEY_VAR[purpose];
  return {
    purpose,
    kek: decodeDedicatedKey(varName, env[varName]),
    derived: deriveFromSecret(master, purpose),
    derivedFallback: fallback ? deriveFromSecret(fallback, purpose) : null,
    legacyMaster: master,
    legacyFallback: fallback,
  };
}

// ---------------------------------------------------------------------------
// Seal / open
// ---------------------------------------------------------------------------

const V1_PREFIX = "v1:";
const H1_PREFIX = "h1:";

function sealDerived(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${H1_PREFIX}${Buffer.concat([iv, ct, tag]).toString("base64")}`;
}

function openDerived(body: string, key: Buffer): string {
  const buf = Buffer.from(body, "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("at-rest-secret: malformed h1 ciphertext");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Seal a plaintext secret in the keyring's CURRENT format. */
export async function sealSecret(plaintext: string, keyring: Keyring): Promise<string> {
  if (keyring.kek) return encryptField(plaintext, keyring.kek);
  return sealDerived(plaintext, keyring.derived);
}

/**
 * Open a stored value in any format this module has ever written, trying the
 * current key first and the fallback second. Throws when nothing opens it —
 * never returns partial plaintext.
 */
export async function openSecret(stored: string, keyring: Keyring): Promise<string> {
  if (stored.startsWith(V1_PREFIX)) {
    if (!keyring.kek) {
      throw new Error(
        `at-rest-secret: value is sealed under ${DEDICATED_KEY_VAR[keyring.purpose]} but that key is not configured`,
      );
    }
    return decryptField(stored, keyring.kek);
  }

  if (stored.startsWith(H1_PREFIX)) {
    const body = stored.slice(H1_PREFIX.length);
    try {
      return openDerived(body, keyring.derived);
    } catch (err) {
      if (!keyring.derivedFallback) throw err;
      return openDerived(body, keyring.derivedFallback);
    }
  }

  // Legacy: bare base64 of iv‖ct under the raw-character key.
  try {
    return await legacyDecryptSecret(stored, keyring.legacyMaster);
  } catch (err) {
    if (!keyring.legacyFallback) throw err;
    return legacyDecryptSecret(stored, keyring.legacyFallback);
  }
}

/**
 * True when `stored` is not in the format {@link sealSecret} would produce
 * today (legacy, `h1:` after a dedicated key was provisioned, or sealed under
 * the fallback rather than the current secret). Callers with a write path
 * re-seal after a successful open; the rest of the rows migrate on their next
 * use, which is how a rotation completes without a stop-the-world job.
 */
export function needsReseal(stored: string, keyring: Keyring): boolean {
  if (keyring.kek) return !stored.startsWith(V1_PREFIX);
  if (!stored.startsWith(H1_PREFIX)) return true;
  // h1 under the current derived key is current; anything else re-seals.
  try {
    openDerived(stored.slice(H1_PREFIX.length), keyring.derived);
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Backup codes (keyed hash)
// ---------------------------------------------------------------------------

const K1_PREFIX = "k1:";

function normalizeBackupCode(code: string): string {
  return code.replace(/-/g, "").toUpperCase();
}

function backupHmacKey(base: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", base, Buffer.alloc(0), BACKUP_HMAC_INFO, DEK_LEN));
}

function keyedBackupHash(code: string, base: Buffer): string {
  return `${K1_PREFIX}${createHmac("sha256", backupHmacKey(base)).update(normalizeBackupCode(code), "utf8").digest("hex")}`;
}

/** Hash a backup code for storage under the keyring's current key. */
export function hashBackupCodeKeyed(code: string, keyring: Keyring): string {
  return keyedBackupHash(code, keyring.kek ?? keyring.derived);
}

/**
 * Find `code` among stored hashes: keyed under the current key, keyed under
 * the fallback-derived key, then the legacy unsalted SHA-256. Returns the
 * index or -1. A matched code is consumed by the caller, so there is nothing
 * to re-hash — remaining legacy hashes cannot be upgraded without their
 * plaintext and stay until the user re-enrols.
 */
export async function matchBackupCode(
  code: string,
  stored: readonly string[],
  keyring: Keyring,
): Promise<number> {
  const candidates = [keyedBackupHash(code, keyring.kek ?? keyring.derived)];
  if (keyring.derivedFallback) candidates.push(keyedBackupHash(code, keyring.derivedFallback));
  candidates.push(await legacyHashBackupCode(code));
  for (const candidate of candidates) {
    const index = stored.indexOf(candidate);
    if (index !== -1) return index;
  }
  return -1;
}
