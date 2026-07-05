// CONTRACT: stable — coordinate changes. AR5 media AI-spend guard seam.
//
// The media-processing worker starts paid AI jobs (video moderation,
// transcription) whose cost scales with media duration. This module is the
// worker's DAILY SPEND GUARD: a pure cost-estimation core plus the capability
// seam for a consuming-app-provided daily spend counter (Skybber implements it
// on DynamoDB). Mirroring the media-ports.ts seam discipline: core ships the
// *interface* plus a test-only Mock; the consuming app injects the concrete
// counter adapter at startup. Core imports NO cloud SDK here.
//
// Threshold-secrecy rule: the daily cap and the per-minute rate are RUNTIME
// CONFIG (Env/SSM-sourced values carried in MediaSpendConfig), never literals
// in this file — it ships in the PUBLIC npm tarball.
//
// Fail-closed posture:
//   - `isOverDailyCap` treats a non-finite counter value as OVER the cap: a
//     corrupted counter must stop spend, not silently wave jobs through.
//   - `estimateJobCostUsd` throws on invalid inputs rather than returning a
//     silently-wrong (under-)estimate; the worker's classifier treats the
//     throw as retryable, so the job is retried/DLQ'd, never run unguarded.
//   - A cap of 0 (or negative) blocks ALL new AI jobs — the operator's
//     emergency stop, not a "disabled" sentinel. Absent config disables the
//     guard instead (see the worker's wiring rules).

// ---------------------------------------------------------------------------
// Config + seam
// ---------------------------------------------------------------------------

/**
 * The spend-guard slice of the worker config. Both values are operator-tuned
 * runtime config sourced from Env/SSM by the consuming app (never literals).
 */
export interface MediaSpendConfig {
  /** Daily estimated-spend ceiling (USD). At/above it, new AI jobs stop. */
  readonly dailyCapUsd: number;
  /**
   * Combined per-minute-of-media rate (USD/min) covering the AI jobs one
   * processed upload triggers (video moderation + transcription + downstream
   * text moderation). An intentionally coarse operator-owned estimate.
   */
  readonly perMinuteRateUsd: number;
}

/**
 * The daily spend counter the worker consults before starting paid AI jobs.
 * Implemented by the consuming app (Skybber: a TTL'd DynamoDB counter item);
 * in tests by {@link MockSpendGuardPort}.
 */
export interface MediaSpendGuardPort {
  /**
   * Today's accumulated estimated spend (USD). MUST throw on a backend error —
   * the worker fails CLOSED (retry/DLQ) when the counter cannot be read; a
   * defaulted 0 here would silently disable the cap exactly when the backend
   * is unhealthy.
   */
  getTodaySpendUsd(): Promise<number>;
  /**
   * Add one started job's estimated cost (USD) to today's counter. Called
   * AFTER the jobs were started (the money is committed at that point). May
   * throw; the worker logs and acks anyway — see the worker's documented
   * fail-open-on-record-error note.
   */
  recordSpendUsd(estimatedUsd: number): Promise<void>;
  /**
   * Signal that a job was short-circuited because the cap was reached (the
   * adapter emits an observability metric). Best-effort: implementations
   * should not throw, and the worker ignores failures.
   */
  reportCapExceeded(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure functional core
// ---------------------------------------------------------------------------

/**
 * Estimate the AI cost (USD) of processing one upload of `durationSeconds`,
 * at the operator-configured `perMinuteRateUsd`.
 *
 * Throws on non-finite or negative inputs: a silently-wrong estimate would
 * corrupt the counter (an under-estimate is a cost leak), so invalid inputs
 * fail loudly and the caller's classifier retries/DLQs the job (fail closed).
 */
export function estimateJobCostUsd(
  durationSeconds: number,
  perMinuteRateUsd: number,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new TypeError(
      `estimateJobCostUsd: invalid durationSeconds ${String(durationSeconds)}`,
    );
  }
  if (!Number.isFinite(perMinuteRateUsd) || perMinuteRateUsd < 0) {
    throw new TypeError(
      `estimateJobCostUsd: invalid perMinuteRateUsd ${String(perMinuteRateUsd)}`,
    );
  }
  return (durationSeconds / 60) * perMinuteRateUsd;
}

/**
 * Whether today's accumulated spend has reached the daily cap.
 *
 * - `currentSpendUsd >= dailyCapUsd` is over (the cap is a ceiling, not a
 *   budget to exactly consume; equality blocks the next job).
 * - A non-finite `currentSpendUsd` (corrupted counter) is OVER — fail closed.
 * - A cap ≤ 0 blocks everything (operator emergency stop).
 */
export function isOverDailyCap(
  currentSpendUsd: number,
  dailyCapUsd: number,
): boolean {
  if (!Number.isFinite(currentSpendUsd)) {
    return true;
  }
  return currentSpendUsd >= dailyCapUsd;
}

// ===========================================================================
// Mock implementation (test-only). Deterministic, in-memory, no outside I/O.
// ===========================================================================

/**
 * In-memory MediaSpendGuardPort. Tests program the current counter value (or
 * a read failure) and assert the recorded amounts / cap-exceeded signals.
 */
export class MockSpendGuardPort implements MediaSpendGuardPort {
  private spendUsd: number;
  private readError: Error | undefined;
  private recordError: Error | undefined;

  /** Records of each recordSpendUsd call, for assertions. */
  readonly recorded: number[] = [];
  /** Number of reportCapExceeded calls, for assertions. */
  capExceededReports = 0;

  constructor(opts: { spendUsd?: number } = {}) {
    this.spendUsd = opts.spendUsd ?? 0;
  }

  /** Program the counter value subsequent reads return. */
  setSpendUsd(usd: number): void {
    this.spendUsd = usd;
  }

  /** Program getTodaySpendUsd to throw (backend outage). */
  failReads(err: Error): void {
    this.readError = err;
  }

  /** Program recordSpendUsd to throw (backend outage on the write path). */
  failRecords(err: Error): void {
    this.recordError = err;
  }

  async getTodaySpendUsd(): Promise<number> {
    if (this.readError) throw this.readError;
    return this.spendUsd;
  }

  async recordSpendUsd(estimatedUsd: number): Promise<void> {
    if (this.recordError) throw this.recordError;
    this.recorded.push(estimatedUsd);
    this.spendUsd += estimatedUsd;
  }

  async reportCapExceeded(): Promise<void> {
    this.capExceededReports += 1;
  }
}
