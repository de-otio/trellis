/**
 * Tests for transcript-moderation.ts
 *
 * Obligations:
 *   1. Clean transcript -> seam decision is honoured (all three known values).
 *   2. Seam throws           -> "review"  (fail closed).
 *   3. Unknown/garbage decision from seam -> "review" (fail closed).
 *   4. Null/undefined verdict object     -> "review" (fail closed).
 *   5. No failure path returns "approved".
 *   6. Empty transcript is passed to the seam unchanged; the seam's decision
 *      is honoured (including "approved" when the seam explicitly approves it).
 *   7. Seam throws on empty input         -> "review".
 *
 * Properties (fast-check):
 *   A. For any non-throwing seam whose decision is one of the three known
 *      values the result equals that decision.
 *   B. For any input, if the seam throws the result is always "review".
 *   C. No execution path ever returns a value outside {"approved","review","quarantine"}.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { transcriptToModerationDecision } from "../../../src/lib/media/transcript-moderation.js";
import {
  MockTextModerationProvider,
} from "../../../src/lib/media/text-moderation.js";
import type { ModerationVerdict } from "../../../src/lib/media/moderation-provider.js";
import type { ModerationDecision } from "../../../src/lib/media/media-lifecycle.js";
import { ALL_MODERATION_DECISIONS } from "../../../src/lib/media/media-lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verdict(decision: ModerationDecision): ModerationVerdict {
  return { decision, labels: [], provider: "test" };
}

// A TextModerationProvider that always throws.
class ThrowingProvider {
  async moderateText(_text: string): Promise<ModerationVerdict> {
    throw new Error("seam error");
  }
}

// A TextModerationProvider that returns a raw object with any `decision` value.
class RawDecisionProvider {
  constructor(private readonly raw: string) {}
  async moderateText(_text: string): Promise<ModerationVerdict> {
    return { decision: this.raw as ModerationDecision, labels: [], provider: "raw" };
  }
}

// A TextModerationProvider that returns null (simulates a very broken adapter).
class NullReturnProvider {
  async moderateText(_text: string): Promise<ModerationVerdict> {
    return null as unknown as ModerationVerdict;
  }
}

// A TextModerationProvider that records the exact text it received.
class RecordingProvider {
  calls: string[] = [];
  private readonly canned: ModerationVerdict;
  constructor(canned: ModerationVerdict) {
    this.canned = canned;
  }
  async moderateText(text: string): Promise<ModerationVerdict> {
    this.calls.push(text);
    return this.canned;
  }
}

// ---------------------------------------------------------------------------
// Unit tests — obligation 1: known decisions are passed through
// ---------------------------------------------------------------------------

describe("transcriptToModerationDecision — known decisions", () => {
  for (const decision of ALL_MODERATION_DECISIONS) {
    it(`returns "${decision}" when seam returns "${decision}"`, async () => {
      const seam = new MockTextModerationProvider(verdict(decision));
      const result = await transcriptToModerationDecision("hello world", seam);
      expect(result).toBe(decision);
    });
  }
});

// ---------------------------------------------------------------------------
// Obligation 2: seam throws => "review"
// ---------------------------------------------------------------------------

describe("transcriptToModerationDecision — seam throws", () => {
  it("returns review when seam throws a generic Error", async () => {
    const seam = new ThrowingProvider();
    const result = await transcriptToModerationDecision("some text", seam);
    expect(result).toBe("review");
  });

  it("returns review when seam throws a non-Error value", async () => {
    const seam = {
      async moderateText(_: string): Promise<ModerationVerdict> {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "string-thrown";
      },
    };
    const result = await transcriptToModerationDecision("some text", seam);
    expect(result).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// Obligation 3: unknown/garbage decision => "review"
// ---------------------------------------------------------------------------

describe("transcriptToModerationDecision — unknown decision", () => {
  it("returns review for an unknown decision string", async () => {
    const seam = new RawDecisionProvider("unknown-token");
    const result = await transcriptToModerationDecision("hello", seam);
    expect(result).toBe("review");
  });

  it("returns review for empty-string decision", async () => {
    const seam = new RawDecisionProvider("");
    const result = await transcriptToModerationDecision("hello", seam);
    expect(result).toBe("review");
  });

  it("returns review for REJECTED decision (not a valid classifier decision)", async () => {
    // REJECTED is a lifecycle status, not a classifier decision.
    const seam = new RawDecisionProvider("REJECTED");
    const result = await transcriptToModerationDecision("hello", seam);
    expect(result).toBe("review");
  });

  it("returns review for APPROVED (uppercase, not the canonical lowercase)", async () => {
    const seam = new RawDecisionProvider("APPROVED");
    const result = await transcriptToModerationDecision("hello", seam);
    expect(result).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// Obligation 4: null/undefined verdict object => "review"
// ---------------------------------------------------------------------------

describe("transcriptToModerationDecision — null/undefined verdict", () => {
  it("returns review when seam resolves to null", async () => {
    const seam = new NullReturnProvider();
    const result = await transcriptToModerationDecision("hello", seam);
    expect(result).toBe("review");
  });

  it("returns review when seam resolves to undefined", async () => {
    const seam = {
      async moderateText(_: string): Promise<ModerationVerdict> {
        return undefined as unknown as ModerationVerdict;
      },
    };
    const result = await transcriptToModerationDecision("hello", seam);
    expect(result).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// Obligation 5: no failure path returns "approved"
// ---------------------------------------------------------------------------

describe("transcriptToModerationDecision — approved never from failure", () => {
  it("throwing seam never returns approved", async () => {
    const result = await transcriptToModerationDecision("x", new ThrowingProvider());
    expect(result).not.toBe("approved");
  });

  it("unknown decision never returns approved", async () => {
    const result = await transcriptToModerationDecision("x", new RawDecisionProvider("garbage"));
    expect(result).not.toBe("approved");
  });

  it("null verdict never returns approved", async () => {
    const result = await transcriptToModerationDecision("x", new NullReturnProvider());
    expect(result).not.toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// Obligation 6: empty transcript is passed to the seam unchanged
// ---------------------------------------------------------------------------

describe("transcriptToModerationDecision — empty transcript", () => {
  it("passes the empty string to the seam as-is", async () => {
    const seam = new RecordingProvider(verdict("review"));
    await transcriptToModerationDecision("", seam);
    expect(seam.calls).toHaveLength(1);
    expect(seam.calls[0]).toBe("");
  });

  it("honours approved when seam explicitly approves empty input", async () => {
    const seam = new MockTextModerationProvider(verdict("approved"));
    const result = await transcriptToModerationDecision("", seam);
    expect(result).toBe("approved");
  });

  it("honours quarantine when seam flags empty input", async () => {
    const seam = new MockTextModerationProvider(verdict("quarantine"));
    const result = await transcriptToModerationDecision("", seam);
    expect(result).toBe("quarantine");
  });

  it("honours review when seam is uncertain on empty input", async () => {
    const seam = new MockTextModerationProvider(verdict("review"));
    const result = await transcriptToModerationDecision("", seam);
    expect(result).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// Obligation 7: seam throws on empty input => "review"
// ---------------------------------------------------------------------------

describe("transcriptToModerationDecision — seam throws on empty", () => {
  it("returns review when seam throws on empty transcript", async () => {
    const seam = new ThrowingProvider();
    const result = await transcriptToModerationDecision("", seam);
    expect(result).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// Property A: non-throwing seam with known decision => result equals decision
// ---------------------------------------------------------------------------

describe("property A — known decision round-trips", () => {
  it("result === seam decision for any transcript and any known decision", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.constantFrom<ModerationDecision>("approved", "review", "quarantine"),
        async (transcript, decision) => {
          const seam = new MockTextModerationProvider(verdict(decision));
          const result = await transcriptToModerationDecision(transcript, seam);
          return result === decision;
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property B: seam throws => always "review" for any input
// ---------------------------------------------------------------------------

describe("property B — throw always resolves to review", () => {
  it("for any transcript, a throwing seam always returns review", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (transcript) => {
        const seam = new ThrowingProvider();
        const result = await transcriptToModerationDecision(transcript, seam);
        return result === "review";
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property C: result always within the 3-value decision set
// ---------------------------------------------------------------------------

describe("property C — result is always a known decision", () => {
  const knownDecisions = new Set<string>(["approved", "review", "quarantine"]);

  it("non-throwing seam returns a known decision for any transcript", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.constantFrom<ModerationDecision>("approved", "review", "quarantine"),
        async (transcript, decision) => {
          const seam = new MockTextModerationProvider(verdict(decision));
          const result = await transcriptToModerationDecision(transcript, seam);
          return knownDecisions.has(result);
        },
      ),
    );
  });

  it("unknown-decision seam always returns a known decision", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string().filter((s) => !knownDecisions.has(s)),
        async (transcript, rawDecision) => {
          const seam = new RawDecisionProvider(rawDecision);
          const result = await transcriptToModerationDecision(transcript, seam);
          return knownDecisions.has(result);
        },
      ),
    );
  });

  it("throwing seam always returns a known decision", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (transcript) => {
        const seam = new ThrowingProvider();
        const result = await transcriptToModerationDecision(transcript, seam);
        return knownDecisions.has(result);
      }),
    );
  });
});
