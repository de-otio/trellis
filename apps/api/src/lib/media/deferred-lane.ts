/**
 * deferred-lane.ts — pure functional core: the deferred lane's config, its
 * disposition protocol, and the one restriction it ships closed with.
 *
 * Plan 031 (`plans/031-deferred-lane-spec.md` in skybber) is the spec. This
 * module holds the parts of it that must be TRUE rather than DOCUMENTED — the
 * relationships a comment cannot enforce and a quarter of drift will otherwise
 * quietly break. The workflow body itself lives in `apps/worker`, because
 * `@de-otio/trellis` is published and must not gain an SDK dependency for an
 * evaluation its consumers did not opt into.
 *
 * ⚠ EVALUATION SCAFFOLDING. Plan 030 decides *run the evaluation*, not *adopt
 * Hatchet*. Nothing here is load-bearing: with `allowApprove` closed and τ at 0
 * every path lands on today's behaviour, and if the kill criteria fire this
 * module and its workflow are deleted together.
 *
 * PURITY: no I/O, no clock, no randomness. Every number is operator config.
 */

import type { ModerationDecision } from "./media-lifecycle.js";
import {
  classifyWorkerErrorDetailed,
  type WorkerErrorClassification,
} from "./classify-worker-error.js";

/** Thrown at wiring time when the lane is unusable. Never thrown per-job. */
export class DeferredLaneConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeferredLaneConfigError";
  }
}

/**
 * Retry count for the deferred workflow.
 *
 * NOT TUNABLE, and that is plan 031 §4.2's call: it mirrors the SQS
 * `maxReceiveCount = 3` the rest of the media pipeline runs under. An unset
 * engine default that differs from 3 silently changes poison-adjacent
 * behaviour — cheap to get right, invisible when wrong. Exported so the
 * workflow registration reads the same constant the test asserts on, rather
 * than a `3` typed twice.
 */
export const DEFERRED_LANE_RETRIES = 3;

/**
 * The operator-supplied lane config. Every value is runtime config; none has a
 * default here, for the reason `cascade-route.ts` sets out at length — this
 * file ships in a public tarball, and a published rate limit tells an adversary
 * exactly how much uncertain content per hour to push before the lane sheds to
 * `REVIEW`, a queue they know nobody drains.
 */
export interface DeferredLaneConfig {
  /**
   * Per-workflow concurrency cap. Plan 031 §5 recommends starting at **2**:
   * at 13–20 s per call that is ≈6–9 jobs/min, and the binding constraint is
   * not CPU (Gate 0 measured 2200m free) but the `db-play2-pico` the engine
   * shares with the app. Start at the smallest number that demonstrates the
   * lane works and raise it against a measurement.
   */
  readonly concurrency: number;
  /**
   * Per-tenant rate limit, in escalations per {@link reviewRateWindowMs}'s
   * window. Constrained from below — see {@link createDeferredLaneConfig}.
   */
  readonly perTenantRateLimit: number;
  /**
   * How long an escalation may stay open before the job ages out to `REVIEW`.
   * Plan 031 §5 recommends **1 h**: long enough that a 20 s call plus queueing
   * is not remotely tight, short enough that a stuck lane surfaces the same day
   * rather than the same week.
   */
  readonly evictionWindowMs: number;
  /**
   * May an escalation resolve to `approved`?
   *
   * **SHIPS CLOSED.** Plan 031 §7.2, decided 2026-08-23: the review/quarantine
   * floors on dev are provisional and never calibrated, and the calibration in
   * flight defers the five hard categories. So a deferred verdict inherits a
   * threshold that is evidence-based against OVER-blocks and judgement against
   * UNDER-blocks — and an escalation that can downgrade to "approved" on the
   * unmeasured side is the riskiest thing in the design.
   *
   * The restriction costs little: the lane's value is turning a dead end into
   * an ANSWER, and `quarantine` is an answer. It is a flag rather than a
   * compiled restriction so it can be revisited against evidence — but it is
   * opened only when the calibration has produced real under-block numbers, not
   * when the mechanism merely works.
   */
  readonly allowApprove: boolean;
}

/**
 * Build a lane config, or refuse.
 *
 * `reviewRateCap` is not part of the config — it is the neighbouring operator
 * value (`/skybber/{stage}/media/review-rate-cap`) this config must be
 * consistent WITH, so it is passed in and checked rather than duplicated.
 *
 * ── THE ONE RELATIONSHIP THAT MUST HOLD ────────────────────────────────────
 *
 *   `perTenantRateLimit >= reviewRateCap`
 *
 * `review-rate-cap` is the per-tenant flagged-object cap over a 24 h window —
 * the only thing bounding an un-drained `REVIEW` queue. The deferred lane exists
 * to REDUCE the flow into that queue. If its per-tenant limit is TIGHTER than
 * the review cap, the excess sheds straight back to `REVIEW`, and the lane makes
 * the queue it was built to relieve no smaller while costing money to run.
 *
 * Set it lower and the lane is decorative. This is asserted rather than
 * documented because it is exactly the kind of thing that is true on the day it
 * is configured and quietly false a quarter later, with no symptom other than a
 * lane that seems to work and achieves nothing.
 */
export function createDeferredLaneConfig(
  config: DeferredLaneConfig,
  reviewRateCap: number,
): DeferredLaneConfig {
  if (config === null || typeof config !== "object") {
    throw new DeferredLaneConfigError(
      "deferred lane requires a config; refusing to construct a lane nobody configured",
    );
  }
  requirePositiveInt(config.concurrency, "concurrency");
  requirePositiveInt(config.perTenantRateLimit, "perTenantRateLimit");
  requirePositiveInt(config.evictionWindowMs, "evictionWindowMs");
  if (typeof config.allowApprove !== "boolean") {
    throw new DeferredLaneConfigError(
      "deferred lane requires an explicit `allowApprove` boolean — letting an escalation approve is a decision, not a default",
    );
  }
  if (!Number.isFinite(reviewRateCap) || reviewRateCap < 0) {
    throw new DeferredLaneConfigError(
      "deferred lane needs the operator's review-rate cap to check its own rate limit against; refusing to guess it",
    );
  }
  if (config.perTenantRateLimit < reviewRateCap) {
    throw new DeferredLaneConfigError(
      `deferred lane perTenantRateLimit (${config.perTenantRateLimit}) is below the review-rate cap (${reviewRateCap}); the excess would shed straight back to REVIEW, which is the queue this lane exists to relieve`,
    );
  }
  return {
    concurrency: config.concurrency,
    perTenantRateLimit: config.perTenantRateLimit,
    evictionWindowMs: config.evictionWindowMs,
    allowApprove: config.allowApprove,
  };
}

function requirePositiveInt(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new DeferredLaneConfigError(
      `deferred lane requires a positive integer \`${name}\` from operator config; there is no compiled-in default`,
    );
  }
}

/**
 * Clamp an escalated verdict against {@link DeferredLaneConfig.allowApprove}.
 *
 * With the flag closed, `approved` becomes `review` — the lane may only ever
 * arrive at `review` or `quarantine`. Note the direction: this can only ever
 * make a verdict MORE conservative, exactly like `label-policy.ts`'s rule 5, so
 * there is no configuration of this function that releases content.
 *
 * C3's source scan asserts that no code path can emit `approved` from the lane
 * while the flag is closed; this function is the single place that has to be
 * right for that to hold.
 */
export function clampEscalatedDecision(
  decision: ModerationDecision,
  config: DeferredLaneConfig,
): ModerationDecision {
  if (config.allowApprove) return decision;
  return decision === "approved" ? "review" : decision;
}

// ---------------------------------------------------------------------------
// The disposition protocol (plan 031 §4.2)
// ---------------------------------------------------------------------------

/**
 * Why a run was legitimately not done. Every `ack-drop` names one, because
 * plan 031 §6 makes "how often did we shed to `REVIEW`, per cause?" the lane's
 * PRIMARY metric rather than its error metric: a lane that runs cleanly and
 * sheds 90% of its input has failed at its purpose while reporting no failures.
 */
export type ShedCause =
  /** The inline lane settled the job while this run was queued. Not an error. */
  | "already-resolved"
  /** The daily spend cap was reached. */
  | "spend-capped"
  /** The tenant's per-tenant rate limit was reached. */
  | "rate-limited"
  /** The input cannot succeed on retry — `classifyWorkerErrorDetailed` said poison. */
  | "poison"
  /** The eviction window expired before the escalation returned. */
  | "evicted";

/**
 * The three outcomes, and there is no fourth.
 *
 * The naming is the estate's — `ack-drop` appears throughout
 * `workers/media-processing.ts` — and the shape is a TYPED RETURN rather than a
 * convention, deliberately.
 *
 * **`ack-drop` must never be a swallowed exception.** A `catch` that returns
 * normally is indistinguishable from success at the engine, and silently
 * converts "this failed" into "this is done". In a moderation pipeline that
 * means content released or lost without a verdict. Making the drop a value the
 * caller must construct means the difference is visible in the source, which is
 * what C3's scan can then check.
 */
export type Disposition =
  /** The escalation ran and a completion was published. Normal return. */
  | { readonly kind: "ack" }
  /** Retryable — the caller THROWS this, letting the engine retry. */
  | { readonly kind: "fail"; readonly infraFault: boolean }
  /** Legitimately not to be done. A typed no-op return, never a caught throw. */
  | { readonly kind: "ack-drop"; readonly cause: ShedCause; readonly infraFault: boolean };

/**
 * Map a thrown error onto a disposition.
 *
 * `classifyWorkerErrorDetailed` is MANDATORY here, not optional, and not the
 * simple `classifyWorkerError`. The detailed form returns two things the simple
 * one discards and this lane needs both:
 *
 *  - `source: "typed" | "heuristic"` — a typed provider error must win over the
 *    name-matching heuristic, or a permanent rejection whose message happens to
 *    contain "timeout" is retried until it dead-letters. Three retries of a
 *    13–20 s reasoning call is the expensive way to learn that.
 *  - `infraFault` — operators must be told the INFRASTRUCTURE, not the media,
 *    failed. This matters more in the deferred lane than anywhere else: nothing
 *    user-visible changes until a job ages out, so a lane quietly failing on
 *    infrastructure looks exactly like a lane quietly working.
 *
 * `retryable` → `fail` (throw). `poison` → `ack-drop`, and let the job age out
 * to `REVIEW` rather than retry-storming the expensive model.
 *
 * ⚠ `infraFault` RIDES THE `ack-drop`, and that is not an oversight to tidy up.
 * `classifyWorkerErrorDetailed` sets the flag on exactly one classification —
 * a TYPED PERMANENT error whose cause the adapter could not attribute — and
 * that classification is `poison`, which maps here to `ack-drop`. So the branch
 * that carries the flag is the one that does NOT throw. Dropping it on that
 * branch (the obvious shape: put `infraFault` only on `fail`) would mean the
 * alert can never fire, on any input, while the code still reads as though it
 * announces outages. It is carried on both variants so the caller cannot
 * observe one and miss the other.
 */
export function dispositionForError(err: unknown): Disposition {
  const classification: WorkerErrorClassification = classifyWorkerErrorDetailed(err);
  if (classification.klass === "retryable") {
    return { kind: "fail", infraFault: classification.infraFault };
  }
  return { kind: "ack-drop", cause: "poison", infraFault: classification.infraFault };
}

/**
 * Map a DEADLINE breach onto a disposition.
 *
 * Separate from {@link dispositionForError} on purpose. `moderation-deadline.ts`
 * throws `retryable: true` on a breach, reasoning that "a deadline says
 * something about the moment, not about the media" — which is right for a
 * tens-of-milliseconds inline call and wrong here. In the deferred lane a breach
 * means a 13–20 s reasoning call was abandoned, and retrying it three times
 * costs three more of them against the daily spend cap.
 *
 * Plan 031 §4.4 requires this to be CHOSEN rather than inherited. The choice is
 * **ack-drop → age out to `REVIEW`**: the lane's whole degradation story already
 * lands on `REVIEW`, so a breach costs one call and reaches today's behaviour,
 * where a retry costs four and reaches the same place.
 */
export function dispositionForDeadlineBreach(): Disposition {
  // Not an infra fault: the window expiring is the lane working as configured,
  // and alerting on it would train operators to ignore the alert that matters.
  return { kind: "ack-drop", cause: "evicted", infraFault: false };
}
