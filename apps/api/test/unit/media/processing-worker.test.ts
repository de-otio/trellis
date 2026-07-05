/**
 * Unit tests for the P0b media-processing orchestration SHELL
 * (apps/api/src/lambda/media-processing-worker.ts).
 *
 * The shell is exercised entirely against the B0 in-memory Mock ports
 * (MockStoragePort / MockTranscodePort / MockTranscribePort), the Mock
 * moderation provider, and an in-memory MediaPersistencePort fake. No real
 * cloud, no real encoder, no real DB, no Date.now/Math.random (the job-name
 * factory is injected deterministically).
 *
 * Obligations covered (from the B2 brief):
 *   - key-prefix rejection (non-pending key ⇒ ack-drop, never written under)
 *   - tenant-from-row + key-mismatch ⇒ hard reject (poison ⇒ REVIEW + ack)
 *   - duration-cap ⇒ REVIEW (poison ⇒ ack)
 *   - happy path persists VISUAL + AUDIO jobs WITH a threshold snapshot
 *   - moderation starts on the cleaned STAGING key, NOT the raw pending key
 *     (and NOT a cas/ key — cas/ holds only APPROVED bytes); the real content
 *     hash + serve key are persisted onto the row
 *   - the cleaned bytes are NOT written to cas/ by this worker
 *   - poison vs retryable disposition (ack vs SQS retry)
 *   - reportBatchItemFailures per-record semantics
 *
 * Plus boundary/failure paths and a fast-check property: a non-pending key is
 * NEVER processed and NEVER written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  processObjectKey,
  processRecord,
  parsePendingKey,
  extractObjectKeys,
  handler,
  setMediaProcessingDeps,
  __resetMediaProcessingDeps,
  type MediaProcessingDeps,
  type MediaFileRow,
  type ThresholdSnapshot,
} from "../../../src/lambda/media-processing-worker.js";
import {
  MockStoragePort,
  MockTranscodePort,
  MockTranscribePort,
} from "../../../src/lib/media/media-ports.js";
import {
  MockModerationProvider,
} from "../../../src/lib/media/moderation-provider.js";
import { pendingKey, casKey, isCasKeyError } from "../../../src/lib/media/cas-keys.js";
import type { Track } from "../../../src/lib/media/track-verdict.js";
import {
  MockSpendGuardPort,
  type MediaSpendConfig,
  type MediaSpendGuardPort,
} from "../../../src/lib/media/spend-guard.js";

// ---------------------------------------------------------------------------
// Fixtures — valid CUIDs (c + 24 [a-z0-9]) so cas-keys allowlists pass.
// ---------------------------------------------------------------------------

const TENANT_A = "caaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "cbbbbbbbbbbbbbbbbbbbbbbbb";
const UPLOAD_1 = "cuuuuuuuuuuuuuuuuuuuuuuu1";
const BUCKET = "test-media-bucket";

const THRESHOLDS: ThresholdSnapshot = {
  // Opaque category tokens only — never real-category vocabulary.
  category_a: { review: 0.5, quarantine: 0.9 },
  category_b: { review: 0.4, quarantine: 0.8 },
};

function key(tenant: string, upload: string): string {
  const k = pendingKey(tenant, upload);
  if (isCasKeyError(k)) throw new Error("fixture pendingKey invalid");
  return k;
}

/**
 * Type-safe read of the `poison` flag, which the RecordOutcome union scopes to
 * the `ack` variant. Asserts the outcome is an ack (so a `fail` outcome fails
 * loudly rather than silently reading `undefined`) and returns the flag.
 */
function poisonOf(out: Awaited<ReturnType<typeof processObjectKey>>): boolean | undefined {
  expect(out.disposition).toBe("ack");
  return out.disposition === "ack" ? out.poison : undefined;
}

// ---------------------------------------------------------------------------
// In-memory persistence fake + deps builder.
// ---------------------------------------------------------------------------

interface PersistenceFake {
  rows: Map<string, MediaFileRow>; // keyed by uploadId
  jobs: Array<{
    mediaId: string;
    track: Track;
    jobId: string;
    thresholdSnapshot: ThresholdSnapshot;
    initialDecision?: string;
  }>;
  /** persistCleanedContent calls: the real hash + serve key written per media. */
  cleaned: Array<{ mediaId: string; contentHash: string; originalKey: string }>;
  reviewed: string[]; // mediaIds marked for REVIEW
  uploaded: string[]; // mediaIds driven through bytes-arrived (T14)
  rejected: string[]; // mediaIds driven to REJECTED (T14 over-duration)
}

function makeDeps(opts: {
  storageSeed?: Record<string, Buffer>;
  duration?: number;
  rows?: MediaFileRow[];
  moderation?: MockModerationProvider;
  transcribe?: MockTranscribePort;
  storage?: MockStoragePort;
  transcode?: MockTranscodePort;
  maxDurationSeconds?: number;
  failPersistence?: boolean;
  spendGuard?: MediaSpendGuardPort;
  spend?: MediaSpendConfig;
} = {}): { deps: MediaProcessingDeps; fake: PersistenceFake } {
  const fake: PersistenceFake = {
    rows: new Map((opts.rows ?? []).map((r) => [r.uploadId!, r])),
    jobs: [],
    cleaned: [],
    reviewed: [],
    uploaded: [],
    rejected: [],
  };

  const persistence = {
    async findMediaByUploadId(uploadId: string): Promise<MediaFileRow | null> {
      return fake.rows.get(uploadId) ?? null;
    },
    async createModerationJob(input: {
      mediaId: string;
      track: Track;
      jobId: string;
      thresholdSnapshot: ThresholdSnapshot;
      initialDecision?: string;
    }): Promise<void> {
      if (opts.failPersistence) throw new Error("ThrottlingException");
      fake.jobs.push(input);
    },
    async persistCleanedContent(
      mediaId: string,
      content: { contentHash: string; originalKey: string },
    ): Promise<void> {
      fake.cleaned.push({ mediaId, ...content });
    },
    async markMediaForReview(mediaId: string): Promise<void> {
      fake.reviewed.push(mediaId);
    },
    async markMediaUploaded(mediaId: string): Promise<void> {
      fake.uploaded.push(mediaId);
    },
    async markMediaRejected(mediaId: string): Promise<void> {
      fake.rejected.push(mediaId);
    },
  };

  const deps: MediaProcessingDeps = {
    storage: opts.storage ?? new MockStoragePort(opts.storageSeed ?? {}),
    transcode: opts.transcode ?? new MockTranscodePort({ duration: opts.duration ?? 0 }),
    transcribe: opts.transcribe ?? new MockTranscribePort(),
    moderation: opts.moderation ?? new MockModerationProvider(),
    persistence,
    config: {
      maxDurationSeconds: opts.maxDurationSeconds ?? 60,
      thresholds: THRESHOLDS,
      ...(opts.spend ? { spend: opts.spend } : {}),
    },
    ...(opts.spendGuard ? { spendGuard: opts.spendGuard } : {}),
    bucket: BUCKET,
    newJobName: (seed: string) => `jobname-${seed}`,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  return { deps, fake };
}

/**
 * Seed storage so the transcode output key (processing/{tenant}/{upload}) has
 * cleaned bytes the shell can read back and hash. The MockTranscodePort echoes
 * outputPath back, so we pre-place the cleaned bytes at that key.
 */
function happyStorage(tenant: string, upload: string, cleaned: Buffer): MockStoragePort {
  return new MockStoragePort({
    [`processing/${tenant}/${upload}`]: cleaned,
  });
}

function makeSqsRecord(messageId: string, objectKey: string) {
  return {
    messageId,
    body: JSON.stringify({
      Records: [{ s3: { bucket: { name: BUCKET }, object: { key: objectKey } } }],
    }),
    receiptHandle: "r",
    attributes: {},
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:eu-central-1:000000000000:q",
    awsRegion: "eu-central-1",
  } as any;
}

// ===========================================================================

describe("parsePendingKey", () => {
  it("accepts a canonical pending/{tenant}/{upload} key and round-trips it", () => {
    const k = key(TENANT_A, UPLOAD_1);
    expect(parsePendingKey(k)).toEqual({ tenantId: TENANT_A, uploadId: UPLOAD_1 });
  });

  it("rejects non-pending prefixes, wrong arity, and malformed ids", () => {
    expect(parsePendingKey(`cas/${TENANT_A}/${"a".repeat(64)}`)).toBeNull();
    expect(parsePendingKey(`originals/${TENANT_A}/photo.jpg`)).toBeNull();
    expect(parsePendingKey(`pending/${TENANT_A}`)).toBeNull(); // arity
    expect(parsePendingKey(`pending/${TENANT_A}/${UPLOAD_1}/extra`)).toBeNull();
    expect(parsePendingKey(`pending/NOT-A-CUID/${UPLOAD_1}`)).toBeNull();
    expect(parsePendingKey(`pending/${TENANT_A}/../etc/passwd`)).toBeNull();
    expect(parsePendingKey("")).toBeNull();
  });
});

describe("extractObjectKeys", () => {
  it("extracts and URL-decodes keys from an S3-over-SQS body", () => {
    const body = JSON.stringify({
      Records: [{ s3: { object: { key: "pending/c1/c2%20x" } } }],
    });
    expect(extractObjectKeys(body)).toEqual(["pending/c1/c2 x"]);
  });

  it("returns [] when there is no Records array", () => {
    expect(extractObjectKeys(JSON.stringify({}))).toEqual([]);
  });

  it("throws on an unparseable body (caller treats as poison)", () => {
    expect(() => extractObjectKeys("not json")).toThrow();
  });
});

describe("processObjectKey — key-prefix rejection", () => {
  it("ack-drops a non-pending key and NEVER writes under it", async () => {
    const storage = new MockStoragePort();
    const { deps, fake } = makeDeps({ storage });
    const putSpy = vi.spyOn(storage, "putObject");

    const out = await processObjectKey(`cas/${TENANT_A}/${"a".repeat(64)}`, deps);

    expect(out.disposition).toBe("ack");
    expect(out.reason).toBe("non-pending-key");
    expect(poisonOf(out)).toBeUndefined(); // a drop is not poison
    expect(putSpy).not.toHaveBeenCalled();
    expect(fake.jobs).toHaveLength(0);
    expect(fake.reviewed).toHaveLength(0);
  });

  it("never writes outputs under the pending/ prefix on the happy path", async () => {
    const cleaned = Buffer.from("cleaned-bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const { deps } = makeDeps({
      storage,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });
    const putSpy = vi.spyOn(storage, "putObject");

    await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    for (const call of putSpy.mock.calls) {
      expect(String(call[0]).startsWith("pending/")).toBe(false);
    }
  });
});

describe("processObjectKey — tenant-from-row + key mismatch", () => {
  it("rejects when the key's tenant disagrees with the row's tenant (poison ⇒ REVIEW + ack)", async () => {
    // Triggering key claims TENANT_B; the row says the upload belongs to TENANT_A.
    const { deps, fake } = makeDeps({
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    const out = await processObjectKey(key(TENANT_B, UPLOAD_1), deps);

    expect(out.disposition).toBe("ack");
    expect(poisonOf(out)).toBe(true);
    // Best-effort: the row WAS found by uploadId, so it is marked for REVIEW.
    expect(fake.reviewed).toEqual(["media1"]);
    expect(fake.jobs).toHaveLength(0);
  });

  it("re-derives tenant from the ROW, not the key (uses rowTenant for the persisted cas key)", async () => {
    // The row's tenant (TENANT_A) is what the cleaned cas key must be built from.
    // Moderation runs on the STAGING key; the cas key is only PERSISTED (the
    // completion worker promotes staging -> cas on approval).
    const cleaned = Buffer.from("xyz");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const moderation = new MockModerationProvider();
    const startSpy = vi.spyOn(moderation, "startVideoModeration");
    const { deps, fake } = makeDeps({
      storage,
      moderation,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    const expectedCas = casKey(TENANT_A, createHashHex(cleaned));
    if (isCasKeyError(expectedCas)) throw new Error("expected valid cas key");
    const stagingKey = `processing/${TENANT_A}/${UPLOAD_1}`;
    // Moderation started on the STAGING key (the exact bytes that will serve).
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0][0]).toEqual({ bucket: BUCKET, key: stagingKey });
    // The real cas key (derived from rowTenant + the cleaned hash) was PERSISTED.
    expect(fake.cleaned).toEqual([
      { mediaId: "media1", contentHash: createHashHex(cleaned), originalKey: expectedCas },
    ]);
  });

  it("rejects (poison ⇒ REVIEW) when no row exists for the uploadId", async () => {
    const { deps, fake } = makeDeps({ rows: [] });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out.disposition).toBe("ack");
    expect(poisonOf(out)).toBe(true);
    // No row to mark, so nothing is reviewed but the message is still dropped.
    expect(fake.reviewed).toHaveLength(0);
    expect(fake.jobs).toHaveLength(0);
  });

  it("rejects when the row has a null uploadId", async () => {
    const { deps, fake } = makeDeps({
      rows: [], // populate manually with a null-uploadId row below
    });
    // Insert a row whose uploadId is null but is reachable via the fake map key.
    (deps.persistence as any).findMediaByUploadId = async () =>
      ({ id: "media1", tenantId: TENANT_A, uploadId: null } as MediaFileRow);

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out.disposition).toBe("ack");
    expect(poisonOf(out)).toBe(true);
    expect(fake.jobs).toHaveLength(0);
  });
});

describe("processObjectKey — duration cap", () => {
  it("over-cap duration ⇒ REJECTED + staged object deleted BEFORE moderation, ack, no transcode, no jobs (T14)", async () => {
    const transcode = new MockTranscodePort({ duration: 120 }); // probe returns 120
    const videoSpy = vi.spyOn(transcode, "transcodeVideo");
    const pendingK = key(TENANT_A, UPLOAD_1);
    const storage = new MockStoragePort({ [pendingK]: Buffer.from("raw") });
    const deleteSpy = vi.spyOn(storage, "deleteObject");
    const { deps, fake } = makeDeps({
      storage,
      transcode,
      maxDurationSeconds: 60,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    const out = await processObjectKey(pendingK, deps);

    expect(out.disposition).toBe("ack");
    expect(out.reason).toBe("duration-cap-rejected");
    expect(poisonOf(out)).toBeUndefined(); // terminal reject, not poison/REVIEW
    expect(fake.rejected).toEqual(["media1"]); // row is REJECTED (never serves)
    expect(fake.reviewed).toHaveLength(0); // no human-review bandwidth consumed
    expect(deleteSpy).toHaveBeenCalledWith(pendingK); // bytes gone pre-moderation
    expect(videoSpy).not.toHaveBeenCalled(); // probe gate runs BEFORE transcode
    expect(fake.jobs).toHaveLength(0); // NO moderation job ever saw the bytes
  });

  it("over-cap duration: reject-write is persisted BEFORE the delete; a delete failure still acks (row already REJECTED)", async () => {
    const transcode = new MockTranscodePort({ duration: 120 });
    const pendingK = key(TENANT_A, UPLOAD_1);
    const storage = new MockStoragePort({ [pendingK]: Buffer.from("raw") });
    vi.spyOn(storage, "deleteObject").mockRejectedValue(
      new Error("AccessDenied"),
    );
    const { deps, fake } = makeDeps({
      storage,
      transcode,
      maxDurationSeconds: 60,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    const out = await processObjectKey(pendingK, deps);

    expect(out.disposition).toBe("ack");
    expect(out.reason).toBe("duration-cap-rejected");
    expect(fake.rejected).toEqual(["media1"]);
    expect(fake.jobs).toHaveLength(0);
  });

  it("exactly at the cap is allowed (boundary): proceeds to start jobs", async () => {
    const cleaned = Buffer.from("ok");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const transcode = new MockTranscodePort({ duration: 60 }); // == cap
    const { deps, fake } = makeDeps({
      storage,
      transcode,
      maxDurationSeconds: 60,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out.disposition).toBe("ack");
    expect(poisonOf(out)).toBeUndefined();
    expect(fake.jobs).toHaveLength(2);
  });
});

describe("processObjectKey — happy path", () => {
  it("persists VISUAL + AUDIO jobs WITH the threshold snapshot, started on the STAGING key", async () => {
    const cleaned = Buffer.from("the-cleaned-bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const moderation = new MockModerationProvider();
    const transcribe = new MockTranscribePort();
    const { deps, fake } = makeDeps({
      storage,
      moderation,
      transcribe,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out.disposition).toBe("ack");
    expect(out.reason).toBe("started-moderation");

    // Exactly two jobs: one VISUAL, one AUDIO, both for media1.
    expect(fake.jobs).toHaveLength(2);
    const visual = fake.jobs.find((j) => j.track === "VISUAL")!;
    const audio = fake.jobs.find((j) => j.track === "AUDIO")!;
    expect(visual).toBeDefined();
    expect(audio).toBeDefined();
    expect(visual.mediaId).toBe("media1");
    expect(audio.mediaId).toBe("media1");

    // Threshold snapshot is the CURRENT operative thresholds, persisted by value.
    expect(visual.thresholdSnapshot).toEqual(THRESHOLDS);
    expect(audio.thresholdSnapshot).toEqual(THRESHOLDS);

    // Job ids come from the provider/transcribe seams, not invented by the shell.
    expect(visual.jobId).toBe("mock-job-1");
    expect(audio.jobId).toBe("mock-transcribe-1");

    // Moderation + transcription were started on the cleaned STAGING key — the
    // exact bytes that will be served — NOT a cas/ key.
    const stagingKey = `processing/${TENANT_A}/${UPLOAD_1}`;
    const expectedCas = casKey(TENANT_A, createHashHex(cleaned));
    if (isCasKeyError(expectedCas)) throw new Error("expected valid cas key");
    expect(moderation.startVideoModeration).toBeDefined();
    expect(transcribe.startCalls).toEqual([
      { key: stagingKey, jobName: `jobname-${stagingKey}` },
    ]);

    // The real content identity was PERSISTED (replacing the uploadId placeholder).
    expect(fake.cleaned).toEqual([
      { mediaId: "media1", contentHash: createHashHex(cleaned), originalKey: expectedCas },
    ]);

    // The cleaned bytes are NOT written to cas/ here — cas/ stays empty until the
    // completion worker promotes on approval.
    expect((storage as MockStoragePort).contentTypeOf(expectedCas)).toBeUndefined();
  });

  it("a no-audio video starts NO transcription and pre-resolves AUDIO as approved", async () => {
    const cleaned = Buffer.from("silent-video-bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const moderation = new MockModerationProvider();
    const transcribe = new MockTranscribePort();
    // The transcode reports no audio stream on the cleaned output.
    const transcode = new MockTranscodePort({ duration: 10, hasAudio: false });
    const { deps, fake } = makeDeps({
      storage,
      moderation,
      transcribe,
      transcode,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out.disposition).toBe("ack");
    expect(out.reason).toBe("started-moderation");

    // NO transcription job was started — there is no audio to transcribe.
    expect(transcribe.startCalls).toEqual([]);

    // Still exactly two jobs: VISUAL (to be fanned in) + a pre-resolved AUDIO.
    expect(fake.jobs).toHaveLength(2);
    const audio = fake.jobs.find((j) => j.track === "AUDIO")!;
    const visual = fake.jobs.find((j) => j.track === "VISUAL")!;
    expect(visual.initialDecision).toBeUndefined(); // VISUAL resolves via fan-in
    // AUDIO is pre-resolved as approved (vacuous: no audio content to be unsafe),
    // under a synthetic, namespaced job id that no completion can ever reference.
    expect(audio.initialDecision).toBe("approved");
    expect(audio.jobId).toBe("noaudio:media1");
    expect(audio.thresholdSnapshot).toEqual(THRESHOLDS);
  });

  it("starts moderation on the STAGING key, NEVER on the raw pending key or a cas/ key", async () => {
    const cleaned = Buffer.from("bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const moderation = new MockModerationProvider();
    const startSpy = vi.spyOn(moderation, "startVideoModeration");
    const { deps } = makeDeps({
      storage,
      moderation,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    const ref = startSpy.mock.calls[0][0];
    expect(ref.key).toBe(`processing/${TENANT_A}/${UPLOAD_1}`);
    expect(ref.key.startsWith("cas/")).toBe(false);
    expect(ref.key.startsWith("pending/")).toBe(false);
    expect(ref.key).not.toBe(key(TENANT_A, UPLOAD_1));
  });

  it("does NOT write the cleaned bytes to cas/ (no putObject to a cas/ key)", async () => {
    const cleaned = Buffer.from("bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const putSpy = vi.spyOn(storage, "putObject");
    const { deps } = makeDeps({
      storage,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    // The worker writes NOTHING to cas/ — promotion is the completion worker's job.
    for (const call of putSpy.mock.calls) {
      expect(String(call[0]).startsWith("cas/")).toBe(false);
    }
  });

  it("does NOT fetch verdicts (worker only starts jobs)", async () => {
    const cleaned = Buffer.from("bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const moderation = new MockModerationProvider();
    const getSpy = vi.spyOn(moderation, "getVideoModeration");
    const transcribe = new MockTranscribePort();
    const getTranscriptSpy = vi.spyOn(transcribe, "getTranscription");
    const { deps } = makeDeps({
      storage,
      moderation,
      transcribe,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(getSpy).not.toHaveBeenCalled();
    expect(getTranscriptSpy).not.toHaveBeenCalled();
  });
});

describe("processObjectKey — poison vs retryable", () => {
  it("a retryable infra fault (throttling on persistence) ⇒ fail (SQS retry)", async () => {
    const cleaned = Buffer.from("bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const { deps, fake } = makeDeps({
      storage,
      failPersistence: true, // createModerationJob throws ThrottlingException
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out.disposition).toBe("fail"); // retryable ⇒ not acked
    expect(fake.reviewed).toHaveLength(0); // NOT routed to review
  });

  it("a poison decode fault from the transcode seam ⇒ ack + REVIEW", async () => {
    const transcode = new MockTranscodePort({ duration: 10 });
    vi.spyOn(transcode, "transcodeVideo").mockRejectedValue(
      Object.assign(new Error("failed to decode media"), { name: "DecodeError" }),
    );
    const { deps, fake } = makeDeps({
      transcode,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out.disposition).toBe("ack");
    expect(poisonOf(out)).toBe(true);
    expect(fake.reviewed).toEqual(["media1"]);
  });

  it("ack still happens even when marking REVIEW itself fails (no infinite loop)", async () => {
    const transcode = new MockTranscodePort({ duration: 10 });
    vi.spyOn(transcode, "transcodeVideo").mockRejectedValue(
      Object.assign(new Error("corrupt media"), { name: "CorruptError" }),
    );
    const { deps } = makeDeps({
      transcode,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });
    vi.spyOn(deps.persistence, "markMediaForReview").mockRejectedValue(
      new Error("DB down"),
    );

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    // Poison is still acked — a failed mark must not flip it to retry.
    expect(out.disposition).toBe("ack");
    expect(poisonOf(out)).toBe(true);
    expect(out.reason).toBe("poison-mark-failed");
  });
});

describe("processObjectKey — daily AI-spend guard (AR5)", () => {
  const SPEND: MediaSpendConfig = { dailyCapUsd: 5, perMinuteRateUsd: 0.2 };

  function spendDeps(opts: {
    spendUsd?: number;
    guard?: MockSpendGuardPort;
    spend?: MediaSpendConfig;
    duration?: number;
  } = {}) {
    const guard = opts.guard ?? new MockSpendGuardPort({ spendUsd: opts.spendUsd ?? 0 });
    const cleaned = Buffer.from("cleaned-bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const transcode = new MockTranscodePort({ duration: opts.duration ?? 30 });
    const built = makeDeps({
      storage,
      transcode,
      spendGuard: guard,
      spend: opts.spend ?? SPEND,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });
    return { ...built, guard, transcode };
  }

  it("under the cap: proceeds, starts jobs, and records the duration-based estimate AFTER starting", async () => {
    const { deps, fake, guard } = spendDeps({ spendUsd: 4.99, duration: 30 });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out.disposition).toBe("ack");
    expect(out.reason).toBe("started-moderation");
    expect(fake.jobs).toHaveLength(2);
    // 30s at 0.2 USD/min = 0.1 USD, recorded exactly once.
    expect(guard.recorded).toEqual([0.1]);
    expect(guard.capExceededReports).toBe(0);
  });

  it("over the cap: fails the record (SQS retry → DLQ), starts NOTHING, records NOTHING, never poisons", async () => {
    const { deps, fake, guard, transcode } = spendDeps({ spendUsd: 5 }); // == cap ⇒ over
    const videoSpy = vi.spyOn(transcode, "transcodeVideo");

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    // `fail` ⇒ batchItemFailure ⇒ SQS redelivery ⇒ redrive policy routes the
    // message to the DLQ (never a silent drop, never REVIEW).
    expect(out).toEqual({ disposition: "fail", reason: "daily-spend-cap-exceeded" });
    expect(videoSpy).not.toHaveBeenCalled(); // gate runs BEFORE the transcode
    expect(fake.jobs).toHaveLength(0);
    expect(fake.reviewed).toHaveLength(0); // an over-cap is NOT a media defect
    expect(guard.recorded).toEqual([]); // a short-circuit never inflates the counter
    expect(guard.capExceededReports).toBe(1); // observability signal emitted
  });

  it("a cap of 0 blocks every job (operator emergency stop)", async () => {
    const { deps, fake } = spendDeps({
      spendUsd: 0,
      spend: { dailyCapUsd: 0, perMinuteRateUsd: 0.2 },
    });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out.disposition).toBe("fail");
    expect(fake.jobs).toHaveLength(0);
  });

  it("counter READ failure fails closed: no jobs, `fail` disposition, no REVIEW", async () => {
    const guard = new MockSpendGuardPort();
    guard.failReads(new Error("dynamo down"));
    const { deps, fake } = spendDeps({ guard });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out).toEqual({ disposition: "fail", reason: "spend-guard-unavailable" });
    expect(fake.jobs).toHaveLength(0);
    expect(fake.reviewed).toHaveLength(0);
  });

  it("counter WRITE failure after jobs started still acks (documented fail-open on record; jobs are not re-run)", async () => {
    const guard = new MockSpendGuardPort({ spendUsd: 0 });
    guard.failRecords(new Error("dynamo write down"));
    const { deps, fake } = spendDeps({ guard });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out.disposition).toBe("ack");
    expect(out.reason).toBe("started-moderation");
    expect(fake.jobs).toHaveLength(2); // the started jobs stand
    expect((deps.logger.error as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it("a reportCapExceeded failure never changes the over-cap disposition", async () => {
    const guard = new MockSpendGuardPort({ spendUsd: 99 });
    vi.spyOn(guard, "reportCapExceeded").mockRejectedValue(new Error("cw down"));
    const { deps } = spendDeps({ guard });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out).toEqual({ disposition: "fail", reason: "daily-spend-cap-exceeded" });
  });

  it("half-wired guard (config without port) fails closed as misconfigured", async () => {
    const cleaned = Buffer.from("cleaned-bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const { deps, fake } = makeDeps({
      storage,
      spend: SPEND, // config present…
      // …but NO spendGuard port wired.
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out).toEqual({ disposition: "fail", reason: "spend-guard-misconfigured" });
    expect(fake.jobs).toHaveLength(0);
  });

  it("half-wired guard (port without config) fails closed as misconfigured", async () => {
    const cleaned = Buffer.from("cleaned-bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const { deps, fake } = makeDeps({
      storage,
      spendGuard: new MockSpendGuardPort(),
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out).toEqual({ disposition: "fail", reason: "spend-guard-misconfigured" });
    expect(fake.jobs).toHaveLength(0);
  });

  it("no guard wired at all: worker behaves exactly as before (backwards compatible)", async () => {
    const cleaned = Buffer.from("cleaned-bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const { deps, fake } = makeDeps({
      storage,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });

    const out = await processObjectKey(key(TENANT_A, UPLOAD_1), deps);

    expect(out.disposition).toBe("ack");
    expect(fake.jobs).toHaveLength(2);
  });
});

describe("processRecord — reportBatchItemFailures semantics", () => {
  it("acks a record whose key drops as non-pending", async () => {
    const { deps } = makeDeps();
    const rec = makeSqsRecord("m0", `originals/${TENANT_A}/x.jpg`);
    const out = await processRecord(rec, deps);
    expect(out.disposition).toBe("ack");
  });

  it("fails the record when a key is retryable", async () => {
    const cleaned = Buffer.from("bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const { deps } = makeDeps({
      storage,
      failPersistence: true,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });
    const rec = makeSqsRecord("m0", key(TENANT_A, UPLOAD_1));
    const out = await processRecord(rec, deps);
    expect(out.disposition).toBe("fail");
  });

  it("acks an unparseable body as poison (no retry loop)", async () => {
    const { deps } = makeDeps();
    const rec = { ...makeSqsRecord("m0", "x"), body: "not-json" } as any;
    const out = await processRecord(rec, deps);
    expect(out.disposition).toBe("ack");
    expect(poisonOf(out)).toBe(true);
  });
});

describe("handler — injected-deps gate + batchItemFailures", () => {
  beforeEach(() => {
    __resetMediaProcessingDeps();
  });

  it("throws (fail closed) when no deps are injected", async () => {
    const event = { Records: [makeSqsRecord("m0", key(TENANT_A, UPLOAD_1))] } as any;
    await expect(handler(event, {} as any, () => {})).rejects.toThrow(/deps not injected/);
  });

  it("returns only the retryable record's id as a batchItemFailure", async () => {
    const cleaned = Buffer.from("bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    // Record A succeeds (happy), record B fails (retryable persistence throttle).
    // Use one shared deps: persistence fails for ALL, so make A a drop instead.
    const { deps } = makeDeps({
      storage,
      failPersistence: true,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });
    setMediaProcessingDeps(deps);

    const event = {
      Records: [
        makeSqsRecord("m-drop", `originals/${TENANT_A}/x.jpg`), // ack-drop
        makeSqsRecord("m-retry", key(TENANT_A, UPLOAD_1)), // retryable
      ],
    } as any;

    const result: any = await handler(event, {} as any, () => {});

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m-retry" }]);
  });

  it("returns an empty batchItemFailures when everything acks", async () => {
    const cleaned = Buffer.from("bytes");
    const storage = happyStorage(TENANT_A, UPLOAD_1, cleaned);
    const { deps } = makeDeps({
      storage,
      rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
    });
    setMediaProcessingDeps(deps);

    const event = { Records: [makeSqsRecord("m0", key(TENANT_A, UPLOAD_1))] } as any;
    const result: any = await handler(event, {} as any, () => {});

    expect(result.batchItemFailures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Property: a non-pending key is NEVER processed and NEVER written.
// ---------------------------------------------------------------------------

describe("property — non-pending keys are inert", () => {
  it("never starts a job, never writes, for any non-pending key", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => parsePendingKey(s) === null),
        async (badKey) => {
          const storage = new MockStoragePort();
          const moderation = new MockModerationProvider();
          const { deps, fake } = makeDeps({
            storage,
            moderation,
            rows: [{ id: "media1", tenantId: TENANT_A, uploadId: UPLOAD_1 }],
          });
          const putSpy = vi.spyOn(storage, "putObject");
          const startSpy = vi.spyOn(moderation, "startVideoModeration");

          const out = await processObjectKey(badKey, deps);

          // A non-pending key is always an ack-drop (never poison, never fail).
          expect(out.disposition).toBe("ack");
          expect(out.reason).toBe("non-pending-key");
          expect(putSpy).not.toHaveBeenCalled();
          expect(startSpy).not.toHaveBeenCalled();
          expect(fake.jobs).toHaveLength(0);
          expect(fake.reviewed).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Local helper mirroring the shell's hashing (node:crypto, deterministic).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
function createHashHex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
