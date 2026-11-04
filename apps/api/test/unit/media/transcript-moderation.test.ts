/**
 * Tests for transcript-moderation.ts
 *
 * Obligations:
 *   1. Clean transcript -> seam decision is honoured (all three known values).
 *   2. Seam throws           -> "review"  (fail closed).
 *   3. Unknown/garbage decision from seam -> "review" (fail closed).
 *   4. Null/undefined verdict object     -> "review" (fail closed).
 *   5. No failure path returns "approved".
 *   6. Empty / whitespace-only transcript -> "approved" with reason
 *      "no-speech"; the seam is not consulted.
 *   7. Retryable / infraFault errors are re-thrown; other errors and malformed
 *      verdicts -> "review".
 *
 * Properties (fast-check):
 *   A. For any non-throwing seam whose decision is one of the three known
 *      values the result equals that decision.
 *   B. For any input, if the seam throws the result is always "review".
 *   C. No execution path ever returns a value outside {"approved","review","quarantine"}.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  moderateTranscript,
  transcriptToModerationDecision,
} from "../../../src/lib/media/transcript-moderation.js";
import { ModerationProviderError } from "../../../src/lib/media/moderation-provider.js";
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
// Obligation 6: an empty / whitespace-only transcript is silence — approved
// with reason `no-speech`, and the seam is not consulted
// ---------------------------------------------------------------------------

describe("moderateTranscript — empty transcript", () => {
  for (const blank of ["", "   ", "\n\t \r\n"]) {
    it(`approves ${JSON.stringify(blank)} with reason no-speech`, async () => {
      const seam = new RecordingProvider(verdict("quarantine"));
      expect(await moderateTranscript(blank, seam)).toEqual({
        decision: "approved",
        reason: "no-speech",
      });
      // Nothing to classify, so nothing is sent to the provider.
      expect(seam.calls).toHaveLength(0);
    });
  }

  it("approves silence without reaching a seam that would have thrown", async () => {
    const result = await moderateTranscript("", new ThrowingProvider());
    expect(result).toEqual({ decision: "approved", reason: "no-speech" });
  });

  it("transcriptToModerationDecision returns the same approval", async () => {
    expect(await transcriptToModerationDecision("  ", new ThrowingProvider())).toBe(
      "approved",
    );
  });

  it("a transcript with any text goes to the seam and carries no reason", async () => {
    const seam = new RecordingProvider(verdict("review"));
    const result = await moderateTranscript(" hi ", seam);
    expect(seam.calls).toEqual([" hi "]);
    expect(result).toEqual({ decision: "review" });
  });
});

// ---------------------------------------------------------------------------
// Retryable / infrastructure faults propagate; malformed verdicts review
// ---------------------------------------------------------------------------

describe("moderateTranscript — whose fault the failure was", () => {
  it("re-throws a retryable provider error", async () => {
    const err = new ModerationProviderError("throttled", { retryable: true });
    const seam = {
      async moderateText(): Promise<ModerationVerdict> {
        throw err;
      },
    };
    await expect(moderateTranscript("hello", seam)).rejects.toBe(err);
    await expect(transcriptToModerationDecision("hello", seam)).rejects.toBe(err);
  });

  it("re-throws an infrastructure fault even when it is not retryable", async () => {
    const err = new ModerationProviderError("unattributable", {
      retryable: false,
      infraFault: true,
    });
    const seam = {
      async moderateText(): Promise<ModerationVerdict> {
        throw err;
      },
    };
    await expect(moderateTranscript("hello", seam)).rejects.toBe(err);
  });

  it("re-throws a structurally-marked error from a foreign copy of the class", async () => {
    const err = Object.assign(new Error("transient"), { retryable: true });
    const seam = {
      async moderateText(): Promise<ModerationVerdict> {
        throw err;
      },
    };
    await expect(moderateTranscript("hello", seam)).rejects.toBe(err);
  });

  it("reviews a permanent provider error", async () => {
    const seam = {
      async moderateText(): Promise<ModerationVerdict> {
        throw new ModerationProviderError("rejected", { retryable: false });
      },
    };
    expect(await moderateTranscript("hello", seam)).toEqual({ decision: "review" });
  });

  it("reviews a malformed verdict", async () => {
    for (const bad of [null, undefined, "approved", { labels: [] }, { decision: "nope" }]) {
      const seam = {
        async moderateText(): Promise<ModerationVerdict> {
          return bad as unknown as ModerationVerdict;
        },
      };
      expect(await moderateTranscript("hello", seam)).toEqual({ decision: "review" });
    }
  });
});

// ---------------------------------------------------------------------------
// Property A: non-throwing seam with known decision => result equals decision
// ---------------------------------------------------------------------------

describe("property A — known decision round-trips", () => {
  it("result === seam decision for any transcript and any known decision", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((t) => t.trim().length > 0),
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
      fc.asyncProperty(fc.string().filter((t) => t.trim().length > 0), async (transcript) => {
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
        fc.string().filter((t) => t.trim().length > 0),
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
      fc.asyncProperty(fc.string().filter((t) => t.trim().length > 0), async (transcript) => {
        const seam = new ThrowingProvider();
        const result = await transcriptToModerationDecision(transcript, seam);
        return knownDecisions.has(result);
      }),
    );
  });
});
