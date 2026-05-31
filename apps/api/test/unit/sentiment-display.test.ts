/**
 * Unit Tests: Sentiment Display Mode
 *
 * Tests age-tier-based sentiment display rules.
 */

import { describe, expect, it } from "vitest";
import {
  getSentimentDisplayMode,
  SentimentDisplayMode,
} from "../../src/lib/sentiment-display.js";

describe("getSentimentDisplayMode", () => {
  describe("CHILD age tier", () => {
    it("should return DISTRIBUTION for own post", () => {
      expect(getSentimentDisplayMode("CHILD", true)).toBe(
        SentimentDisplayMode.DISTRIBUTION,
      );
    });

    it("should return HIDDEN for other's post", () => {
      expect(getSentimentDisplayMode("CHILD", false)).toBe(
        SentimentDisplayMode.HIDDEN,
      );
    });
  });

  describe("TEEN age tier", () => {
    it("should return DISTRIBUTION for own post", () => {
      expect(getSentimentDisplayMode("TEEN", true)).toBe(
        SentimentDisplayMode.DISTRIBUTION,
      );
    });

    it("should return DISTRIBUTION for other's post", () => {
      expect(getSentimentDisplayMode("TEEN", false)).toBe(
        SentimentDisplayMode.DISTRIBUTION,
      );
    });
  });

  describe("ADULT age tier", () => {
    it("should return FULL for own post", () => {
      expect(getSentimentDisplayMode("ADULT", true)).toBe(
        SentimentDisplayMode.FULL,
      );
    });

    it("should return FULL for other's post", () => {
      expect(getSentimentDisplayMode("ADULT", false)).toBe(
        SentimentDisplayMode.FULL,
      );
    });
  });

  describe("enum values", () => {
    it("should have correct string values for display modes", () => {
      expect(SentimentDisplayMode.FULL).toBe("full");
      expect(SentimentDisplayMode.DISTRIBUTION).toBe("distribution");
      expect(SentimentDisplayMode.HIDDEN).toBe("hidden");
    });

    it("should default to HIDDEN for unknown age tier", () => {
      // Cast to AgeTier to simulate an unknown value
      expect(getSentimentDisplayMode("UNKNOWN" as any, true)).toBe(
        SentimentDisplayMode.HIDDEN,
      );
    });
  });
});
