import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  assertKek,
  decryptField,
  deriveSubKey,
  encryptField,
  hmacHex,
  safeEqual,
} from "../../src/lib/field-encryption.js";

const KEK = Buffer.alloc(32, 7);
const OTHER_KEK = Buffer.alloc(32, 9);

describe("field-encryption", () => {
  describe("encryptField / decryptField round-trip", () => {
    it("round-trips ASCII plaintext", () => {
      const enc = encryptField("user@example.com", KEK);
      expect(decryptField(enc, KEK)).toBe("user@example.com");
    });

    it("round-trips unicode plaintext", () => {
      const pt = "böse@münchen.example — 犬 🐕";
      expect(decryptField(encryptField(pt, KEK), KEK)).toBe(pt);
    });

    it("produces a versioned, self-describing serialization", () => {
      const enc = encryptField("a@b.example", KEK);
      expect(enc).toMatch(/^v1:[^.]+\.[^.]+\.[^.]+\.[^.]+$/);
    });

    it("is non-deterministic (random salt + iv per call)", () => {
      const a = encryptField("same@example.com", KEK);
      const b = encryptField("same@example.com", KEK);
      expect(a).not.toBe(b);
      expect(decryptField(a, KEK)).toBe(decryptField(b, KEK));
    });
  });

  describe("decrypt failure paths (auth-tag / integrity)", () => {
    it("throws when decrypting with the wrong key", () => {
      const enc = encryptField("secret@example.com", KEK);
      expect(() => decryptField(enc, OTHER_KEK)).toThrow();
    });

    it("throws on tampered ciphertext", () => {
      const enc = encryptField("secret@example.com", KEK);
      // Flip the last base64url char of the ciphertext component.
      const parts = enc.split(".");
      const ctChar = parts[3].slice(-1);
      parts[3] = parts[3].slice(0, -1) + (ctChar === "A" ? "B" : "A");
      expect(() => decryptField(parts.join("."), KEK)).toThrow();
    });

    it("throws on a malformed value", () => {
      expect(() => decryptField("not-a-ciphertext", KEK)).toThrow(/malformed/);
    });

    it("throws on an unknown key version", () => {
      const enc = encryptField("a@b.example", KEK);
      const bumped = enc.replace(/^v1:/, "v2:");
      expect(() => decryptField(bumped, KEK)).toThrow(/keyVersion/);
    });

    it("throws on a bad component length", () => {
      // Valid version + structure, but salt is too short.
      const enc = `v1:${Buffer.alloc(4).toString("base64url")}.${Buffer.alloc(12).toString(
        "base64url",
      )}.${Buffer.alloc(16).toString("base64url")}.${Buffer.alloc(8).toString("base64url")}`;
      expect(() => decryptField(enc, KEK)).toThrow(/component length/);
    });
  });

  describe("assertKek — no weak/short keys, no ambient fallback", () => {
    it("rejects a non-32-byte key on encrypt", () => {
      expect(() => encryptField("x@y.example", Buffer.alloc(16))).toThrow(/32-byte/);
    });
    it("rejects a non-32-byte key on decrypt", () => {
      const enc = encryptField("x@y.example", KEK);
      expect(() => decryptField(enc, Buffer.alloc(31))).toThrow(/32-byte/);
    });
    it("assertKek throws for non-buffer input", () => {
      // @ts-expect-error deliberate misuse
      expect(() => assertKek("not-a-buffer")).toThrow();
    });
  });

  describe("HMAC + sub-key primitives", () => {
    const MASTER = "master-secret-at-least-32-chars-long!!";
    const OTHER_MASTER = "another-master-secret-32-chars-plus!!";

    it("deriveSubKey is deterministic per (secret, info) and domain-separated", () => {
      const a1 = deriveSubKey(MASTER, "info-a");
      const a2 = deriveSubKey(MASTER, "info-a");
      const b = deriveSubKey(MASTER, "info-b");
      expect(a1.equals(a2)).toBe(true);
      expect(a1.equals(b)).toBe(false); // different info => different key
      expect(deriveSubKey(OTHER_MASTER, "info-a").equals(a1)).toBe(false);
    });

    it("deriveSubKey rejects an empty or short (<32-char) secret", () => {
      expect(() => deriveSubKey("", "info")).toThrow();
      expect(() => deriveSubKey("too-short", "info")).toThrow(/32 characters/);
    });

    it("hmacHex is deterministic and key-dependent", () => {
      const k1 = randomBytes(32);
      const k2 = randomBytes(32);
      expect(hmacHex(k1, "data")).toBe(hmacHex(k1, "data"));
      expect(hmacHex(k1, "data")).not.toBe(hmacHex(k2, "data"));
    });

    it("safeEqual is true for equal strings, false otherwise incl. length mismatch", () => {
      expect(safeEqual("abc", "abc")).toBe(true);
      expect(safeEqual("abc", "abd")).toBe(false);
      expect(safeEqual("abc", "abcd")).toBe(false);
    });
  });
});
