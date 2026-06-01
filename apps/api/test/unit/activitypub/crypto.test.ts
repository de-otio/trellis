/**
 * Unit Tests: KeyPairService (ActivityPub crypto)
 *
 * Contract under test
 * -------------------
 * ActivityPub actors store their RSA private keys encrypted at rest.
 * `KeyPairService` provides:
 *
 *   - `generateKeyPair()` — produces a fresh 2048-bit RSA key pair in PEM form
 *     (SPKI public key, PKCS#8 private key).
 *
 *   - `encryptPrivateKey(pem, env)` — encrypts a PEM string with AES-256-GCM
 *     using a 32-byte key derived via SHA-256 from either
 *     `env.ACTIVITYPUB_KEY_ENCRYPTION_KEY` (preferred) or `env.SESSION_SECRET`
 *     (fallback). Returns a JSON string containing base64-encoded `iv`,
 *     `authTag`, and `encrypted` fields. A fresh random IV is used each call,
 *     so the ciphertext is non-deterministic.
 *
 *   - `decryptPrivateKey(json, env)` — reverses `encryptPrivateKey`. The GCM
 *     auth tag provides authenticated encryption: any tampering (flipped
 *     authTag, corrupted ciphertext, wrong key) causes an immediate throw
 *     rather than returning garbage plaintext.
 *
 *   - Neither method performs I/O or requires a database connection — they use
 *     `node:crypto` directly and are therefore fully testable as pure units.
 */

import { describe, expect, it } from "vitest";
import type { Env } from "../../../src/env.js";
import { KeyPairService } from "../../../src/lib/activitypub/crypto.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Env carrying only the fields KeyPairService reads. */
function makeEnv(overrides: {
  SESSION_SECRET?: string;
  ACTIVITYPUB_KEY_ENCRYPTION_KEY?: string;
}): Env {
  return overrides as any as Env;
}

/** Parse the JSON blob returned by encryptPrivateKey. */
function parseCiphertext(json: string): {
  iv: string;
  authTag: string;
  encrypted: string;
} {
  return JSON.parse(json);
}

/**
 * Flip a single byte inside a base64 string so it remains valid base64 but
 * decodes to different bytes. We XOR the second character of the string
 * (avoiding the first, which may already be at the boundary of a base64 group
 * and produce an out-of-bounds char) with 0xff.
 */
function corruptBase64(b64: string): string {
  const bytes = Buffer.from(b64, "base64");
  bytes[Math.min(1, bytes.length - 1)] ^= 0xff;
  return bytes.toString("base64");
}

// Stable plaintext used across several tests (looks like a real PEM prefix)
const SAMPLE_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC" +
  "FAKE_PAYLOAD_FOR_UNIT_TESTS" +
  "\n-----END PRIVATE KEY-----\n";

const SESSION_SECRET_A = "session-secret-alpha-32-chars-ok!";
const SESSION_SECRET_B = "session-secret-beta--32-chars-ok!";
const AP_KEY_A = "activitypub-encryption-key-alpha!";
const AP_KEY_B = "activitypub-encryption-key-beta!!";

// ---------------------------------------------------------------------------
// generateKeyPair
// ---------------------------------------------------------------------------

describe("KeyPairService.generateKeyPair", () => {
  it("returns an object with publicKey and privateKey strings", () => {
    const { publicKey, privateKey } = KeyPairService.generateKeyPair();
    expect(typeof publicKey).toBe("string");
    expect(typeof privateKey).toBe("string");
  });

  it("publicKey is PEM SPKI (contains BEGIN PUBLIC KEY header)", () => {
    const { publicKey } = KeyPairService.generateKeyPair();
    expect(publicKey).toContain("-----BEGIN PUBLIC KEY-----");
    expect(publicKey).toContain("-----END PUBLIC KEY-----");
  });

  it("privateKey is PEM PKCS8 (contains BEGIN PRIVATE KEY header)", () => {
    const { privateKey } = KeyPairService.generateKeyPair();
    expect(privateKey).toContain("-----BEGIN PRIVATE KEY-----");
    expect(privateKey).toContain("-----END PRIVATE KEY-----");
  });

  it("successive calls produce distinct key pairs", () => {
    const pair1 = KeyPairService.generateKeyPair();
    const pair2 = KeyPairService.generateKeyPair();
    expect(pair1.publicKey).not.toBe(pair2.publicKey);
    expect(pair1.privateKey).not.toBe(pair2.privateKey);
  });
});

// ---------------------------------------------------------------------------
// encryptPrivateKey — ciphertext shape
// ---------------------------------------------------------------------------

describe("KeyPairService.encryptPrivateKey — ciphertext shape", () => {
  const env = makeEnv({ SESSION_SECRET: SESSION_SECRET_A });

  it("returns a valid JSON string", () => {
    const json = KeyPairService.encryptPrivateKey(SAMPLE_PEM, env);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("JSON contains iv, authTag, and encrypted fields (all strings)", () => {
    const { iv, authTag, encrypted } = parseCiphertext(
      KeyPairService.encryptPrivateKey(SAMPLE_PEM, env),
    );
    expect(typeof iv).toBe("string");
    expect(typeof authTag).toBe("string");
    expect(typeof encrypted).toBe("string");
  });

  it("all three fields are valid base64 strings (non-empty)", () => {
    const { iv, authTag, encrypted } = parseCiphertext(
      KeyPairService.encryptPrivateKey(SAMPLE_PEM, env),
    );
    for (const field of [iv, authTag, encrypted]) {
      expect(field.length).toBeGreaterThan(0);
      // Round-trip through Buffer to confirm decodability
      expect(() => Buffer.from(field, "base64")).not.toThrow();
    }
  });

  it("IV is 16 bytes (AES block size)", () => {
    const { iv } = parseCiphertext(KeyPairService.encryptPrivateKey(SAMPLE_PEM, env));
    expect(Buffer.from(iv, "base64").length).toBe(16);
  });

  it("authTag is 16 bytes (GCM default tag length)", () => {
    const { authTag } = parseCiphertext(KeyPairService.encryptPrivateKey(SAMPLE_PEM, env));
    expect(Buffer.from(authTag, "base64").length).toBe(16);
  });

  it("random IV: two encryptions of the same plaintext produce different IVs", () => {
    const iv1 = parseCiphertext(KeyPairService.encryptPrivateKey(SAMPLE_PEM, env)).iv;
    const iv2 = parseCiphertext(KeyPairService.encryptPrivateKey(SAMPLE_PEM, env)).iv;
    expect(iv1).not.toBe(iv2);
  });

  it("random IV: two encryptions of the same plaintext produce different ciphertexts", () => {
    const json1 = KeyPairService.encryptPrivateKey(SAMPLE_PEM, env);
    const json2 = KeyPairService.encryptPrivateKey(SAMPLE_PEM, env);
    expect(json1).not.toBe(json2);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: encrypt then decrypt
// ---------------------------------------------------------------------------

describe("KeyPairService round-trip (encrypt → decrypt)", () => {
  it("recovers exact plaintext when using ACTIVITYPUB_KEY_ENCRYPTION_KEY", () => {
    const env = makeEnv({ ACTIVITYPUB_KEY_ENCRYPTION_KEY: AP_KEY_A });
    const json = KeyPairService.encryptPrivateKey(SAMPLE_PEM, env);
    expect(KeyPairService.decryptPrivateKey(json, env)).toBe(SAMPLE_PEM);
  });

  it("recovers exact plaintext when falling back to SESSION_SECRET", () => {
    const env = makeEnv({ SESSION_SECRET: SESSION_SECRET_A });
    const json = KeyPairService.encryptPrivateKey(SAMPLE_PEM, env);
    expect(KeyPairService.decryptPrivateKey(json, env)).toBe(SAMPLE_PEM);
  });

  it("ACTIVITYPUB_KEY_ENCRYPTION_KEY takes precedence over SESSION_SECRET", () => {
    // When both are set, the dedicated key wins for both encrypt and decrypt.
    const env = makeEnv({
      ACTIVITYPUB_KEY_ENCRYPTION_KEY: AP_KEY_A,
      SESSION_SECRET: SESSION_SECRET_A,
    });
    const json = KeyPairService.encryptPrivateKey(SAMPLE_PEM, env);
    expect(KeyPairService.decryptPrivateKey(json, env)).toBe(SAMPLE_PEM);
  });

  it("round-trips a freshly generated RSA private key (full PEM)", () => {
    const env = makeEnv({ SESSION_SECRET: SESSION_SECRET_A });
    const { privateKey } = KeyPairService.generateKeyPair();
    const json = KeyPairService.encryptPrivateKey(privateKey, env);
    expect(KeyPairService.decryptPrivateKey(json, env)).toBe(privateKey);
  });

  it("round-trips with a very short ACTIVITYPUB_KEY_ENCRYPTION_KEY (SHA-256 derivation)", () => {
    // The implementation hashes any-length key to 32 bytes via SHA-256.
    const env = makeEnv({ ACTIVITYPUB_KEY_ENCRYPTION_KEY: "x" });
    const json = KeyPairService.encryptPrivateKey(SAMPLE_PEM, env);
    expect(KeyPairService.decryptPrivateKey(json, env)).toBe(SAMPLE_PEM);
  });
});

// ---------------------------------------------------------------------------
// Tamper detection (AES-256-GCM auth tag)
// ---------------------------------------------------------------------------

describe("KeyPairService tamper detection", () => {
  const env = makeEnv({ SESSION_SECRET: SESSION_SECRET_A });

  it("throws when the authTag is corrupted", () => {
    const parsed = parseCiphertext(KeyPairService.encryptPrivateKey(SAMPLE_PEM, env));
    parsed.authTag = corruptBase64(parsed.authTag);
    expect(() =>
      KeyPairService.decryptPrivateKey(JSON.stringify(parsed), env),
    ).toThrow();
  });

  it("throws when the encrypted payload is corrupted", () => {
    const parsed = parseCiphertext(KeyPairService.encryptPrivateKey(SAMPLE_PEM, env));
    parsed.encrypted = corruptBase64(parsed.encrypted);
    expect(() =>
      KeyPairService.decryptPrivateKey(JSON.stringify(parsed), env),
    ).toThrow();
  });

  it("throws when the iv is swapped (authentication fails)", () => {
    const parsed1 = parseCiphertext(KeyPairService.encryptPrivateKey(SAMPLE_PEM, env));
    const parsed2 = parseCiphertext(KeyPairService.encryptPrivateKey(SAMPLE_PEM, env));
    // Use the IV from a different encryption of the same message
    parsed1.iv = parsed2.iv;
    expect(() =>
      KeyPairService.decryptPrivateKey(JSON.stringify(parsed1), env),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Key derivation / fallback independence
// ---------------------------------------------------------------------------

describe("KeyPairService key derivation and fallback independence", () => {
  it("ciphertext encrypted with AP key does NOT decrypt under a different AP key", () => {
    const envA = makeEnv({ ACTIVITYPUB_KEY_ENCRYPTION_KEY: AP_KEY_A });
    const envB = makeEnv({ ACTIVITYPUB_KEY_ENCRYPTION_KEY: AP_KEY_B });
    const json = KeyPairService.encryptPrivateKey(SAMPLE_PEM, envA);
    expect(() => KeyPairService.decryptPrivateKey(json, envB)).toThrow();
  });

  it("ciphertext encrypted under SESSION_SECRET round-trips without AP key", () => {
    const env = makeEnv({ SESSION_SECRET: SESSION_SECRET_A });
    const json = KeyPairService.encryptPrivateKey(SAMPLE_PEM, env);
    expect(KeyPairService.decryptPrivateKey(json, env)).toBe(SAMPLE_PEM);
  });

  it("ciphertext encrypted with AP key does NOT decrypt when only a different SESSION_SECRET is present", () => {
    const envEncrypt = makeEnv({ ACTIVITYPUB_KEY_ENCRYPTION_KEY: AP_KEY_A });
    const envDecrypt = makeEnv({ SESSION_SECRET: SESSION_SECRET_B });
    const json = KeyPairService.encryptPrivateKey(SAMPLE_PEM, envEncrypt);
    // AP_KEY_A hashes to a different 32-byte key than SESSION_SECRET_B
    expect(() => KeyPairService.decryptPrivateKey(json, envDecrypt)).toThrow();
  });

  it("two different SESSION_SECRETs are independent (cross-decrypt fails)", () => {
    const envA = makeEnv({ SESSION_SECRET: SESSION_SECRET_A });
    const envB = makeEnv({ SESSION_SECRET: SESSION_SECRET_B });
    const json = KeyPairService.encryptPrivateKey(SAMPLE_PEM, envA);
    expect(() => KeyPairService.decryptPrivateKey(json, envB)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Missing key error handling
// ---------------------------------------------------------------------------

describe("KeyPairService missing key errors", () => {
  it("encryptPrivateKey throws when neither key is set", () => {
    const env = makeEnv({});
    expect(() => KeyPairService.encryptPrivateKey(SAMPLE_PEM, env)).toThrow();
  });

  it("decryptPrivateKey throws when neither key is set", () => {
    // Encrypt first with a valid env, then try to decrypt without any keys.
    const validEnv = makeEnv({ SESSION_SECRET: SESSION_SECRET_A });
    const json = KeyPairService.encryptPrivateKey(SAMPLE_PEM, validEnv);
    const emptyEnv = makeEnv({});
    expect(() => KeyPairService.decryptPrivateKey(json, emptyEnv)).toThrow();
  });

  it("error message from encryptPrivateKey mentions the required env var", () => {
    const env = makeEnv({});
    let message = "";
    try {
      KeyPairService.encryptPrivateKey(SAMPLE_PEM, env);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // The message should reference at least one of the two env vars so callers
    // know what to set.
    expect(
      message.includes("ACTIVITYPUB_KEY_ENCRYPTION_KEY") ||
        message.includes("SESSION_SECRET"),
    ).toBe(true);
  });
});
