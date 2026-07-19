// media-completion.ts — imperative SHELL for the standardized media
// job-completion queue (B2). (WS-2 T6: moved here from
// lambda/media-completion-worker.ts; the lambda file keeps `makeHandler` —
// which already IS the thin AWS adapter — and re-exports this module's
// public surface so existing deep imports keep resolving.)
//
// One queue drains the completion notifications of BOTH async moderation
// tracks of a media object:
//
//   - VISUAL: the image/video moderation provider finishes a job and publishes
//     a completion to SNS, which is fanned into this SQS queue. The SNS envelope
//     carries `{ Message: "<json>" }` whose inner JSON has a `JobId`.
//   - AUDIO: speech-to-text (Transcribe) finishes and emits an EventBridge event
//     fanned into this SQS queue, whose `detail` carries `TranscriptionJobName`.
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
import { casKey, pendingKey, isCasKeyError } from "../media/cas-keys.js";
import type { TrackOutcome, Track } from "../media/track-verdict.js";
import { deriveDedupeKey } from "../media/dedupe-key.js";
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
  /** Threshold snapshot captured at submission time (opaque JSON). */
  readonly thresholdSnapshot: unknown;
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
   */
  readOtherTrack(
    mediaId: string,
    thisTrack: Track,
  ): Promise<OtherTrackState>;

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
  | { readonly kind: "retry"; readonly reason: string }; // transient I/O — return to queue

// ---------------------------------------------------------------------------
// Body parsing — extract ONLY the job id from an untrusted pointer.
// ---------------------------------------------------------------------------

/**
 * Extract the provider job id from an untrusted completion message body.
 *
 * Two shapes are accepted; everything else (and any embedded verdict/status) is
 * ignored:
 *   - Rekognition via SNS:  { "Message": "{...\"JobId\":\"...\"}" }  OR a body
 *     that itself directly carries { "JobId": "..." }.
 *   - Transcribe via EventBridge: { "detail": { "TranscriptionJobName": "..." } }
 *     OR a body that directly carries { "TranscriptionJobName": "..." }.
 *
 * Returns the job id and which track it belongs to, or `null` when no job id can
 * be recovered (fail-closed: the caller ack-drops an unroutable message rather
 * than DLQ-looping a permanently-malformed pointer).
 *
 * Pure & total: never throws.
 */
export function extractJobPointer(
  body: string,
): { readonly jobId: string; readonly track: Track } | null {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return null;
  }
  if (root === null || typeof root !== "object") return null;

  const obj = root as Record<string, unknown>;

  // Transcribe (AUDIO): EventBridge `detail.TranscriptionJobName`, or direct.
  const detail =
    typeof obj.detail === "object" && obj.detail !== null
      ? (obj.detail as Record<string, unknown>)
      : undefined;
  const transcriptionName =
    pickString(detail?.TranscriptionJobName) ??
    pickString(obj.TranscriptionJobName);
  if (transcriptionName !== null) {
    return { jobId: transcriptionName, track: "AUDIO" };
  }

  // Rekognition (VISUAL): SNS `Message` is a JSON string carrying `JobId`, or
  // the body carries `JobId` directly.
  const directJobId = pickString(obj.JobId);
  if (directJobId !== null) {
    return { jobId: directJobId, track: "VISUAL" };
  }
  const snsMessage = pickString(obj.Message);
  if (snsMessage !== null) {
    let inner: unknown;
    try {
      inner = JSON.parse(snsMessage);
    } catch {
      return null;
    }
    if (inner !== null && typeof inner === "object") {
      const innerJobId = pickString((inner as Record<string, unknown>).JobId);
      if (innerJobId !== null) {
        return { jobId: innerJobId, track: "VISUAL" };
      }
    }
  }

  return null;
}

/** Return a non-empty string value, or null for anything else. */
function pickString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
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

  // 2. DEDUPE FIRST — before any side effect. The dedupe key binds the content
  //    hash, the jobId, and the track so the two tracks of the same bytes never
  //    collide and a redelivery of the SAME completion is a no-op.
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
  const thisDecision = await refetchTrackDecision(pointer, job, deps);

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
  type PromoteSource =
    | { readonly kind: "staging"; readonly versionId: string }
    | { readonly kind: "cas" }
    | { readonly kind: "none" };
  let promoteSource: PromoteSource = { kind: "none" };
  // Normalize fail-closed: only a non-empty string is a usable pin. An
  // undefined/empty value (legacy row, adapter gap) must NOT degrade into an
  // unpinned head/copy of the current staging bytes.
  const pinnedVersion =
    typeof media.stagingVersionId === "string" &&
    media.stagingVersionId.length > 0
      ? media.stagingVersionId
      : null;
  if (pinnedVersion !== null) {
    const pinnedHead = await deps.storage.headObject(stagingK, {
      versionId: pinnedVersion,
    });
    if (pinnedHead.exists) {
      promoteSource = { kind: "staging", versionId: pinnedVersion };
    }
  }
  if (promoteSource.kind === "none") {
    if ((await deps.storage.headObject(casK)).exists) {
      promoteSource = { kind: "cas" };
    }
  }
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
    if (promoteSource.kind === "staging") {
      await deps.storage.copyObject(stagingK, casK, {
        fromVersionId: promoteSource.versionId,
      });
    }
    // Best-effort raw-original cleanup. Tolerate already-deleted (a prior
    // delivery or lifecycle expiry) — the cas/ copy is what matters.
    try {
      await deps.storage.deleteObject(pendingK);
    } catch (err) {
      deps.log?.warn?.("completion: pending delete tolerated", {
        mediaId: job.mediaId,
        error: String(err),
      });
    }
    // Best-effort staging cleanup. Same tolerance.
    try {
      await deps.storage.deleteObject(stagingK);
    } catch (err) {
      deps.log?.warn?.("completion: staging delete tolerated", {
        mediaId: job.mediaId,
        error: String(err),
      });
    }
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
