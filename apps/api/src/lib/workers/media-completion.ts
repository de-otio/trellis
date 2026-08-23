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
//   1. DEDUPE FIRST: insert ProcessedModerationMessage(dedupeKey); if it already
//      exists, ack-drop (idempotent no-op) BEFORE any side effect.
//   2. RE-FETCH authoritative track state from the provider (visual) or the
//      transcription seam (audio). Derive THIS track's decision SOLELY from the
//      re-fetched result. Non-terminal / failed / unknown => errored (fail closed).
//   3. Look up the MediaModerationJob by jobId => mediaId + track. Persist this
//      track's decision. Read the OTHER track's decision. Build both TrackOutcomes.
//   4. decidePromotion({ visual, audio, currentStatus, casObjectPresent }).
//      casObjectPresent = the cleaned bytes are available to serve: TRUE iff the
//      cas/ key exists (a prior promote) OR the cleaned STAGING key exists (the
//      processing worker left them there, pre-promote).
//   5. APPLY in fixed order:
//        a. if shouldPromote: copyObject(STAGING -> cas) — promote the CLEANED
//           STAGING bytes (the exact bytes that were moderated), NEVER the raw
//           pending upload. Then best-effort deleteObject(pending) (raw-original
//           cleanup) AND deleteObject(staging) (staging cleanup) — tolerate
//           already-deleted on both. cas/ thus only ever holds APPROVED cleaned
//           bytes ("cleaned-staging, promote-on-approval").
//        b. if shouldPersistStatus: persist transition.status.
//        c. if shouldEmitResolved: emit moderation.resolved with
//           moderationResolvedPayload(mediaId, status) — ready|not-ready ONLY.
//      An illegal transition (transition.ok === false) is ack-dropped, never DLQ.
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
} from "../media/promote-staging.js";
import { casKey, pendingKey, isCasKeyError } from "../media/cas-keys.js";
import type { TrackOutcome, Track } from "../media/track-verdict.js";
import { deriveDedupeKey } from "../media/dedupe-key.js";
import { parseCompletionEnvelope } from "../media/completion-envelope.js";
import { moderationResolvedPayload } from "../media/moderation-resolved-payload.js";
import { transcriptToModerationDecision } from "../media/transcript-moderation.js";
import type { TextModerationProvider } from "../media/text-moderation.js";
import type { StoragePort, TranscribePort } from "../media/media-ports.js";
import type {
  MediaModerationProvider,
  ModerationVerdict,
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

  /** Read the media object's current persisted lifecycle + CAS coords. */
  findMedia(mediaId: string): Promise<MediaCoords | null>;

  /** Persist a new moderation status for the media object. */
  persistMediaStatus(
    mediaId: string,
    status: MediaLifecycle,
  ): Promise<void>;
}

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
  | { readonly kind: "escalated"; readonly escalationJobId: string };

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
 * track outcome (never `"approved"`).
 *
 * VISUAL: `getVideoModeration(jobId)` returns a settled verdict; the verdict is
 * re-interpreted against the JOB's threshold snapshot (not live Env).
 *
 * AUDIO: `getTranscription(jobId)` is polled; only a COMPLETED transcription is
 * fed to `transcriptToModerationDecision` (which is itself fail-closed). Any
 * other status (IN_PROGRESS / FAILED) yields `null` (errored — fail closed).
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
  if (res == null || res.status !== "COMPLETED") {
    // Non-terminal or failed transcription — fail closed (errored).
    return null;
  }
  const transcript = res.transcript ?? "";
  const decision = await transcriptToModerationDecision(
    transcript,
    deps.textModeration,
  );
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
      // A sibling job that exists but has not resolved is NOT approval — the
      // combinator treats `absent` and `errored` alike (both degrade away from
      // approved), and we have no positive evidence yet, so fail closed.
      return { state: "errored" };
  }
}

// ---------------------------------------------------------------------------
// Per-record processor (the heart; mock-friendly).
// ---------------------------------------------------------------------------

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

  // 1. Look up the job row first — needed for the contentHash that scopes the
  //    dedupe key and for the threshold snapshot. (No side effect yet.)
  const job = await deps.store.findJobByJobId(pointer.jobId);
  if (job === null) {
    deps.log?.warn?.("completion: unknown jobId — dropping", {
      jobId: pointer.jobId,
    });
    return { kind: "unroutable" };
  }

  // 1b. The body's `track` is a routing HINT chosen by whatever wrote the
  //     message; the job row's track is the authority. A mismatch is dropped
  //     here — before the dedupe claim — because claiming the key first would
  //     let a message with a forged track burn the slot the genuine completion
  //     needs, turning a parse-level lie into a permanently silenced verdict.
  if (pointer.track !== job.track) {
    deps.log?.warn?.("completion: track does not match the job row — dropping", {
      jobId: pointer.jobId,
      claimedTrack: pointer.track,
    });
    return { kind: "unroutable" };
  }

  // The media object's content hash addresses the dedupe key so identical bytes
  // share fan-in across tenants; we read it from the media coords below. But the
  // dedupe MUST happen before ANY side effect, and persistTrackDecision is a
  // side effect — so we resolve the media first (read-only) to obtain the hash.
  const media = await deps.store.findMedia(job.mediaId);
  if (media === null) {
    deps.log?.warn?.("completion: media row missing — dropping", {
      mediaId: job.mediaId,
    });
    return { kind: "unroutable" };
  }

  // 1c. Pre-claim routing (plan 031 C1). Two cases obtain THIS track's
  //     decision BEFORE the dedupe claim — deliberately, because their
  //     re-fetches are read-only and the escalate branch must NEVER burn the
  //     claim slot: a claim followed by a crash in the trigger would make the
  //     redelivery a "duplicate" and silently lose the escalation. The
  //     escalate branch's own side effects are each idempotent by their own
  //     keys instead (unique parent_job_id; the engine's idempotency key).
  //
  //     `undefined` = not precomputed (the plain path re-fetches after the
  //     claim, exactly as before); `null` = precomputed as errored.
  let preDecision: ModerationDecision | null | undefined;

  if (job.priority === "deferred") {
    // A deferred row's provider IS the deferred lane: re-fetch from the
    // escalation-result port. Missing port, missing result, or an unknown
    // value all fail closed to an errored outcome — never approved.
    const got =
      deps.escalationResults === undefined
        ? null
        : await deps.escalationResults.get(pointer.jobId);
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
    const verdict = await deps.moderation.getVideoModeration(pointer.jobId);
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
        // trigger re-fires idempotently on the next delivery, because the
        // original claim slot below was never touched.
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

  // 2. DEDUPE FIRST — before any side effect. The dedupe key binds the content
  //    hash, the jobId, and the track so the two tracks of the same bytes never
  //    collide and a redelivery of the SAME completion is a no-op. (The
  //    escalate branch above returns without claiming — its side effects carry
  //    their own idempotency; this claim guards the SETTLE path's.)
  const dedupeKey = deriveDedupeKey({
    contentHash: media.contentHash,
    jobId: pointer.jobId,
    track: pointer.track,
  });
  const claimed = await deps.store.claimMessage(dedupeKey);
  if (!claimed) {
    deps.log?.info?.("completion: duplicate delivery — ack-drop", {
      jobId: pointer.jobId,
    });
    return { kind: "duplicate" };
  }

  // 3. RE-FETCH authoritative state for THIS track (body verdict ignored).
  //    Skipped when 1c already obtained it (deferred row / routed-to-settle):
  //    re-fetching twice would double the provider read for no new evidence.
  const thisDecision =
    preDecision !== undefined
      ? preDecision
      : await refetchTrackDecision(pointer, job, deps);

  // Persist this track's decision (the side effect we just earned the right to
  // perform). An errored re-fetch persists nothing on the row (decision stays
  // null) but still contributes an `errored` outcome to the combine.
  if (thisDecision !== null) {
    await deps.store.persistTrackDecision(pointer.jobId, thisDecision);
  }

  // Read the OTHER track's decision and build both outcomes.
  const other = await deps.store.readOtherTrack(job.mediaId, pointer.track);
  const thisOutcome = outcomeFromDecision(thisDecision);
  const otherOutcome = outcomeFromOther(other);

  const visual = pointer.track === "VISUAL" ? thisOutcome : otherOutcome;
  const audio = pointer.track === "AUDIO" ? thisOutcome : otherOutcome;

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

  // 4. Resolve the promote SOURCE, version-pinned (AR-SEC F3), then decide
  //    (pure). Promotion may only ever copy the EXACT staging object version
  //    the processing worker hashed and moderated — never "whatever bytes
  //    currently sit at the staging key" (TOCTOU: a swap between moderation
  //    and promote must not ride the approval into cas/). A cas/ object from
  //    a prior promote also satisfies presence: those bytes were themselves
  //    pin-copied.
  // Normalize fail-closed: only a non-empty string is a usable pin. An
  // undefined/empty value (legacy row, adapter gap) must NOT degrade into an
  // unpinned head/copy of the current staging bytes. (resolvePromoteSource owns
  // that rule, shared with the human-approval path.)
  const promoteSource = await resolvePromoteSource({
    storage: deps.storage,
    stagingKey: stagingK,
    casKey: casK,
    stagingVersionId: media.stagingVersionId,
  });
  const casPresent = promoteSource.kind !== "none";
  const action = decidePromotion({
    visual,
    audio,
    currentStatus: media.lifecycle,
    casObjectPresent: casPresent,
  });

  // An illegal transition (e.g. replay on a terminal APPROVED/REJECTED) is an
  // idempotent ack-drop — NEVER a DLQ.
  if (action.transition.ok === false) {
    deps.log?.info?.("completion: illegal/absorbing transition — ack-drop", {
      mediaId: job.mediaId,
      from: media.lifecycle,
    });
    return { kind: "illegal-transition" };
  }

  const nextStatusValue = action.transition.status;

  // AR-SEC F3 fail-closed hold: both tracks approved but the version-pinned
  // moderated bytes cannot be resolved (unpinned legacy row, pinned version
  // gone, and no prior cas/ promote). Do NOT persist APPROVED — an APPROVED
  // row without certified bytes would emit "ready" with nothing safe to
  // serve, and could later be satisfied by unmoderated bytes. Hold in REVIEW
  // instead: a human (or a pipeline re-run) resolves it; doubt never serves.
  if (nextStatusValue === "APPROVED" && promoteSource.kind === "none") {
    deps.log?.error?.(
      "completion: approved but pinned moderated bytes unresolvable — holding REVIEW",
      { mediaId: job.mediaId },
    );
    await deps.store.persistMediaStatus(job.mediaId, "REVIEW");
    await deps.emitResolved(moderationResolvedPayload(job.mediaId, "REVIEW"));
    return { kind: "applied", status: "REVIEW" };
  }

  // 5. APPLY in fixed order: promote -> persist -> emit.

  // 5a. PROMOTE: copy the CLEANED STAGING bytes — pinned to the EXACT version
  //     that was hashed and moderated (AR-SEC F3) — to cas/ so they can serve;
  //     NEVER the raw pending upload and NEVER the unpinned "current" staging
  //     bytes. copyObject is idempotent (content-derived target key). When the
  //     cas/ object already exists (a prior pinned promote; replay), the copy
  //     is skipped — re-copying from staging could adopt post-moderation
  //     bytes. Then best-effort remove BOTH the raw original (pending/) and
  //     the staging copy. cas/ thus only ever holds APPROVED cleaned bytes.
  if (action.shouldPromote) {
    await promotePinned({
      storage: deps.storage,
      source: promoteSource,
      stagingKey: stagingK,
      casKey: casK,
      // Raw original + cleaned staging copy: both transient, neither may
      // outlive the promotion. Tolerate already-deleted on both (a prior
      // delivery or lifecycle expiry) — the cas/ copy is what matters.
      cleanupKeys: [pendingK, stagingK],
      log: deps.log,
      logContext: { mediaId: job.mediaId },
    });
  }

  // 5b. PERSIST the new status.
  if (action.shouldPersistStatus) {
    await deps.store.persistMediaStatus(job.mediaId, nextStatusValue);
  }

  // 5c. EMIT the anti-oracle resolved event (ready|not-ready ONLY).
  if (action.shouldEmitResolved) {
    const payload = moderationResolvedPayload(job.mediaId, nextStatusValue);
    await deps.emitResolved(payload);
  }

  deps.log?.info?.("completion: applied", {
    mediaId: job.mediaId,
    status: nextStatusValue,
  });
  return { kind: "applied", status: nextStatusValue };
}

// The SQS `makeHandler` adapter stays in `lambda/media-completion-worker.ts`
// (it already IS the thin AWS shim); this module ships completely SDK- and
// lambda-type-free so the container can host `processCompletion` directly.
