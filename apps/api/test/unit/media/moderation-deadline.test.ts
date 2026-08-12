import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ModerationDeadlineConfigError,
  withModerationDeadline,
} from "../../../src/lib/media/moderation-deadline.js";
import {
  isModerationProviderError,
  MockModerationProvider,
  type MediaModerationProvider,
  type ModerationVerdict,
} from "../../../src/lib/media/moderation-provider.js";

const TIMEOUT_MS = 1000;
const REF = { bucket: "example-media-bucket", key: "cas/tenant/hash" };

function approved(): ModerationVerdict {
  return { decision: "approved", labels: [], provider: "mock" };
}

/** A provider whose calls settle only when the test says so. */
function controllable(): {
  provider: MediaModerationProvider;
  settle: (verdict: ModerationVerdict) => void;
  fail: (err: unknown) => void;
  sawAbort: () => boolean;
} {
  let resolveFn: (v: ModerationVerdict) => void = () => {};
  let rejectFn: (e: unknown) => void = () => {};
  let aborted = false;
  const pending = () =>
    new Promise<ModerationVerdict>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
  // An adapter learns about an abort two ways: the event, or the flag being
  // already set when the call starts. The double honours both, because a real
  // adapter must too — a signal that arrived first fires no event.
  const watch = (options?: { signal?: AbortSignal }): void => {
    if (options?.signal?.aborted === true) aborted = true;
    options?.signal?.addEventListener("abort", () => {
      aborted = true;
    });
  };
  const provider: MediaModerationProvider = {
    async moderateImage(_input, options) {
      watch(options);
      return pending();
    },
    async startVideoModeration(_input, options) {
      watch(options);
      await pending();
      return { jobId: "never" };
    },
    async getVideoModeration(_jobId, options) {
      watch(options);
      return pending();
    },
  };
  return {
    provider,
    settle: (v) => resolveFn(v),
    fail: (e) => rejectFn(e),
    sawAbort: () => aborted,
  };
}

describe("withModerationDeadline — refuses to run unbounded", () => {
  it("throws when no timeout was configured", () => {
    const provider = new MockModerationProvider();
    expect(() => withModerationDeadline(provider, {})).toThrow(
      ModerationDeadlineConfigError,
    );
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => withModerationDeadline(provider, { timeoutMs: bad })).toThrow(
        ModerationDeadlineConfigError,
      );
    }
  });
});

describe("withModerationDeadline — the deadline binds the decision", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a fast verdict straight through", async () => {
    const inner = new MockModerationProvider();
    inner.setImageVerdict(approved());
    const wrapped = withModerationDeadline(inner, { timeoutMs: TIMEOUT_MS });

    await expect(wrapped.moderateImage(REF)).resolves.toEqual(approved());
  });

  it("throws a typed RETRYABLE error when the deadline passes", async () => {
    const { provider } = controllable();
    const wrapped = withModerationDeadline(provider, { timeoutMs: TIMEOUT_MS });

    const call = wrapped.moderateImage(REF);
    const assertion = expect(call).rejects.toSatisfy(
      (err: unknown) => isModerationProviderError(err) && err.retryable === true,
    );
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await assertion;
  });

  it("aborts the provider call at the deadline", async () => {
    const { provider, sawAbort } = controllable();
    const wrapped = withModerationDeadline(provider, { timeoutMs: TIMEOUT_MS });

    const call = wrapped.moderateImage(REF).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await call;

    expect(sawAbort()).toBe(true);
  });

  it("DISCARDS a provider that resolves approved after the deadline", async () => {
    // The whole point: a late success must not be able to overturn the
    // fail-closed outcome the caller has already committed to.
    const { provider, settle } = controllable();
    const wrapped = withModerationDeadline(provider, { timeoutMs: TIMEOUT_MS });

    let outcome: string | undefined;
    const call = wrapped.moderateImage(REF).then(
      (v) => {
        outcome = `resolved:${v.decision}`;
      },
      (err) => {
        outcome = isModerationProviderError(err) ? "timed-out" : "other-error";
      },
    );

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await call;
    expect(outcome).toBe("timed-out");

    // The provider finally answers "approved" — far too late.
    settle(approved());
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 10);

    expect(outcome).toBe("timed-out");
  });

  it("swallows a late REJECTION rather than letting it go unhandled", async () => {
    const { provider, fail } = controllable();
    const wrapped = withModerationDeadline(provider, { timeoutMs: TIMEOUT_MS });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    const call = wrapped.moderateImage(REF).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await call;

    fail(new Error("provider blew up, eventually"));
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("propagates a provider error that arrives before the deadline", async () => {
    const inner = new MockModerationProvider();
    inner.setImageResponder(async () => {
      throw new Error("provider said no");
    });
    const wrapped = withModerationDeadline(inner, { timeoutMs: TIMEOUT_MS });

    await expect(wrapped.moderateImage(REF)).rejects.toThrow("provider said no");
  });

  it("bounds the video start and poll calls too", async () => {
    const { provider } = controllable();
    const wrapped = withModerationDeadline(provider, { timeoutMs: TIMEOUT_MS });

    const start = expect(wrapped.startVideoModeration(REF)).rejects.toSatisfy(
      (err: unknown) => isModerationProviderError(err) && err.retryable === true,
    );
    const poll = expect(wrapped.getVideoModeration("job-1")).rejects.toSatisfy(
      (err: unknown) => isModerationProviderError(err) && err.retryable === true,
    );
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await start;
    await poll;
  });

  it("aborts inward when the CALLER's own signal aborts", async () => {
    const { provider, sawAbort } = controllable();
    const wrapped = withModerationDeadline(provider, { timeoutMs: TIMEOUT_MS });
    const controller = new AbortController();

    const call = wrapped
      .moderateImage(REF, { signal: controller.signal })
      .catch(() => undefined);
    controller.abort();
    await Promise.resolve();

    expect(sawAbort()).toBe(true);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await call;
  });

  it("aborts inward immediately when the caller's signal is ALREADY aborted", async () => {
    const { provider, sawAbort } = controllable();
    const wrapped = withModerationDeadline(provider, { timeoutMs: TIMEOUT_MS });
    const controller = new AbortController();
    controller.abort();

    const call = wrapped
      .moderateImage(REF, { signal: controller.signal })
      .catch(() => undefined);
    await Promise.resolve();
    expect(sawAbort()).toBe(true);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await call;
  });
});
