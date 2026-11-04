// media-completion.ts — imperative SHELL for the standardized media
// job-completion queue (B2). (WS-2 T6: moved here from
// lambda/media-completion-worker.ts; the lambda file keeps `makeHandler` —
// which already IS the thin AWS adapter — and re-exports this module's
// public surface so existing deep imports keep resolving.)
//
// One queue drains the completion notifications of BOTH async moderation
// tracks of a media object:
//
//   - VISUAL: the image/video moderation provider finishes a job.
//   - AUDIO: speech-to-text finishes.
//
// Both arrive as the canonical `{ track, jobId }` envelope (see
// lib/media/completion-envelope.ts), which also keeps the historical
// notification wire shapes parsing so an existing backend needs no change.
//
// THREAT MODEL: the SQS message body is an UNTRUSTED POINTER. A replay, a forged
// body, or a spoofed verdict must not move a media object toward "approved". So
// the worker treats the body as nothing more than a job-id pointer and re-fetches
// the authoritative state from the provider. The body's own verdict/status (if
// any) is ALWAYS ignored.
//
// SAFETY ORDER (fixed, never reordered):
//   0. parse body -> jobId ONLY
//   1. PRE-CHECK, rows only, no provider call. An unknown or superseded job
//      row, a row pinned to a version other than the media's current
//      `stagingVersionId`, or a track mismatch is `unroutable`. An item that is
//      no longer UPLOADED, or a track that already has a decision, is a
//      `duplicate`.
//   2. RE-FETCH authoritative track state from the provider (visual) or the
//      transcription seam (audio) — read-only. Derive THIS track's decision
//      SOLELY from the re-fetched result. A job that has not finished
//      (`ModerationJobPendingError`, or an in-progress transcription) is
//      `not-terminal`: acknowledged, nothing claimed, nothing persisted. Any
//      throw is a `retry` with no claim. For the audio track the transcript
//      moderation runs here, so a text-provider outage is also a `retry`.
//   3. ONE database transaction (`store.inTransaction`):
//        a. claim the dedupe key (already claimed => `duplicate`);
//        b. persist this track's decision;
//        c. read the sibling track;
//        d. sibling undecided and this track neither quarantined nor errored
//           => commit and return `awaiting-sibling`;
//        e. otherwise fan in (decidePromotion) and write the lifecycle with a
//           COMPARE-AND-SET (`expectedFrom`); a count other than 1 means a
//           concurrent writer moved the item => `lost-race` (the track
//           decision stays, the lifecycle is untouched).
//   4. AFTER the commit, if APPROVED: promote the pinned version, then emit.
//      A promotion failure is logged and left for the recovery sweeper; the
//      item stays APPROVED but serves nothing until repaired (serving needs
//      the cas/ object), and "ready" is not announced meanwhile. Promotion
//      NEVER precedes the commit: an uncommitted approval must not make bytes
//      servable.
//   A quarantine — or an errored track, which can only ever hold — settles at
//   once rather than waiting for the sibling: nothing the sibling says can
//   improve on it, and waiting would let a lone errored track strand the item.
//   An illegal transition (transition.ok === false) is ack-dropped, never DLQ.
//
// THRESHOLD SNAPSHOT: when (re)interpreting the re-fetched verdict we use the
// threshold snapshot stored ON THE JOB ROW (job.thresholdSnapshot), never live
// Env — so a config edit landing between the original submission and a (re)delivery
// cannot flip a replayed verdict. The reinterpreter is an injected pure function
// (no operational numbers live in this PUBLIC tarball).
//
// This is the imperative shell: it sequences I/O and delegates EVERY decision to
// the pure functional-core units (decidePromotion, combineTrackVerdicts,
// transcriptToModerationDecision, deriveDedupeKey, moderationResolvedPayload).

import { decidePromotion } from "../media/promote-decision.js";
import {
  routeOnConfidence,
  type CascadeRouteConfig,
  type EscalationCause,
} from "../media/cascade-route.js";
import type { DeferredLaneConfig } from "../media/deferred-lane.js";
import type { LabelPolicyExplanation } from "../media/label-policy.js";
import type { ModerationJobPriority } from "./media-processing.js";
import {
  resolvePromoteSource,
  promotePinned,
  type PromoteSource,
} from "../media/promote-staging.js";
import { casKey, pendingKey, isCasKeyError } from "../media/cas-keys.js";
import type { TrackOutcome, Track } from "../media/track-verdict.js";
import { deriveDedupeKey } from "../media/dedupe-key.js";
import { parseCompletionEnvelope } from "../media/completion-envelope.js";
import { moderationResolvedPayload } from "../media/moderation-resolved-payload.js";
import { transcriptToModerationDecision } from "../media/transcript-moderation.js";
import type { TextModerationProvider } from "../media/text-moderation.js";
import type { StoragePort, TranscribePort } from "../media/media-ports.js";
import {
  ModerationJobPendingError,
  isModerationJobPendingError,
  type MediaModerationProvider,
  type ModerationVerdict,
} from "../media/moderation-provider.js";
import type {
  ModerationDecision,
  MediaLifecycle,
} from "../media/media-lifecycle.js";

// ---------------------------------------------------------------------------
// Narrow data shapes the shell needs from persistence. These mirror the Prisma
// MediaModerationJob / MediaFile / ProcessedModerationMessage rows at the I/O
// boundary, but are declared structurally so this module does NOT import the
// generated Prisma client (matching the seam discipline elsewhere in media/).
// ---------------------------------------------------------------------------

/** The persisted moderation-job row, looked up by its provider jobId. */
export interface ModerationJobRow {
  readonly mediaId: string;
  readonly track: Track;
  /**
   * Threshold snapshot captured at submission time (opaque JSON). For a
   * `deferred` row this is the DEFERRED lane's own policy snapshot, captured at
   * trigger time — the escalation runs a different model under a different
   * taxonomy, and interpreting it through the inline snapshot would floor every
   * deferred verdict at `review` via the taxonomy pin (plan 031 §status).
   */
  readonly thresholdSnapshot: unknown;
  /**
   * Scheduling intent (plan 031). `interactive` rows re-fetch from the media
   * provider; `deferred` rows are escalation rows and re-fetch from the
   * {@link EscalationResultPort}.
   */
  readonly priority: ModerationJobPriority;
  /**
   * The staging version this job was submitted against. OPTIONAL: the stock
   * store leaves it `undefined` (core keeps no such column), and an absent
   * value skips the rule below. A store that has it — a deployment tracking
   * provider jobs in its own table — sets it, and a completion for a row whose
   * `pinnedVersion` differs from the media's current `stagingVersionId` is
   * `unroutable`: the verdict is about bytes that are no longer the pinned
   * ones.
   */
  readonly pinnedVersion?: string;
  /**
   * `true` when a later job has replaced this one. OPTIONAL, same contract as
   * {@link pinnedVersion}: absent means "not known to be superseded". A
   * completion for a superseded row is `unroutable`.
   */
  readonly superseded?: boolean;
}

/**
 * The persistence seam. Every method is idempotent-friendly and total; the
 * shell never reaches around it to a concrete client.
 */
export interface CompletionStore {
  /**
   * Attempt to claim a message for processing. Returns `true` if THIS call
   * inserted the row (first delivery), `false` if the row already existed
   * (duplicate — caller must ack-drop). Implemented with an INSERT ...
   * ON CONFLICT DO NOTHING so it is atomic across concurrent deliveries.
   */
  claimMessage(dedupeKey: string): Promise<boolean>;

  /** Look up the job row by its provider jobId. `null` if unknown. */
  findJobByJobId(jobId: string): Promise<ModerationJobRow | null>;

  /**
   * This job's persisted decision, or `null` while unresolved. Read by the
   * pre-check so a redelivery for an already-decided track is dropped before
   * any provider call. OPTIONAL: the dedupe claim inside the transaction is the
   * authority, so a store without it only loses the early exit.
   */
  readTrackDecision?(jobId: string): Promise<ModerationDecision | null>;

  /** Persist this track's resolved decision onto its job row. */
  persistTrackDecision(
    jobId: string,
    decision: ModerationDecision,
  ): Promise<void>;

  /**
   * Read the sibling track's resolved decision for a media object. Returns the
   * decision if the other track's job exists AND has resolved; otherwise the
   * `state` distinguishes a job that exists-but-unresolved from no-such-job.
   *
   * MULTIPLE ROWS PER TRACK (plan 031): when a track has more than one job row
   * — an `interactive` row plus the `deferred` escalation row it spawned — the
   * LATEST row (by creation) is authoritative for that track's state. An
   * escalation row is a strictly later, strictly more deliberate attempt at the
   * same question; the interactive row it supersedes stays open (its decision
   * null) and must not be read as "pending" once the escalation has decided.
   */
  readOtherTrack(
    mediaId: string,
    thisTrack: Track,
  ): Promise<OtherTrackState>;

  /**
   * Create (or re-find) the escalation job row for `parentJobId` (plan 031 C1).
   * MUST be idempotent on the parent: `parent_job_id` is unique, so a retried
   * trigger re-finds the existing row and returns ITS jobId rather than minting
   * a second one — that stability is what keeps the derived dedupe key and the
   * engine's idempotency key the same string across retries. Implemented with
   * INSERT ... ON CONFLICT (parent_job_id) DO NOTHING + re-select.
   *
   * OPTIONAL because only deployments that wire the cascade need it; the shell
   * throws (→ retry, visible) if a cascade is configured without it.
   */
  createEscalationJob?(spec: EscalationJobSpec): Promise<CreatedEscalationJob>;

  /**
   * Record, up front, which tracks a media object will be moderated on, so a
   * completion for one track can tell a sibling that has not started yet from
   * one that will never exist. MUST be idempotent: reserving the same tracks
   * twice is a no-op.
   *
   * OPTIONAL so existing implementers keep compiling; no core path calls it yet.
   */
  reserveTracks?(mediaId: string, tracks: readonly Track[]): Promise<void>;

  /** Read the media object's current persisted lifecycle + CAS coords. */
  findMedia(mediaId: string): Promise<MediaCoords | null>;

  /**
   * Persist a new moderation status for the media object — a COMPARE-AND-SET.
   *
   * MUST be a single conditional update (`updateMany({ where: { id: mediaId,
   * lifecycle: options.expectedFrom }, data: { lifecycle: status } })`) and
   * MUST report how many rows it changed. A human decision or another delivery
   * can land between this worker's read and its write, and an unconditional
   * write would overwrite it. `count !== 1` makes the shell stand down with
   * `lost-race`.
   */
  persistMediaStatus(
    mediaId: string,
    status: MediaLifecycle,
    options: { readonly expectedFrom: MediaLifecycle },
  ): Promise<{ readonly count: number }>;

  /**
   * Run `fn` inside ONE database transaction and return its result. If `fn`
   * throws, everything done through `tx` is rolled back and the error
   * propagates. If it returns, everything commits.
   *
   * MUST serialize transactions for the same `mediaId` (a row lock on the media
   * row, or an advisory lock keyed on it). Two tracks completing at once each
   * persist their own decision and then read the other's; without the lock,
   * under read-committed isolation both can read the sibling as undecided and
   * both answer `awaiting-sibling`, leaving nobody to settle the item. With the
   * lock, the second to enter sees the first's committed decision.
   *
   * `fn` may be run once per call and must stay free of side effects other than
   * through `tx`.
   */
  inTransaction<T>(
    mediaId: string,
    fn: (tx: CompletionTransaction) => Promise<T>,
  ): Promise<T>;
}

/**
 * The store operations that take part in the completion transaction. Same
 * contracts as on {@link CompletionStore}; here they are atomic with each other.
 */
export type CompletionTransaction = Pick<
  CompletionStore,
  | "claimMessage"
  | "persistTrackDecision"
  | "readOtherTrack"
  | "persistMediaStatus"
>;

/**
 * The sibling track's state, used to build its {@link TrackOutcome}.
 *  - `decided`  — the other track has a resolved decision.
 *  - `pending`  — the other track's job exists but has not resolved yet.
 *  - `absent`   — there is no job for the other track on this media object.
 */
export type OtherTrackState =
  | { readonly state: "decided"; readonly decision: ModerationDecision }
  | { readonly state: "pending" }
  | { readonly state: "absent" };

// ---------------------------------------------------------------------------
// The deferred-lane call site's seams (plan 031 C1). All OPTIONAL on
// CompletionDeps: a deployment that wires none of them gets the exact
// pre-cascade behaviour.
// ---------------------------------------------------------------------------

/** What {@link CompletionStore.createEscalationJob} persists. */
export interface EscalationJobSpec {
  readonly mediaId: string;
  readonly track: Track;
  /** The interactive row whose uncertain verdict spawned this escalation. */
  readonly parentJobId: string;
  /** The DEFERRED lane's own policy snapshot (see ModerationJobRow docs). */
  readonly thresholdSnapshot: unknown;
}

/** The escalation row's identity — its jobId is the dedupe-key ingredient. */
export interface CreatedEscalationJob {
  readonly jobId: string;
}

/**
 * What the trigger receives. Structurally identical to the worker host's
 * `EscalationInput` (apps/worker/src/moderation/escalation-run.ts) — declared
 * here too because the dependency arrow runs worker → api, never back.
 *
 * `jobId` is the ESCALATION row's own jobId, never the parent's: the
 * completion dedupe key is SHA-256(contentHash, jobId, track), and re-entering
 * under the parent's jobId would re-derive the key the inline completion
 * already claimed, silently discarding the escalated verdict (plan 031
 * §status).
 */
export interface DeferredEscalationRequest {
  readonly jobId: string;
  readonly mediaId: string;
  readonly tenantId: string;
  readonly track: Track;
  readonly contentHash: string;
  readonly dedupeKey: string;
  readonly cause: EscalationCause;
  readonly confidence: number;
}

/**
 * Where a `deferred` row's verdict is re-fetched from. The deferred lane
 * persists its clamped decision here BEFORE publishing its completion
 * envelope; the envelope stays an untrusted pointer, exactly like the
 * provider-backed tracks. `null` = no result recorded (fail closed: the row's
 * outcome is `errored`, never `approved`).
 */
export interface EscalationResultPort {
  get(jobId: string): Promise<ModerationDecision | null>;
}

/** The cascade wiring, present only where the deferred lane is deployed. */
export interface CompletionCascade {
  /** Operator route config (τ). Refused-at-construction upstream. */
  readonly config: CascadeRouteConfig;
  /** The lane config — read here for `allowApprove` (ships false, plan 031 §7.2). */
  readonly lane: DeferredLaneConfig;
  /** Captured onto every escalation row it creates. */
  readonly deferredThresholdSnapshot: unknown;
  /**
   * Fire the deferred workflow. MUST absorb the engine's idempotency
   * collision and nothing else (the worker host's `triggerEscalation` does
   * exactly this); every other failure must throw so the delivery retries.
   */
  readonly trigger: (req: DeferredEscalationRequest) => Promise<void>;
}

/**
 * The media coordinates the shell needs to gate promotion and build keys. The
 * store returns the RAW identity columns ({@link tenantId}, {@link uploadId},
 * {@link contentHash}); the shell derives every storage key from them via the
 * canonical cas-keys builders (so key construction is centralized here and the
 * store never hand-rolls a key string). {@link contentHash} is the post-
 * transcode SHA-256 the processing worker persisted (NOT the upload-time
 * uploadId placeholder).
 */
export interface MediaCoords {
  readonly lifecycle: MediaLifecycle;
  /** Tenant that owns this object (cas-keys input). */
  readonly tenantId: string;
  /** Upload session id — addresses the raw pending + cleaned staging keys. */
  readonly uploadId: string;
  /** 64-char lowercase SHA-256 of the CLEANED bytes (addresses the cas/ key). */
  readonly contentHash: string;
  /**
   * The S3 versionId of the cleaned STAGING object the processing worker
   * hashed and moderated (AR-SEC F3; persisted via persistCleanedContent).
   * The promote copy pins its source to EXACTLY this version — never "the
   * current bytes at the staging key" (TOCTOU). `null` on legacy/unpinned
   * rows: those can never promote from staging (fail-closed REVIEW hold);
   * only an already-present cas/ object (a prior pinned promote) satisfies
   * them.
   */
  readonly stagingVersionId: string | null;
}

// ---------------------------------------------------------------------------
// Injected pure helpers (no operational numbers in this tarball).
// ---------------------------------------------------------------------------

/**
 * Pure re-interpreter for a VISUAL verdict against the job's threshold snapshot.
 *
 * Injected (not implemented here) so this PUBLIC module carries NO operational
 * thresholds. It receives the SNAPSHOT taken at submission time — never live
 * Env — so a config edit between deliveries cannot flip a replayed verdict. Must
 * be total and fail-closed: any uncertainty maps to `"review"`, never `"approved"`.
 */
export type VisualVerdictReinterpreter = (
  verdict: ModerationVerdict,
  thresholdSnapshot: unknown,
) => ModerationDecision;

/** Everything the per-record processor binds to. */
export interface CompletionDeps {
  readonly store: CompletionStore;
  readonly moderation: MediaModerationProvider;
  readonly transcribe: TranscribePort;
  readonly textModeration: TextModerationProvider;
  readonly storage: StoragePort;
  /** Re-interpret a visual verdict using the job's threshold snapshot. */
  readonly reinterpretVisual: VisualVerdictReinterpreter;
  /** Emit the anti-oracle resolved event. Best-effort; must not throw to ack. */
  readonly emitResolved: (
    payload: { readonly mediaId: string; readonly status: "ready" | "not-ready" },
  ) => Promise<void>;
  /** Structured logger seam (defaults to a no-op in tests). */
  readonly log?: {
    info?: (msg: string, data?: unknown) => void;
    warn?: (msg: string, data?: unknown) => void;
    error?: (msg: string, data?: unknown) => void;
  };
  /**
   * Explain a visual verdict against the job's snapshot (plan 031 C1) — the
   * explanation, not just the decision, because `routeOnConfidence` needs the
   * GROUND (a taxonomy-pin failure must settle, never escalate). Absent ⇒ the
   * cascade never routes and behaviour is exactly pre-cascade.
   */
  readonly explainVisual?: (
    verdict: ModerationVerdict,
    thresholdSnapshot: unknown,
  ) => LabelPolicyExplanation;
  /** The deferred lane's call-site wiring. Absent ⇒ no escalation, ever. */
  readonly cascade?: CompletionCascade;
  /** Where `deferred` rows re-fetch their verdict from. Absent ⇒ errored. */
  readonly escalationResults?: EscalationResultPort;
}

/**
 * The outcome of processing one SQS record. `retry` is the ONLY value that
 * causes the message to be returned to the queue (and eventually DLQ'd);
 * everything else is an ack-drop (idempotent no-op or fail-closed terminal).
 */
export type RecordOutcome =
  | { readonly kind: "duplicate" } // dedupe hit — already processed
  | { readonly kind: "unroutable" } // no jobId / unknown job — fail-closed drop
  | { readonly kind: "illegal-transition" } // replay on terminal — ack-drop, no DLQ
  | { readonly kind: "applied"; readonly status: MediaLifecycle }
  | { readonly kind: "retry"; readonly reason: string } // transient I/O — return to queue
  // Routed to the deferred lane (plan 031 C1): no verdict written, the job
  // stays open, the escalation row + workflow own the rest. An ack.
  | { readonly kind: "escalated"; readonly escalationJobId: string }
  // The job reported progress that is not a final result. An ack.
  | { readonly kind: "not-terminal" }
  // This track resolved but a sibling track has not; the sibling's completion
  // finishes the media object. An ack.
  | { readonly kind: "awaiting-sibling" }
  // A concurrent delivery already moved the media object; this one stands
  // down without writing. An ack.
  | { readonly kind: "lost-race" };

// ---------------------------------------------------------------------------
// Body parsing — extract ONLY the job id from an untrusted pointer.
// ---------------------------------------------------------------------------

/**
 * Extract the provider job pointer from an untrusted completion message body.
 *
 * The parsing itself lives in ./media/completion-envelope.ts, which accepts the
 * canonical `{ track, jobId }` shape any adapter can emit and keeps the
 * historical notification shapes parsing as a fallback. This re-export is the
 * stable name the worker (and existing deep importers) bind to.
 *
 * Returns the job id and the CLAIMED track, or `null` when nothing routable can
 * be recovered. The claimed track is a hint: {@link processCompletion} checks it
 * against the job row before acting on it.
 *
 * Pure & total: never throws.
 */
export function extractJobPointer(
  body: string,
): { readonly jobId: string; readonly track: Track } | null {
  return parseCompletionEnvelope(body);
}

// ---------------------------------------------------------------------------
// Re-fetch authoritative track decision (fail-closed).
// ---------------------------------------------------------------------------

/**
 * Re-fetch THIS track's authoritative decision from the provider, ignoring the
 * message body entirely. Fail-closed: a non-terminal / failed / unknown result
 * yields `"errored"`-equivalent `null` so the caller records it as an errored
 * track outcome (never `"approved"`). A job that has simply not finished yet is
 * different: it throws {@link ModerationJobPendingError} (from the provider, or
 * raised here for an in-progress transcription) so the caller can acknowledge
 * without deciding anything.
 *
 * VISUAL: `getVideoModeration(jobId)` returns a settled verdict; the verdict is
 * re-interpreted against the JOB's threshold snapshot (not live Env).
 *
 * AUDIO: `getTranscription(jobId)` is polled; only a COMPLETED transcription is
 * fed to `transcriptToModerationDecision` (which is itself fail-closed).
 * IN_PROGRESS is pending (throws {@link ModerationJobPendingError}); FAILED or
 * anything else yields `null` (errored — fail closed).
 */
export async function refetchTrackDecision(
  pointer: { readonly jobId: string; readonly track: Track },
  job: ModerationJobRow,
  deps: CompletionDeps,
): Promise<ModerationDecision | null> {
  if (pointer.track === "VISUAL") {
    const verdict = await deps.moderation.getVideoModeration(pointer.jobId);
    if (verdict == null || typeof verdict !== "object") return null;
    const decision = deps.reinterpretVisual(verdict, job.thresholdSnapshot);
    return normalizeDecision(decision);
  }

  // AUDIO
  const res = await deps.transcribe.getTranscription(pointer.jobId);
  if (res != null && res.status === "IN_PROGRESS") {
    throw new ModerationJobPendingError("transcription in progress");
  }
  if (res == null || res.status !== "COMPLETED") {
    // Failed or unrecognised transcription — fail closed (errored).
    return null;
  }
  const transcript = res.transcript ?? "";
  // transcriptToModerationDecision is fail-closed by contract: a throwing seam
  // becomes "review". For a PERSISTED verdict that is right, but here it would
  // turn a transient text-provider outage into a permanent hold. Probe the seam
  // so the shell can see the throw and retry instead (nothing claimed yet).
  let seamFailure: { readonly error: unknown } | null = null;
  const probe: TextModerationProvider = {
    moderateText: async (text) => {
      try {
        return await deps.textModeration.moderateText(text);
      } catch (error) {
        seamFailure = { error };
        throw error;
      }
    },
  };
  const decision = await transcriptToModerationDecision(transcript, probe);
  if (seamFailure !== null) throw (seamFailure as { error: unknown }).error;
  return normalizeDecision(decision);
}

/** Accept only the three known decisions; anything else fails closed to null. */
function normalizeDecision(d: unknown): ModerationDecision | null {
  return d === "approved" || d === "review" || d === "quarantine" ? d : null;
}

// ---------------------------------------------------------------------------
// Build a TrackOutcome from a (possibly null) decision.
// ---------------------------------------------------------------------------

/** A resolved decision => `decided`; a null (failed/unknown) => `errored`. */
function outcomeFromDecision(d: ModerationDecision | null): TrackOutcome {
  return d === null ? { state: "errored" } : { state: "decided", decision: d };
}

/** Map the sibling track's persisted state to a TrackOutcome (fail-closed). */
function outcomeFromOther(other: OtherTrackState): TrackOutcome {
  switch (other.state) {
    case "decided":
      return { state: "decided", decision: other.decision };
    case "absent":
      return { state: "absent" };
    case "pending":
    default:
      // Reached only when this track settles at once (quarantine / errored)
      // with the sibling unresolved; an undecided sibling is NOT approval and
      // the combinator degrades `errored` away from approved, so fail closed.
      // (Otherwise a pending sibling returns `awaiting-sibling` before here.)
      return { state: "errored" };
  }
}

// ---------------------------------------------------------------------------
// Per-record processor (the heart; mock-friendly).
// ---------------------------------------------------------------------------

type Guarded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly outcome: RecordOutcome };

/**
 * Run one read-only provider/port read. A pending job is `not-terminal`; any
 * other throw is a `retry`. Neither has claimed or persisted anything.
 */
async function guardedRead<T>(
  read: () => Promise<T>,
  deps: CompletionDeps,
  jobId: string,
): Promise<Guarded<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    if (isModerationJobPendingError(err)) {
      deps.log?.info?.("completion: job not finished — ack, nothing recorded", {
        jobId,
      });
      return { ok: false, outcome: { kind: "not-terminal" } };
    }
    deps.log?.warn?.("completion: re-fetch failed — retry, nothing claimed", {
      jobId,
      error: String(err),
    });
    return { ok: false, outcome: { kind: "retry", reason: "refetch-failed" } };
  }
}

/** What the transaction decided; promotion and emit happen after the commit. */
type TxResult =
  | { readonly done: RecordOutcome }
  | {
      readonly done?: undefined;
      readonly status: MediaLifecycle;
      readonly promote: boolean;
    };

/**
 * Process one completion message. Returns a {@link RecordOutcome}; only
 * `kind: "retry"` should be surfaced to SQS as a batch-item failure. Throws are
 * caught by the handler and converted to a retry.
 */
export async function processCompletion(
  body: string,
  deps: CompletionDeps,
): Promise<RecordOutcome> {
  // 0. Extract ONLY the job id from the untrusted pointer.
  const pointer = extractJobPointer(body);
  if (pointer === null) {
    deps.log?.warn?.("completion: no job pointer in body — dropping");
    return { kind: "unroutable" };
  }

  // 1. PRE-CHECK — rows only, no provider call, no write.
  const job = await deps.store.findJobByJobId(pointer.jobId);
  if (job === null) {
    deps.log?.warn?.("completion: unknown jobId — dropping", {
      jobId: pointer.jobId,
    });
    return { kind: "unroutable" };
  }
  if (job.superseded === true) {
    deps.log?.warn?.("completion: superseded job row — dropping", {
      jobId: pointer.jobId,
    });
    return { kind: "unroutable" };
  }

  // The body's `track` is a routing HINT chosen by whatever wrote the message;
  // the job row's track is the authority. A mismatch is dropped before any
  // claim, so a forged track cannot burn the slot the genuine completion needs.
  if (pointer.track !== job.track) {
    deps.log?.warn?.("completion: track does not match the job row — dropping", {
      jobId: pointer.jobId,
      claimedTrack: pointer.track,
    });
    return { kind: "unroutable" };
  }

  const media = await deps.store.findMedia(job.mediaId);
  if (media === null) {
    deps.log?.warn?.("completion: media row missing — dropping", {
      mediaId: job.mediaId,
    });
    return { kind: "unroutable" };
  }

  // A row that records the version it was submitted against must still match
  // the media's pin. Absent => the rule is skipped (the stock store has no such
  // column).
  if (
    job.pinnedVersion !== undefined &&
    job.pinnedVersion !== media.stagingVersionId
  ) {
    deps.log?.warn?.("completion: job row pinned to another version — dropping", {
      jobId: pointer.jobId,
    });
    return { kind: "unroutable" };
  }

  if (media.lifecycle !== "UPLOADED") {
    deps.log?.info?.("completion: item already settled — ack-drop", {
      mediaId: job.mediaId,
      from: media.lifecycle,
    });
    return { kind: "duplicate" };
  }
  if (deps.store.readTrackDecision !== undefined) {
    const existing = await deps.store.readTrackDecision(pointer.jobId);
    if (existing !== null) {
      deps.log?.info?.("completion: track already decided — ack-drop", {
        jobId: pointer.jobId,
      });
      return { kind: "duplicate" };
    }
  }

  // 2. RE-FETCH (read-only). `undefined` = not precomputed; `null` = errored.
  //    The deferred row and the cascade-routed visual track obtain their
  //    decision here too, and the escalate branch returns WITHOUT claiming: its
  //    side effects are each idempotent by their own keys (unique parent_job_id;
  //    the engine's idempotency key), and a claim followed by a crash in the
  //    trigger would make the redelivery a "duplicate" and lose the escalation.
  let preDecision: ModerationDecision | null | undefined;

  if (job.priority === "deferred") {
    // A deferred row's provider IS the deferred lane: re-fetch from the
    // escalation-result port. Missing port, missing result, or an unknown
    // value all fail closed to an errored outcome — never approved.
    let got: ModerationDecision | null = null;
    if (deps.escalationResults !== undefined) {
      const port = deps.escalationResults;
      const r = await guardedRead(() => port.get(pointer.jobId), deps, pointer.jobId);
      if (!r.ok) return r.outcome;
      got = r.value;
    }
    const norm = normalizeDecision(got);
    // Re-clamp on the way back in (belt and braces on plan 031 §7.2's "the
    // lane ships unable to approve"): approve survives only when the lane
    // config explicitly allows it. Same law as clampEscalatedDecision.
    const allowApprove = deps.cascade?.lane.allowApprove === true;
    preDecision =
      norm === "approved" && !allowApprove ? "review" : norm;
  } else if (
    pointer.track === "VISUAL" &&
    deps.cascade !== undefined &&
    deps.explainVisual !== undefined
  ) {
    const read = await guardedRead(
      () => deps.moderation.getVideoModeration(pointer.jobId),
      deps,
      pointer.jobId,
    );
    if (!read.ok) return read.outcome;
    const verdict = read.value;
    if (verdict == null || typeof verdict !== "object") {
      // Provider unreadable — errored; falls through to the settle path,
      // which fails closed exactly as it always has.
      preDecision = null;
    } else {
      const explanation = deps.explainVisual(verdict, job.thresholdSnapshot);
      const route = routeOnConfidence(explanation, deps.cascade.config);
      if (route.kind === "escalate") {
        if (deps.store.createEscalationJob === undefined) {
          // Wiring bug, not a data condition: a cascade without a store that
          // can create escalation rows must surface, not settle silently.
          throw new Error(
            "completion: cascade configured but store.createEscalationJob is missing",
          );
        }
        // Idempotent by construction: parent_job_id is unique, so a retried
        // delivery re-finds the SAME escalation row and jobId — which keeps
        // the derived dedupe key and the engine's idempotency key stable.
        const esc = await deps.store.createEscalationJob({
          mediaId: job.mediaId,
          track: pointer.track,
          parentJobId: pointer.jobId,
          thresholdSnapshot: deps.cascade.deferredThresholdSnapshot,
        });
        const escalationDedupeKey = deriveDedupeKey({
          contentHash: media.contentHash,
          jobId: esc.jobId,
          track: pointer.track,
        });
        // A trigger failure THROWS (→ retry): the route recomputes and the
        // trigger re-fires idempotently on the next delivery, because no claim
        // was ever taken.
        await deps.cascade.trigger({
          jobId: esc.jobId,
          mediaId: job.mediaId,
          tenantId: media.tenantId,
          track: pointer.track,
          contentHash: media.contentHash,
          dedupeKey: escalationDedupeKey,
          cause: route.cause,
          confidence: route.confidence,
        });
        // No verdict written, no status persisted, no claim burned: the job
        // stays open and the deferred lane owns the rest (plan 031 §2).
        deps.log?.info?.("completion: escalated to the deferred lane", {
          jobId: pointer.jobId,
          escalationJobId: esc.jobId,
          cause: route.cause,
        });
        return { kind: "escalated", escalationJobId: esc.jobId };
      }
      preDecision = normalizeDecision(route.decision);
    }
  }

  let thisDecision: ModerationDecision | null;
  if (preDecision !== undefined) {
    thisDecision = preDecision;
  } else {
    const r = await guardedRead(
      () => refetchTrackDecision(pointer, job, deps),
      deps,
      pointer.jobId,
    );
    if (!r.ok) return r.outcome;
    thisDecision = r.value;
  }

  // Derive every storage key from the row's identity columns via the canonical
  // cas-keys builders — key construction is centralized here, never trusted from
  // the store. A malformed identity (should be impossible past the upload gate)
  // fails closed to a retry rather than touching an un-addressable key.
  const casK = casKey(media.tenantId, media.contentHash);
  const pendingK = pendingKey(media.tenantId, media.uploadId);
  if (isCasKeyError(casK) || isCasKeyError(pendingK)) {
    deps.log?.error?.("completion: un-addressable media identity — retry", {
      mediaId: job.mediaId,
    });
    return { kind: "retry", reason: "cas-key-error" };
  }
  // The cleaned bytes live at the STAGING key until promoted to cas/.
  const stagingK = `processing/${media.tenantId}/${media.uploadId}`;

  // Resolve the promote SOURCE, version-pinned (AR-SEC F3). Promotion may only
  // ever copy the EXACT staging object version the processing worker hashed and
  // moderated — never "whatever bytes currently sit at the staging key"
  // (TOCTOU). A cas/ object from a prior promote also satisfies presence: those
  // bytes were themselves pin-copied. This is storage I/O, so it happens before
  // the transaction opens, and only when this track approved — any other
  // decision cannot lead to APPROVED, so its source is never consulted.
  const promoteSource: PromoteSource =
    thisDecision === "approved"
      ? await resolvePromoteSource({
          storage: deps.storage,
          stagingKey: stagingK,
          casKey: casK,
          stagingVersionId: media.stagingVersionId,
        })
      : { kind: "none" };
  const casPresent = promoteSource.kind !== "none";

  const dedupeKey = deriveDedupeKey({
    contentHash: media.contentHash,
    jobId: pointer.jobId,
    track: pointer.track,
  });
  // A quarantine, or an errored track (which can only ever hold), settles at
  // once: nothing the sibling says can improve on it.
  const settlesAtOnce = thisDecision === null || thisDecision === "quarantine";

  // 3. ONE transaction: claim -> persist -> read sibling -> fan in -> CAS.
  //    Everything here commits together or not at all, so a failure after the
  //    claim leaves no claim behind for the redelivery to trip over.
  let tx: TxResult;
  try {
    tx = await deps.store.inTransaction<TxResult>(job.mediaId, async (t) => {
      if (!(await t.claimMessage(dedupeKey))) {
        return { done: { kind: "duplicate" } };
      }
      if (thisDecision !== null) {
        await t.persistTrackDecision(pointer.jobId, thisDecision);
      }

      const other = await t.readOtherTrack(job.mediaId, pointer.track);
      if (other.state === "pending" && !settlesAtOnce) {
        return { done: { kind: "awaiting-sibling" } };
      }

      const thisOutcome = outcomeFromDecision(thisDecision);
      const otherOutcome = outcomeFromOther(other);
      const action = decidePromotion({
        visual: pointer.track === "VISUAL" ? thisOutcome : otherOutcome,
        audio: pointer.track === "AUDIO" ? thisOutcome : otherOutcome,
        currentStatus: media.lifecycle,
        casObjectPresent: casPresent,
      });

      // An illegal transition is an idempotent ack-drop — NEVER a DLQ.
      if (action.transition.ok === false) {
        return { done: { kind: "illegal-transition" } };
      }

      let status = action.transition.status;
      let promote = action.shouldPromote;
      // AR-SEC F3 fail-closed hold: approved, but the version-pinned moderated
      // bytes cannot be resolved (unpinned legacy row, pinned version gone, and
      // no prior cas/ promote). Do NOT persist APPROVED — it would emit "ready"
      // with nothing safe to serve. Hold in REVIEW; doubt never serves.
      if (status === "APPROVED" && promoteSource.kind === "none") {
        deps.log?.error?.(
          "completion: approved but pinned moderated bytes unresolvable — holding REVIEW",
          { mediaId: job.mediaId },
        );
        status = "REVIEW";
        promote = false;
      }

      // Compare-and-set from the lifecycle the pre-check saw. Zero rows means a
      // concurrent writer got there first: stand down, keep the track decision.
      const res = await t.persistMediaStatus(job.mediaId, status, {
        expectedFrom: media.lifecycle,
      });
      if (res.count !== 1) return { done: { kind: "lost-race" } };

      return { status, promote };
    });
  } catch (err) {
    deps.log?.error?.("completion: transaction failed — retry, nothing committed", {
      jobId: pointer.jobId,
      error: String(err),
    });
    return { kind: "retry", reason: "transaction-failed" };
  }

  if (tx.done !== undefined) {
    deps.log?.info?.("completion: not settled by this delivery", {
      jobId: pointer.jobId,
      outcome: tx.done.kind,
    });
    return tx.done;
  }

  // 4. AFTER the commit. Promote the CLEANED STAGING bytes — pinned to the
  //    EXACT version that was hashed and moderated — to cas/, then remove the
  //    raw original (pending/) and the staging copy, best-effort. copyObject is
  //    idempotent (content-derived target key). A failure here must not undo
  //    or hide the committed decision: it is logged and the recovery sweeper
  //    repairs the promotion. Until then the item serves nothing, and "ready"
  //    is not announced.
  let servable = true;
  if (tx.promote) {
    try {
      await promotePinned({
        storage: deps.storage,
        source: promoteSource,
        stagingKey: stagingK,
        casKey: casK,
        cleanupKeys: [pendingK, stagingK],
        log: deps.log,
        logContext: { mediaId: job.mediaId },
      });
    } catch (err) {
      servable = false;
      deps.log?.error?.(
        "completion: promotion failed after commit — left for the recovery sweep",
        { mediaId: job.mediaId, error: String(err) },
      );
    }
  }

  // EMIT the anti-oracle resolved event (ready|not-ready ONLY). Best-effort: a
  // redelivery would now be a `duplicate`, so a throw here must not become a
  // retry that can never emit.
  if (servable) {
    try {
      await deps.emitResolved(moderationResolvedPayload(job.mediaId, tx.status));
    } catch (err) {
      deps.log?.warn?.("completion: resolved event not emitted", {
        mediaId: job.mediaId,
        error: String(err),
      });
    }
  }

  deps.log?.info?.("completion: applied", {
    mediaId: job.mediaId,
    status: tx.status,
  });
  return { kind: "applied", status: tx.status };
}

// The SQS `makeHandler` adapter stays in `lambda/media-completion-worker.ts`
// (it already IS the thin AWS shim); this module ships completely SDK- and
// lambda-type-free so the container can host `processCompletion` directly.
