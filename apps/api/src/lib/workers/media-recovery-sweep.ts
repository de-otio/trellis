// The media recovery sweep.
//
// A periodic sweep that finds media objects whose pipeline stalled (a lost
// processing message, a completion that never arrived, a promotion that did
// not finish) and decides what to do with each. This module holds the read
// model, the actions, the config and its validator, the pure planner
// (`planRecovery`) and the imperative shell (`sweepMedia`).
//
// Every number in the config is runtime config, never a constant in this file:
// the npm tarball is public.

import type { MediaLifecycle, ModerationDecision } from "../media/media-lifecycle.js";
import type { Track, TrackOutcome } from "../media/track-verdict.js";
import type { HoldGround } from "../media/moderation-provider.js";
import type { StoragePort } from "../media/media-ports.js";
import { casKey, pendingKey, isCasKeyError } from "../media/cas-keys.js";
import { decidePromotion } from "../media/promote-decision.js";
import { moderationResolvedPayload } from "../media/moderation-resolved-payload.js";
import { promotePinned, resolvePromoteSource } from "../media/promote-staging.js";
import type { CompletionStore } from "./media-completion.js";

/** Operator config for the sweep. All values are seconds except `batchSize`. */
export interface MediaRecoverySweepConfig {
  /**
   * How long a stalled object is left alone before the sweep acts on it. Must
   * outlast every redelivery the completion queue can still make, so the sweep
   * never races a completion that is merely slow.
   */
  readonly settleWindowSeconds: number;
  /**
   * Past this age an object that still has no verdict is settled as a
   * technical hold rather than re-driven. Strictly greater than the settle
   * window.
   */
  readonly maxMediaAgeSeconds: number;
  /** Maximum objects read per sweep run. */
  readonly batchSize: number;
}

/** One thing the sweep decided to do about one media object. */
export type RecoveryAction =
  | { readonly kind: "reenqueue-processing"; readonly mediaId: string }
  | { readonly kind: "repair-promotion"; readonly mediaId: string }
  | { readonly kind: "settle-technical"; readonly mediaId: string };

/** What the sweep knows about one moderation track of a candidate. */
export interface RecoveryTrackState {
  /** A job row for this track exists and has not been superseded. */
  readonly hasLiveRow: boolean;
  /** The track's resolved decision, or `null` while unresolved. */
  readonly decision: ModerationDecision | null;
}

/** The read model the planner needs for one media object. */
export interface RecoveryCandidate {
  readonly mediaId: string;
  readonly lifecycle: MediaLifecycle;
  readonly createdAt: Date;
  /** Keyed by track; a track the object is not moderated on is absent. */
  readonly tracks: Readonly<Partial<Record<Track, RecoveryTrackState>>>;
  /** The content-addressed object exists in storage. */
  readonly casObjectPresent: boolean;
}

/** The completion queue's settings the sweep config must be checked against. */
export interface CompletionQueueTiming {
  readonly completionVisibilitySeconds: number;
  readonly completionMaxReceive: number;
}

function isNonNegativeFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * Check a sweep config against the completion queue's timing. Pure and total:
 * returns every problem found, and an empty list when the config is usable.
 *
 *   - `settleWindowSeconds` ≥ visibility × max receive count, so the sweep
 *     cannot act while the queue could still redeliver a completion;
 *   - `maxMediaAgeSeconds` > `settleWindowSeconds`;
 *   - every value is a finite non-negative number and `batchSize` a positive
 *     integer, so a malformed value is reported rather than compared.
 */
export function validateRecoverySweepConfig(
  c: MediaRecoverySweepConfig,
  queue: CompletionQueueTiming,
): string[] {
  const errors: string[] = [];

  const numbersOk =
    isNonNegativeFinite(c.settleWindowSeconds) &&
    isNonNegativeFinite(c.maxMediaAgeSeconds) &&
    isNonNegativeFinite(queue.completionVisibilitySeconds) &&
    isNonNegativeFinite(queue.completionMaxReceive);

  if (!isNonNegativeFinite(c.settleWindowSeconds)) {
    errors.push("settleWindowSeconds must be a finite non-negative number");
  }
  if (!isNonNegativeFinite(c.maxMediaAgeSeconds)) {
    errors.push("maxMediaAgeSeconds must be a finite non-negative number");
  }
  if (!isNonNegativeFinite(queue.completionVisibilitySeconds)) {
    errors.push("completionVisibilitySeconds must be a finite non-negative number");
  }
  if (!isNonNegativeFinite(queue.completionMaxReceive)) {
    errors.push("completionMaxReceive must be a finite non-negative number");
  }
  if (!Number.isInteger(c.batchSize) || c.batchSize <= 0) {
    errors.push("batchSize must be a positive integer");
  }

  if (numbersOk) {
    const redeliveryHorizon = queue.completionVisibilitySeconds * queue.completionMaxReceive;
    if (c.settleWindowSeconds < redeliveryHorizon) {
      errors.push(
        "settleWindowSeconds must be at least completionVisibilitySeconds × completionMaxReceive",
      );
    }
    if (c.maxMediaAgeSeconds <= c.settleWindowSeconds) {
      errors.push("maxMediaAgeSeconds must be greater than settleWindowSeconds");
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// The planner (pure) and the shell.
// ---------------------------------------------------------------------------

/** The tracks a video is moderated on. */
const SWEEP_TRACKS: readonly Track[] = ["VISUAL", "AUDIO"];

function ageSeconds(createdAt: Date, now: Date): number {
  return (now.getTime() - createdAt.getTime()) / 1000;
}

/**
 * Whether an UPLOADED object still has work nobody has started: it has no
 * track at all, or at least one track recorded without a live job row.
 */
function hasMissingTrack(c: RecoveryCandidate): boolean {
  const present = SWEEP_TRACKS.filter((t) => c.tracks[t] !== undefined);
  if (present.length === 0) return true;
  return present.some((t) => c.tracks[t]?.hasLiveRow !== true);
}

/**
 * Decide, for each candidate, the one thing the sweep should do about it.
 * Pure and total; the output keeps the input's order and holds at most one
 * action per candidate.
 *
 *   - UPLOADED at or past `maxMediaAgeSeconds` ⇒ `settle-technical`. This takes
 *     precedence over re-enqueueing: past the bound an object is settled, not
 *     re-driven.
 *   - UPLOADED older than `settleWindowSeconds` with a track that has no live
 *     job row (or no track at all) ⇒ `reenqueue-processing`.
 *   - APPROVED older than `settleWindowSeconds` whose content-addressed object
 *     is absent (`casObjectPresent === false`) ⇒ `repair-promotion`.
 *   - Anything else, and anything inside the settle window, ⇒ no action.
 */
export function planRecovery(input: {
  readonly media: ReadonlyArray<RecoveryCandidate>;
  readonly now: Date;
  readonly config: MediaRecoverySweepConfig;
}): RecoveryAction[] {
  const { media, now, config } = input;
  const actions: RecoveryAction[] = [];
  for (const c of media) {
    const age = ageSeconds(c.createdAt, now);
    if (c.lifecycle === "UPLOADED") {
      if (age >= config.maxMediaAgeSeconds) {
        actions.push({ kind: "settle-technical", mediaId: c.mediaId });
      } else if (age > config.settleWindowSeconds && hasMissingTrack(c)) {
        actions.push({ kind: "reenqueue-processing", mediaId: c.mediaId });
      }
    } else if (c.lifecycle === "APPROVED") {
      if (age > config.settleWindowSeconds && c.casObjectPresent === false) {
        actions.push({ kind: "repair-promotion", mediaId: c.mediaId });
      }
    }
  }
  return actions;
}

/**
 * The persistence the sweep needs. Implemented by the consuming application.
 */
export interface MediaRecoveryStore extends Pick<CompletionStore, "findMedia"> {
  /**
   * Read up to `batchSize` candidates:
   *   - UPLOADED objects created before `createdBefore`, WHATEVER their job
   *     rows (none, placeholders only, partly started, fully started);
   *   - APPROVED objects whose content-addressed object is absent, with
   *     `casObjectPresent: false`. The store resolves that, since it holds the
   *     coordinates; it must not return APPROVED objects that are fine.
   * Per track, `hasLiveRow` is "a row with a job id that is not superseded".
   * The read MUST be bounded by `batchSize` and ordered oldest first.
   */
  findRecoveryCandidates(query: {
    readonly createdBefore: Date;
    readonly batchSize: number;
  }): Promise<ReadonlyArray<RecoveryCandidate>>;
  /**
   * Move a media object to `status` as a COMPARE-AND-SET: apply only if the
   * row still holds `expectedFrom`. Resolves `true` when THIS call made the
   * transition and `false` when the row had already moved. `ground` is the
   * hold ground when `status` is REVIEW; the store may record it or not.
   */
  settleMedia(
    mediaId: string,
    status: MediaLifecycle,
    options: {
      readonly expectedFrom: MediaLifecycle;
      readonly ground?: HoldGround;
    },
  ): Promise<boolean>;
}

/** Everything {@link sweepMedia} binds to. */
export interface MediaRecoverySweepDeps {
  readonly store: MediaRecoveryStore;
  readonly storage: StoragePort;
  /** Put the media object's processing message back on the queue. */
  readonly enqueueProcessing: (mediaId: string) => Promise<void>;
  /**
   * The sweep config. ABSENT means the sweeper is disabled: it logs one WARN
   * and does nothing. There is no default, because every value is operator
   * config.
   */
  readonly config?: MediaRecoverySweepConfig;
  /** The completion queue's timing, which the config is validated against. */
  readonly queueTiming?: CompletionQueueTiming;
  /** Defaults to the wall clock; injected so tests control time. */
  readonly now?: () => Date;
  /** The anti-oracle resolved event. Best-effort, after a settlement. */
  readonly emitResolved?: (payload: {
    readonly mediaId: string;
    readonly status: "ready" | "not-ready";
  }) => Promise<void>;
  readonly logger: {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
  };
}

/** What one sweep run did. */
export interface MediaRecoverySweepResult {
  /** `false` when the sweeper is disabled (no or invalid config). */
  readonly enabled: boolean;
  readonly examined: number;
  readonly reenqueued: number;
  /** Settlements THIS run made (a lost compare-and-set is not counted). */
  readonly settled: number;
  readonly repaired: number;
  /** Actions that lost a race or failed; the next run sees the object again. */
  readonly skipped: number;
}

let warnedDisabled = false;

/** Test helper: forget that the disabled warning was already logged. */
export function __resetMediaRecoverySweepWarnings(): void {
  warnedDisabled = false;
}

const DISABLED: MediaRecoverySweepResult = {
  enabled: false,
  examined: 0,
  reenqueued: 0,
  settled: 0,
  repaired: 0,
  skipped: 0,
};

/**
 * One recovery sweep.
 *
 * Reads a bounded batch of candidates, plans, and executes. No claim or dedupe
 * row is taken: every lifecycle write is a compare-and-set, so two sweepers
 * running at once produce one transition and the loser stands down. Re-enqueue
 * is safe to repeat because processing starts only tracks without a live row.
 *
 * `settle-technical` runs the normal fan-in over the tracks as read: an
 * undecided track counts as review, and a quarantined track still wins.
 * `repair-promotion` calls the existing pinned promotion.
 */
export async function sweepMedia(
  deps: MediaRecoverySweepDeps,
): Promise<MediaRecoverySweepResult> {
  const { config, queueTiming, logger } = deps;
  if (config === undefined || queueTiming === undefined) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      logger.warn(
        "Media recovery sweep is DISABLED: no sweep config (or no completion queue timing) was supplied",
      );
    }
    return DISABLED;
  }
  const problems = validateRecoverySweepConfig(config, queueTiming);
  if (problems.length > 0) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      logger.warn("Media recovery sweep is DISABLED: the sweep config is invalid", {
        problems,
      });
    }
    return DISABLED;
  }

  const now = (deps.now ?? (() => new Date()))();
  const candidates = await deps.store.findRecoveryCandidates({
    createdBefore: new Date(now.getTime() - config.settleWindowSeconds * 1000),
    batchSize: config.batchSize,
  });
  // The store is told the bound; enforce it here too.
  const batch = candidates.slice(0, config.batchSize);
  const byId = new Map(batch.map((c) => [c.mediaId, c]));
  const actions = planRecovery({ media: batch, now, config });

  let reenqueued = 0;
  let settled = 0;
  let repaired = 0;
  let skipped = 0;
  for (const action of actions) {
    const candidate = byId.get(action.mediaId);
    if (candidate === undefined) continue;
    try {
      switch (action.kind) {
        case "reenqueue-processing":
          await deps.enqueueProcessing(action.mediaId);
          reenqueued += 1;
          break;
        case "settle-technical":
          if (await settleTechnical(deps, candidate)) settled += 1;
          else skipped += 1;
          break;
        case "repair-promotion":
          if (await repairPromotion(deps, candidate)) repaired += 1;
          else skipped += 1;
          break;
      }
    } catch (err) {
      // One object's failure must not stop the rest of the batch; the next run
      // reads it again.
      skipped += 1;
      logger.error("Media recovery action failed", {
        mediaId: action.mediaId,
        action: action.kind,
        error: err,
      });
    }
  }

  logger.info("Media recovery sweep finished", {
    examined: batch.length,
    reenqueued,
    settled,
    repaired,
    skipped,
  });
  return { enabled: true, examined: batch.length, reenqueued, settled, repaired, skipped };
}

function trackOutcome(state: RecoveryTrackState | undefined): TrackOutcome {
  if (state === undefined) return { state: "absent" };
  if (state.decision === null) return { state: "errored" };
  return { state: "decided", decision: state.decision };
}

/**
 * Settle an object that is past its age bound. The normal fan-in decides:
 * an undecided track counts as review, an absent track is not approval, and a
 * quarantined track wins over everything. The write is a compare-and-set from
 * UPLOADED, so a completion that lands meanwhile is never overwritten.
 */
async function settleTechnical(
  deps: MediaRecoverySweepDeps,
  c: RecoveryCandidate,
): Promise<boolean> {
  const action = decidePromotion({
    visual: trackOutcome(c.tracks.VISUAL),
    audio: trackOutcome(c.tracks.AUDIO),
    currentStatus: "UPLOADED",
    casObjectPresent: c.casObjectPresent,
  });
  if (action.transition.ok === false) return false;
  const status = action.transition.status;
  const applied = await deps.store.settleMedia(c.mediaId, status, {
    expectedFrom: "UPLOADED",
    ...(status === "REVIEW" && { ground: "technical" as const }),
  });
  if (!applied) {
    deps.logger.info("Recovery settle lost the race — standing down", {
      mediaId: c.mediaId,
    });
    return false;
  }
  deps.logger.warn("Media past its age bound — settled by the recovery sweep", {
    mediaId: c.mediaId,
    status,
  });
  if (typeof deps.emitResolved === "function") {
    try {
      await deps.emitResolved(moderationResolvedPayload(c.mediaId, status));
    } catch (err) {
      deps.logger.warn("Recovery settle: resolved-event emission failed (decision persisted)", {
        mediaId: c.mediaId,
        error: err,
      });
    }
  }
  return true;
}

/** Re-run the pinned promotion for an APPROVED object whose bytes never landed. */
async function repairPromotion(
  deps: MediaRecoverySweepDeps,
  c: RecoveryCandidate,
): Promise<boolean> {
  const coords = await deps.store.findMedia(c.mediaId);
  if (coords === null || coords.lifecycle !== "APPROVED") return false;
  const stagingKey = `processing/${coords.tenantId}/${coords.uploadId}`;
  const cas = casKey(coords.tenantId, coords.contentHash);
  const pending = pendingKey(coords.tenantId, coords.uploadId);
  if (isCasKeyError(cas) || isCasKeyError(pending)) {
    deps.logger.error("Recovery promotion: coordinates are not addressable", {
      mediaId: c.mediaId,
    });
    return false;
  }
  const source = await resolvePromoteSource({
    storage: deps.storage,
    stagingKey,
    casKey: cas,
    stagingVersionId: coords.stagingVersionId,
  });
  if (source.kind === "none") {
    deps.logger.error(
      "Recovery promotion: approved but the pinned moderated bytes are unresolvable — needs a human",
      { mediaId: c.mediaId },
    );
    return false;
  }
  await promotePinned({
    storage: deps.storage,
    source,
    stagingKey,
    casKey: cas,
    cleanupKeys: [pending, stagingKey],
    log: {
      warn: (msg, data) => deps.logger.warn(msg, data as Record<string, unknown>),
    },
    logContext: { mediaId: c.mediaId },
  });
  deps.logger.info("Recovery promotion repaired an approved object", {
    mediaId: c.mediaId,
  });
  return true;
}
