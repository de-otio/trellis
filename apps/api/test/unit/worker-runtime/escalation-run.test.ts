/**
 * `axis-a-escalate`'s body, driven without an engine.
 *
 * The tests that earn their place here are the ORDERING ones. Every step in
 * this body is individually obvious and the safety lives entirely in the
 * sequence: a spend gate consulted after the call reports spending rather than
 * preventing it, and an admission check that runs second re-classifies media
 * the inline lane already settled. Neither is visible in a test that only
 * asserts the happy path's return value.
 */

import { describe, expect, it, vi } from "vitest";

import {
  runEscalation,
  estimateEscalationCostUsd,
  type EscalationDeps,
  type EscalationInput,
  type EscalationJobState,
  type EscalationObservation,
  type EscalationSpendConfig,
} from "../../../../worker/src/moderation/escalation-run.js";
import { createDeferredLaneConfig } from "../../../src/lib/media/deferred-lane.js";
import { ModerationProviderError } from "../../../src/lib/media/moderation-provider.js";
import type { ModerationDecision } from "../../../src/lib/media/media-lifecycle.js";

/** Obviously-mock operator values. None is an operative threshold. */
const MOCK_REVIEW_RATE_CAP = 20;
const SPEND: EscalationSpendConfig = { dailyCapUsd: 10, perMinuteRateUsd: 0.5 };

const CONFIG = createDeferredLaneConfig(
  {
    concurrency: 2,
    perTenantRateLimit: MOCK_REVIEW_RATE_CAP,
    evictionWindowMs: 60 * 60 * 1000,
    allowApprove: false,
  },
  MOCK_REVIEW_RATE_CAP,
);

const OPEN_CONFIG = createDeferredLaneConfig(
  {
    concurrency: 2,
    perTenantRateLimit: MOCK_REVIEW_RATE_CAP,
    evictionWindowMs: 60 * 60 * 1000,
    allowApprove: true,
  },
  MOCK_REVIEW_RATE_CAP,
);

const INPUT: EscalationInput = {
  jobId: "mock-job-1",
  mediaId: "mock-media-1",
  tenantId: "mock-tenant-1",
  track: "VISUAL",
  contentHash: "mock-hash",
  dedupeKey: "mock-dedupe-key",
  cause: "grey-band",
  confidence: 0.4,
};

interface Harness {
  readonly deps: EscalationDeps;
  readonly calls: string[];
  readonly published: string[];
  readonly recorded: number[];
  readonly observed: EscalationObservation[];
}

function harness(
  over: {
    job?: EscalationJobState | null;
    spendUsd?: number;
    decision?: ModerationDecision;
    escalateThrows?: unknown;
    readSpendThrows?: unknown;
    publishThrows?: unknown;
  } = {},
): Harness {
  const calls: string[] = [];
  const published: string[] = [];
  const recorded: number[] = [];
  const observed: EscalationObservation[] = [];

  const deps: EscalationDeps = {
    async readJob() {
      calls.push("readJob");
      return over.job === undefined ? { resolved: false, durationSeconds: 60 } : over.job;
    },
    async getTodaySpendUsd() {
      calls.push("getTodaySpendUsd");
      if (over.readSpendThrows !== undefined) throw over.readSpendThrows;
      return over.spendUsd ?? 0;
    },
    async recordSpendUsd(usd) {
      calls.push("recordSpendUsd");
      recorded.push(usd);
    },
    async reportCapExceeded() {
      calls.push("reportCapExceeded");
    },
    async escalate() {
      calls.push("escalate");
      if (over.escalateThrows !== undefined) throw over.escalateThrows;
      return over.decision ?? "quarantine";
    },
    async publishCompletion(body) {
      calls.push("publishCompletion");
      if (over.publishThrows !== undefined) throw over.publishThrows;
      published.push(body);
    },
    observe(event) {
      observed.push(event);
    },
  };

  return { deps, calls, published, recorded, observed };
}

// ---------------------------------------------------------------------------
// The happy path, and the order it happens in
// ---------------------------------------------------------------------------

describe("runEscalation — the happy path", () => {
  it("acks and publishes a completion", async () => {
    const h = harness();
    const d = await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(d).toEqual({ kind: "ack" });
    expect(h.published).toEqual([JSON.stringify({ track: "VISUAL", jobId: "mock-job-1" })]);
  });

  it("publishes an envelope carrying ONLY the track and the job id", async () => {
    // The completion worker re-fetches authoritative state; a verdict smuggled
    // into the envelope would be a second, divergent verdict path.
    const h = harness({ decision: "quarantine" });
    await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    const parsed = JSON.parse(h.published[0]) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["jobId", "track"]);
  });

  it("checks admission BEFORE reading spend, and spend BEFORE the provider call", async () => {
    const h = harness();
    await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(h.calls).toEqual([
      "readJob",
      "getTodaySpendUsd",
      "escalate",
      "recordSpendUsd",
      "publishCompletion",
    ]);
  });

  it("records the estimated spend after the call, because that is when it is committed", async () => {
    const h = harness();
    await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(h.recorded).toEqual([estimateEscalationCostUsd(60, SPEND)]);
  });
});

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

describe("runEscalation — admission", () => {
  it("ack-drops an already-resolved job WITHOUT calling the expensive model", async () => {
    const h = harness({ job: { resolved: true, durationSeconds: 60 } });
    const d = await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(d).toEqual({ kind: "ack-drop", cause: "already-resolved", infraFault: false });
    expect(h.calls).not.toContain("escalate");
    expect(h.published).toEqual([]);
  });

  it("ack-drops a job that no longer exists", async () => {
    const h = harness({ job: null });
    const d = await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(d).toEqual({ kind: "ack-drop", cause: "already-resolved", infraFault: false });
    expect(h.calls).not.toContain("escalate");
  });

  it("reports the shed so the lane's primary metric can attribute it", async () => {
    const h = harness({ job: { resolved: true, durationSeconds: 60 } });
    await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(h.observed).toEqual([
      { kind: "shed", cause: "already-resolved", tenantId: "mock-tenant-1" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The spend gate
// ---------------------------------------------------------------------------

describe("runEscalation — the spend gate is not optional", () => {
  it("ack-drops at the cap WITHOUT calling the expensive model", async () => {
    const h = harness({ spendUsd: SPEND.dailyCapUsd });
    const d = await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(d).toEqual({ kind: "ack-drop", cause: "spend-capped", infraFault: false });
    expect(h.calls).not.toContain("escalate");
  });

  it("does NOT retry at the cap — the same question gets the same answer", async () => {
    const h = harness({ spendUsd: SPEND.dailyCapUsd + 1 });
    const d = await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(d.kind).not.toBe("fail");
  });

  it("emits the cap-exceeded signal", async () => {
    const h = harness({ spendUsd: SPEND.dailyCapUsd });
    await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(h.calls).toContain("reportCapExceeded");
  });

  it("FAILS CLOSED on a corrupted counter rather than spending", async () => {
    const h = harness({ spendUsd: Number.NaN });
    const d = await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(d).toEqual({ kind: "ack-drop", cause: "spend-capped", infraFault: false });
    expect(h.calls).not.toContain("escalate");
  });

  it("an unreadable counter is a retry, never a defaulted zero", async () => {
    // A counter that cannot be read must stop spend. Defaulting to 0 would
    // silently disable the cap exactly when the backend is unhealthy.
    const h = harness({ readSpendThrows: new Error("counter backend down") });
    const d = await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(d.kind).toBe("fail");
    expect(h.calls).not.toContain("escalate");
  });
});

// ---------------------------------------------------------------------------
// The closed approval flag
// ---------------------------------------------------------------------------

describe("runEscalation — the lane ships unable to approve", () => {
  it("never observes an `approved` decision while the flag is closed", async () => {
    const h = harness({ decision: "approved" });
    await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    const escalated = h.observed.find((o) => o.kind === "escalated");
    expect(escalated).toEqual({
      kind: "escalated",
      tenantId: "mock-tenant-1",
      decision: "review",
    });
  });

  it("passes an approval through once the flag is opened", async () => {
    const h = harness({ decision: "approved" });
    await runEscalation(INPUT, OPEN_CONFIG, SPEND, h.deps);
    const escalated = h.observed.find((o) => o.kind === "escalated");
    expect(escalated).toMatchObject({ decision: "approved" });
  });

  it("still publishes the completion — the clamp changes the verdict, not the path", async () => {
    const h = harness({ decision: "approved" });
    const d = await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(d).toEqual({ kind: "ack" });
    expect(h.published).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("runEscalation — dispositions", () => {
  it("fails (retryable) on a transient provider error", async () => {
    const h = harness({
      escalateThrows: new ModerationProviderError("upstream 503", { retryable: true }),
    });
    const d = await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(d).toEqual({ kind: "fail", infraFault: false });
    expect(h.published).toEqual([]);
  });

  it("ack-drops a permanent provider rejection instead of retrying it three times", async () => {
    const h = harness({
      escalateThrows: new ModerationProviderError("cannot decode", { retryable: false }),
    });
    const d = await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(d).toEqual({ kind: "ack-drop", cause: "poison", infraFault: false });
  });

  it("ANNOUNCES an unattributed fault, on the branch that actually carries the flag", async () => {
    // The flag is set by exactly one classification — a typed PERMANENT error
    // the adapter could not attribute — and that classification is `poison`,
    // which ack-drops rather than throwing. An implementation that checks
    // `infraFault` only on the throwing branch compiles, reads correctly, and
    // can never fire. This test is what distinguishes the two.
    const h = harness({
      escalateThrows: new ModerationProviderError("something failed, cause unknown", {
        retryable: false,
        unknownCause: true,
      }),
    });
    const d = await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(d).toEqual({ kind: "ack-drop", cause: "poison", infraFault: true });
    expect(h.observed).toContainEqual({ kind: "infra-fault", tenantId: "mock-tenant-1" });
  });

  it("does NOT announce a fault for an attributed permanent rejection", async () => {
    // The negative control for the test above: if this also announced, the
    // alert would fire on every unsupported-media upload and be worthless.
    const h = harness({
      escalateThrows: new ModerationProviderError("unsupported media type", {
        retryable: false,
      }),
    });
    await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(h.observed.some((o) => o.kind === "infra-fault")).toBe(false);
  });

  it("never publishes a completion when the escalation did not run", async () => {
    for (const throws of [
      new ModerationProviderError("t", { retryable: true }),
      new ModerationProviderError("p", { retryable: false }),
      new Error("unknown"),
    ]) {
      const h = harness({ escalateThrows: throws });
      await runEscalation(INPUT, CONFIG, SPEND, h.deps);
      expect(h.published).toEqual([]);
    }
  });

  it("NEVER THROWS — every exit is a disposition the caller acts on", async () => {
    for (const over of [
      { escalateThrows: new Error("boom") },
      { readSpendThrows: new Error("boom") },
      { publishThrows: new Error("boom") },
      { escalateThrows: "a string, not an Error" },
      { escalateThrows: null },
      { escalateThrows: undefined as unknown as string },
    ]) {
      const h = harness(over);
      await expect(runEscalation(INPUT, CONFIG, SPEND, h.deps)).resolves.toBeDefined();
    }
  });

  it("a publish failure is a retry, not a silent success", async () => {
    // The money is already spent at this point. Acking here would lose the
    // verdict AND the spend, and the job would sit open until it aged out.
    const h = harness({ publishThrows: new Error("queue unavailable") });
    const d = await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(d.kind).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("runEscalation — replay safety", () => {
  it("reads no clock and no RNG", async () => {
    // Durable task bodies replay on recovery. A body that reads Date.now() or
    // Math.random() between checkpoints produces a different value on replay,
    // which is how a replayed run diverges from the one it is replaying.
    const now = vi.spyOn(Date, "now");
    const random = vi.spyOn(Math, "random");
    const h = harness();
    await runEscalation(INPUT, CONFIG, SPEND, h.deps);
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    now.mockRestore();
    random.mockRestore();
  });

  it("is idempotent in its observable effects for the same input", async () => {
    const a = harness();
    const b = harness();
    const da = await runEscalation(INPUT, CONFIG, SPEND, a.deps);
    const db = await runEscalation(INPUT, CONFIG, SPEND, b.deps);
    expect(da).toEqual(db);
    expect(a.published).toEqual(b.published);
    expect(a.calls).toEqual(b.calls);
  });
});

describe("estimateEscalationCostUsd", () => {
  it("has the same shape as the inline estimator, because it is one budget", () => {
    expect(estimateEscalationCostUsd(60, { dailyCapUsd: 1, perMinuteRateUsd: 0.5 })).toBe(0.5);
    expect(estimateEscalationCostUsd(0, { dailyCapUsd: 1, perMinuteRateUsd: 0.5 })).toBe(0);
  });

  it("throws rather than returning a silently-wrong under-estimate", () => {
    expect(() => estimateEscalationCostUsd(-1, SPEND)).toThrow(TypeError);
    expect(() => estimateEscalationCostUsd(Number.NaN, SPEND)).toThrow(TypeError);
    expect(() =>
      estimateEscalationCostUsd(60, { dailyCapUsd: 1, perMinuteRateUsd: Number.NaN }),
    ).toThrow(TypeError);
  });
});
