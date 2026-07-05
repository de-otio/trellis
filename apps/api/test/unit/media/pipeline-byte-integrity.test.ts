/**
 * CROSS-WORKER byte-integrity regression test for the P0b media pipeline.
 *
 * The per-worker unit tests (processing-worker.test.ts / completion-worker.test.ts)
 * each mock the OTHER worker's view of storage, so neither catches a divergence
 * BETWEEN them — e.g. the processing worker writing cleaned bytes to one key and
 * the completion worker promoting a DIFFERENT key. This test closes that gap: it
 * drives BOTH workers, in order, against a SINGLE shared in-memory StoragePort
 * (a Map of key -> bytes) and a single shared persistence state, then asserts the
 * end-to-end byte invariants on an APPROVED path.
 *
 * The load-bearing security invariants (the parser-differential / un-moderated-
 * window bypasses this test exists to prevent):
 *   (a) after processing, cas/ does NOT yet contain bytes (only staging + pending);
 *   (b) after completion-approval, the bytes at the cas/ key are BYTE-IDENTICAL
 *       to the CLEANED bytes the transcoder produced, and are NOT equal to the
 *       raw pending bytes (no copyObject(pending -> cas) reintroduced);
 *   (c) after completion, pending/ and staging/ are deleted;
 *   (d) the bytes handed to startVideoModeration (what was MODERATED) equal the
 *       bytes later served from cas/ (what is SERVED) — same bytes, no swap.
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  processObjectKey,
  type MediaProcessingDeps,
  type MediaFileRow,
  type ThresholdSnapshot,
} from "../../../src/lambda/media-processing-worker.js";
import {
  processCompletion,
  type CompletionDeps,
  type CompletionStore,
  type ModerationJobRow,
  type MediaCoords,
  type OtherTrackState,
} from "../../../src/lambda/media-completion-worker.js";
import {
  MockStoragePort,
  MockTranscodePort,
  MockTranscribePort,
} from "../../../src/lib/media/media-ports.js";
import { MockModerationProvider } from "../../../src/lib/media/moderation-provider.js";
import { pendingKey, casKey, isCasKeyError } from "../../../src/lib/media/cas-keys.js";
import type {
  ModerationDecision,
  MediaLifecycle,
} from "../../../src/lib/media/media-lifecycle.js";
import type { Track } from "../../../src/lib/media/track-verdict.js";
import type {
  MediaModerationProvider,
  ModerationVerdict,
  S3Ref,
} from "../../../src/lib/media/moderation-provider.js";

// Valid CUIDs (c + 24 [a-z0-9]) so the cas-keys allowlists pass.
const TENANT = "caaaaaaaaaaaaaaaaaaaaaaaa";
const UPLOAD = "cuuuuuuuuuuuuuuuuuuuuuuu1";
const BUCKET = "test-media-bucket";
const MEDIA_ID = "media-byte-1";

const THRESHOLDS: ThresholdSnapshot = {
  category_a: { review: 0.5, quarantine: 0.9 },
};

function k(fn: (a: string, b: string) => string | { kind: string }, a: string, b: string): string {
  const r = fn(a, b);
  if (typeof r !== "string") throw new Error("fixture key invalid");
  return r;
}

function hashHex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Shared in-memory persistence: ONE source of truth across both workers.
// ---------------------------------------------------------------------------

interface SharedPersistence {
  /** The single MediaFile row, mutated in place as the pipeline advances. */
  row: {
    id: string;
    tenantId: string;
    uploadId: string | null;
    // contentHash starts null (mirrors the upload path); the worker sets the
    // real SHA-256 of the cleaned bytes via persistCleanedContent.
    contentHash: string | null;
    lifecycle: MediaLifecycle;
  };
  jobs: Array<{ mediaId: string; track: Track; jobId: string; decision: ModerationDecision | null; thresholdSnapshot: unknown }>;
  claimed: Set<string>;
}

describe("P0b pipeline — cross-worker byte integrity (APPROVED path)", () => {
  it("cas/ ends byte-identical to the CLEANED bytes, never the raw pending bytes", async () => {
    // ---- Shared storage: ONE Map-backed StoragePort for BOTH workers. ----
    const storage = new MockStoragePort();

    // The raw upload (EXIF/polyglot intact) the route wrote to pending/.
    const rawBytes = Buffer.from("RAW-UPLOAD-with-exif-and-polyglot-payload");
    // The cleaned bytes the transcoder will produce, written to the staging key.
    const cleanedBytes = Buffer.from("CLEANED-transcoded-safe-bytes");
    expect(cleanedBytes.equals(rawBytes)).toBe(false); // sanity: they differ

    const pendingK = k(pendingKey, TENANT, UPLOAD);
    const stagingK = `processing/${TENANT}/${UPLOAD}`;
    const expectedCasK = casKey(TENANT, hashHex(cleanedBytes));
    if (isCasKeyError(expectedCasK)) throw new Error("expected valid cas key");

    // Seed: raw bytes at pending/ (as the upload route would).
    await storage.putObject(pendingK, rawBytes, "video/mp4");

    // A transcode mock that WRITES the cleaned bytes to the staging output key
    // (a real encoder writes the cleaned output to outputPath), so the shared
    // storage reflects exactly what production would see.
    const transcode = new MockTranscodePort({ duration: 10 });
    const origTranscodeVideo = transcode.transcodeVideo.bind(transcode);
    transcode.transcodeVideo = async (input) => {
      const res = await origTranscodeVideo(input);
      await storage.putObject(input.outputPath, cleanedBytes, "video/mp4");
      return res;
    };

    // ---- Shared persistence row (null contentHash, like the route). ----
    const shared: SharedPersistence = {
      row: {
        id: MEDIA_ID,
        tenantId: TENANT,
        uploadId: UPLOAD,
        contentHash: null, // null until the worker hashes the cleaned bytes
        lifecycle: "UPLOADED",
      },
      jobs: [],
      claimed: new Set(),
    };

    const moderation = new MockModerationProvider();
    const moderatedRefs: S3Ref[] = [];
    const origStartVideo = moderation.startVideoModeration.bind(moderation);
    moderation.startVideoModeration = async (ref: S3Ref) => {
      moderatedRefs.push(ref);
      return origStartVideo(ref);
    };
    const transcribe = new MockTranscribePort();

    // ===================================================================
    // PHASE 1 — processing worker starts moderation.
    // ===================================================================
    const processingDeps: MediaProcessingDeps = {
      storage,
      transcode,
      transcribe,
      moderation,
      persistence: {
        async findMediaByUploadId(uploadId): Promise<MediaFileRow | null> {
          return uploadId === UPLOAD
            ? { id: shared.row.id, tenantId: shared.row.tenantId, uploadId: shared.row.uploadId }
            : null;
        },
        async createModerationJob(input) {
          shared.jobs.push({ ...input, decision: null });
        },
        async persistCleanedContent(mediaId, content) {
          // The processing worker replaces the placeholder with the real hash.
          if (mediaId === shared.row.id) {
            shared.row.contentHash = content.contentHash;
          }
        },
        async markMediaForReview(mediaId) {
          shared.row.lifecycle = "REVIEW";
          void mediaId;
        },
        async markMediaUploaded(mediaId) {
          // Conditional bytes-arrived write: only from AWAITING_UPLOAD.
          if (
            mediaId === shared.row.id &&
            shared.row.lifecycle === "AWAITING_UPLOAD"
          ) {
            shared.row.lifecycle = "UPLOADED";
          }
        },
        async markMediaRejected(mediaId) {
          if (mediaId === shared.row.id) shared.row.lifecycle = "REJECTED";
        },
      },
      config: { maxDurationSeconds: 60, thresholds: THRESHOLDS },
      bucket: BUCKET,
      newJobName: (seed) => `jobname-${seed}`,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const procOut = await processObjectKey(pendingK, processingDeps);
    expect(procOut.disposition).toBe("ack");
    expect(procOut.reason).toBe("started-moderation");

    // (a) After processing: cas/ does NOT yet hold bytes; staging + pending do.
    expect((await storage.headObject(expectedCasK)).exists).toBe(false);
    expect((await storage.headObject(stagingK)).exists).toBe(true);
    expect((await storage.headObject(pendingK)).exists).toBe(true);

    // The real content hash was persisted (placeholder replaced).
    expect(shared.row.contentHash).toBe(hashHex(cleanedBytes));

    // (d-part1) Capture the bytes that were MODERATED (the key handed to the
    // moderation provider must resolve to the CLEANED bytes, not the raw upload).
    expect(moderatedRefs).toHaveLength(1);
    const moderatedKey = moderatedRefs[0].key;
    expect(moderatedKey).toBe(stagingK);
    const moderatedBytes = await storage.getObject(moderatedKey);
    expect(moderatedBytes.equals(cleanedBytes)).toBe(true);
    expect(moderatedBytes.equals(rawBytes)).toBe(false);

    // ===================================================================
    // PHASE 2 — completion worker fans both tracks in and APPROVES.
    // Mark both jobs as decided-approved so combineTrackVerdicts -> APPROVED.
    // ===================================================================
    const visualJob = shared.jobs.find((j) => j.track === "VISUAL")!;
    const audioJob = shared.jobs.find((j) => j.track === "AUDIO")!;
    expect(visualJob).toBeDefined();
    expect(audioJob).toBeDefined();

    const store: CompletionStore = {
      async claimMessage(dedupeKey) {
        if (shared.claimed.has(dedupeKey)) return false;
        shared.claimed.add(dedupeKey);
        return true;
      },
      async findJobByJobId(jobId): Promise<ModerationJobRow | null> {
        const j = shared.jobs.find((x) => x.jobId === jobId);
        return j ? { mediaId: MEDIA_ID, track: j.track, thresholdSnapshot: j.thresholdSnapshot } : null;
      },
      async persistTrackDecision(jobId, decision) {
        const j = shared.jobs.find((x) => x.jobId === jobId);
        if (j) j.decision = decision;
      },
      async readOtherTrack(_mediaId, thisTrack): Promise<OtherTrackState> {
        const other = shared.jobs.find((x) => x.track !== thisTrack);
        if (!other || other.decision === null) return { state: "absent" };
        return { state: "decided", decision: other.decision };
      },
      async findMedia(mediaId): Promise<MediaCoords | null> {
        if (mediaId !== shared.row.id) return null;
        return {
          lifecycle: shared.row.lifecycle,
          tenantId: shared.row.tenantId,
          uploadId: shared.row.uploadId!,
          contentHash: shared.row.contentHash, // the REAL post-transcode hash
        };
      },
      async persistMediaStatus(mediaId, status) {
        if (mediaId === shared.row.id) shared.row.lifecycle = status;
      },
    };

    const completionDeps: CompletionDeps = {
      store,
      // Provider re-fetch returns approved for the visual track.
      moderation: {
        async moderateImage(): Promise<ModerationVerdict> {
          return { decision: "approved", labels: [], provider: "fake" };
        },
        async startVideoModeration() {
          return { jobId: "x" };
        },
        async getVideoModeration(): Promise<ModerationVerdict> {
          return { decision: "approved", labels: [], provider: "fake" };
        },
      } satisfies MediaModerationProvider,
      transcribe: {
        async startTranscription() {
          return { jobId: "x" };
        },
        async getTranscription() {
          return { status: "COMPLETED", transcript: "" };
        },
      },
      textModeration: {
        async moderateText(): Promise<ModerationVerdict> {
          return { decision: "approved", labels: [], provider: "fake" };
        },
      },
      storage,
      reinterpretVisual: (v) => v.decision,
      emitResolved: async () => {},
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    // Model the moment the SECOND track resolves while the object is still
    // PENDING: the sibling (AUDIO) track decision is already persisted-approved
    // (its own completion ran the persistTrackDecision side effect), and we now
    // deliver the VISUAL completion that drives PENDING -> APPROVED and promotes.
    // (A `decision` event is only legal from PENDING — the lifecycle gates
    // REVIEW behind a human — so this is the genuine auto-approve path: both
    // tracks decided-approved with the object still PENDING.)
    audioJob.decision = "approved";
    expect(shared.row.lifecycle).toBe("UPLOADED");

    // Sanity: cas/ still empty right before the promoting completion.
    expect((await storage.headObject(expectedCasK)).exists).toBe(false);

    const visualBody = JSON.stringify({ Message: JSON.stringify({ JobId: visualJob.jobId }) });
    const visualOut = await processCompletion(visualBody, completionDeps);
    expect(visualOut.kind).toBe("applied");
    expect((visualOut as { status: MediaLifecycle }).status).toBe("APPROVED");

    // ===================================================================
    // INVARIANTS after approval.
    // ===================================================================

    // (b) cas/ now holds bytes that are BYTE-IDENTICAL to the CLEANED bytes and
    //     are NOT the raw pending bytes (no copyObject(pending -> cas)).
    expect((await storage.headObject(expectedCasK)).exists).toBe(true);
    const servedBytes = await storage.getObject(expectedCasK);
    expect(servedBytes.equals(cleanedBytes)).toBe(true);
    expect(servedBytes.equals(rawBytes)).toBe(false);

    // (c) pending/ and staging/ are deleted.
    expect((await storage.headObject(pendingK)).exists).toBe(false);
    expect((await storage.headObject(stagingK)).exists).toBe(false);

    // (d) the bytes that were MODERATED equal the bytes now SERVED from cas/.
    expect(servedBytes.equals(moderatedBytes)).toBe(true);
  });

  it("would FAIL if copyObject(pending -> cas) were reintroduced", async () => {
    // This is the precise regression guard: build the same APPROVED path but
    // assert directly that the cas/ bytes are NOT the raw pending bytes. If a
    // future edit restores copyObject(pendingKey, casKey) in the completion
    // worker, servedBytes would equal rawBytes and this assertion turns red.
    const storage = new MockStoragePort();
    const rawBytes = Buffer.from("RAW-polyglot");
    const cleanedBytes = Buffer.from("CLEANED-safe");
    const pendingK = k(pendingKey, TENANT, UPLOAD);
    const stagingK = `processing/${TENANT}/${UPLOAD}`;
    const casK = casKey(TENANT, hashHex(cleanedBytes));
    if (isCasKeyError(casK)) throw new Error("cas key");

    // Pre-place BOTH raw (pending) and cleaned (staging) so a wrong-source copy
    // is observable: a pending->cas copy would put rawBytes at cas/.
    await storage.putObject(pendingK, rawBytes, "video/mp4");
    await storage.putObject(stagingK, cleanedBytes, "video/mp4");

    const row = {
      lifecycle: "UPLOADED" as MediaLifecycle,
      tenantId: TENANT,
      uploadId: UPLOAD,
      contentHash: hashHex(cleanedBytes),
    };
    const claimed = new Set<string>();
    const jobs = [
      { jobId: "v1", track: "VISUAL" as Track, decision: "approved" as ModerationDecision | null },
      { jobId: "a1", track: "AUDIO" as Track, decision: "approved" as ModerationDecision | null },
    ];

    const deps: CompletionDeps = {
      store: {
        async claimMessage(dk) {
          if (claimed.has(dk)) return false;
          claimed.add(dk);
          return true;
        },
        async findJobByJobId(jobId) {
          const j = jobs.find((x) => x.jobId === jobId);
          return j ? { mediaId: MEDIA_ID, track: j.track, thresholdSnapshot: {} } : null;
        },
        async persistTrackDecision() {},
        async readOtherTrack(_m, thisTrack) {
          const o = jobs.find((x) => x.track !== thisTrack)!;
          return { state: "decided", decision: o.decision! };
        },
        async findMedia() {
          return { ...row };
        },
        async persistMediaStatus(_m, status) {
          row.lifecycle = status;
        },
      },
      moderation: {
        async moderateImage() {
          return { decision: "approved", labels: [], provider: "f" };
        },
        async startVideoModeration() {
          return { jobId: "x" };
        },
        async getVideoModeration() {
          return { decision: "approved", labels: [], provider: "f" };
        },
      },
      transcribe: {
        async startTranscription() {
          return { jobId: "x" };
        },
        async getTranscription() {
          return { status: "COMPLETED", transcript: "" };
        },
      },
      textModeration: {
        async moderateText() {
          return { decision: "approved", labels: [], provider: "f" };
        },
      },
      storage,
      reinterpretVisual: (v) => v.decision,
      emitResolved: async () => {},
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const out = await processCompletion(
      JSON.stringify({ Message: JSON.stringify({ JobId: "v1" }) }),
      deps,
    );
    expect((out as { status: MediaLifecycle }).status).toBe("APPROVED");

    const served = await storage.getObject(casK);
    // The crux: promotion copied the CLEANED staging bytes, NOT the raw pending.
    expect(served.equals(cleanedBytes)).toBe(true);
    expect(served.equals(rawBytes)).toBe(false);
  });
});
