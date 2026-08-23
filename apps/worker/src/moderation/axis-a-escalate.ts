/**
 * axis-a-escalate.ts — the deferred lane's Hatchet registration (plan 031, C1 + C4).
 *
 * ⚠ EVALUATION SCAFFOLDING. Plan 030 decides *run the evaluation*, not *adopt
 * Hatchet*. If the kill criteria fire, this lane reverts by deleting this file:
 * the cascade route's false branch degrades to `REVIEW`, which is today's
 * behaviour. Nothing here is load-bearing, and the split from
 * `escalation-run.ts` is what keeps the deletion that small.
 *
 * The SDK import lives in this file and `../hatchet.ts` ONLY. No import of it
 * may cross into `@de-otio/trellis` (apps/api) — that package is published, and
 * a dependency added there is a dependency every consumer inherits for an
 * evaluation they did not opt into.
 *
 * ── WHY A SEPARATE WORKFLOW, NOT HATCHET'S PRIORITY LADDER (plan 031 §1) ───
 *
 * Priorities order runs WITHIN one workflow. They do not isolate. Two lanes
 * sharing a workflow share a worker pool, so a burst of deferred work starves
 * the interactive path no matter how the priorities are set. The isolation here
 * comes from the per-workflow concurrency cap plus the per-tenant rate limit,
 * and `ModerationJobPriority` survives only as a tie-breaker INSIDE this lane —
 * which is not needed at the start and is deliberately not configured.
 *
 * ── THE HARD INVARIANT: THE SLOW MODEL CANNOT RUN INLINE ───────────────────
 *
 * At 13–20 s a reasoning-class call exceeds the inline lane's 5000 ms deadline
 * by 3–4×, so EVERY such call would fail closed to `REVIEW` — which, with no
 * standing moderator, is silent content loss rather than a degraded mode. Plan
 * 031 §1 asks for this to be enforced rather than documented, so the slow
 * provider is reachable only through `EscalationDeps.escalate`, which only this
 * workflow constructs. "Run the slow model inline" is not expressible from the
 * inline path, not merely discouraged.
 *
 * ── DETERMINISM (plan 031 §7.4) ────────────────────────────────────────────
 *
 * A durable task body REPLAYS on recovery, so code between checkpoints must not
 * read clocks or RNG non-idempotently. `runEscalation` takes neither. Where a
 * timestamp is genuinely needed, `ctx.now()` is memoized across replays and is
 * the only correct source — `Date.now()` is not.
 */

import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk/v1/task.js";
import type { DurableContext } from "@hatchet-dev/typescript-sdk/v1/client/worker/context.js";

import {
  DEFERRED_LANE_RETRIES,
  dispositionForDeadlineBreach,
  type DeferredLaneConfig,
} from "../../../api/src/lib/media/deferred-lane.js";
import {
  runEscalation,
  type EscalationDeps,
  type EscalationInput,
  type EscalationSpendConfig,
} from "./escalation-run.js";

/** The workflow's name, in one place. Used by the trigger and by the tests. */
export const AXIS_A_ESCALATE = "axis-a-escalate";

/**
 * What the workflow returns. `ack-drop` is a VALUE here, never a swallowed
 * exception — see `deferred-lane.ts`. A `catch` that returns normally is
 * indistinguishable from success at the engine, and in a moderation pipeline
 * that means content released or lost without a verdict.
 */
export type EscalationOutput = {
  readonly outcome: "ack" | "ack-drop";
  /** Present only on `ack-drop`. The shed cause, for plan 031 §6's metric. */
  readonly shedCause?: string;
};

/**
 * Register `axis-a-escalate`.
 *
 * ── CONCURRENCY AND RATE LIMIT ─────────────────────────────────────────────
 *
 * Both come from operator config and neither has a default here. The concurrency
 * expression is a CONSTANT so the cap is per-WORKFLOW (the isolation §1 asks
 * for); the rate limit is keyed on the tenant so one tenant cannot consume the
 * lane. `createDeferredLaneConfig` has already refused any config whose
 * per-tenant limit is below the review-rate cap — the relationship that decides
 * whether this lane relieves the `REVIEW` queue or merely decorates it.
 *
 * ── RETRIES ────────────────────────────────────────────────────────────────
 *
 * Set EXPLICITLY, mirroring the pipeline's `maxReceiveCount = 3`. An unset
 * engine default that differs from 3 silently changes poison-adjacent
 * behaviour; it is cheap to get right and invisible when wrong.
 *
 * ── IDEMPOTENCY ────────────────────────────────────────────────────────────
 *
 * A CEL expression over `input.dedupeKey`, which is the pipeline's OWN derived
 * key (`deriveDedupeKey({ contentHash, jobId, track })`) rather than a second
 * format minted for this lane. The cascade route runs inside the retrying
 * inline lane and can therefore fire more than once for one job; with the
 * derived key that repeat is a no-op at the engine. `strategy: "status"` keeps
 * the key alive until the run reaches a terminal state, which is the semantics
 * a repeat needs — a TTL shorter than an escalation would let the second
 * trigger start a second expensive call.
 */
export function registerAxisAEscalate(
  hatchet: HatchetClient,
  config: DeferredLaneConfig,
  spend: EscalationSpendConfig,
  deps: EscalationDeps,
): ReturnType<HatchetClient["durableTask"]> {
  // The SDK's `Duration` accepts a bare number and treats it as milliseconds,
  // which is the unit the estate's other operational windows already use
  // (`MEDIA_REVIEW_RATE_WINDOW_MS`, the stale-media-reap window). Passing it
  // straight through keeps one vocabulary and avoids a conversion that could
  // round an operator's window to something they did not ask for.
  const evictionWindow = config.evictionWindowMs;

  return hatchet.durableTask<EscalationInput, EscalationOutput>({
    name: AXIS_A_ESCALATE,
    retries: DEFERRED_LANE_RETRIES,
    idempotency: {
      strategy: "status",
      expression: "input.dedupeKey",
      // A backstop, not the mechanism: the status strategy releases the key at
      // terminal state, and this only bounds a key whose run never gets there.
      // Deliberately longer than the eviction window, so it can never expire
      // while a wait is still legitimately open.
      fallbackTtlMs: config.evictionWindowMs * 2,
    },
    concurrency: {
      // A constant expression makes this a per-WORKFLOW cap. Keying it on the
      // tenant instead would give every tenant its own slots, which is the
      // opposite of the isolation this lane needs from the inline path.
      expression: `'${AXIS_A_ESCALATE}'`,
      maxRuns: config.concurrency,
      // NOT the SDK's `CANCEL_IN_PROGRESS` default. Cancelling an in-flight
      // reasoning call to admit a newer one throws away money already spent and
      // leaves the older job open with nothing to show for it — the worst
      // combination available on a lane whose whole cost is the call.
      //
      // Of the alternatives, `DROP_NEWEST` and `QUEUE_NEWEST` are both marked
      // deprecated in the generated enum, and `CANCEL_NEWEST` still cancels. So
      // `GROUP_ROUND_ROBIN` is the one non-deprecated, non-cancelling strategy,
      // and with a CONSTANT expression there is exactly one group — which
      // should make it behave as a plain queue.
      //
      // ⚠ "Should" is doing work in that sentence, and it is a local reading of
      // an enum rather than an observed behaviour. Round-robin over a single
      // group is asserted nowhere in the SDK's types. Plan 030 risk #2 applies:
      // treat this as provisional until Phase 2 observes it on the real engine,
      // and check specifically that a queued run WAITS rather than being
      // dropped — a silently-dropped escalation looks exactly like a lane with
      // nothing to do.
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    },
    rateLimits: [
      {
        dynamicKey: "input.tenantId",
        units: 1,
        limit: config.perTenantRateLimit,
      },
    ],
    fn: async (
      input: EscalationInput,
      ctx: DurableContext<EscalationInput>,
    ): Promise<EscalationOutput> => {
      // ── C4: the eviction bound ─────────────────────────────────────────
      //
      // The escalation RACES a durable sleep. Whichever finishes first decides:
      // the escalation's own disposition, or — if the window expires — an
      // ack-drop that ages the job out to `REVIEW`. Today's behaviour, reached
      // deliberately and after a real attempt, rather than immediately and by
      // default.
      //
      // ⚠ THIS IS NOT `Or(sleepFor, event)`, WHICH IS WHAT PLAN 031 §4.4 ASKS
      // FOR, and the divergence is deliberate rather than an oversight.
      //
      // `waitFor(Or(sleep, event))` is the right shape for an escalation that
      // completes ASYNCHRONOUSLY and notifies. This lane's escalation is a
      // DIRECT 13–20 s call (§4.1 step 3). Written literally as the spec says,
      // the body waits for a "done" event that only the escalation could emit
      // — and the escalation has not been started, because the body is waiting.
      // It is a deadlock by construction that always evicts, and it looks
      // exactly like a correctly-configured lane with nothing to escalate.
      //
      // That is not a deduction. It was BUILT that way, run against the local
      // engine, and returned `{"outcome":"ack-drop","shedCause":"evicted"}` with
      // the injected dependencies recording ZERO calls. The unit tests could not
      // have caught it: they exercise `runEscalation`, and the bug was that
      // `runEscalation` was never reached.
      //
      // The event arm belongs to the async-provider case and to spike S5. When
      // a provider that notifies is wired, this is where `Or` comes back, with
      // `considerEventsSince` as the lookback — an event pushed before the wait
      // is established is an event the wait never sees, which is the estate's
      // event-before-registration gotcha in miniature.
      //
      // ON REPLAY, what is KNOWN and what is not. `runEscalation` is not
      // checkpointed, so the obvious worry is that a replay re-runs the
      // expensive call. Measured against the local engine on 2026-08-23 by
      // running three shapes side by side — this race, a durable task with no
      // sleep, and a plain task — and counting provider calls: **all three
      // called it exactly once**. So the normal path does not double-spend.
      //
      // What that does NOT establish is behaviour under an actual recovery — a
      // killed worker mid-run, which the probe did not exercise. If a replay
      // does re-enter the body, `ctx.sleepFor` resolves from the durable log
      // and the race settles as evicted, which is the SAFE direction: it lands
      // on `REVIEW`, never on a release. Worth a deliberate kill-the-worker
      // test in Phase 2 (it is adjacent to spike S4's upgrade rehearsal);
      // not worth a more intricate construct before there is evidence.
      const outcome = await Promise.race([
        runEscalation(input, config, spend, deps).then((d) => ({
          disposition: d,
          evicted: false,
        })),
        ctx
          .sleepFor(evictionWindow)
          .then(() => ({ disposition: dispositionForDeadlineBreach(), evicted: true })),
      ]);

      const disposition = outcome.disposition;

      switch (disposition.kind) {
        case "ack":
          return { outcome: "ack" };
        case "ack-drop":
          // A TYPED NO-OP RETURN. Not a caught exception, not a bare `return`.
          return { outcome: "ack-drop", shedCause: disposition.cause };
        case "fail":
          // THROW. The engine retries; `dispositionForError` already decided
          // that retrying is the right answer for this error, using the typed
          // classification rather than a name-matching guess.
          throw new EscalationRetryableError(input.jobId, disposition.infraFault);
      }
    },
  });
}

/**
 * Thrown to signal "retry me" to the engine, carrying nothing about the media.
 *
 * The jobId is included because an operator reading a failed run needs to find
 * the job; the media, the verdict, the provider's message and the tenant are
 * NOT, because a run's error text is one of the places a moderation pipeline
 * leaks what it saw.
 */
export class EscalationRetryableError extends Error {
  readonly infraFault: boolean;
  constructor(jobId: string, infraFault: boolean) {
    super(`axis-a-escalate: retryable failure for job ${jobId}`);
    this.name = "EscalationRetryableError";
    this.infraFault = infraFault;
  }
}

