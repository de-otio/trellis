/**
 * Unit Tests: KeyPairService (ActivityPub crypto) — after F7.
 *
 * Contract under test
 * -------------------
 * ActivityPub actors store their RSA private keys encrypted at rest.
 *
 *   - `generateKeyPair()` — a fresh 2048-bit RSA key pair in PEM form
 *     (SPKI public key, PKCS#8 private key).
 *
 *   - `encryptPrivateKey(pem, env)` — AES-256-GCM under a per-record DEK
 *     derived by HKDF-SHA256 from a dedicated 32-byte
 *     `ACTIVITYPUB_KEY_ENCRYPTION_KEY` and a random salt. Serialized as
 *     `v{version}:{salt}.{iv}.{tag}.{ciphertext}`.
 *
 *   - `decryptPrivateKey(value, env)` — reverses the above, and still reads
 *     the LEGACY JSON format during migration. Any tampering fails the GCM
 *     auth tag and throws rather than returning garbage.
 *
 * The previously-tested behaviours that are now DELIBERATELY GONE, each with a
 * test asserting the refusal:
 *   - falling back to `SESSION_SECRET` (secret reuse across trust domains)
 *   - accepting a short passphrase and SHA-256-ing it into 32 bytes
 */

import * as crypto from "crypto";
import { describe, expect, it } from "vitest";
import type { Env } from "../../../src/env.js";
import {
  AP_KEY_ENC_VERSION,
  KeyPairService,
} from "../../../src/lib/activitypub/crypto.js";

/** Minimal Env carrying only the fields KeyPairService reads. */
function makeEnv(overrides: Record<string, unknown>): Env {
  return overrides as any as Env;
}

/** A real 32-byte key, hex-encoded — what an operator must now provision. */
function key32(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex");
}

const AP_KEY_A = key32("alpha");
const AP_KEY_B = key32("beta");

const SAMPLE_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC" +
  "FAKE_PAYLOAD_FOR_UNIT_TESTS" +
  "\n-----END PRIVATE KEY-----\n";

const envA = makeEnv({ ACTIVITYPUB_KEY_ENCRYPTION_KEY: AP_KEY_A });
const envB = makeEnv({ ACTIVITYPUB_KEY_ENCRYPTION_KEY: AP_KEY_B });

/** Wrap `pem` the OLD way, so migration can be tested against real legacy data. */
function legacyWrap(pem: string, secret: string): string {
  const kek = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);
  let encrypted = cipher.update(pem, "utf8", "base64");
  encrypted += cipher.final("base64");
  return JSON.stringify({
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    encrypted,
  });
}

describe("KeyPairService.generateKeyPair", () => {
  it("returns publicKey and privateKey strings", () => {
    const kp = KeyPairService.generateKeyPair();
    expect(typeof kp.publicKey).toBe("string");
    expect(typeof kp.privateKey).toBe("string");
  });

  it("publicKey is PEM SPKI", () => {
    expect(KeyPairService.generateKeyPair().publicKey).toContain(
      "BEGIN PUBLIC KEY",
    );
  });

  it("privateKey is PEM PKCS8", () => {
    expect(KeyPairService.generateKeyPair().privateKey).toContain(
      "BEGIN PRIVATE KEY",
    );
  });

  it("successive calls produce distinct key pairs", () => {
    expect(KeyPairService.generateKeyPair().privateKey).not.toBe(
      KeyPairService.generateKeyPair().privateKey,
    );
  });
});

describe("ciphertext shape (mirrors field-encryption.ts)", () => {
  const enc = KeyPairService.encryptPrivateKey(SAMPLE_PEM, envA);

  it("is the versioned compact form, not a JSON blob", () => {
    expect(enc.startsWith(`v${AP_KEY_ENC_VERSION}:`)).toBe(true);
    expect(() => JSON.parse(enc)).toThrow();
  });

  it("has four base64url components of the documented lengths", () => {
    const m = /^v\d+:([^.]+)\.([^.]+)\.([^.]+)\.([^.]+)$/.exec(enc);
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1], "base64url")).toHaveLength(32); // salt
    expect(Buffer.from(m![2], "base64url")).toHaveLength(12); // 96-bit IV
    expect(Buffer.from(m![3], "base64url")).toHaveLength(16); // GCM tag
    expect(Buffer.from(m![4], "base64url").length).toBeGreaterThan(0);
  });

  it("uses a fresh random salt AND iv per call", () => {
    const a = KeyPairService.encryptPrivateKey(SAMPLE_PEM, envA);
    const b = KeyPairService.encryptPrivateKey(SAMPLE_PEM, envA);
    expect(a).not.toBe(b);
    expect(a.split(".")[0]).not.toBe(b.split(".")[0]); // salt differs
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]); // iv differs
  });
});

describe("round-trip", () => {
  it("recovers the exact plaintext", () => {
    const enc = KeyPairService.encryptPrivateKey(SAMPLE_PEM, envA);
    expect(KeyPairService.decryptPrivateKey(enc, envA)).toBe(SAMPLE_PEM);
  });

  it("round-trips a real generated RSA private key", () => {
    const { privateKey } = KeyPairService.generateKeyPair();
    const enc = KeyPairService.encryptPrivateKey(privateKey, envA);
    expect(KeyPairService.decryptPrivateKey(enc, envA)).toBe(privateKey);
  });

  it("accepts a base64-encoded 32-byte key as well as hex", () => {
    const b64Env = makeEnv({
      ACTIVITYPUB_KEY_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    });
    const enc = KeyPairService.encryptPrivateKey(SAMPLE_PEM, b64Env);
    expect(KeyPairService.decryptPrivateKey(enc, b64Env)).toBe(SAMPLE_PEM);
  });
});

describe("tamper detection", () => {
  const enc = KeyPairService.encryptPrivateKey(SAMPLE_PEM, envA);
  const [prefix, rest] = [enc.slice(0, enc.indexOf(":") + 1), enc.slice(enc.indexOf(":") + 1)];
  const [salt, iv, tag, ct] = rest.split(".");

  const flip = (b64url: string) => {
    const bytes = Buffer.from(b64url, "base64url");
    bytes[0] ^= 0xff;
    return bytes.toString("base64url");
  };

  it("throws when the auth tag is corrupted", () => {
    expect(() =>
      KeyPairService.decryptPrivateKey(
        `${prefix}${salt}.${iv}.${flip(tag)}.${ct}`,
        envA,
      ),
    ).toThrow();
  });

  it("throws when the ciphertext is corrupted", () => {
    expect(() =>
      KeyPairService.decryptPrivateKey(
        `${prefix}${salt}.${iv}.${tag}.${flip(ct)}`,
        envA,
      ),
    ).toThrow();
  });

  it("throws when the salt is swapped (derives a different DEK)", () => {
    expect(() =>
      KeyPairService.decryptPrivateKey(
        `${prefix}${flip(salt)}.${iv}.${tag}.${ct}`,
        envA,
      ),
    ).toThrow();
  });

  it("throws when the iv is swapped", () => {
    expect(() =>
      KeyPairService.decryptPrivateKey(
        `${prefix}${salt}.${flip(iv)}.${tag}.${ct}`,
        envA,
      ),
    ).toThrow();
  });

  it("throws on an unknown key version", () => {
    expect(() =>
      KeyPairService.decryptPrivateKey(`v99:${rest}`, envA),
    ).toThrow(/unsupported keyVersion/);
  });

  it("rejects non-canonical version aliases", () => {
    expect(() =>
      KeyPairService.decryptPrivateKey(`v01:${rest}`, envA),
    ).toThrow(/unsupported keyVersion/);
  });

  it("throws on a bad component length", () => {
    const shortSalt = Buffer.alloc(8).toString("base64url");
    expect(() =>
      KeyPairService.decryptPrivateKey(
        `${prefix}${shortSalt}.${iv}.${tag}.${ct}`,
        envA,
      ),
    ).toThrow(/bad component length/);
  });

  it("throws on a malformed value", () => {
    expect(() => KeyPairService.decryptPrivateKey("garbage", envA)).toThrow();
    expect(() =>
      KeyPairService.decryptPrivateKey("x".repeat(20_000), envA),
    ).toThrow(/malformed/);
  });
});

describe("key separation", () => {
  it("ciphertext under one KEK does not decrypt under another", () => {
    const enc = KeyPairService.encryptPrivateKey(SAMPLE_PEM, envA);
    expect(() => KeyPairService.decryptPrivateKey(enc, envB)).toThrow();
  });
});

describe("F7 — the SESSION_SECRET fallback is gone", () => {
  it("REFUSES to encrypt with only SESSION_SECRET present", () => {
    // The finding: session signing and federation identity shared one secret.
    const env = makeEnv({ SESSION_SECRET: "a".repeat(64) });
    expect(() => KeyPairService.encryptPrivateKey(SAMPLE_PEM, env)).toThrow(
      /ACTIVITYPUB_KEY_ENCRYPTION_KEY is required/,
    );
  });

  it("REFUSES a short passphrase instead of hashing it into a key", () => {
    // Previously `SHA-256(anything)` produced a 32-byte "key", so a
    // 12-character passphrase looked like a 256-bit key. It is not.
    const env = makeEnv({ ACTIVITYPUB_KEY_ENCRYPTION_KEY: "short-secret" });
    expect(() => KeyPairService.encryptPrivateKey(SAMPLE_PEM, env)).toThrow(
      /exactly 32 bytes/,
    );
  });

  it("REFUSES a 32-CHARACTER passphrase that is not 32 bytes of key material", () => {
    const env = makeEnv({
      ACTIVITYPUB_KEY_ENCRYPTION_KEY: "activitypub-encryption-key-alpha!",
    });
    expect(() => KeyPairService.encryptPrivateKey(SAMPLE_PEM, env)).toThrow(
      /exactly 32 bytes/,
    );
  });

  it("REFUSES a hex string of the wrong length", () => {
    const env = makeEnv({ ACTIVITYPUB_KEY_ENCRYPTION_KEY: "ab".repeat(16) });
    expect(() => KeyPairService.encryptPrivateKey(SAMPLE_PEM, env)).toThrow(
      /exactly 32 bytes/,
    );
  });

  it("names the required variable in the error", () => {
    expect(() =>
      KeyPairService.encryptPrivateKey(SAMPLE_PEM, makeEnv({})),
    ).toThrow(/ACTIVITYPUB_KEY_ENCRYPTION_KEY/);
  });
});

describe("F7 — migration of already-wrapped keys", () => {
  const legacySecret = "activitypub-encryption-key-alpha!";
  const legacy = legacyWrap(SAMPLE_PEM, legacySecret);

  const migrationEnv = makeEnv({
    ACTIVITYPUB_KEY_ENCRYPTION_KEY: AP_KEY_A,
    ACTIVITYPUB_LEGACY_KEY_ENCRYPTION_KEY: legacySecret,
  });

  it("identifies a legacy value as needing rewrap", () => {
    expect(KeyPairService.needsRewrap(legacy)).toBe(true);
    expect(
      KeyPairService.needsRewrap(
        KeyPairService.encryptPrivateKey(SAMPLE_PEM, envA),
      ),
    ).toBe(false);
  });

  it("still DECRYPTS a legacy value during migration", () => {
    // Existing actors must keep working across the deploy.
    expect(KeyPairService.decryptPrivateKey(legacy, migrationEnv)).toBe(
      SAMPLE_PEM,
    );
  });

  it("rewraps a legacy value into the current format", () => {
    const rewrapped = KeyPairService.rewrapPrivateKey(legacy, migrationEnv);
    expect(rewrapped.startsWith(`v${AP_KEY_ENC_VERSION}:`)).toBe(true);
    expect(KeyPairService.decryptPrivateKey(rewrapped, envA)).toBe(SAMPLE_PEM);
  });

  it("rewrap is idempotent", () => {
    const once = KeyPairService.rewrapPrivateKey(legacy, migrationEnv);
    expect(KeyPairService.rewrapPrivateKey(once, migrationEnv)).toBe(once);
  });

  it("reads legacy data written under the old SESSION_SECRET fallback", () => {
    const sessionSecret = "session-secret-alpha-32-chars-ok!";
    const old = legacyWrap(SAMPLE_PEM, sessionSecret);
    const env = makeEnv({
      ACTIVITYPUB_KEY_ENCRYPTION_KEY: AP_KEY_A,
      ACTIVITYPUB_LEGACY_KEY_ENCRYPTION_KEY: sessionSecret,
    });
    expect(KeyPairService.decryptPrivateKey(old, env)).toBe(SAMPLE_PEM);
  });

  it("REFUSES legacy values once the legacy path is switched off", () => {
    // The post-backfill state: the old format must stop being readable.
    const closed = makeEnv({
      ACTIVITYPUB_KEY_ENCRYPTION_KEY: AP_KEY_A,
      ACTIVITYPUB_LEGACY_KEY_ENCRYPTION_KEY: legacySecret,
      ACTIVITYPUB_LEGACY_KEY_DECRYPT: "false",
    });
    expect(() => KeyPairService.decryptPrivateKey(legacy, closed)).toThrow(
      /legacy read path is disabled/,
    );
  });

  it("throws a directive error on a malformed legacy blob", () => {
    expect(() =>
      KeyPairService.decryptPrivateKey('{"iv":"x"}', migrationEnv),
    ).toThrow(/malformed legacy wrapped key/);
  });
});
