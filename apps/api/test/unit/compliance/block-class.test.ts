/**
 * Unit Tests: server-only block-class derivation (spec 07 §4.3).
 *
 * The carve-out hinges on this pure function: the reserved illegal token maps to
 * `illegal-suspected` (never appealable); everything else is `lawful-flagged`.
 * Core hardcodes NO provider vocabulary — only the reserved neutral token.
 */

import { describe, expect, it } from "vitest";
import {
  ILLEGAL_SUSPECTED_LABEL,
  deriveBlockClass,
  isAppealable,
} from "../../../src/lib/compliance/block-class.js";
import type { ModerationVerdict } from "../../../src/lib/media/moderation-provider.js";

function verdict(labels: Array<{ category: string; confidence: number }>): ModerationVerdict {
  return { decision: "quarantine", labels, provider: "test" };
}

describe("deriveBlockClass", () => {
  it("returns illegal-suspected when the reserved illegal token is present", () => {
    expect(
      deriveBlockClass(verdict([{ category: ILLEGAL_SUSPECTED_LABEL, confidence: 0.9 }])),
    ).toBe("illegal-suspected");
  });

  it("returns illegal-suspected even when mixed with ordinary opaque labels", () => {
    expect(
      deriveBlockClass(
        verdict([
          { category: "category_a", confidence: 0.5 },
          { category: ILLEGAL_SUSPECTED_LABEL, confidence: 0.99 },
        ]),
      ),
    ).toBe("illegal-suspected");
  });

  it("returns lawful-flagged for ordinary opaque labels", () => {
    expect(
      deriveBlockClass(verdict([{ category: "category_a", confidence: 0.8 }])),
    ).toBe("lawful-flagged");
  });

  it("returns lawful-flagged for a verdict with no labels", () => {
    expect(deriveBlockClass(verdict([]))).toBe("lawful-flagged");
  });

  it("does NOT hardcode any provider real-category vocabulary", () => {
    // Neutral, out-of-band reserved token — not a real moderation category name.
    expect(ILLEGAL_SUSPECTED_LABEL).toBe("x-illegal-suspected");
    expect(ILLEGAL_SUSPECTED_LABEL).not.toMatch(/minor|sexual|csam|child/i);
  });
});

describe("isAppealable", () => {
  it("is false for illegal-suspected (the carve-out)", () => {
    expect(isAppealable("illegal-suspected")).toBe(false);
  });

  it("is true for lawful-flagged", () => {
    expect(isAppealable("lawful-flagged")).toBe(true);
  });

  it("treats unknown/null as appealable (media illegal-class is a known gap)", () => {
    expect(isAppealable(null)).toBe(true);
    expect(isAppealable(undefined)).toBe(true);
  });
});
