/**
 * Unit tests for Secure Voting hash utilities.
 */

import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  generateFiatShamirChallenge,
  hashDeviceInfo,
  hashElectionRecord,
  hashVerificationCode,
} from "../../../../src/lib/crypto/voting/hash-utils.js";

function expectedHex(data: string | object): string {
  const s = typeof data === "string" ? data : JSON.stringify(data);
  return createHash("sha256").update(s, "utf8").digest("hex");
}

describe("Secure Voting Hash Utilities", () => {
  describe("hashVerificationCode", () => {
    it("produces a 64-char hex SHA-256", async () => {
      const hash = await hashVerificationCode("ballot-123-election-456");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic for identical input", async () => {
      expect(await hashVerificationCode("ballot-123")).toBe(
        await hashVerificationCode("ballot-123"),
      );
    });

    it("matches a plain SHA-256 over the normalized input", async () => {
      const data = "test-data";
      expect(await hashVerificationCode(data)).toBe(expectedHex(data));
    });
  });

  describe("hashElectionRecord", () => {
    it("hashes structured records", async () => {
      const record = {
        electionId: "election-123",
        publicKey: "key-data",
        options: ["option1", "option2"],
      };
      expect(await hashElectionRecord(record)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic for the same record", async () => {
      const record = { electionId: "election-123" };
      expect(await hashElectionRecord(record)).toBe(await hashElectionRecord(record));
    });

    it("matches plain SHA-256 over JSON.stringify", async () => {
      const record = { electionId: "test" };
      expect(await hashElectionRecord(record)).toBe(expectedHex(record));
    });
  });

  describe("generateFiatShamirChallenge", () => {
    it("produces a challenge from a transcript", async () => {
      const transcript = {
        publicValues: "public-data",
        commitments: ["commit1", "commit2"],
      };
      expect(await generateFiatShamirChallenge(transcript)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic for the same transcript", async () => {
      const transcript = { data: "test" };
      expect(await generateFiatShamirChallenge(transcript)).toBe(
        await generateFiatShamirChallenge(transcript),
      );
    });

    it("diverges on distinct transcripts", async () => {
      expect(await generateFiatShamirChallenge({ data: "test1" })).not.toBe(
        await generateFiatShamirChallenge({ data: "test2" }),
      );
    });

    it("matches plain SHA-256 over JSON.stringify", async () => {
      const transcript = { data: "test" };
      expect(await generateFiatShamirChallenge(transcript)).toBe(expectedHex(transcript));
    });
  });

  describe("hashDeviceInfo", () => {
    it("hashes device-info objects", async () => {
      const deviceInfo = {
        userAgent: "Mozilla/5.0",
        platform: "iOS",
        timestamp: Date.now(),
      };
      expect(await hashDeviceInfo(deviceInfo)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic for the same device info", async () => {
      const deviceInfo = { platform: "iOS" };
      expect(await hashDeviceInfo(deviceInfo)).toBe(await hashDeviceInfo(deviceInfo));
    });

    it("matches plain SHA-256 over JSON.stringify", async () => {
      const deviceInfo = { platform: "test" };
      expect(await hashDeviceInfo(deviceInfo)).toBe(expectedHex(deviceInfo));
    });
  });

  describe("Cross-function consistency", () => {
    it("all four helpers agree on a shared input", async () => {
      const input = "test-data";
      const expected = expectedHex(input);
      expect(await hashVerificationCode(input)).toBe(expected);
      expect(await hashElectionRecord(input)).toBe(expected);
      expect(await generateFiatShamirChallenge(input)).toBe(expected);
    });
  });
});
