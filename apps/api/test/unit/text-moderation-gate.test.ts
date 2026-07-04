/**
 * Unit Tests: text-moderation-gate.ts (T4 — fail-closed posting gate)
 *
 * THE fail-closed invariant for user text on the posting flow:
 * only an affirmative `approved` verdict lets content through. Everything else
 * — quarantine, review, an unknown decision token, a provider that throws, and
 * the un-wired Null default — produces an error Response (content NOT
 * persisted, NOT served).
 */

import { afterEach, describe, expect, it } from "vitest";
import { gateTextOrRespond } from "../../src/lib/text-moderation-gate.js";
import {
  __resetTextModerationProviderForTests,
  setTextModerationProvider,
} from "../../src/lib/media/request-text-moderation.js";
import { MockTextModerationProvider } from "../../src/lib/media/text-moderation.js";
import type { ModerationVerdict } from "../../src/lib/media/moderation-provider.js";

const REJECT_MSG = "Your post contains inappropriate content.";

function inject(verdict: ModerationVerdict): void {
  setTextModerationProvider(new MockTextModerationProvider(verdict));
}

afterEach(() => {
  __resetTextModerationProviderForTests();
});

describe("gateTextOrRespond — approved passthrough", () => {
  it("returns null (caller proceeds) ONLY on an affirmative approved verdict", async () => {
    inject({ decision: "approved", labels: [], provider: "mock-text" });
    expect(await gateTextOrRespond("nice dog", REJECT_MSG)).toBeNull();
  });
});

describe("gateTextOrRespond — positive flag (quarantine)", () => {
  it("returns 400 CONTENT_REJECTED and the caller's message", async () => {
    inject({
      decision: "quarantine",
      labels: [{ category: "category_a", confidence: 0.99 }],
      provider: "mock-text",
    });
    const response = await gateTextOrRespond("bad text", REJECT_MSG);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
    const body = await response!.json();
    expect(body.error).toBe("CONTENT_REJECTED");
    expect(body.message).toBe(REJECT_MSG);
  });

  it("does not leak provider labels/internals in the response body", async () => {
    inject({
      decision: "quarantine",
      labels: [{ category: "category_a", confidence: 0.99 }],
      provider: "mock-text",
    });
    const response = await gateTextOrRespond("bad text", REJECT_MSG);
    const body = await response!.json();
    expect(Object.keys(body).sort()).toEqual(["error", "message"]);
  });
});

describe("gateTextOrRespond — FAIL CLOSED (review / fault / unknown)", () => {
  it("review verdict → 503 MODERATION_UNAVAILABLE (content held, not persisted)", async () => {
    inject({ decision: "review", labels: [], provider: "mock-text" });
    const response = await gateTextOrRespond("uncertain text", REJECT_MSG);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    expect((await response!.json()).error).toBe("MODERATION_UNAVAILABLE");
  });

  it("provider ERROR (throw) → 503, never approval, never a bubbled 500", async () => {
    setTextModerationProvider({
      moderateText: async () => {
        throw new Error("hosted moderation API unreachable");
      },
    });
    const response = await gateTextOrRespond("any text", REJECT_MSG);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    expect((await response!.json()).error).toBe("MODERATION_UNAVAILABLE");
  });

  it("unknown/future decision token → 503 (uncertainty never approves)", async () => {
    inject({
      decision: "totally-new-decision" as never,
      labels: [],
      provider: "mock-text",
    });
    const response = await gateTextOrRespond("any text", REJECT_MSG);
    expect(response!.status).toBe(503);
  });

  it("UN-WIRED seam (Null default) → 503 (an un-wired deploy cannot auto-approve text)", async () => {
    // No provider injected at all — the seam's fail-closed Null default rules.
    const response = await gateTextOrRespond("any text", REJECT_MSG);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    expect((await response!.json()).error).toBe("MODERATION_UNAVAILABLE");
  });

  it("a non-approved outcome NEVER returns null on any path", async () => {
    for (const decision of ["review", "quarantine", "bogus"] as const) {
      inject({ decision: decision as never, labels: [], provider: "mock-text" });
      expect(await gateTextOrRespond("t", REJECT_MSG)).not.toBeNull();
    }
  });
});
