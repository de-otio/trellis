/**
 * moderation-deadline.ts — bound how long a moderation call may take, and make
 * the deadline bind the DECISION rather than merely the wait.
 *
 * A timeout that only stops waiting is not a timeout. Two halves are needed and
 * both are here:
 *
 *  1. **Abort the call.** The wrapper passes an `AbortSignal` down, so an
 *     adapter that honours it stops burning a connection and a provider quota
 *     on an answer nobody is listening for any more.
 *  2. **Commit the decision at the deadline.** When the clock runs out the
 *     wrapper throws — permanently, for that call. If the provider resolves
 *     `approved` a second later, that resolution is DISCARDED: the caller has
 *     already recorded a fail-closed verdict, and a late success that could
 *     overwrite it would mean the timeout was advisory. A late rejection is
 *     swallowed too, so it cannot surface as an unhandled rejection and take
 *     the worker down.
 *
 * The timeout thrown is `retryable: true`. A deadline says something about the
 * moment, not about the media: the same bytes may well classify fine on the
 * next delivery. Retrying is bounded by the existing delivery-attempt limit and
 * its dead-letter queue, so the fail-open-for-retry choice cannot loop forever,
 * and it keeps a provider outage visible as retries rather than silently
 * absorbed as a pile of review items.
 *
 * NO COMPILED-IN TIMEOUT. The value is operator config. A timeout baked into a
 * public tarball tells an adversary exactly how long a call must be stalled for
 * to force every upload into review — a cheap denial of moderation. Absence is
 * a wiring error, and this module refuses to construct rather than inventing
 * one.
 */

import {
  ModerationProviderError,
  type ImageRef,
  type MediaModerationProvider,
  type ModerationCallOptions,
  type ModerationVerdict,
  type S3Ref,
  type VideoModerationStart,
} from "./moderation-provider.js";

/** Thrown at wiring time when no deadline was configured. */
export class ModerationDeadlineConfigError extends Error {
  constructor() {
    super(
      "moderation deadline requires an operator-supplied timeout; refusing to run moderation calls unbounded, and refusing to invent a bound",
    );
    this.name = "ModerationDeadlineConfigError";
  }
}

export interface ModerationDeadlineConfig {
  /** Milliseconds a single seam call may take. Operator-supplied; no default. */
  readonly timeoutMs?: number;
}

/** Timer seam, so tests drive the clock instead of waiting on it. */
export interface DeadlineTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const REAL_TIMERS: DeadlineTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The error a deadline breach throws. Typed, and retryable by contract. */
export function deadlineExceeded(operation: string): ModerationProviderError {
  return new ModerationProviderError(
    `moderation ${operation} exceeded its deadline`,
    { retryable: true },
  );
}

/**
 * Race a provider call against the deadline.
 *
 * Returns the provider's value if it settles first. Otherwise aborts the call
 * and throws {@link deadlineExceeded} — and from that moment the provider's
 * eventual outcome, success or failure, is inert.
 */
async function raceDeadline<T>(
  operation: string,
  timeoutMs: number,
  timers: DeadlineTimers,
  caller: ModerationCallOptions | undefined,
  run: (options: ModerationCallOptions) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  // Honour a signal the caller already owns: an outer abort must abort inward
  // too, or a cancelled request keeps a provider call alive behind it.
  const forwardAbort = (): void => controller.abort();
  let listening = false;
  if (caller?.signal !== undefined) {
    if (caller.signal.aborted) {
      controller.abort();
    } else {
      caller.signal.addEventListener("abort", forwardAbort, { once: true });
      listening = true;
    }
  }

  let settled = false;
  let timer: unknown;

  /**
   * Detach from the caller's signal once this call is over. Without this a
   * long-lived signal reused across many calls accumulates one listener per
   * call — a slow leak that eventually announces itself as a max-listeners
   * warning and, before that, as memory nobody attributes to moderation.
   */
  const release = (): void => {
    if (listening && caller?.signal !== undefined) {
      caller.signal.removeEventListener("abort", forwardAbort);
      listening = false;
    }
  };

  const work = run({ ...caller, signal: controller.signal });

  return await new Promise<T>((resolve, reject) => {
    timer = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      release();
      controller.abort();
      reject(deadlineExceeded(operation));
    }, timeoutMs);

    work.then(
      (value) => {
        if (settled) return; // Late success: discarded, by design.
        settled = true;
        timers.clearTimeout(timer);
        release();
        resolve(value);
      },
      (err) => {
        if (settled) return; // Late failure: swallowed, never unhandled.
        settled = true;
        timers.clearTimeout(timer);
        release();
        reject(err);
      },
    );
  });
}

/**
 * Wrap a provider so every seam call is deadline-bounded.
 *
 * Throws {@link ModerationDeadlineConfigError} when no timeout was configured —
 * the "refuse to enable the feature" form of failing closed, chosen over a
 * per-call review because an unconfigured deadline is a deployment mistake that
 * should be visible at wiring time rather than as a slow drip of review items.
 */
export function withModerationDeadline(
  provider: MediaModerationProvider,
  config: ModerationDeadlineConfig,
  timers: DeadlineTimers = REAL_TIMERS,
): MediaModerationProvider {
  const timeoutMs = config?.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new ModerationDeadlineConfigError();
  }

  return {
    // Pass the inner name through: a deadline changes WHEN core gives up, not
    // whose classifier ran. Naming the wrapper here would split the wrapped
    // provider's counters and cache entries in two the moment an operator
    // configured a timeout.
    name: provider.name,
    async moderateImage(
      input: ImageRef,
      options?: ModerationCallOptions,
    ): Promise<ModerationVerdict> {
      return raceDeadline("moderateImage", timeoutMs, timers, options, (o) =>
        provider.moderateImage(input, o),
      );
    },
    async startVideoModeration(
      input: S3Ref,
      options?: ModerationCallOptions,
    ): Promise<VideoModerationStart> {
      return raceDeadline(
        "startVideoModeration",
        timeoutMs,
        timers,
        options,
        (o) => provider.startVideoModeration(input, o),
      );
    },
    async getVideoModeration(
      jobId: string,
      options?: ModerationCallOptions,
    ): Promise<ModerationVerdict> {
      return raceDeadline("getVideoModeration", timeoutMs, timers, options, (o) =>
        provider.getVideoModeration(jobId, o),
      );
    },
  };
}
