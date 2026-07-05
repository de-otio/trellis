import { describe, it, expect, beforeEach, vi } from "vitest";
import fc from "fast-check";

import {
  processCompletion,
  extractJobPointer,
  makeHandler,
  type CompletionDeps,
  type CompletionStore,
  type ModerationJobRow,
  type MediaCoords,
  type OtherTrackState,
  type RecordOutcome,
} from "../../../src/lambda/media-completion-worker.js";
import type {
  ModerationDecision,
  MediaLifecycle,
} from "../../../src/lib/media/media-lifecycle.js";
import type { Track } from "../../../src/lib/media/track-verdict.js";
import type {
  MediaModerationProvider,
  ModerationVerdict,
} from "../../../src/lib/media/moderation-provider.js";
import type {
  StoragePort,
  TranscribePort,
  TranscriptionStatus,
} from "../../../src/lib/media/media-ports.js";
import type { TextModerationProvider } from "../../../src/lib/media/text-moderation.js";

// Valid CUIDs (c + 24 [a-z0-9]) so the cas-keys allowlists pass when the worker
// derives keys from the row's identity columns.
const TENANT = "c0000000000000000000000aa";
const UPLOAD = "c1111111111111111111111bb";
// A valid 64-char lowercase hex content hash (the dedupe key addresses it; the
// worker derives cas/{TENANT}/{HASH} from it).
const HASH = "a".repeat(64);
const CAS_KEY = `cas/${TENANT}/${HASH}`;
const STAGING_KEY = `processing/${TENANT}/${UPLOAD}`;
const PENDING_KEY = `pending/${TENANT}/${UPLOAD}`;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface StoreState {
  /** dedupe keys already claimed */
  claimed: Set<string>;
  /** jobId -> job row */
  jobs: Map<string, ModerationJobRow>;
  /** jobId -> persisted decision */
  trackDecisions: Map<string, ModerationDecision>;
  /** mediaId -> coords (mutable status) */
  media: Map<string, { coords: MediaCoords }>;
  /** mediaId+track -> sibling state */
  others: Map<string, OtherTrackState>;
  /** ordered log of side-effecting store calls */
  calls: string[];
}

function makeStore(state: StoreState): CompletionStore {
  return {
    async claimMessage(dedupeKey) {
      state.calls.push("claimMessage");
      if (state.claimed.has(dedupeKey)) return false;
      state.claimed.add(dedupeKey);
      return true;
    },
    async findJobByJobId(jobId) {
      return state.jobs.get(jobId) ?? null;
    },
    async persistTrackDecision(jobId, decision) {
      state.calls.push("persistTrackDecision");
      state.trackDecisions.set(jobId, decision);
    },
    async readOtherTrack(mediaId, thisTrack) {
      return state.others.get(`${mediaId}:${thisTrack}`) ?? { state: "absent" };
    },
    async findMedia(mediaId) {
      return state.media.get(mediaId)?.coords ?? null;
    },
    async persistMediaStatus(mediaId, status) {
      state.calls.push("persistMediaStatus");
      const m = state.media.get(mediaId);
      if (m) {
        state.media.set(mediaId, {
          coords: { ...m.coords, lifecycle: status },
        });
      }
    },
  };
}

class FakeModeration implements MediaModerationProvider {
  constructor(public verdict: ModerationVerdict) {}
  async moderateImage(): Promise<ModerationVerdict> {
    return this.verdict;
  }
  async startVideoModeration(): Promise<{ jobId: string }> {
    return { jobId: "x" };
  }
  async getVideoModeration(): Promise<ModerationVerdict> {
    return this.verdict;
  }
}

class FakeTranscribe implements TranscribePort {
  constructor(
    public result: { status: TranscriptionStatus; transcript?: string },
  ) {}
  async startTranscription(): Promise<{ jobId: string }> {
    return { jobId: "x" };
  }
  async getTranscription() {
    return this.result;
  }
}

class FakeText implements TextModerationProvider {
  constructor(private verdict: ModerationVerdict) {}
  async moderateText(): Promise<ModerationVerdict> {
    return this.verdict;
  }
}

function verdict(decision: ModerationDecision): ModerationVerdict {
  return { decision, labels: [], provider: "fake" };
}

interface Harness {
  state: StoreState;
  deps: CompletionDeps;
  emitted: { mediaId: string; status: "ready" | "not-ready" }[];
  storageCalls: string[];
  reinterpretArgs: { verdict: ModerationVerdict; snapshot: unknown }[];
}

function harness(opts: {
  jobId: string;
  track: Track;
  mediaId?: string;
  currentStatus?: MediaLifecycle;
  casPresent?: boolean;
  thresholdSnapshot?: unknown;
  // visual path
  videoVerdict?: ModerationDecision;
  reinterpretReturns?: ModerationDecision;
  // audio path
  transcription?: { status: TranscriptionStatus; transcript?: string };
  textVerdict?: ModerationDecision;
  // sibling
  other?: OtherTrackState;
}): Harness {
  const mediaId = opts.mediaId ?? "media-1";
  const casPresent = opts.casPresent ?? true;

  const state: StoreState = {
    claimed: new Set(),
    jobs: new Map([
      [
        opts.jobId,
        {
          mediaId,
          track: opts.track,
          thresholdSnapshot: opts.thresholdSnapshot ?? { v: 1 },
        },
      ],
    ]),
    trackDecisions: new Map(),
    media: new Map([
      [
        mediaId,
        {
          coords: {
            lifecycle: opts.currentStatus ?? "UPLOADED",
            tenantId: TENANT,
            uploadId: UPLOAD,
            contentHash: HASH,
          },
        },
      ],
    ]),
    others: new Map(
      opts.other ? [[`${mediaId}:${opts.track}`, opts.other]] : [],
    ),
    calls: [],
  };

  const emitted: Harness["emitted"] = [];
  const storageCalls: string[] = [];
  const reinterpretArgs: Harness["reinterpretArgs"] = [];

  const storage: StoragePort = {
    async getObject() {
      throw new Error("unused");
    },
    async putObject() {
      storageCalls.push("putObject");
    },
    async copyObject() {
      storageCalls.push("copyObject");
    },
    async deleteObject() {
      storageCalls.push("deleteObject");
    },
    async headObject() {
      storageCalls.push("headObject");
      return { exists: casPresent };
    },
  };

  const deps: CompletionDeps = {
    store: makeStore(state),
    moderation: new FakeModeration(verdict(opts.videoVerdict ?? "review")),
    transcribe: new FakeTranscribe(
      opts.transcription ?? { status: "COMPLETED", transcript: "" },
    ),
    textModeration: new FakeText(verdict(opts.textVerdict ?? "review")),
    storage,
    reinterpretVisual: (v, snapshot) => {
      reinterpretArgs.push({ verdict: v, snapshot });
      return opts.reinterpretReturns ?? v.decision;
    },
    emitResolved: async (p) => {
      emitted.push(p);
    },
  };

  return { state, deps, emitted, storageCalls, reinterpretArgs };
}

// SNS-wrapped Rekognition completion body carrying a JobId in the inner Message.
function snsBody(jobId: string, forgedExtra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Message: JSON.stringify({ JobId: jobId, ...forgedExtra }),
  });
}

// EventBridge Transcribe completion body carrying TranscriptionJobName.
function ebBody(jobName: string, forgedExtra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    detail: { TranscriptionJobName: jobName, ...forgedExtra },
  });
}

// ---------------------------------------------------------------------------
// extractJobPointer
// ---------------------------------------------------------------------------

describe("extractJobPointer", () => {
  it("extracts JobId from an SNS-wrapped Rekognition body as VISUAL", () => {
    expect(extractJobPointer(snsBody("rek-1"))).toEqual({
      jobId: "rek-1",
      track: "VISUAL",
    });
  });

  it("extracts a direct JobId as VISUAL", () => {
    expect(extractJobPointer(JSON.stringify({ JobId: "rek-2" }))).toEqual({
      jobId: "rek-2",
      track: "VISUAL",
    });
  });

  it("extracts TranscriptionJobName from EventBridge detail as AUDIO", () => {
    expect(extractJobPointer(ebBody("tr-1"))).toEqual({
      jobId: "tr-1",
      track: "AUDIO",
    });
  });

  it("returns null for malformed / pointer-less bodies (fail-closed)", () => {
    expect(extractJobPointer("not json")).toBeNull();
    expect(extractJobPointer(JSON.stringify({ nothing: true }))).toBeNull();
    expect(extractJobPointer(JSON.stringify({ JobId: "" }))).toBeNull();
    expect(extractJobPointer(JSON.stringify(null))).toBeNull();
    expect(extractJobPointer(JSON.stringify([1, 2]))).toBeNull();
  });

  it("ignores any verdict/status fields in the body (pointer only)", () => {
    const p = extractJobPointer(
      snsBody("rek-3", { decision: "approved", status: "APPROVED" }),
    );
    expect(p).toEqual({ jobId: "rek-3", track: "VISUAL" });
  });
});

// ---------------------------------------------------------------------------
// Dedupe-before-side-effect
// ---------------------------------------------------------------------------

describe("processCompletion — dedupe before side effect", () => {
  it("duplicate delivery is a no-op: no persist, no storage write, no emit", async () => {
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "approved",
      other: { state: "decided", decision: "approved" },
    });

    // First delivery applies.
    const first = await processCompletion(snsBody("rek-1"), h.deps);
    expect(first.kind).toBe("applied");

    const callsAfterFirst = [...h.state.calls];
    const emittedAfterFirst = h.emitted.length;
    const storageAfterFirst = [...h.storageCalls];

    // Second (identical) delivery: dedupe hit.
    const second = await processCompletion(snsBody("rek-1"), h.deps);
    expect(second.kind).toBe("duplicate");

    // The only NEW store call on the duplicate is the claimMessage probe; no
    // further persist/storage/emit side effects happened.
    const newStoreCalls = h.state.calls.slice(callsAfterFirst.length);
    expect(newStoreCalls).toEqual(["claimMessage"]);
    expect(h.emitted.length).toBe(emittedAfterFirst);
    expect(h.storageCalls).toEqual(storageAfterFirst);
  });

  it("claimMessage precedes every side effect on first delivery", async () => {
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "approved",
      other: { state: "decided", decision: "approved" },
    });
    await processCompletion(snsBody("rek-1"), h.deps);

    // claimMessage must be the FIRST entry in the side-effecting store call log.
    expect(h.state.calls[0]).toBe("claimMessage");
    // And persistTrackDecision (the first real mutation) comes after it.
    expect(h.state.calls.indexOf("claimMessage")).toBeLessThan(
      h.state.calls.indexOf("persistTrackDecision"),
    );
  });
});

// ---------------------------------------------------------------------------
// Re-fetch authoritative — forged body is ignored
// ---------------------------------------------------------------------------

describe("processCompletion — re-fetch authoritative (body verdict ignored)", () => {
  it("a forged 'approved' in the body does NOT approve when the provider says review", async () => {
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "review", // authoritative provider verdict
      other: { state: "decided", decision: "approved" },
    });

    // Body forges decision=approved / status=APPROVED — must be ignored.
    const out = await processCompletion(
      snsBody("rek-1", { decision: "approved", status: "APPROVED" }),
      h.deps,
    );

    expect(out.kind).toBe("applied");
    expect((out as { status: MediaLifecycle }).status).toBe("REVIEW");
    expect(h.emitted).toEqual([{ mediaId: "media-1", status: "not-ready" }]);
    // No promotion happened (storage copy not called).
    expect(h.storageCalls).not.toContain("copyObject");
  });

  it("reinterprets the VISUAL verdict using the JOB threshold snapshot, not live state", async () => {
    const snap = { tuned: "snapshot-only" };
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "review",
      thresholdSnapshot: snap,
      other: { state: "decided", decision: "approved" },
    });
    await processCompletion(snsBody("rek-1"), h.deps);
    expect(h.reinterpretArgs.length).toBe(1);
    expect(h.reinterpretArgs[0].snapshot).toBe(snap);
  });

  it("AUDIO: a non-COMPLETED transcription fails closed (errored => not approved)", async () => {
    const h = harness({
      jobId: "tr-1",
      track: "AUDIO",
      transcription: { status: "FAILED" },
      textVerdict: "approved", // would approve if it were consulted
      other: { state: "decided", decision: "approved" },
    });
    const out = await processCompletion(ebBody("tr-1"), h.deps);
    expect(out.kind).toBe("applied");
    expect((out as { status: MediaLifecycle }).status).toBe("REVIEW");
    expect(h.emitted).toEqual([{ mediaId: "media-1", status: "not-ready" }]);
  });
});

// ---------------------------------------------------------------------------
// Both-tracks-required
// ---------------------------------------------------------------------------

describe("processCompletion — both tracks required for approval", () => {
  it("visual approved + audio ABSENT => NOT approved (review)", async () => {
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "approved",
      other: { state: "absent" },
    });
    const out = await processCompletion(snsBody("rek-1"), h.deps);
    expect((out as { status: MediaLifecycle }).status).toBe("REVIEW");
    expect(h.emitted).toEqual([{ mediaId: "media-1", status: "not-ready" }]);
    expect(h.storageCalls).not.toContain("copyObject");
  });

  it("visual approved + audio PENDING (job exists, unresolved) => NOT approved", async () => {
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "approved",
      other: { state: "pending" },
    });
    const out = await processCompletion(snsBody("rek-1"), h.deps);
    expect((out as { status: MediaLifecycle }).status).toBe("REVIEW");
    expect(h.storageCalls).not.toContain("copyObject");
  });

  it("visual approved + audio decided-approved => APPROVED + ready + promotion", async () => {
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "approved",
      other: { state: "decided", decision: "approved" },
    });
    const out = await processCompletion(snsBody("rek-1"), h.deps);
    expect((out as { status: MediaLifecycle }).status).toBe("APPROVED");
    expect(h.emitted).toEqual([{ mediaId: "media-1", status: "ready" }]);
    expect(h.storageCalls).toContain("copyObject");
  });

  it("APPROVED but CAS object ABSENT => persist+emit but NO promotion (doubt never serves bytes)", async () => {
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "approved",
      casPresent: false,
      other: { state: "decided", decision: "approved" },
    });
    const out = await processCompletion(snsBody("rek-1"), h.deps);
    expect((out as { status: MediaLifecycle }).status).toBe("APPROVED");
    // status persisted, event emitted...
    expect(h.state.calls).toContain("persistMediaStatus");
    expect(h.emitted).toEqual([{ mediaId: "media-1", status: "ready" }]);
    // ...but bytes were NOT copied because the CAS object is not present.
    expect(h.storageCalls).not.toContain("copyObject");
  });
});

// ---------------------------------------------------------------------------
// Promote -> persist -> emit ordering
// ---------------------------------------------------------------------------

describe("processCompletion — fixed promote/persist/emit ordering", () => {
  it("copyObject precedes persistMediaStatus precedes emit on approval", async () => {
    const order: string[] = [];
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "approved",
      other: { state: "decided", decision: "approved" },
    });

    // Wrap the side-effecting deps to record a global ordering.
    const origCopy = h.deps.storage.copyObject.bind(h.deps.storage);
    const origPersist = h.deps.store.persistMediaStatus.bind(h.deps.store);
    const origEmit = h.deps.emitResolved;
    const deps: CompletionDeps = {
      ...h.deps,
      storage: {
        ...h.deps.storage,
        copyObject: async (a, b) => {
          order.push("copy");
          return origCopy(a, b);
        },
      },
      store: {
        ...h.deps.store,
        persistMediaStatus: async (m, s) => {
          order.push("persist");
          return origPersist(m, s);
        },
      },
      emitResolved: async (p) => {
        order.push("emit");
        return origEmit(p);
      },
    };

    await processCompletion(snsBody("rek-1"), deps);
    expect(order).toEqual(["copy", "persist", "emit"]);
  });

  it("deleteObject is best-effort: a delete failure does not fail the record", async () => {
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "approved",
      other: { state: "decided", decision: "approved" },
    });
    const deps: CompletionDeps = {
      ...h.deps,
      storage: {
        ...h.deps.storage,
        deleteObject: async () => {
          throw new Error("pending already deleted");
        },
      },
    };
    const out = await processCompletion(snsBody("rek-1"), deps);
    expect((out as { status: MediaLifecycle }).status).toBe("APPROVED");
    expect(h.emitted).toEqual([{ mediaId: "media-1", status: "ready" }]);
  });
});

// ---------------------------------------------------------------------------
// Replay on a terminal status
// ---------------------------------------------------------------------------

describe("processCompletion — replay on terminal status", () => {
  it("a fresh (non-deduped) decision on an already-APPROVED object is an ack-drop no-op", async () => {
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "approved",
      currentStatus: "APPROVED", // already terminal
      other: { state: "decided", decision: "approved" },
    });
    const out = await processCompletion(snsBody("rek-1"), h.deps);
    expect(out.kind).toBe("illegal-transition");
    // No status persisted, no promotion, no emit.
    expect(h.state.calls).not.toContain("persistMediaStatus");
    expect(h.storageCalls).not.toContain("copyObject");
    expect(h.emitted).toEqual([]);
  });

  it("illegal transition is NOT a retry (never DLQ)", async () => {
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "approved",
      currentStatus: "REJECTED",
      other: { state: "decided", decision: "approved" },
    });
    const out = await processCompletion(snsBody("rek-1"), h.deps);
    expect(out.kind).toBe("illegal-transition");
    expect(out.kind).not.toBe("retry");
  });
});

// ---------------------------------------------------------------------------
// Emitted payload is anti-oracle (ready|not-ready only)
// ---------------------------------------------------------------------------

describe("processCompletion — emitted payload carries only ready|not-ready", () => {
  const cases: { name: string; decision: ModerationDecision; other: OtherTrackState; expected: "ready" | "not-ready" }[] = [
    {
      name: "both approved => ready",
      decision: "approved",
      other: { state: "decided", decision: "approved" },
      expected: "ready",
    },
    {
      name: "quarantine => not-ready",
      decision: "quarantine",
      other: { state: "decided", decision: "approved" },
      expected: "not-ready",
    },
    {
      name: "review => not-ready",
      decision: "review",
      other: { state: "decided", decision: "approved" },
      expected: "not-ready",
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const h = harness({
        jobId: "rek-1",
        track: "VISUAL",
        videoVerdict: c.decision,
        other: c.other,
      });
      await processCompletion(snsBody("rek-1"), h.deps);
      expect(h.emitted.length).toBe(1);
      const payload = h.emitted[0];
      // Exactly two keys; status is the binary flag only.
      expect(Object.keys(payload).sort()).toEqual(["mediaId", "status"]);
      expect(payload.status).toBe(c.expected);
      expect(["ready", "not-ready"]).toContain(payload.status);
    });
  }
});

// ---------------------------------------------------------------------------
// Unroutable / unknown-job fail-closed drops
// ---------------------------------------------------------------------------

describe("processCompletion — unroutable fail-closed drops", () => {
  it("a body with no extractable jobId is dropped (no claim, no side effect)", async () => {
    const h = harness({ jobId: "rek-1", track: "VISUAL" });
    const out = await processCompletion("garbage", h.deps);
    expect(out.kind).toBe("unroutable");
    expect(h.state.calls).toEqual([]);
  });

  it("a jobId with no matching job row is dropped before any claim", async () => {
    const h = harness({ jobId: "rek-1", track: "VISUAL" });
    const out = await processCompletion(snsBody("unknown-job"), h.deps);
    expect(out.kind).toBe("unroutable");
    expect(h.state.calls).not.toContain("claimMessage");
  });
});

// ---------------------------------------------------------------------------
// Handler batch semantics
// ---------------------------------------------------------------------------

describe("makeHandler — SQS batch semantics", () => {
  function sqsEvent(bodies: string[]) {
    return {
      Records: bodies.map((body, i) => ({
        messageId: `m-${i}`,
        body,
      })),
    } as any;
  }

  it("acks duplicates, unroutable, and illegal transitions (no batch-item failures)", async () => {
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      currentStatus: "APPROVED",
      videoVerdict: "approved",
      other: { state: "decided", decision: "approved" },
    });
    const handler = makeHandler(h.deps);
    // illegal-transition (terminal) + unroutable garbage — both ack.
    const res = await handler(sqsEvent([snsBody("rek-1"), "garbage"]), {} as any, () => {});
    expect(res).toBeUndefined();
  });

  it("an unexpected throw becomes a batch-item failure (retry)", async () => {
    const h = harness({
      jobId: "rek-1",
      track: "VISUAL",
      videoVerdict: "approved",
      other: { state: "decided", decision: "approved" },
    });
    const deps: CompletionDeps = {
      ...h.deps,
      store: {
        ...h.deps.store,
        findMedia: async () => {
          throw new Error("transient DB outage");
        },
      },
    };
    const handler = makeHandler(deps);
    const res = (await handler(sqsEvent([snsBody("rek-1")]), {} as any, () => {})) as
      | { batchItemFailures: { itemIdentifier: string }[] }
      | undefined;
    expect(res?.batchItemFailures).toEqual([{ itemIdentifier: "m-0" }]);
  });
});

// ---------------------------------------------------------------------------
// Property: approval requires positive evidence on BOTH tracks
// ---------------------------------------------------------------------------

const decisionArb = fc.constantFrom<ModerationDecision>(
  "approved",
  "review",
  "quarantine",
);
const otherArb = fc.oneof(
  fc.record({
    state: fc.constant<"decided">("decided"),
    decision: decisionArb,
  }),
  fc.constant<OtherTrackState>({ state: "pending" }),
  fc.constant<OtherTrackState>({ state: "absent" }),
);

describe("property — APPROVED/ready iff both tracks positively approved", () => {
  it("ready is emitted iff this track AND the sibling are both decided-approved", async () => {
    await fc.assert(
      fc.asyncProperty(
        decisionArb,
        otherArb,
        async (thisDecision, other) => {
          const h = harness({
            jobId: "rek-1",
            track: "VISUAL",
            videoVerdict: thisDecision,
            other,
            currentStatus: "UPLOADED",
          });
          const out = await processCompletion(snsBody("rek-1"), h.deps);
          // PENDING always permits a legal transition, so the record applies.
          expect(out.kind).toBe("applied");
          const status = (out as { status: MediaLifecycle }).status;
          const bothApproved =
            thisDecision === "approved" &&
            other.state === "decided" &&
            other.decision === "approved";
          if (bothApproved) {
            expect(status).toBe("APPROVED");
            expect(h.emitted[0].status).toBe("ready");
            expect(h.storageCalls).toContain("copyObject");
          } else {
            expect(status).not.toBe("APPROVED");
            expect(h.emitted[0].status).toBe("not-ready");
            expect(h.storageCalls).not.toContain("copyObject");
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("a quarantine on either track is sticky (never ready) regardless of sibling", async () => {
    await fc.assert(
      fc.asyncProperty(otherArb, async (other) => {
        const h = harness({
          jobId: "rek-1",
          track: "VISUAL",
          videoVerdict: "quarantine",
          other,
          currentStatus: "UPLOADED",
        });
        await processCompletion(snsBody("rek-1"), h.deps);
        expect(h.emitted[0].status).toBe("not-ready");
        expect(h.storageCalls).not.toContain("copyObject");
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property: extractJobPointer never throws and never invents a job id
// ---------------------------------------------------------------------------

describe("property — extractJobPointer is total and never fabricates", () => {
  it("never throws; only returns a pointer when a real id string is present", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        let body: string;
        try {
          body = JSON.stringify(v);
        } catch {
          body = "circular";
        }
        const result = extractJobPointer(body);
        if (result !== null) {
          expect(result.jobId.length).toBeGreaterThan(0);
          expect(["VISUAL", "AUDIO"]).toContain(result.track);
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// T14 acceptance — FAIL-CLOSED: a video whose moderation errors or times out
// is HELD (REVIEW / still-UPLOADED) and the serve gate NEVER serves it.
// ---------------------------------------------------------------------------

import { isServable } from "../../../src/lib/media/serve-gate.js";

describe("T14 fail-closed — errored/timed-out moderation is HELD, never served", () => {
  it("provider re-fetch FAILS (errored track) ⇒ REVIEW, no promotion, serve gate denies", async () => {
    const h = harness({
      jobId: "tr-err",
      track: "AUDIO",
      transcription: { status: "FAILED" }, // provider job errored
      textVerdict: "approved", // would approve if (wrongly) consulted
      other: { state: "decided", decision: "approved" }, // sibling is clean
    });

    const out = await processCompletion(ebBody("tr-err"), h.deps);

    // HELD: the object lands in REVIEW (human queue), not APPROVED.
    expect(out.kind).toBe("applied");
    expect((out as { status: MediaLifecycle }).status).toBe("REVIEW");
    // NEVER promoted: no bytes were copied toward the served cas/ prefix.
    expect(h.storageCalls).not.toContain("copyObject");
    // NEVER served: the serve gate denies the resulting state.
    expect(
      isServable({ lifecycle: "REVIEW", hidden: false, deletedAt: null }),
    ).toBe(false);
  });

  it("provider re-fetch THROWS (timeout) ⇒ record retried, object stays UPLOADED, serve gate denies", async () => {
    const h = harness({
      jobId: "rek-timeout",
      track: "VISUAL",
      other: { state: "decided", decision: "approved" },
    });
    // The provider call times out / throws instead of answering.
    h.deps.moderation.getVideoModeration = async () => {
      throw new Error("ETIMEDOUT");
    };

    // processCompletion propagates (the SQS handler converts it to a retry) —
    // the object's persisted state is untouched.
    await expect(processCompletion(snsBody("rek-timeout"), h.deps)).rejects.toThrow();

    const persisted = h.state.media.get("media-1")!.coords.lifecycle;
    expect(persisted).toBe("UPLOADED"); // never advanced toward APPROVED
    expect(h.storageCalls).not.toContain("copyObject");
    expect(
      isServable({ lifecycle: persisted, hidden: false, deletedAt: null }),
    ).toBe(false);
  });

  it("moderation that never completes at all (no message) leaves UPLOADED — which the serve gate denies", () => {
    // The degenerate case: the completion message is simply never delivered.
    // The object sits at UPLOADED forever; the gate approves APPROVED only.
    expect(
      isServable({ lifecycle: "UPLOADED", hidden: false, deletedAt: null }),
    ).toBe(false);
    expect(
      isServable({ lifecycle: "AWAITING_UPLOAD", hidden: false, deletedAt: null }),
    ).toBe(false);
  });
});
