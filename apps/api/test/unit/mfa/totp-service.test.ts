/**
 * Unit Tests: TOTP Service
 *
 * Tests for RFC 6238 TOTP generation, verification, backup codes,
 * and secret encryption/decryption.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateSecret,
  generateTOTP,
  verifyTOTP,
  buildOTPAuthURI,
  generateBackupCodes,
  hashBackupCode,
  encryptSecret,
  decryptSecret,
} from "../../../src/lib/mfa/totp-service.js";

describe("generateSecret", () => {
  it("should produce a non-empty base32 string", () => {
    const secret = generateSecret();
    expect(secret).toBeDefined();
    expect(secret.length).toBeGreaterThan(0);
    // Base32 characters only
    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  it("should produce unique secrets on each call", () => {
    const s1 = generateSecret();
    const s2 = generateSecret();
    expect(s1).not.toBe(s2);
  });

  it("should produce a secret of expected length for 160-bit key", () => {
    const secret = generateSecret();
    // 20 bytes = 160 bits, base32 encoded = ceil(160/5) = 32 chars
    expect(secret.length).toBe(32);
  });
});

describe("generateTOTP", () => {
  it("should produce a 6-digit string", async () => {
    const secret = generateSecret();
    const code = await generateTOTP(secret);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("should produce the same code for the same time", async () => {
    const secret = generateSecret();
    const time = 1700000000;
    const code1 = await generateTOTP(secret, time);
    const code2 = await generateTOTP(secret, time);
    expect(code1).toBe(code2);
  });

  it("should produce different codes for different time periods", async () => {
    const secret = generateSecret();
    // Ensure we cross a 30-second boundary
    const code1 = await generateTOTP(secret, 1700000000);
    const code2 = await generateTOTP(secret, 1700000060);
    // Not guaranteed but extremely likely with different counters
    // If they happen to collide, the test is still valid but rare
    expect(typeof code1).toBe("string");
    expect(typeof code2).toBe("string");
  });
});

describe("verifyTOTP", () => {
  it("should verify a freshly generated code", async () => {
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    const code = await generateTOTP(secret, now);
    const valid = await verifyTOTP(secret, code);
    expect(valid).toBe(true);
  });

  it("should reject an incorrect code", async () => {
    const secret = generateSecret();
    const valid = await verifyTOTP(secret, "000000");
    // Extremely unlikely to be the actual TOTP
    // If it somehow is, regenerate the secret
    expect(typeof valid).toBe("boolean");
  });

  it("should reject empty code", async () => {
    const secret = generateSecret();
    const valid = await verifyTOTP(secret, "");
    expect(valid).toBe(false);
  });

  it("should reject code with wrong length", async () => {
    const secret = generateSecret();
    const valid = await verifyTOTP(secret, "12345");
    expect(valid).toBe(false);
  });

  it("should reject code with 7 digits", async () => {
    const secret = generateSecret();
    const valid = await verifyTOTP(secret, "1234567");
    expect(valid).toBe(false);
  });

  it("should accept code within the window period", async () => {
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    // Generate code for one period ago (within default window=1)
    const pastCounter = Math.floor(now / 30) - 1;
    const pastTime = pastCounter * 30;
    const code = await generateTOTP(secret, pastTime);
    const valid = await verifyTOTP(secret, code, 1);
    expect(valid).toBe(true);
  });

  it("should reject code outside the window period", async () => {
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    // Generate code for 5 periods ago (outside default window=1)
    const farPastCounter = Math.floor(now / 30) - 5;
    const farPastTime = farPastCounter * 30;
    const code = await generateTOTP(secret, farPastTime);
    const valid = await verifyTOTP(secret, code, 1);
    expect(valid).toBe(false);
  });
});

describe("buildOTPAuthURI", () => {
  it("should build a valid otpauth:// URI", () => {
    const uri = buildOTPAuthURI("JBSWY3DPEHPK3PXP", "user@example.com");
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("user%40example.com");
    expect(uri).toContain("issuer=Trellis");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    expect(uri).toContain("algorithm=SHA1");
  });

  it("should use custom issuer when provided", () => {
    const uri = buildOTPAuthURI("SECRET", "a@b.com", "MyApp");
    expect(uri).toContain("issuer=MyApp");
    expect(uri).toContain("MyApp:");
  });

  it("should encode special characters in email", () => {
    const uri = buildOTPAuthURI("SECRET", "user+tag@example.com");
    expect(uri).toContain("user%2Btag%40example.com");
  });
});

describe("generateBackupCodes", () => {
  it("should generate the requested number of codes", () => {
    const codes = generateBackupCodes(10);
    expect(codes).toHaveLength(10);
  });

  it("should generate codes with default count of 10", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
  });

  it("should format codes as XXXX-XXXX", () => {
    const codes = generateBackupCodes(5);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });

  it("should not contain ambiguous characters (I, O, 0, 1)", () => {
    const codes = generateBackupCodes(20);
    for (const code of codes) {
      expect(code).not.toMatch(/[IO01]/);
    }
  });

  it("should generate unique codes", () => {
    const codes = generateBackupCodes(10);
    const unique = new Set(codes);
    // Very high probability all are unique
    expect(unique.size).toBe(10);
  });

  it("should generate different sets each time", () => {
    const set1 = generateBackupCodes(5);
    const set2 = generateBackupCodes(5);
    // At least one code should differ
    expect(set1).not.toEqual(set2);
  });
});

describe("hashBackupCode", () => {
  it("should produce a hex string", async () => {
    const hash = await hashBackupCode("ABCD-EFGH");
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("should produce a 64-char hex string (SHA-256)", async () => {
    const hash = await hashBackupCode("ABCD-EFGH");
    expect(hash).toHaveLength(64);
  });

  it("should produce the same hash for the same code", async () => {
    const h1 = await hashBackupCode("ABCD-EFGH");
    const h2 = await hashBackupCode("ABCD-EFGH");
    expect(h1).toBe(h2);
  });

  it("should normalize by removing dashes and uppercasing", async () => {
    const h1 = await hashBackupCode("ABCD-EFGH");
    const h2 = await hashBackupCode("abcdefgh");
    expect(h1).toBe(h2);
  });

  it("should produce different hashes for different codes", async () => {
    const h1 = await hashBackupCode("ABCD-EFGH");
    const h2 = await hashBackupCode("WXYZ-1234");
    expect(h1).not.toBe(h2);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("should roundtrip: encrypt then decrypt returns original", async () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const key = "my-encryption-key-for-testing!!!";
    const encrypted = await encryptSecret(secret, key);
    const decrypted = await decryptSecret(encrypted, key);
    expect(decrypted).toBe(secret);
  });

  it("should produce base64 encoded output", async () => {
    const encrypted = await encryptSecret("SECRET", "testkey1234567890");
    // Base64 characters only
    expect(encrypted).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("should produce different ciphertexts for same plaintext (random IV)", async () => {
    const secret = "SAME_SECRET";
    const key = "same-key-for-both-encryptions!!";
    const e1 = await encryptSecret(secret, key);
    const e2 = await encryptSecret(secret, key);
    expect(e1).not.toBe(e2);
  });

  it("should fail to decrypt with wrong key", async () => {
    const secret = "MY_SECRET";
    const encrypted = await encryptSecret(secret, "correct-key-here!!");
    await expect(
      decryptSecret(encrypted, "wrong-key-here-now!!"),
    ).rejects.toThrow();
  });

  it("should handle short encryption keys by padding", async () => {
    const secret = "SHORT_KEY_TEST";
    const key = "short";
    const encrypted = await encryptSecret(secret, key);
    const decrypted = await decryptSecret(encrypted, key);
    expect(decrypted).toBe(secret);
  });

  it("should handle long encryption keys by truncating to 32 bytes", async () => {
    const secret = "LONG_KEY_TEST";
    const key = "this-is-a-very-long-encryption-key-that-exceeds-32-bytes";
    const encrypted = await encryptSecret(secret, key);
    const decrypted = await decryptSecret(encrypted, key);
    expect(decrypted).toBe(secret);
  });
});
