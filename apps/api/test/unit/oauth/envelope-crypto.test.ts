/**
 * Unit tests: envelope-crypto.ts
 *
 * Verifies:
 *  - HKDF-derived DEK rejects mismatched device_code at decrypt time.
 *  - Round-trip seal/open succeeds.
 *  - Tamper detection on ciphertext / iv / tag.
 *  - DEK derivation rejects malformed inputs.
 *  - resolveKek paths: env-inline KEK, missing config error.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  CURRENT_KEK_VERSION,
  DEK_INFO,
  _resetKekCacheForTest,
  deriveDek,
  open,
  resolveKek,
  resolveKekForVersion,
  safeEqual,
  seal,
} from "../../../src/lib/oauth/envelope-crypto.js";

const KEK = randomBytes(32);
const DEVICE_CODE = "device-code-this-is-very-secret-".padEnd(64, "x");

describe("envelope-crypto.deriveDek", () => {
  it("rejects short device_code", () => {
    expect(() => deriveDek("short", KEK, randomBytes(32))).toThrow(/device_code too short/);
  });

  it("rejects KEK that is not 32 bytes", () => {
    expect(() => deriveDek(DEVICE_CODE, randomBytes(16), randomBytes(32))).toThrow(/KEK must be 32/);
  });

  it("rejects salt length other than 32", () => {
    expect(() => deriveDek(DEVICE_CODE, KEK, randomBytes(8))).toThrow(/salt must be/);
  });

  it("derives a stable 32-byte DEK for fixed inputs", () => {
    const salt = Buffer.alloc(32, 7);
    const dek1 = deriveDek(DEVICE_CODE, KEK, salt);
    const dek2 = deriveDek(DEVICE_CODE, KEK, salt);
    expect(dek1.length).toBe(32);
    expect(dek1.equals(dek2)).toBe(true);
  });

  it("produces different DEKs when device_code differs", () => {
    const salt = Buffer.alloc(32, 1);
    const dek1 = deriveDek(DEVICE_CODE, KEK, salt);
    const dek2 = deriveDek(DEVICE_CODE + "-other", KEK, salt);
    expect(dek1.equals(dek2)).toBe(false);
  });
});

describe("envelope-crypto.seal/open", () => {
  it("round-trips plaintext", () => {
    const env = seal("hello world", DEVICE_CODE, KEK);
    const plain = open(env, DEVICE_CODE, KEK);
    expect(plain).toBe("hello world");
  });

  it("opens a multi-byte JSON payload", () => {
    const payload = JSON.stringify({ access: "a".repeat(2048), refresh: "b".repeat(2048) });
    const env = seal(payload, DEVICE_CODE, KEK);
    const plain = open(env, DEVICE_CODE, KEK);
    expect(plain).toBe(payload);
  });

  it("alg + info markers are pinned", () => {
    const env = seal("x", DEVICE_CODE, KEK);
    expect(env.alg).toBe("AES-256-GCM+HKDF-SHA256");
    expect(env.info).toBe(DEK_INFO);
  });

  it("MEDIUM-1: stamps the envelope with the current KEK version", () => {
    const env = seal("x", DEVICE_CODE, KEK);
    expect(env.keyVersion).toBe(CURRENT_KEK_VERSION);
    expect(env.keyVersion).toBe(1);
  });

  it("MEDIUM-1: open() rejects envelopes from unknown KEK versions", () => {
    const env = seal("x", DEVICE_CODE, KEK);
    const tampered = { ...env, keyVersion: 99 };
    expect(() => open(tampered, DEVICE_CODE, KEK)).toThrow(/unsupported envelope keyVersion/);
  });

  it("MEDIUM-1: open() accepts envelopes without a keyVersion field for backward compatibility", () => {
    const env = seal("backwards", DEVICE_CODE, KEK);
    // Strip the field as if loaded from a row written before the
    // forward-compatible field existed.
    const noVersion = { ...env } as Partial<typeof env> & Record<string, unknown>;
    delete (noVersion as { keyVersion?: number }).keyVersion;
    expect(open(noVersion as typeof env, DEVICE_CODE, KEK)).toBe("backwards");
  });

  it("MEDIUM-1: resolveKekForVersion(1) trampolines to resolveKek", async () => {
    process.env.DEVICE_AUTH_KEK_BASE64 = randomBytes(32).toString("base64");
    _resetKekCacheForTest();
    const k = await resolveKekForVersion(1);
    expect(k.length).toBe(32);
    delete process.env.DEVICE_AUTH_KEK_BASE64;
  });

  it("MEDIUM-1: resolveKekForVersion rejects unknown versions", async () => {
    await expect(resolveKekForVersion(2)).rejects.toThrow(/unsupported envelope keyVersion/);
  });

  it("REJECTS decryption with the wrong device_code (sec finding #1)", () => {
    const env = seal("secret-token", DEVICE_CODE, KEK);
    expect(() => open(env, DEVICE_CODE + "-tamper", KEK)).toThrow();
  });

  it("rejects decryption with an empty device_code", () => {
    const env = seal("secret-token", DEVICE_CODE, KEK);
    expect(() => open(env, "", KEK)).toThrow();
  });

  it("rejects decryption with the wrong KEK", () => {
    const env = seal("secret-token", DEVICE_CODE, KEK);
    expect(() => open(env, DEVICE_CODE, randomBytes(32))).toThrow();
  });

  it("rejects ciphertext tampering", () => {
    const env = seal("secret", DEVICE_CODE, KEK);
    const tampered = { ...env, ciphertext: Buffer.from(env.ciphertext, "base64url").map((b, i) => (i === 0 ? b ^ 1 : b)).toString("base64url") };
    expect(() => open(tampered, DEVICE_CODE, KEK)).toThrow();
  });

  it("rejects iv tampering", () => {
    const env = seal("secret", DEVICE_CODE, KEK);
    const tampered = { ...env, iv: Buffer.alloc(12, 0).toString("base64url") };
    expect(() => open(tampered, DEVICE_CODE, KEK)).toThrow();
  });

  it("rejects salt tampering", () => {
    const env = seal("secret", DEVICE_CODE, KEK);
    const tampered = { ...env, salt: Buffer.alloc(32, 0).toString("base64url") };
    expect(() => open(tampered, DEVICE_CODE, KEK)).toThrow();
  });

  it("rejects unsupported algorithm", () => {
    const env = seal("x", DEVICE_CODE, KEK);
    const tampered = { ...env, alg: "AES-128-CBC" as never };
    expect(() => open(tampered, DEVICE_CODE, KEK)).toThrow(/unsupported envelope alg/);
  });

  it("rejects unsupported info string", () => {
    const env = seal("x", DEVICE_CODE, KEK);
    const tampered = { ...env, info: "wrong-info" };
    expect(() => open(tampered, DEVICE_CODE, KEK)).toThrow(/unsupported envelope info/);
  });

  it("rejects bad envelope shape (salt length)", () => {
    const env = seal("x", DEVICE_CODE, KEK);
    const tampered = { ...env, salt: Buffer.alloc(8, 0).toString("base64url") };
    expect(() => open(tampered, DEVICE_CODE, KEK)).toThrow(/salt length/);
  });

  it("rejects bad envelope shape (iv length)", () => {
    const env = seal("x", DEVICE_CODE, KEK);
    const tampered = { ...env, iv: Buffer.alloc(8, 0).toString("base64url") };
    expect(() => open(tampered, DEVICE_CODE, KEK)).toThrow(/iv length/);
  });

  it("rejects bad envelope shape (tag length)", () => {
    const env = seal("x", DEVICE_CODE, KEK);
    const tampered = { ...env, tag: Buffer.alloc(8, 0).toString("base64url") };
    expect(() => open(tampered, DEVICE_CODE, KEK)).toThrow(/tag length/);
  });
});

describe("envelope-crypto.safeEqual", () => {
  it("returns true for identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("returns false for different lengths", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("returns false for different content", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
  });
});

describe("envelope-crypto.resolveKek", () => {
  const PRIOR_INLINE = process.env.DEVICE_AUTH_KEK_BASE64;
  const PRIOR_KMS = process.env.DEVICE_AUTH_KMS_KEY_ID;

  beforeEach(() => {
    _resetKekCacheForTest();
    delete process.env.DEVICE_AUTH_KEK_BASE64;
    delete process.env.DEVICE_AUTH_KMS_KEY_ID;
  });

  afterEach(() => {
    if (PRIOR_INLINE === undefined) delete process.env.DEVICE_AUTH_KEK_BASE64;
    else process.env.DEVICE_AUTH_KEK_BASE64 = PRIOR_INLINE;
    if (PRIOR_KMS === undefined) delete process.env.DEVICE_AUTH_KMS_KEY_ID;
    else process.env.DEVICE_AUTH_KMS_KEY_ID = PRIOR_KMS;
  });

  it("uses DEVICE_AUTH_KEK_BASE64 when set", async () => {
    process.env.DEVICE_AUTH_KEK_BASE64 = randomBytes(32).toString("base64");
    const k = await resolveKek();
    expect(k.length).toBe(32);
  });

  it("rejects DEVICE_AUTH_KEK_BASE64 of wrong length", async () => {
    process.env.DEVICE_AUTH_KEK_BASE64 = randomBytes(16).toString("base64");
    await expect(resolveKek()).rejects.toThrow(/32 bytes/);
  });

  it("throws when neither inline nor KMS configured", async () => {
    await expect(resolveKek()).rejects.toThrow(/Device-auth KEK not configured/);
  });

  it("caches the resolved KEK", async () => {
    process.env.DEVICE_AUTH_KEK_BASE64 = randomBytes(32).toString("base64");
    const k1 = await resolveKek();
    // Mutating env after first call should not change the result.
    process.env.DEVICE_AUTH_KEK_BASE64 = randomBytes(32).toString("base64");
    const k2 = await resolveKek();
    expect(k1.equals(k2)).toBe(true);
  });
});

describe("envelope-crypto.resolveKek (KMS path)", () => {
  const PRIOR_INLINE = process.env.DEVICE_AUTH_KEK_BASE64;
  const PRIOR_KMS = process.env.DEVICE_AUTH_KMS_KEY_ID;

  beforeEach(async () => {
    _resetKekCacheForTest();
    const { _resetKmsKekFetcherForTest } = await import("../../../src/lib/oauth/envelope-crypto.js");
    _resetKmsKekFetcherForTest();
    delete process.env.DEVICE_AUTH_KEK_BASE64;
    delete process.env.DEVICE_AUTH_KMS_KEY_ID;
  });

  afterEach(() => {
    if (PRIOR_INLINE === undefined) delete process.env.DEVICE_AUTH_KEK_BASE64;
    else process.env.DEVICE_AUTH_KEK_BASE64 = PRIOR_INLINE;
    if (PRIOR_KMS === undefined) delete process.env.DEVICE_AUTH_KMS_KEY_ID;
    else process.env.DEVICE_AUTH_KMS_KEY_ID = PRIOR_KMS;
  });

  it("uses the configured KMS fetcher when DEVICE_AUTH_KMS_KEY_ID is set", async () => {
    process.env.DEVICE_AUTH_KMS_KEY_ID = "alias/trellis-device-auth";
    const { setKmsKekFetcher } = await import("../../../src/lib/oauth/envelope-crypto.js");
    const fakePlaintext = randomBytes(32);
    setKmsKekFetcher(async () => fakePlaintext);

    const k = await resolveKek();
    expect(k.equals(fakePlaintext)).toBe(true);
  });

  it("rejects a KMS fetcher that returns the wrong length", async () => {
    process.env.DEVICE_AUTH_KMS_KEY_ID = "alias/trellis-device-auth";
    const { setKmsKekFetcher } = await import("../../../src/lib/oauth/envelope-crypto.js");
    setKmsKekFetcher(async () => randomBytes(16));

    await expect(resolveKek()).rejects.toThrow(/wrong length/);
  });

  it("throws if no KMS fetcher is wired but the KMS path is selected", async () => {
    process.env.DEVICE_AUTH_KMS_KEY_ID = "alias/trellis-device-auth";
    await expect(resolveKek()).rejects.toThrow(/KMS KEK fetcher not configured/);
  });
});
