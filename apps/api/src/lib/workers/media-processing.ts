// media-processing.ts — the P0b media-processing orchestration SHELL
// (WS-2 T6: moved here from lambda/media-processing-worker.ts; the lambda
// file remains the thin AWS entrypoint and re-exports this module's public
// surface, so existing deep imports keep resolving).
//
// This is the imperative shell over the pure functional-core media units. It is
// NOT itself a functional-core unit: it performs I/O (object storage, transcode,
// transcription, moderation, DB writes). BUT all of that I/O arrives through
// INJECTED capability seams (TranscodePort / StoragePort / TranscribePort /
// MediaModerationProvider) and a Prisma-shaped persistence port, so the
// orchestration logic is exercised in unit tests against the B0 in-memory Mocks
// — no real cloud, no real encoder, no real DB.
//
// Per the seam discipline (see lib/media/media-ports.ts and
// lib/media/moderation-provider.ts): CORE ships the interfaces + mocks; the
// consuming app (Skybber) injects the concrete cloud adapters at startup via
// `setMediaProcessingDeps()`. Until they are injected, the handler fails CLOSED
// (throws → SQS retry), never silently approves or drops work.
//
// Fail-closed posture, end to end:
//   - A key that is not a well-formed `pending/{tenant}/{upload}` key is dropped
//     (ack) and NEVER written under — the re-trigger-loop guard.
//   - The tenant is re-derived FROM THE ROW, and the triggering key must equal
//     pendingKey(rowTenant, uploadId); a mismatch is a hard reject (poison →
//     REVIEW + ack), so a forged/odd key cannot make us moderate the wrong cas/.
//   - Over-cap duration (T14): terminal REJECTED + the staged object is
//     DELETED before any moderation/transcode job is started (ffprobe is the
//     authoritative duration gate — S3 cannot enforce duration). Ack.
//   - The worker ONLY starts moderation jobs + persists their jobIds; it never
//     fetches verdicts (a separate poller owns fan-in). Moderation runs on the
//     cleaned bytes at the STAGING key, NOT the raw pending upload — and the
//     cleaned bytes are NOT written to cas/ here. cas/ is the CDN-served prefix,
//     so it must only ever hold APPROVED cleaned bytes; the completion worker
//     promotes staging -> cas/ on approval ("cleaned-staging, promote-on-approval").
//   - classifyWorkerError() splits permanent media/payload defects (poison →
//     REVIEW + ack, no DLQ loop) from transient infra faults (retryable → throw
//     → SQS retry → DLQ + alert backstop).

import { createHash } from "node:crypto";

import {
  pendingKey,
  casKey,
  isCasKeyError,
} from "../media/cas-keys.js";
import { exceedsDurationCap } from "../media/duration-cap.js";
import { classifyWorkerErrorDetailed } from "../media/classify-worker-error.js";
import { decidePromotion } from "../media/promote-decision.js";
import { moderationResolvedPayload } from "../media/moderation-resolved-payload.js";
import {
  promotePinned,
  resolvePromoteSource,
} from "../media/promote-staging.js";
import type { Track } from "../media/track-verdict.js";
import type { ModerationDecision } from "../media/media-lifecycle.js";
import type { SyntheticSourceType } from "../provenance/types.js";
import { provenanceMetric } from "../provenance/metrics.js";
import type { MetricsPort } from "./metrics-port.js";
import type {
  StoragePort,
  TranscodePort,
  TranscribePort,
} from "../media/media-ports.js";
import type { MediaLifecycle } from "../media/media-lifecycle.js";
import type {
  MediaModerationProvider,
  ModerationJobDetail,
  ModerationLabel,
  S3Ref,
} from "../media/moderation-provider.js";

import {
  estimateJobCostUsd,
  isOverDailyCap,
  type MediaSpendConfig,
  type MediaSpendGuardPort,
} from "../media/spend-guard.js";

/**
 * Scheduling intent for a moderation job. Recorded, not yet acted on: a
 * deferred lane needs a scheduler, and this is the field it will read.
 */
export type ModerationJobPriority = "interactive" | "deferred";

// ---------------------------------------------------------------------------
// Provider-neutral shapes (WS-2: this core imports neither `aws-lambda` nor
// `@aws-lambda-powertools`)
// ---------------------------------------------------------------------------

/**
 * The slice of a queue record the worker consumes. Structurally satisfied by
 * the AWS `SQSRecord`, so the Lambda entrypoint passes its records through
 * unchanged; the container consumer builds the same shape from received
 * messages.
 */
export interface QueueRecordLike {
  readonly body: string;
  readonly messageId: string;
}

/**
 * Structural logger seam. Satisfied by BOTH a powertools `Logger` instance
 * (what Skybber injects on Lambda today) and the neutral `lib/logger.ts`
 * shape (what the container injects) — the seam is the shape, not the class.
 */
export interface MediaWorkerLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Injected persistence + config seams
// ---------------------------------------------------------------------------

/**
 * The minimal MediaFile row shape the worker reads. Re-declared (not imported
 * from the Prisma client) so this module compiles in worktrees that have not
 * regenerated the client, mirroring moderation-status.ts's discipline. The
 * shell maps the real Prisma row to this shape at the persistence-port boundary.
 */
export interface MediaFileRow {
  readonly id: string;
  readonly tenantId: string;
  readonly uploadId: string | null;
  /**
   * The row's CURRENT lifecycle, when the adapter can supply it.
   *
   * Needed because this worker's queue is at-least-once and it has no dedupe
   * of its own: a redelivered message re-runs the whole pipeline, and without
   * knowing where the object actually stands, a second pass would compute a
   * transition from a state the object left long ago. If a moderator has since
   * REJECTED it, that is a rejection being silently reversed.
   *
   * OPTIONAL, as a published seam requires. The consequence is stated rather
   * than hidden: without it, an object whose tracks all resolve during
   * processing is NOT settled here — it is held for human review instead,
   * because settling would mean writing a lifecycle computed from a guess.
   */
  readonly lifecycle?: MediaLifecycle;
}

/**
 * A copy of the operative moderation thresholds, snapshotted at job-submission
 * time so historical decisions stay auditable after a threshold change. The
 * shape mirrors Env.media.thresholds; the worker treats it as an opaque JSON
 * blob and never reads individual values (no compiled threshold logic here).
 */
export type ThresholdSnapshot = Record<
  string,
  { review: number; quarantine: number }
>;

/**
 * The persistence operations the worker needs, narrowed to exactly what it
 * uses. Implemented in production by a thin Prisma adapter; in tests by an
 * in-memory fake. Keeping this narrow keeps the worker testable without the
 * generated client and documents the worker's full DB surface in one place.
 */
export interface MediaPersistencePort {
  /** Load the MediaFile row for an upload session, or null if none exists. */
  findMediaByUploadId(uploadId: string): Promise<MediaFileRow | null>;
  /**
   * Persist a started per-track moderation job with its threshold snapshot.
   *
   * `initialDecision` pre-resolves the track's verdict at creation time. It is
   * used ONLY for the vacuously-approved AUDIO track of a no-audio video: there
   * is no transcription job to later fan in, so the decision is recorded up
   * front and the completion worker reads it as the sibling track's outcome.
   * Omitted for normal tracks (decision stays null until fan-in resolves it).
   */
  createModerationJob(input: {
    mediaId: string;
    track: Track;
    jobId: string;
    thresholdSnapshot: ThresholdSnapshot;
    initialDecision?: ModerationDecision;
    /**
     * Which backend produced (or will produce) this verdict. Together with the
     * media row's `contentHash`, {@link modelVersion} and {@link policyVersion},
     * this is the four-part identity of a verdict: the same bytes, scored by
     * the same provider, under the same taxonomy and the same sampling policy,
     * are the same answer. Persisting all four now is what lets a verdict cache
     * — or an audit asking "how do you know you caught it?" — be built later
     * without a migration.
     */
    provider?: string;
    /** The taxonomy/model build the verdict was produced under. */
    modelVersion?: string;
    /** The sampling/scoring policy the verdict was produced under. */
    policyVersion?: string;
    /**
     * Scheduling intent. `interactive` is an upload someone is waiting on;
     * `deferred` is one that may be scored later (a budget-pressure lane).
     * Nothing schedules on it yet — carrying the field is the point, because
     * adding it to persisted rows afterwards is a migration and carrying it now
     * is a word.
     */
    priority?: ModerationJobPriority;
    /**
     * Per-frame evidence and counts behind the verdict.
     *
     * NEVER SERVE ANY OF THIS TO A CLIENT — confidences, frame timings and skip
     * counts are a tuning oracle. It is recorded so operators can audit their
     * own pipeline, and the frames it describes are deleted immediately, so if
     * it is not captured here it does not exist anywhere.
     */
    detail?: ModerationJobDetail;
    /** The provider's raw labels. Same server-side-only rule as `detail`. */
    labels?: ReadonlyArray<ModerationLabel>;
  }): Promise<void>;
  /**
   * Persist the REAL content identity of the cleaned bytes onto the MediaFile
   * row, replacing the upload-time `uploadId` placeholder contentHash with the
   * SHA-256 of the transcoded output and recording the future serve key. The
   * completion worker derives the promote target (`cas/{tenant}/{hash}`) from
   * this persisted `contentHash`, so this write MUST happen before moderation
   * fans in — otherwise the object can never promote.
   *
   * `stagingVersionId` (AR-SEC F3) is the S3 versionId of the cleaned STAGING
   * object this worker hashed and started moderation on. The adapter must
   * persist it retrievably for the completion store (no schema change needed —
   * e.g. inside the existing `MediaFile.videoMetadata` JSON column) and
   * surface it back as `MediaCoords.stagingVersionId`, so the promote copy can
   * pin the EXACT moderated version.
   */
  persistCleanedContent(
    mediaId: string,
    content: {
      contentHash: string;
      originalKey: string;
      stagingVersionId: string;
    },
  ): Promise<void>;
  /**
   * Record the synthetic-content provenance read from the ORIGINAL video/audio
   * bytes, before the transcode destroys it (AI Act Art. 50).
   *
   * MONOTONIC RAISE, not a write. The adapter must implement this as a guarded
   * `updateMany` — `where: { id, embeddedSourceType: { in: weakerThan(next) } }`
   * — exactly as the image path does in routes/media.ts, because `MediaFile` is
   * content-addressed and deduped within a tenant: two different originals can
   * transcode to identical bytes and land on the same row, and whichever upload
   * lands second must not erase the other's marking. Also set
   * `provenanceExamined: true` when `examined` is true.
   *
   * OPTIONAL, so an existing consumer adapter still satisfies this interface —
   * this is a published package and a required method would be a breaking change.
   * The consequence is stated plainly rather than hidden: until a consumer
   * implements it, video and audio provenance is READ AND DISCARDED, and the
   * worker logs a warning saying so on every marked upload. See the
   * consuming-application contract (analysis 08).
   */
  recordEmbeddedProvenance?(
    mediaId: string,
    reading: {
      readonly sourceType: SyntheticSourceType;
      readonly examined: boolean;
    },
  ): Promise<void>;
  /** Drive a media object's lifecycle to REVIEW (poison path). */
  markMediaForReview(mediaId: string): Promise<void>;
  /**
   * Persist an arbitrary resolved lifecycle.
   *
   * Needed only when EVERY track resolves during processing — a
   * frame-sampled visual verdict on a silent video — because then no
   * completion notification will arrive and there is nothing else to settle
   * the object. The completion worker owns this transition in every other
   * case.
   *
   * OPTIONAL, as a published seam requires. The consequence is stated rather
   * than hidden: without it, an object whose tracks all resolved inline is
   * driven to REVIEW via `markMediaForReview` instead, whatever the verdict
   * was. That is fail-closed and visible in the review queue — unlike the
   * alternative, which would be a row stuck before any verdict, invisible to
   * everyone.
   */
  persistMediaStatus?(
    mediaId: string,
    status: MediaLifecycle,
    options?: {
      /**
       * Apply the write ONLY if the row still holds this lifecycle.
       *
       * MUST be implemented as a conditional update (`where: { id, lifecycle:
       * expectedFrom }`), for the same reason `markMediaUploaded` must: a human
       * decision can land between this worker reading the row and writing it
       * back, and an unconditional write would clobber it. Together with the
       * lifecycle read this is belt and braces — the read catches a stale
       * replay, the condition catches a race.
       */
      readonly expectedFrom: MediaLifecycle;
    },
  ): Promise<void>;
  /**
   * Drive the `bytes-arrived` transition: AWAITING_UPLOAD -> UPLOADED (T14).
   * MUST be a conditional write (update ... where lifecycle=AWAITING_UPLOAD)
   * so it is idempotent and can never rewind a resolved verdict — the client
   * completion call performs the same transition and the two race benignly.
   */
  markMediaUploaded(mediaId: string): Promise<void>;
  /**
   * Drive a media object's lifecycle to REJECTED — the T14 over-duration
   * terminal path (UPLOADED --over-duration--> REJECTED). The worker deletes
   * the staged object right after; the row must never serve either way.
   */
  markMediaRejected(mediaId: string): Promise<void>;
}

/**
 * The slice of Env.media this worker consumes. Operational parameters arrive
 * here as VALUES sourced from Env.media — never as literals in this file.
 */
export interface MediaProcessingConfig {
  /** Hard duration cap (seconds). From Env.media.maxDurationSeconds. */
  readonly maxDurationSeconds: number;
  /** Current operative thresholds, snapshotted onto each started job. */
  readonly thresholds: ThresholdSnapshot;
  /**
   * Daily AI-spend guard config (AR5). Optional for consumers that have not
   * adopted the guard; when set, `deps.spendGuard` MUST also be wired (and
   * vice versa) — a half-wired guard fails the record closed rather than
   * running unguarded. Values are Env/SSM-sourced, never literals.
   */
  readonly spend?: MediaSpendConfig;
  /**
   * Byte budget for each end of the Art. 50 provenance sniff on video/audio
   * originals (head slice AND tail slice, so the total read is twice this).
   *
   * Runtime config with a conservative default rather than a compiled literal —
   * this bounds a scan of attacker-supplied input, and the npm tarball is public
   * (CLAUDE.md rule 8). Omitted ⇒ {@link DEFAULT_PROVENANCE_SNIFF_BYTES}.
   */
  readonly provenanceSniffBytes?: number;
}

/**
 * Default per-end sniff budget: 256 KiB, matching the image path's JUMBF sniff
 * bound. Large enough for an `ftyp` + `uuid` XMP box at either end of a
 * well-formed MP4, small enough that a malicious 500 MB upload cannot make the
 * worker read itself out of memory.
 */
export const DEFAULT_PROVENANCE_SNIFF_BYTES = 256 * 1024;

/**
 * All capability seams the orchestration core binds to. The handler builds this
 * from the injected concrete adapters; tests build it from the B0 Mocks + an
 * in-memory persistence fake.
 */
export interface MediaProcessingDeps {
  readonly storage: StoragePort;
  readonly transcode: TranscodePort;
  readonly transcribe: TranscribePort;
  readonly moderation: MediaModerationProvider;
  readonly persistence: MediaPersistencePort;
  readonly config: MediaProcessingConfig;
  /**
   * Daily AI-spend counter (AR5). Optional; active iff `config.spend` is also
   * set. Consulted BEFORE the transcode + paid AI jobs; incremented AFTER the
   * jobs were started.
   */
  readonly spendGuard?: MediaSpendGuardPort;
  /**
   * Emit the anti-oracle `moderation.resolved` event (ready|not-ready ONLY).
   *
   * Needed only on the inline-settlement path, where this worker performs the
   * transition the completion worker normally performs — and therefore owes the
   * same notification. Without it a client waiting on the event after uploading
   * a frame-sampled silent video waits forever, which is the exact
   * silent-forever failure the inline path exists to prevent.
   *
   * OPTIONAL, and best-effort: a failure to notify must never undo a decision.
   */
  readonly emitResolved?: (payload: {
    readonly mediaId: string;
    readonly status: "ready" | "not-ready";
  }) => Promise<void>;
  /**
   * Provider-neutral metric emission (WS-2 §5.2). OPTIONAL: this worker predates
   * the port and consumers wire it at their own pace. Absent means the Art. 50
   * provenance counters are not emitted and the log lines are the only signal —
   * which is why the discarded-marking case logs at WARN with the mediaId, rather
   * than relying on a counter that may not be wired.
   */
  readonly metrics?: MetricsPort;
  /** The object-storage bucket handle moderation/transcription refs carry. */
  readonly bucket: string;
  /**
   * Job-name factory for transcription/idempotency. Injected so the shell stays
   * free of Date.now/Math.random in tests; production passes a uuid/time-based
   * generator. `seed` is a stable per-call input (the cas key).
   *
   * MUST BE UNPREDICTABLE — never a pure function of the seed. The job name
   * becomes a completion pointer, and the completion queue dedupes on it: a
   * name derivable from the tenant and upload ids lets anyone who knows those
   * send a completion first, claim the dedupe key, and have the genuine
   * completion later ack-dropped as a duplicate. The object never serves, but
   * it never resolves either. Include real entropy (a uuid) and treat the seed
   * as correlation, not identity.
   */
  readonly newJobName: (seed: string) => string;
  readonly logger: MediaWorkerLogger;
}

// ---------------------------------------------------------------------------
// Per-record outcome
// ---------------------------------------------------------------------------

/**
 * The disposition of one SQS record after orchestration.
 *
 * - `ack`  — remove from the queue (success, drop-non-pending, or poison routed
 *            to REVIEW). A poison ack carries `poison: true` for observability.
 * - `fail` — leave on the queue for SQS to retry (transient/retryable fault).
 *            The handler maps this to a batchItemFailure.
 */
export type RecordOutcome =
  | { readonly disposition: "ack"; readonly reason: string; readonly poison?: boolean }
  | { readonly disposition: "fail"; readonly reason: string };

// ---------------------------------------------------------------------------
// Key parsing — pending/{tenantId}/{uploadId}
// ---------------------------------------------------------------------------

/**
 * Parse a triggering key as a `pending/{tenantId}/{uploadId}` key, validating
 * the FORM by round-tripping the parsed parts back through `pendingKey()`. A
 * key only parses if rebuilding it from its parts yields the identical string —
 * so a path-traversal payload, extra segments, or a malformed id can never pass
 * (cas-keys.ts owns the anchored allowlists).
 *
 * @returns the {tenantId, uploadId} when the key is a canonical pending key,
 *          or null for ANY other key (which the caller ack-drops; we never
 *          write outputs under pending/, so a non-pending key is not our work).
 */
export function parsePendingKey(
  key: string,
): { tenantId: string; uploadId: string } | null {
  const parts = key.split("/");
  if (parts.length !== 3 || parts[0] !== "pending") {
    return null;
  }
  const tenantId = parts[1];
  const uploadId = parts[2];
  const rebuilt = pendingKey(tenantId, uploadId);
  if (isCasKeyError(rebuilt) || rebuilt !== key) {
    return null;
  }
  return { tenantId, uploadId };
}

// ---------------------------------------------------------------------------
// S3-event-over-SQS extraction
// ---------------------------------------------------------------------------

/**
 * Every object key referenced by one queue record. Accepts BOTH shapes
 * (WS-2 §4, Option B — unified path):
 *
 *  - the **native control-inversion message** `{ objectKey: string }` the API
 *    sends from `completeSession` (plus `tenantId`/`uploadId` for logging,
 *    which this parser ignores). NOT URL-decoded — the producer sends the
 *    literal key.
 *  - the **S3-event envelope** `{ Records: [{ s3: { object: { key } } }] }`
 *    from the legacy bucket notification. Kept only to consume in-flight
 *    AWS-notification messages during migration; delete at WS-8. S3
 *    URL-encodes keys and uses '+' for spaces, so these are decoded.
 *
 * Malformed/forged native keys are NOT this parser's problem: the pending-key
 * form gate + row-tenant re-derivation in `processObjectKey` reject them
 * (finding 12 — ack-drop as poison, no retry storm).
 */
export function extractObjectKeys(recordBody: string): string[] {
  const parsed = JSON.parse(recordBody) as {
    Records?: Array<{ s3?: { object?: { key?: string } } }>;
    objectKey?: unknown;
  };

  // Native message: { objectKey } — the unified path (§4 Option B).
  if (typeof parsed.objectKey === "string" && parsed.objectKey.length > 0) {
    return [parsed.objectKey];
  }

  const s3Records = parsed.Records ?? [];
  const keys: string[] = [];
  for (const r of s3Records) {
    const raw = r?.s3?.object?.key;
    if (typeof raw === "string") {
      // S3 URL-encodes keys and uses '+' for spaces in notifications.
      keys.push(decodeURIComponent(raw.replace(/\+/g, " ")));
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Typed errors the orchestration core throws internally
// ---------------------------------------------------------------------------

/** A permanent payload defect: the key did not match the row's tenant/upload. */
class KeyTenantMismatchError extends Error {
  constructor() {
    // The name is in classify-worker-error's poison fragment set ("validation").
    super("media key/tenant validation mismatch: triggering key does not match the row");
    this.name = "ValidationError";
  }
}

/**
 * AR-SEC F3: the cleaned staging object's S3 version could not be resolved —
 * bucket versioning missing/disabled, or the object vanished after transcode.
 * Permanent w.r.t. these bytes: without a pinned version the approve→promote
 * path cannot certify WHAT it would serve, so fail CLOSED to human review
 * (poison → REVIEW + ack), never run an unpinned pipeline.
 */
class StagingVersionUnresolvableError extends Error {
  constructor() {
    // The name is in classify-worker-error's poison fragment set ("validation").
    super(
      "media staging version validation failed: cleaned object version unresolvable (is bucket versioning enabled on the media bucket?)",
    );
    this.name = "ValidationError";
  }
}


// ---------------------------------------------------------------------------
// Orchestration core — testable against the B0 Mocks
// ---------------------------------------------------------------------------

/**
 * Orchestrate processing for ONE already-extracted object key.
 *
 * Steps (every uncertainty fails closed; nothing here can yield APPROVED):
 *  1. Reject any key that is not a canonical `pending/{tenant}/{upload}` key —
 *     ack-drop it; outputs are NEVER written under pending/.
 *  2. Load the MediaFile row by uploadId; re-derive tenant FROM THE ROW and
 *     assert pendingKey(rowTenant, uploadId) === the triggering key. Mismatch
 *     (or missing/uploadId-less row) is a hard reject → REVIEW + ack.
 *  3. Probe duration; over-cap ⇒ poison ⇒ REVIEW + ack (no transcode).
 *  4. Transcode-and-discard ⇒ cleaned bytes at the STAGING key (read back from
 *     the cleaned key). The cleaned bytes are NOT written to cas/ here — cas/ is
 *     the CDN-served prefix and must hold only APPROVED bytes (promotion happens
 *     in the completion worker).
 *  5. Hash the cleaned bytes ⇒ realHash; PERSIST {contentHash: realHash,
 *     originalKey: casKey(tenant, realHash)} onto the row, replacing the
 *     upload-time uploadId placeholder so the completion worker can derive the
 *     promote target.
 *  6. START moderation on the cleaned STAGING object (NOT the raw pending upload,
 *     NOT a cas/ key) — moderation must run on EXACTLY the bytes that will be
 *     served: provider.startVideoModeration ⇒ persist VISUAL job (+ threshold
 *     snapshot); transcribe.startTranscription ⇒ persist AUDIO job (+ snapshot).
 *     The worker only STARTS jobs + persists jobIds; it never fetches verdicts.
 */
export async function processObjectKey(
  triggeringKey: string,
  deps: MediaProcessingDeps,
): Promise<RecordOutcome> {
  // The poster frame the transcode emits is a DERIVATIVE of user media that
  // nothing downstream consumes: it is not hashed, not moderated, and never
  // promoted. Left behind it is an un-moderated still of an object that may
  // well have been quarantined, sitting in the bucket until a lifecycle rule
  // happens to notice. So its key is tracked from the moment it exists and the
  // object is removed on EVERY exit — success, poison, and retry alike.
  //
  // Declared out here (rather than beside the transcode) precisely so the
  // failure paths can reach it, and assigned only AFTER the tenant is
  // re-derived from the row, so a forged triggering key can never aim this
  // delete at someone else's prefix.
  let posterStagingKey: string | null = null;
  try {
    // --- 1. Pending-key form gate (re-trigger-loop guard). ---
    const parsed = parsePendingKey(triggeringKey);
    if (parsed === null) {
      deps.logger.info("Dropping non-pending key (not our work)", {
        key: triggeringKey,
      });
      return { disposition: "ack", reason: "non-pending-key" };
    }
    const { uploadId } = parsed;

    // --- 2. Load row; re-derive tenant FROM THE ROW; assert key match. ---
    const row = await deps.persistence.findMediaByUploadId(uploadId);
    if (row === null || row.uploadId === null) {
      // No row, or a row that lost its upload session — cannot certify this
      // object. Permanent w.r.t. these bytes: fail closed to human review.
      throw new KeyTenantMismatchError();
    }
    const rowTenant = row.tenantId;
    const expectedKey = pendingKey(rowTenant, uploadId);
    if (isCasKeyError(expectedKey) || expectedKey !== triggeringKey) {
      // The triggering key's tenant segment disagrees with the owning tenant,
      // OR the row's tenant is itself malformed. Either way: hard reject.
      throw new KeyTenantMismatchError();
    }

    // --- 2b. Bytes are confirmed present (this event fired because they ---
    // landed): drive AWAITING_UPLOAD -> UPLOADED (T14 `bytes-arrived`) before
    // any processing, so later decision events fan in from the correct state.
    // The adapter's conditional write makes this idempotent — the client's
    // completion call performs the same transition and the two race benignly,
    // and a resolved verdict is never rewound. A throw here is transient
    // (classify → retry), never poison.
    await deps.persistence.markMediaUploaded(row.id);

    // --- 3. Duration cap (probe BEFORE transcoding — cost + abuse guard). ---
    // T14: over-cap is a TERMINAL REJECT, not REVIEW — duration is a product
    // limit, not a content-safety doubt, so it must not consume human-review
    // bandwidth. The staged object is deleted BEFORE any moderation/transcode
    // job could see it (ffprobe is the authoritative duration gate; S3's
    // content-length-range can only rail bytes, not seconds). Fail-closed
    // either way: a REJECTED row never serves, and if the reject-write throws
    // the record retries (row stays UPLOADED — also never serves).
    const probed = await deps.transcode.probeDurationSeconds(triggeringKey);
    if (exceedsDurationCap(probed, deps.config.maxDurationSeconds)) {
      await deps.persistence.markMediaRejected(row.id);
      try {
        await deps.storage.deleteObject(triggeringKey);
      } catch (delErr) {
        // The row is already REJECTED (never serves); a leftover pending/
        // object is storage noise, not a safety hole. Log loudly for ops.
        deps.logger.error(
          "Over-duration reject: staged-object delete failed (row already REJECTED)",
          { key: triggeringKey, error: delErr },
        );
      }
      deps.logger.warn("Duration cap exceeded — media REJECTED, staged object deleted", {
        key: triggeringKey,
        mediaId: row.id,
        probedSeconds: probed,
        maxDurationSeconds: deps.config.maxDurationSeconds,
      });
      return { disposition: "ack", reason: "duration-cap-rejected" };
    }

    // --- 3b. Daily AI-spend guard (AR5) — gate BEFORE the transcode and the ---
    // paid AI jobs. Every uncertainty fails CLOSED as a `fail` disposition
    // (SQS retry → DLQ backstop), NEVER as poison: an over-cap or a counter
    // outage says nothing about the media, so the object must not be driven
    // to REVIEW; the message is routed to the DLQ via the redrive policy.
    const spendGate = resolveSpendGuard(deps);
    if (spendGate === "misconfigured") {
      deps.logger.error(
        "Spend guard misconfigured (config.spend and spendGuard must be wired together) — failing record closed",
        { key: triggeringKey },
      );
      return { disposition: "fail", reason: "spend-guard-misconfigured" };
    }
    let estimatedUsd = 0;
    if (spendGate !== undefined) {
      estimatedUsd = estimateJobCostUsd(probed, spendGate.config.perMinuteRateUsd);
      let currentUsd: number;
      try {
        currentUsd = await spendGate.guard.getTodaySpendUsd();
      } catch (readErr) {
        // Counter unreadable ⇒ we cannot prove we are under the cap ⇒ do NOT
        // start paid jobs (fail closed). Retry/DLQ, never poison/REVIEW.
        deps.logger.error(
          "Spend counter read failed — failing record closed (no AI jobs started)",
          { key: triggeringKey, error: readErr },
        );
        return { disposition: "fail", reason: "spend-guard-unavailable" };
      }
      if (isOverDailyCap(currentUsd, spendGate.config.dailyCapUsd)) {
        deps.logger.warn(
          "Daily media AI spend cap reached — short-circuiting job to retry/DLQ",
          { key: triggeringKey, currentUsd, dailyCapUsd: spendGate.config.dailyCapUsd },
        );
        try {
          await spendGate.guard.reportCapExceeded();
        } catch (reportErr) {
          // Best-effort observability signal; never changes the disposition.
          deps.logger.warn("reportCapExceeded failed (ignored)", { error: reportErr });
        }
        return { disposition: "fail", reason: "daily-spend-cap-exceeded" };
      }
    }

    // --- 3b. Art. 50 provenance: read the ORIGINAL before the transcode. ---
    //
    // The transcode destroys the marking. Verified empirically against ffmpeg 8.1
    // with the production argv: an XMP `uuid` box carrying
    // `Iptc4xmpExt:DigitalSourceType` is present in the input bytes and absent
    // from the output. (The same audit found that `-dn` alone did NOT strip the
    // container metadata dictionary, so GPS survived — fixed separately in
    // ffmpeg-args.ts with `-map_metadata -1`, which is also what destroys the
    // marking outright rather than partially.)
    //
    // So this is the video/audio analogue of the image path's read-then-strip:
    // look first, keep one enum's worth, discard the rest.
    //
    // BOUNDED, and never able to fail the upload. Two ranged reads instead of
    // pulling a possibly-huge original into the worker; any error at all is
    // swallowed to UNKNOWN. Provenance is a disclosure, not a safety gate — an
    // unreadable original must not poison a media object.
    await recordOriginalProvenance(deps, row.id, triggeringKey);

    // --- 4. Transcode-and-discard ⇒ cleaned bytes. ---
    // The cleaned output is written to a transient staging key OUTSIDE pending/
    // (so re-uploading the cleaned bytes can never re-trigger this worker).
    const cleanedStagingKey = `processing/${rowTenant}/${uploadId}`;
    posterStagingKey = `processing/${rowTenant}/${uploadId}.poster`;
    const transcodeResult = await deps.transcode.transcodeVideo({
      inputPath: triggeringKey,
      outputPath: cleanedStagingKey,
      posterPath: posterStagingKey,
      maxDurationSeconds: deps.config.maxDurationSeconds,
    });
    const cleanedStagingKeyOut = transcodeResult.cleanedPath;
    // Track the poster the adapter REPORTS rather than the one we requested.
    // The same function already trusts `cleanedPath` over the requested output
    // path, for the same reason: an adapter may write elsewhere (an image muxer
    // that appends an extension, say), and deleting the key we asked for would
    // then silently miss the still that actually exists.
    if (typeof transcodeResult.posterPath === "string" && transcodeResult.posterPath.length > 0) {
      posterStagingKey = transcodeResult.posterPath;
    }

    // --- 4b. AR-SEC F3 (TOCTOU): pin the EXACT staging object version we ---
    // are about to hash and moderate. Everything downstream — the content
    // hash, the started moderation jobs, and the completion worker's promote
    // copy — references THIS version, so bytes swapped at the same key after
    // this point can never ride an earlier approval into cas/. Requires S3
    // bucket versioning on the media bucket; an unresolvable version fails
    // CLOSED (poison → REVIEW), never an unpinned pipeline.
    const cleanedHead = await deps.storage.headObject(cleanedStagingKeyOut);
    if (!cleanedHead.exists || cleanedHead.versionId === undefined) {
      throw new StagingVersionUnresolvableError();
    }
    const stagingVersionId = cleanedHead.versionId;
    const cleanedBytes = await deps.storage.getObject(cleanedStagingKeyOut, {
      versionId: stagingVersionId,
    });

    // --- 5. Hash the CLEANED bytes ⇒ real content identity; persist it. ---
    // We do NOT write the cleaned bytes to cas/ here: they already live at the
    // STAGING key, and cas/ (the CDN-served prefix) must only ever hold APPROVED
    // bytes. We persist the real hash + future serve key so the completion
    // worker can promote staging -> cas/ on approval.
    const contentHash = createHash("sha256").update(cleanedBytes).digest("hex");
    const cleanedCasKey = casKey(rowTenant, contentHash);
    if (isCasKeyError(cleanedCasKey)) {
      // The hash/tenant failed the CAS allowlist — a permanent defect in our own
      // derivation inputs (e.g. a malformed tenant that slipped the row check).
      // Fail closed: route to review rather than serve un-addressable bytes.
      throw new KeyTenantMismatchError();
    }
    // Replace the upload-time uploadId placeholder contentHash with the REAL
    // hash and record the future serve key (cas/{tenant}/{hash}) plus the
    // pinned staging version the completion worker's promote copy must use.
    await deps.persistence.persistCleanedContent(row.id, {
      contentHash,
      originalKey: cleanedCasKey,
      stagingVersionId,
    });

    // --- 6. START moderation on the CLEANED STAGING object (the exact bytes ---
    // that will be served), NOT the raw pending upload and NOT a cas/ key.
    // The ref is version-pinned (AR-SEC F3) so the provider scans EXACTLY the
    // bytes we hashed. (Transcription cannot pin a version — Transcribe's
    // MediaFileUri is unversioned — but the promote copy still pins, so the
    // bytes that can ever serve remain exactly the hashed/pinned version.)
    // BOTH pin fields are set on purpose: `pin` is the shape core and new
    // adapters read, `versionId` is the deprecated alias an already-shipped
    // adapter reads. Sending only the new one would silently un-pin every
    // existing consumer — the opposite of what widening a seam should do.
    const stagingRef: S3Ref = {
      bucket: deps.bucket,
      key: cleanedStagingKeyOut,
      pin: { kind: "versionId", value: stagingVersionId },
      versionId: stagingVersionId,
    };

    const visual = await deps.moderation.startVideoModeration(stagingRef);
    // A backend may resolve the whole track during `start` — core's
    // frame-sampling adapter does exactly that. Then there is no remote job to
    // poll and no completion notification will ever arrive, so the decision is
    // recorded now, using the same mechanism a silent video's audio track uses.
    await deps.persistence.createModerationJob({
      mediaId: row.id,
      track: "VISUAL",
      jobId: visual.jobId,
      // Snapshot the CURRENT operative thresholds onto the job at submission.
      thresholdSnapshot: deps.config.thresholds,
      priority: "interactive",
      ...(visual.initialDecision !== undefined && {
        initialDecision: visual.initialDecision,
      }),
      // The verdict's identity and its evidence. Optional on the port, so an
      // adapter that stores none of it still satisfies the interface — but
      // then the evidence is gone, because the frames it describes are deleted
      // as soon as the verdict is aggregated.
      ...(visual.modelVersion !== undefined && {
        modelVersion: visual.modelVersion,
      }),
      ...(visual.policyVersion !== undefined && {
        policyVersion: visual.policyVersion,
      }),
      ...(visual.labels !== undefined && { labels: visual.labels }),
      ...(visual.detail !== undefined && { detail: visual.detail }),
    });

    // AUDIO track. A video with an audio stream is transcribed and moderated
    // over the transcript (fan-in resolves the verdict later). A video with NO
    // audio stream has nothing to transcribe: starting a transcription would
    // fail and fail the track closed to REVIEW forever. Instead we record the
    // AUDIO track as vacuously APPROVED at creation (no audio ⇒ no audio content
    // to be unsafe) and start no transcription. The VISUAL completion then fans
    // in against this pre-resolved decision. Fail-closed is preserved: this is a
    // positive verdict on a track with no content, not approval-from-doubt.
    let audioJobId: string;
    let audioInitialDecision: ModerationDecision | undefined;
    if (transcodeResult.hasAudio) {
      const audio = await deps.transcribe.startTranscription({
        key: cleanedStagingKeyOut,
        jobName: deps.newJobName(cleanedStagingKeyOut),
      });
      audioJobId = audio.jobId;
      await deps.persistence.createModerationJob({
        mediaId: row.id,
        track: "AUDIO",
        jobId: audioJobId,
        thresholdSnapshot: deps.config.thresholds,
      });
    } else {
      // Synthetic, unique job id: no provider job exists, and no completion
      // message will ever reference it (the completion worker reads this track
      // by mediaId+track, not by job id). Namespaced so it can never collide
      // with a real Transcribe job name.
      audioJobId = `noaudio:${row.id}`;
      audioInitialDecision = "approved";
      await deps.persistence.createModerationJob({
        mediaId: row.id,
        track: "AUDIO",
        jobId: audioJobId,
        thresholdSnapshot: deps.config.thresholds,
        initialDecision: audioInitialDecision,
      });
    }

    // --- 6b. Both tracks resolved during processing? Then settle the object ---
    // here. Nothing else can: no provider job is outstanding, so no completion
    // notification is coming, and an object waiting for a message that will
    // never arrive would sit un-servable and un-rejected indefinitely — the
    // exact silent-forever failure this pipeline refuses elsewhere.
    if (
      visual.initialDecision !== undefined &&
      audioInitialDecision !== undefined
    ) {
      await settleInlineResolvedTracks(deps, {
        mediaId: row.id,
        currentStatus: row.lifecycle,
        visual: visual.initialDecision,
        audio: audioInitialDecision,
        stagingKey: cleanedStagingKeyOut,
        casKey: cleanedCasKey,
        pendingKey: triggeringKey,
        stagingVersionId,
      });
    }

    // --- 7. Record the started jobs' estimated spend (AR5). The money is ---
    // committed once the jobs are started, so the counter is incremented HERE
    // (not at the gate): a short-circuited/retried record never inflates it.
    // KNOWN FAIL-OPEN (write path only, documented — cf. T4-F2): if this write
    // fails, the jobs have already been started and re-running them via a
    // retry would double real spend, so we log loudly and ack; the counter may
    // UNDERCOUNT until the backend recovers. The load-bearing READ gate above
    // fails closed.
    if (spendGate !== undefined) {
      try {
        await spendGate.guard.recordSpendUsd(estimatedUsd);
      } catch (recordErr) {
        deps.logger.error(
          "Failed to record media AI spend — daily counter may undercount (jobs already started; acking)",
          { key: triggeringKey, estimatedUsd, error: recordErr },
        );
      }
    }

    deps.logger.info("Started per-track moderation jobs", {
      mediaId: row.id,
      stagingKey: cleanedStagingKeyOut,
      stagingVersionId,
      casKey: cleanedCasKey,
      visualJobId: visual.jobId,
      audioJobId,
      hasAudio: transcodeResult.hasAudio,
      estimatedSpendUsd: estimatedUsd,
    });

    return { disposition: "ack", reason: "started-moderation" };
  } catch (err) {
    // Single classification point: poison ⇒ REVIEW + ack; retryable ⇒ fail.
    const { klass, infraFault } = classifyWorkerErrorDetailed(err);
    if (infraFault) {
      // The adapter reported that the INFRASTRUCTURE failed, not the media.
      // Whatever core does about this call, holding media SILENTLY is wrong —
      // a fail-closed verdict and an outage look identical from the review
      // queue, so the fault is announced separately from the decision.
      //
      // This now fires on retryable faults too (a 429 rate limit, a 5xx, a
      // socket failure), not only on unattributable permanent ones. That is
      // deliberate: those are the faults that used to accumulate into a review
      // spike with nothing counting them. The message no longer says
      // "unattributable", because most of these are precisely attributable.
      emitInfraFaultMetric(deps);
      deps.logger.error(
        "Moderation provider reported an infrastructure fault — the endpoint failed, not the media; an infrastructure fault is raised",
        { key: triggeringKey, retryable: klass === "retryable", error: err },
      );
    }
    if (klass === "poison") {
      // Best-effort route to REVIEW. If we can identify the row, mark it; if we
      // cannot (e.g. the failure was the row lookup itself), there is nothing to
      // mark and the ack simply drops a message that would loop forever.
      const reviewReason = await routePoisonToReview(triggeringKey, deps, err);
      return { disposition: "ack", reason: reviewReason, poison: true };
    }
    deps.logger.error("Retryable media-processing fault — letting SQS retry", {
      key: triggeringKey,
      error: err,
    });
    return { disposition: "fail", reason: "retryable" };
  } finally {
    // Runs on every exit, including the returns above.
    await deletePosterStaging(deps, posterStagingKey);
  }
}

/**
 * Remove the transient poster still. Best-effort and totally non-fatal: a
 * leftover poster is storage noise, while a delete failure that escaped here
 * would turn a completed record into a retry (and re-run paid AI jobs).
 */
async function deletePosterStaging(
  deps: MediaProcessingDeps,
  posterStagingKey: string | null,
): Promise<void> {
  if (posterStagingKey === null) return;
  try {
    await deps.storage.deleteObject(posterStagingKey);
  } catch (err) {
    deps.logger.warn("Poster staging delete tolerated", {
      key: posterStagingKey,
      error: err,
    });
  }
}

/**
 * Resolve the AR5 spend-guard wiring for this deps bag.
 *
 * - Both `deps.spendGuard` and `deps.config.spend` present ⇒ active guard.
 * - Neither present ⇒ `undefined` (guard not adopted; worker runs as before).
 * - Exactly one present ⇒ `"misconfigured"`: a half-wired guard means the
 *   operator INTENDED a cap, so running unguarded would fail OPEN. The caller
 *   fails the record closed instead.
 */
/**
 * Read the Art. 50 provenance marking off an ORIGINAL video/audio object and
 * record it, before the transcode destroys it.
 *
 * TOTALLY NON-FATAL. Every failure mode — an unreadable original, a storage
 * adapter with no `range` support, a consumer whose persistence adapter has not
 * implemented `recordEmbeddedProvenance`, a throw from anywhere — resolves to
 * "nothing recorded" plus a log line. A disclosure field must never be able to
 * fail an upload or poison a media object, so this function returns `void` and
 * swallows everything.
 *
 * Two ranged reads (head + tail), because MP4 writers put the XMP `uuid` box at
 * either end and pulling a several-hundred-megabyte original into the worker to
 * find a few hundred bytes is not acceptable. An adapter that IGNORES `range` and
 * returns the whole object still works — the sniff simply searches more bytes
 * than it asked for — so this degrades gracefully on a consumer that has not
 * updated its StoragePort.
 */
async function recordOriginalProvenance(
  deps: MediaProcessingDeps,
  mediaId: string,
  originalKey: string,
): Promise<void> {
  try {
    const budget =
      deps.config.provenanceSniffBytes ?? DEFAULT_PROVENANCE_SNIFF_BYTES;

    const head = await deps.storage.getObject(originalKey, {
      range: { start: 0, end: budget - 1 },
    });

    // The tail read is a SEPARATE best-effort: a short object makes the tail
    // range unsatisfiable on some S3-compatible stores (416), and the head read
    // has usually already covered the whole file in that case.
    let tail: Buffer = Buffer.alloc(0);
    try {
      const size = (await deps.storage.headObject(originalKey)).size;
      if (typeof size === "number" && size > budget) {
        tail = await deps.storage.getObject(originalKey, {
          range: { start: Math.max(0, size - budget), end: size - 1 },
        });
      }
    } catch {
      // No tail. The head slice still yields a reading for front-loaded markings.
    }

    const { readTimedMediaProvenance } = await import(
      "../metadata/provenance-reader.js"
    );
    const reading = readTimedMediaProvenance(head, tail);

    if (!reading.examined) return; // Nothing found; nothing to record.

    // A container was found but carried nothing usable — worth counting
    // separately from "recognised", because a rising unrecognised rate means the
    // vocabulary map is falling behind what tools actually emit.
    if (reading.sourceType === "UNKNOWN") {
      emitProvenanceMetric(deps, {
        kind: "unrecognised",
        container: reading.container ?? "xmp",
        mediaKind: "timed-media",
      });
      return;
    }

    if (typeof deps.persistence.recordEmbeddedProvenance !== "function") {
      emitProvenanceMetric(deps, {
        kind: "discarded",
        reason: "no-persistence-port",
        mediaKind: "timed-media",
      });
      // Said out loud, on every marked upload, rather than failing silently:
      // the read worked and the value is being thrown away because the
      // consuming application has not implemented the port method yet.
      deps.logger.warn(
        "provenance.discarded: read an AI provenance marking from a video/audio original but the persistence adapter does not implement recordEmbeddedProvenance — the marking is being DISCARDED (see analysis 08, consuming-application contract)",
        { mediaId, sourceType: reading.sourceType, container: reading.container },
      );
      return;
    }

    await deps.persistence.recordEmbeddedProvenance(mediaId, {
      sourceType: reading.sourceType,
      examined: reading.examined,
    });

    emitProvenanceMetric(deps, {
      kind: "recognised",
      sourceType: reading.sourceType,
      basis: "EMBEDDED_METADATA",
      mediaKind: "timed-media",
    });

    deps.logger.info("provenance.recognised", {
      mediaId,
      sourceType: reading.sourceType,
      container: reading.container,
      kind: "timed-media",
    });
  } catch (error) {
    emitProvenanceMetric(deps, {
      kind: "read-failed",
      mediaKind: "timed-media",
    });
    deps.logger.warn(
      "provenance.read-failed: could not read provenance from the original (upload unaffected)",
      { mediaId, error },
    );
  }
}

/**
 * Settle an object whose every track resolved during processing.
 *
 * This is the completion worker's job done here, because in this one case there
 * is no completion to wait for. It uses the SAME pure decision (`decidePromotion`)
 * and the SAME version-pinned promotion, so the two paths cannot drift into
 * disagreeing about what "approved" means.
 *
 * Fail-closed, twice:
 *  - Approved but the pinned moderated bytes cannot be resolved ⇒ hold REVIEW.
 *    An APPROVED row with nothing certifiable to serve is worse than a held one.
 *  - No `persistMediaStatus` on the consumer's adapter ⇒ REVIEW, whatever the
 *    verdict was, via the port method that has always been required.
 *
 * Never throws: a failure here must not re-run the paid jobs that already ran.
 */
async function settleInlineResolvedTracks(
  deps: MediaProcessingDeps,
  args: {
    readonly mediaId: string;
    /** The row's ACTUAL lifecycle; `undefined` when the adapter cannot say. */
    readonly currentStatus: MediaLifecycle | undefined;
    readonly visual: ModerationDecision;
    readonly audio: ModerationDecision;
    readonly stagingKey: string;
    readonly casKey: string;
    readonly pendingKey: string;
    readonly stagingVersionId: string;
  },
): Promise<void> {
  // Without the row's real lifecycle we cannot tell a first delivery from a
  // redelivery of an object a moderator has since decided. Writing a status
  // computed from an assumed "UPLOADED" would silently reverse that decision,
  // so refuse: hold for review instead, and say why.
  if (args.currentStatus === undefined) {
    deps.logger.warn(
      "Inline resolution: the persistence adapter does not report the row's lifecycle, so this object is being held for human review rather than settled from an assumed state (surface MediaFileRow.lifecycle to enable inline video verdicts)",
      { mediaId: args.mediaId },
    );
    try {
      await deps.persistence.markMediaForReview(args.mediaId);
    } catch (err) {
      deps.logger.error("Inline resolution: could not hold for review", {
        mediaId: args.mediaId,
        error: err,
      });
    }
    return;
  }

  try {
    const source = await resolvePromoteSource({
      storage: deps.storage,
      stagingKey: args.stagingKey,
      casKey: args.casKey,
      stagingVersionId: args.stagingVersionId,
    });
    const action = decidePromotion({
      visual: { state: "decided", decision: args.visual },
      audio: { state: "decided", decision: args.audio },
      currentStatus: args.currentStatus,
      casObjectPresent: source.kind !== "none",
    });
    if (action.transition.ok === false) {
      // A replay on an object that has already moved on — including one a
      // moderator has decided. Ack-drop it exactly as the completion worker
      // does; never coerce it into a legal-looking transition.
      deps.logger.info(
        "Inline resolution: illegal/absorbing transition — leaving the object as it stands",
        { mediaId: args.mediaId, from: args.currentStatus },
      );
      return;
    }

    let status = action.transition.status;
    if (status === "APPROVED" && source.kind === "none") {
      deps.logger.error(
        "Inline resolution: approved but the pinned moderated bytes are unresolvable — holding REVIEW",
        { mediaId: args.mediaId },
      );
      status = "REVIEW";
    } else if (action.shouldPromote && source.kind !== "none") {
      await promotePinned({
        storage: deps.storage,
        source,
        stagingKey: args.stagingKey,
        casKey: args.casKey,
        cleanupKeys: [args.pendingKey, args.stagingKey],
        log: {
          warn: (msg, data) =>
            deps.logger.warn(msg, data as Record<string, unknown>),
        },
        logContext: { mediaId: args.mediaId },
      });
    }

    if (typeof deps.persistence.persistMediaStatus === "function") {
      // Conditional on the state this decision was computed FROM, so a human
      // decision landing in between is not clobbered.
      await deps.persistence.persistMediaStatus(args.mediaId, status, {
        expectedFrom: args.currentStatus,
      });
    } else {
      deps.logger.warn(
        "Inline resolution: the persistence adapter cannot record a resolved status, so this object is being held for human review regardless of its verdict (implement persistMediaStatus to enable inline video verdicts)",
        { mediaId: args.mediaId, wouldHaveBeen: status },
      );
      await deps.persistence.markMediaForReview(args.mediaId);
    }

    // The notification the completion worker would have sent. Best-effort: the
    // decision is already persisted, and a failed notify must not undo it.
    if (typeof deps.emitResolved === "function") {
      try {
        await deps.emitResolved(moderationResolvedPayload(args.mediaId, status));
      } catch (err) {
        deps.logger.warn(
          "Inline resolution: resolved-event emission failed (decision already persisted)",
          { mediaId: args.mediaId, error: err },
        );
      }
    } else {
      deps.logger.warn(
        "Inline resolution: no resolved-event emitter is wired, so a client waiting on the upload notification will not be told this object settled (wire deps.emitResolved)",
        { mediaId: args.mediaId, status },
      );
    }

    deps.logger.info("Inline resolution: settled without a completion message", {
      mediaId: args.mediaId,
      status,
    });
  } catch (err) {
    // The jobs already ran; a retry would re-run them. Hold for review instead.
    deps.logger.error(
      "Inline resolution failed — holding the object for human review",
      { mediaId: args.mediaId, error: err },
    );
    try {
      await deps.persistence.markMediaForReview(args.mediaId);
    } catch {
      // Nothing further to try; the row stays pre-verdict and never serves.
    }
  }
}

/**
 * Emit one infrastructure-fault counter, if a MetricsPort is wired. Kept
 * separate from the verdict counters on purpose: this says the pipeline is
 * unhealthy, not that the media is suspect.
 */
function emitInfraFaultMetric(deps: MediaProcessingDeps): void {
  if (!deps.metrics) return;
  try {
    deps.metrics.emitCounts(
      { kind: "moderation-infra-fault" },
      [{ name: "ModerationInfraFault", value: 1 }],
    );
  } catch {
    // A metrics bug must never become a media-pipeline bug.
  }
}

/**
 * Emit one provenance counter, if a MetricsPort is wired. Fail-open twice over:
 * the port is optional, and adapters are themselves required to swallow their own
 * failures — but this catches anyway, because a metrics bug must not be able to
 * turn into a media-pipeline bug.
 */
function emitProvenanceMetric(
  deps: MediaProcessingDeps,
  event: Parameters<typeof provenanceMetric>[0],
): void {
  if (!deps.metrics) return;
  try {
    const { dimensions, metrics } = provenanceMetric(event);
    deps.metrics.emitCounts(dimensions, metrics);
  } catch {
    // Intentionally silent: we are already on a best-effort observability path,
    // and logging a metrics failure from inside a metrics helper invites a loop.
  }
}

function resolveSpendGuard(
  deps: MediaProcessingDeps,
):
  | { guard: MediaSpendGuardPort; config: MediaSpendConfig }
  | "misconfigured"
  | undefined {
  const guard = deps.spendGuard;
  const config = deps.config.spend;
  if (guard !== undefined && config !== undefined) {
    return { guard, config };
  }
  if (guard === undefined && config === undefined) {
    return undefined;
  }
  return "misconfigured";
}

/**
 * Best-effort: drive the owning MediaFile to REVIEW for a poison failure. Never
 * throws — a failure to mark must not convert a poison ack into an infinite
 * retry. Returns an observability reason string.
 */
async function routePoisonToReview(
  triggeringKey: string,
  deps: MediaProcessingDeps,
  cause: unknown,
): Promise<string> {
  deps.logger.warn("Poison media — routing to REVIEW + ack", {
    key: triggeringKey,
    error: cause,
  });
  const parsed = parsePendingKey(triggeringKey);
  if (parsed === null) {
    return "poison-no-row";
  }
  try {
    const row = await deps.persistence.findMediaByUploadId(parsed.uploadId);
    if (row === null) {
      return "poison-no-row";
    }
    await deps.persistence.markMediaForReview(row.id);
    return "poison-review";
  } catch (markErr) {
    deps.logger.error("Failed to mark poison media for REVIEW (acking anyway)", {
      key: triggeringKey,
      error: markErr,
    });
    return "poison-mark-failed";
  }
}

/**
 * Process one SQS record (which may carry several S3 object keys). The record
 * fails (SQS retry) iff ANY of its keys produced a retryable fault; otherwise
 * it is acked. Per-key poison is acked, never failed.
 */
export async function processRecord(
  record: QueueRecordLike,
  deps: MediaProcessingDeps,
): Promise<RecordOutcome> {
  let keys: string[];
  try {
    keys = extractObjectKeys(record.body);
  } catch (err) {
    // A body we cannot even parse is a permanent payload defect (poison): a
    // retry re-parses the same bytes to the same failure. Ack to avoid a loop.
    deps.logger.warn("Unparseable SQS record body — acking as poison", {
      messageId: record.messageId,
      error: err,
    });
    return { disposition: "ack", reason: "unparseable-body", poison: true };
  }

  let sawPoison = false;
  for (const key of keys) {
    const outcome = await processObjectKey(key, deps);
    if (outcome.disposition === "fail") {
      // First retryable key fails the whole record; SQS redelivers it. Already-
      // started keys are idempotent on the dedupe path (deriveDedupeKey).
      return outcome;
    }
    if (outcome.disposition === "ack" && outcome.poison === true) {
      sawPoison = true;
    }
  }
  // Propagate the poison marker (WS-2 §3.3): the AWS handler reads only
  // `disposition` (unchanged), but the container dispatcher surfaces poison
  // as an EXPLICIT returned "ack-drop" — the flag must survive aggregation.
  return sawPoison
    ? { disposition: "ack", reason: "record-complete", poison: true }
    : { disposition: "ack", reason: "record-complete" };
}

// ---------------------------------------------------------------------------
// Deps injection seam (consuming app wires concrete adapters at startup)
// ---------------------------------------------------------------------------

let injectedDeps: MediaProcessingDeps | undefined;

/**
 * Inject the concrete media-processing seams. The consuming app (Skybber) calls
 * this once at Lambda cold start with its ffmpeg/MediaConvert TranscodePort, S3
 * StoragePort, Transcribe TranscribePort, injected MediaModerationProvider, and
 * a Prisma-backed MediaPersistencePort. Core ships NO concrete adapters.
 */
export function setMediaProcessingDeps(deps: MediaProcessingDeps): void {
  injectedDeps = deps;
}

/** Test helper: clear injected deps between cases. */
export function __resetMediaProcessingDeps(): void {
  injectedDeps = undefined;
}

/**
 * The currently-injected deps, or undefined when un-wired. Used by the AWS
 * entrypoint (and the container dispatcher) to fail CLOSED when no backend
 * was wired — an un-wired worker must never ack-drop real uploads.
 */
export function getInjectedMediaProcessingDeps(): MediaProcessingDeps | undefined {
  return injectedDeps;
}
