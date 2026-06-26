// CONTRACT: stable — coordinate changes. Shared P0b processing value types.
//
// Pure data contracts that thread a media object through the processing
// pipeline: the job the worker dequeues, the result it produces, and the input
// to the per-track dedupe key. NO behavior here — just the shapes the shell and
// the functional-core units agree on. Ships in the PUBLIC npm tarball: no
// thresholds, secrets, or real-category vocabulary.

import type { Track } from "./track-verdict.js";

/**
 * A unit of work the processing worker dequeues for one uploaded object.
 *
 * - `tenantId` — owning tenant (CUID; validated by ./cas-keys.ts before use).
 * - `uploadId` — the upload session id (CUID).
 * - `key`      — the staging/pending storage key the bytes currently live at
 *                (built ONLY via ./cas-keys.ts `pendingKey`).
 */
export interface ProcessingJob {
  readonly tenantId: string;
  readonly uploadId: string;
  readonly key: string;
}

/**
 * The outcome of processing one object.
 *
 * - `casKey`      — the canonical content-addressed key the cleaned bytes were
 *                   stored at (built via ./cas-keys.ts `casKey`).
 * - `contentHash` — the 64-char lowercase SHA-256 of the cleaned bytes (the CAS
 *                   address; validated by ./cas-keys.ts `validateContentHash`).
 * - `visualJobId` — async moderation job handle for the VISUAL track, when a
 *                   visual track was started; absent for audio-only objects.
 * - `audioJobId`  — async transcription/moderation handle for the AUDIO track,
 *                   when an audio track was started; absent for objects with no
 *                   audio.
 */
export interface ProcessingResult {
  readonly casKey: string;
  readonly contentHash: string;
  readonly visualJobId?: string;
  readonly audioJobId?: string;
}

/**
 * Input to the per-track dedupe key the worker uses to idempotently fan out /
 * fan in async track jobs without double-processing. Keyed by the content hash
 * (so identical bytes share work), the provider/transcription job id, and which
 * track it is — so the VISUAL and AUDIO tracks of the same bytes never collide.
 */
export interface DedupeKeyInput {
  readonly contentHash: string;
  readonly jobId: string;
  readonly track: Track;
}
