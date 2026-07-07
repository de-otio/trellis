import { describe, expect, it } from "vitest";
import {
  hashEmail,
  normalizeEmail,
  signToken,
  verifyToken,
} from "../../src/lib/email-subscription-token.js";

const SECRET = "test-email-sub-hmac-secret-please-rotate";
const OTHER_SECRET = "a-different-operator-secret-32-chars-plus";

describe("email-subscription-token", () => {
  describe("normalizeEmail", () => {
    it("trims and lowercases", () => {
      expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
    });
  });

  describe("hashEmail", () => {
    it("is deterministic for the same email + secret and versioned", () => {
      const h = hashEmail("user@example.com", SECRET);
      expect(h).toBe(hashEmail("USER@example.com", SECRET)); // normalized
      expect(h).toMatch(/^v1:[0-9a-f]{64}$/);
    });
    it("differs for a different email", () => {
      expect(hashEmail("a@example.com", SECRET)).not.toBe(hashEmail("b@example.com", SECRET));
    });
    it("differs for a different secret (keyed)", () => {
      expect(hashEmail("a@example.com", SECRET)).not.toBe(hashEmail("a@example.com", OTHER_SECRET));
    });
    it("rejects an empty or oversized email", () => {
      expect(() => hashEmail("   ", SECRET)).toThrow(/length/);
      expect(() => hashEmail("a".repeat(400) + "@x.example", SECRET)).toThrow(/length/);
    });
    it("rejects a weak (<32-char) master secret", () => {
      expect(() => hashEmail("a@example.com", "too-short")).toThrow(/32 characters/);
    });
  });

  describe("signToken / verifyToken", () => {
    const base = {
      subId: "11111111-2222-3333-4444-555555555555",
      nonce: "nonce-abc",
      exp: 2_000_000_000, // far future
    };

    it("round-trips a valid confirm token and returns subId + nonce", () => {
      const t = signToken({ action: "confirm", ...base }, SECRET);
      const r = verifyToken(t, {
        expectedAction: "confirm",
        masterSecret: SECRET,
        now: 1_000_000_000,
      });
      expect(r.valid).toBe(true);
      if (r.valid) {
        expect(r.subId).toBe(base.subId);
        expect(r.nonce).toBe(base.nonce);
      }
    });

    it("rejects a confirm token presented at the unsubscribe endpoint (action binding, SEC-2)", () => {
      const t = signToken({ action: "confirm", ...base }, SECRET);
      const r = verifyToken(t, {
        expectedAction: "unsubscribe",
        masterSecret: SECRET,
        now: 1_000_000_000,
      });
      expect(r.valid).toBe(false);
    });

    it("rejects an unsubscribe token at the confirm endpoint (reverse)", () => {
      const t = signToken({ action: "unsubscribe", ...base }, SECRET);
      const r = verifyToken(t, {
        expectedAction: "confirm",
        masterSecret: SECRET,
        now: 1_000_000_000,
      });
      expect(r.valid).toBe(false);
    });

    it("rejects a tampered signature", () => {
      const t = signToken({ action: "confirm", ...base }, SECRET);
      const tampered = t.slice(0, -1) + (t.endsWith("a") ? "b" : "a");
      expect(
        verifyToken(tampered, {
          expectedAction: "confirm",
          masterSecret: SECRET,
          now: 1_000_000_000,
        }).valid,
      ).toBe(false);
    });

    it("rejects a tampered payload (action swapped in the clear)", () => {
      const t = signToken({ action: "confirm", ...base }, SECRET);
      const [payloadB64, sig] = t.split(".");
      const decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      decoded.a = "unsubscribe";
      const forgedPayload = Buffer.from(JSON.stringify(decoded)).toString("base64url");
      expect(
        verifyToken(`${forgedPayload}.${sig}`, {
          expectedAction: "unsubscribe",
          masterSecret: SECRET,
          now: 1_000_000_000,
        }).valid,
      ).toBe(false);
    });

    it("rejects an expired token", () => {
      const t = signToken({ action: "confirm", ...base, exp: 1000 }, SECRET);
      expect(
        verifyToken(t, {
          expectedAction: "confirm",
          masterSecret: SECRET,
          now: 2000,
        }).valid,
      ).toBe(false);
    });

    it("rejects a token signed with a different secret", () => {
      const t = signToken({ action: "confirm", ...base }, OTHER_SECRET);
      expect(
        verifyToken(t, {
          expectedAction: "confirm",
          masterSecret: SECRET,
          now: 1_000_000_000,
        }).valid,
      ).toBe(false);
    });

    it("rejects structurally malformed tokens", () => {
      for (const bad of ["", "no-dot", ".", "a.", ".b"]) {
        expect(
          verifyToken(bad, {
            expectedAction: "confirm",
            masterSecret: SECRET,
            now: 1_000_000_000,
          }).valid,
        ).toBe(false);
      }
    });

    it("rejects an oversized token without hashing it", () => {
      expect(
        verifyToken("x".repeat(5000), {
          expectedAction: "confirm",
          masterSecret: SECRET,
          now: 1_000_000_000,
        }).valid,
      ).toBe(false);
    });

    it("signing with a weak master secret throws", () => {
      expect(() => signToken({ action: "confirm", ...base }, "short")).toThrow(/32 characters/);
    });
  });
});
