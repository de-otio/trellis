/**
 * escalation-run.ts — the `axis-a-escalate` body, with no Hatchet in it.
 *
 * ⚠ EVALUATION SCAFFOLDING (plan 030 / plan 031). Nothing here is load-bearing:
 * with the cascade route's τ at 0 nothing ever reaches this module, and if the
 * kill criteria fire it is deleted along with its workflow.
 *
 * WHY THE BODY IS SPLIT FROM ITS REGISTRATION. `axis-a-escalate.ts` holds the
 * SDK types, the durable wait and the workflow options; this file holds what
 * actually happens. Three reasons, in increasing order of how much they matter:
 *
 *  1. It is unit-testable with no engine running. Plan 030 risk #2 says
 *     everything proved against `hatchet-lite` is provisional until Phase 2
 *     re-proves it on the cluster — which is exactly why the ENGINE-independent
 *     half should not need the engine to be tested at all.
 *  2. If the evaluation is killed, the deletion is one import and one file, and
 *     the logic that survives (the disposition mapping, the spend gate ordering)
 *     is already somewhere that does not mention Hatchet.
 *  3. It makes C3's source scan meaningful. A scan over a file that is mostly
 *     SDK boilerplate finds boilerplate; a scan over the body finds the body.
 *
 * ── THE STEP ORDER IS THE SAFETY ARGUMENT (plan 031 §4.1) ──────────────────
 *
 *   admission → spend gate → escalate → publish completion
 *
 * and each arrow is load-bearing in a way that is invisible if it is reordered:
 *
 *  - **Admission first**, because the inline lane may have settled this job
 *    while the run sat in the queue. Re-reading the job is what makes the
 *    trigger safe to repeat: the engine's idempotency key stops a duplicate
 *    ENQUEUE, and this check stops a duplicate CALL. Both, because they fail in
 *    different ways.
 *  - **The spend gate before the provider call**, never after. This lane runs
 *    the expensive model BY CONSTRUCTION, at an input rate set by strangers
 *    uploading media. A gate consulted after the call is a gate that reports
 *    spending rather than preventing it.
 *  - **The completion publish last**, and it is the ONLY way a verdict re-enters.
 *    See below.
 *
 * ── THIS MODULE DOES NOT WRITE VERDICTS ────────────────────────────────────
 *
 * Plan 031 §3 calls this the single most important constraint in the spec, and
 * it is worth restating where it can actually be violated. The escalation
 * publishes `completionEnvelopeBody({ track, jobId })` onto the media-completion
 * queue and stops. The existing completion worker re-fetches authoritative
 * state, claims the dedupe key, does the fan-in accounting, applies
 * `combineTrackVerdicts`, and writes the audit record.
 *
 * Writing `MediaModerationJob` rows from here would be a SECOND verdict-
 * application path: divergent dedupe, divergent aggregation, and a second place
 * for the legal/ops provenance record to be written differently. If the
 * completion path is ever awkward for this lane, the correct response is to fix
 * the completion path, not to bypass it.
 *
 * ── AND IT DOES NOT SWALLOW ERRORS ─────────────────────────────────────────
 *
 * Every exit is a {@link Disposition} the caller acts on. There is exactly one
 * `catch` in this file, it does not return normally, and it hands the error to
 * `dispositionForError` rather than deciding for itself. C3 asserts that.
 *
 * DETERMINISM. Durable task bodies REPLAY on recovery, so code between
 * checkpoints must not read clocks or RNG non-idempotently. This module takes
 * neither: no `Date.now()`, no `Math.random()`, and the one timestamp it needs
 * comes from the injected clock so a replay sees the same value.
 */

import {
  completionEnvelopeBody,
  type ModerationCompletionEnvelope,
} from "../../../api/src/lib/media/completion-envelope.js";
import {
  clampEscalatedDecision,
  dispositionForError,
  type DeferredLaneConfig,
  type Disposition,
} from "../../../api/src/lib/media/deferred-lane.js";
import { isOverDailyCap } from "../../../api/src/lib/media/spend-guard.js";
import type { EscalationCause } from "../../../api/src/lib/media/cascade-route.js";
import type { ModerationDecision } from "../../../api/src/lib/media/media-lifecycle.js";
import type { Track } from "../../../api/src/lib/media/track-verdict.js";

/**
 * What the cascade route hands the deferred lane.
 *
 * `dedupeKey` is DERIVED, never invented — `deriveDedupeKey({ contentHash,
 * jobId, track })`, the same key the rest of the media pipeline dedupes on.
 * Plan 031 §2: two key derivations over the same tuple is how a redelivery
 * becomes a double escalation, and the slow model is the expensive one to run
 * twice. It is carried on the input rather than recomputed here because the
 * engine's idempotency is a CEL expression over the input (`input.dedupeKey`),
 * so the value the engine dedupes on and the value the pipeline dedupes on have
 * to be the same string, not two computations that agree today.
 */
export type EscalationInput = {
  readonly jobId: string;
  readonly mediaId: string;
  readonly tenantId: string;
  readonly track: Track;
  readonly contentHash: string;
  readonly dedupeKey: string;
  /** Why the cascade route escalated. Carried through to the shed metric. */
  readonly cause: EscalationCause;
  /** `q̂` at the moment of the decision to escalate. Recorded, not re-evaluated. */
  readonly confidence: number;
};

/** The job state the admission step needs, and nothing more. */
export interface EscalationJobState {
  /** True once the inline lane (or anything else) has settled this job. */
  readonly resolved: boolean;
  /** Media duration, for the cost estimate. */
  readonly durationSeconds: number;
}

/**
 * Everything this body reaches outside itself. All of it is injected, so the
 * body has no imports of a cloud SDK, a Prisma client, or a queue driver — and
 * so a test can drive every branch without any of them.
 */
export interface EscalationDeps {
  /** Re-read authoritative job state. Returns null when the job is gone. */
  readJob(jobId: string): Promise<EscalationJobState | null>;
  /** Today's accumulated estimated spend (USD). MUST throw on a backend error. */
  getTodaySpendUsd(): Promise<number>;
  /** Record a started escalation's estimated cost. */
  recordSpendUsd(usd: number): Promise<void>;
  /** Emit the cap-exceeded observability signal. Best-effort; must not throw. */
  reportCapExceeded(): Promise<void>;
  /** The slow-model call. */
  escalate(input: EscalationInput): Promise<ModerationDecision>;
  /** Publish onto the media-completion queue. */
  publishCompletion(body: string): Promise<void>;
  /** Structured observation. Never receives media bytes or a secret. */
  observe(event: EscalationObservation): void;
}

/** What operators are told. The shed causes are plan 031 §6's primary metric. */
export type EscalationObservation =
  | { readonly kind: "shed"; readonly cause: string; readonly tenantId: string }
  | { readonly kind: "escalated"; readonly tenantId: string; readonly decision: ModerationDecision }
  | { readonly kind: "infra-fault"; readonly tenantId: string };

/** The daily cap and per-minute rate, from operator config. Never literals. */
export interface EscalationSpendConfig {
  readonly dailyCapUsd: number;
  readonly perMinuteRateUsd: number;
}

/**
 * Run one escalation.
 *
 * NEVER THROWS, and that is the contract the registration wrapper relies on:
 * the wrapper turns a `fail` disposition into a throw, so the decision to
 * retry is made once, here, by `dispositionForError`, rather than by whichever
 * error happened to escape.
 */
export async function runEscalation(
  input: EscalationInput,
  config: DeferredLaneConfig,
  spend: EscalationSpendConfig,
  deps: EscalationDeps,
): Promise<Disposition> {
  try {
    // --- 1. Admission -------------------------------------------------------
    const job = await deps.readJob(input.jobId);
    if (job === null || job.resolved) {
      // A legitimate outcome, not an error: the inline lane may have settled it
      // while this run was queued. Plan 031 §4.1.
      deps.observe({ kind: "shed", cause: "already-resolved", tenantId: input.tenantId });
      return { kind: "ack-drop", cause: "already-resolved", infraFault: false };
    }

    // --- 2. Spend gate ------------------------------------------------------
    // Before the call, always. `getTodaySpendUsd` throws on a backend error and
    // that throw is CORRECT: an unreadable counter must stop spend, not default
    // to zero and silently disable the cap exactly when the backend is sick.
    const today = await deps.getTodaySpendUsd();
    if (isOverDailyCap(today, spend.dailyCapUsd)) {
      await deps.reportCapExceeded();
      deps.observe({ kind: "shed", cause: "spend-capped", tenantId: input.tenantId });
      // ack-drop, NOT a retry. Retrying a spend cap re-asks the same question
      // and gets the same answer, three times, on a schedule.
      return { kind: "ack-drop", cause: "spend-capped", infraFault: false };
    }

    // --- 3. Escalate --------------------------------------------------------
    const raw = await deps.escalate(input);
    // The lane ships unable to approve (plan 031 §7.2). This clamp is the one
    // place that has to be right for that to hold, and it can only ever make a
    // verdict more conservative.
    const decision = clampEscalatedDecision(raw, config);

    // The money is committed at the point the call was made, so it is recorded
    // whether or not the verdict was useful.
    await deps.recordSpendUsd(estimateEscalationCostUsd(job.durationSeconds, spend));

    // --- 4. Publish the completion -----------------------------------------
    // The ONLY way a verdict re-enters. The envelope deliberately carries no
    // verdict: the completion worker re-fetches authoritative state, and this
    // module's `decision` exists only to be observed.
    const envelope: ModerationCompletionEnvelope = {
      track: input.track,
      jobId: input.jobId,
    };
    await deps.publishCompletion(completionEnvelopeBody(envelope));
    deps.observe({ kind: "escalated", tenantId: input.tenantId, decision });
    return { kind: "ack" };
  } catch (err) {
    // The ONLY catch in this file, and it does not return normally on a
    // retryable error — it hands the classification to the module that owns it.
    // `classifyWorkerErrorDetailed` (inside `dispositionForError`) is mandatory
    // here: a typed permanent rejection whose message happens to contain
    // "timeout" must not be retried three more times at 13–20 s a call.
    const disposition = dispositionForError(err);

    // Operators must be told the INFRASTRUCTURE failed, not the media. This
    // lane is where that distinction is hardest to see from the outside:
    // nothing user-visible changes until a job ages out, so a lane quietly
    // failing on infrastructure looks exactly like a lane quietly working.
    //
    // Checked on BOTH branches on purpose. The flag rides an unattributed
    // permanent error, which classifies as poison and therefore ack-drops — so
    // checking it only on the throwing branch is an alert that can never fire.
    if (disposition.kind !== "ack" && disposition.infraFault) {
      deps.observe({ kind: "infra-fault", tenantId: input.tenantId });
    }
    if (disposition.kind === "ack-drop") {
      deps.observe({ kind: "shed", cause: disposition.cause, tenantId: input.tenantId });
    }
    return disposition;
  }
}

/**
 * Cost of one escalation, in USD.
 *
 * Deliberately the SAME shape as the inline path's `estimateJobCostUsd` — a
 * per-minute rate times the media's duration — because the daily cap is one
 * budget both lanes draw on, and two estimators with different shapes would
 * make the counter mean two things at once. The RATE differs (a reasoning model
 * is not priced like a cheap scorer) and that difference lives entirely in
 * operator config, which is where a price belongs.
 */
export function estimateEscalationCostUsd(
  durationSeconds: number,
  spend: EscalationSpendConfig,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new TypeError(
      `estimateEscalationCostUsd: invalid durationSeconds ${String(durationSeconds)}`,
    );
  }
  if (!Number.isFinite(spend.perMinuteRateUsd) || spend.perMinuteRateUsd < 0) {
    throw new TypeError(
      `estimateEscalationCostUsd: invalid perMinuteRateUsd ${String(spend.perMinuteRateUsd)}`,
    );
  }
  return (durationSeconds / 60) * spend.perMinuteRateUsd;
}
