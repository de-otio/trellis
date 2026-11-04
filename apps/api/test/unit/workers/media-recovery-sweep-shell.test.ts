import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetMediaRecoverySweepWarnings,
  sweepMedia,
  type MediaRecoveryStore,
  type MediaRecoverySweepConfig,
  type MediaRecoverySweepDeps,
  type RecoveryCandidate,
} from "../../../src/lib/workers/media-recovery-sweep.js";
import { MockStoragePort } from "../../../src/lib/media/media-ports.js";
import type { MediaLifecycle } from "../../../src/lib/media/media-lifecycle.js";
import type { HoldGround } from "../../../src/lib/media/moderation-provider.js";

const NOW = new Date("2030-01-01T00:00:00Z");
const QUEUE = { completionVisibilitySeconds: 10, completionMaxReceive: 3 };
const CONFIG: MediaRecoverySweepConfig = {
  settleWindowSeconds: 30,
  maxMediaAgeSeconds: 100,
  batchSize: 5,
};
const at = (ageSeconds: number): Date => new Date(NOW.getTime() - ageSeconds * 1000);

/** An in-memory store whose settle is a genuine atomic compare-and-set. */
function fakeStore(candidates: RecoveryCandidate[]) {
  const lifecycle = new Map<string, MediaLifecycle>(
    candidates.map((c) => [c.mediaId, c.lifecycle]),
  );
  const transitions: Array<{ mediaId: string; status: MediaLifecycle; ground?: HoldGround }> = [];
  const queries: Array<{ createdBefore: Date; batchSize: number }> = [];
  const store: MediaRecoveryStore = {
    async findRecoveryCandidates(q) {
      queries.push(q);
      return candidates.slice(0, q.batchSize);
    },
    async settleMedia(mediaId, status, options) {
      // Yield so concurrent sweepers genuinely interleave.
      await Promise.resolve();
      if (lifecycle.get(mediaId) !== options.expectedFrom) return false;
      lifecycle.set(mediaId, status);
      transitions.push({ mediaId, status, ...(options.ground && { ground: options.ground }) });
      return true;
    },
    async findMedia() {
      return null;
    },
  };
  return { store, lifecycle, transitions, queries };
}

function deps(
  store: MediaRecoveryStore,
  over: Partial<MediaRecoverySweepDeps> = {},
): MediaRecoverySweepDeps & { warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return {
    store,
    storage: new MockStoragePort(),
    enqueueProcessing: vi.fn(async () => {}),
    config: CONFIG,
    queueTiming: QUEUE,
    now: () => NOW,
    logger: { info: () => {}, warn, error: () => {} },
    warn,
    ...over,
  };
}

const uploaded = (
  mediaId: string,
  age: number,
  tracks: RecoveryCandidate["tracks"],
): RecoveryCandidate => ({
  mediaId,
  lifecycle: "UPLOADED",
  createdAt: at(age),
  tracks,
  casObjectPresent: false,
});

beforeEach(() => __resetMediaRecoverySweepWarnings());

describe("sweepMedia — configuration", () => {
  it("is disabled, and warns exactly once, without a config", async () => {
    const { store, queries } = fakeStore([]);
    const d = deps(store, { config: undefined });
    expect((await sweepMedia(d)).enabled).toBe(false);
    expect((await sweepMedia(d)).enabled).toBe(false);
    expect(d.warn).toHaveBeenCalledTimes(1);
    expect(queries).toEqual([]);
  });

  it("is disabled when the config fails validation", async () => {
    const { store, queries } = fakeStore([]);
    const d = deps(store, { config: { ...CONFIG, settleWindowSeconds: 1 } });
    expect((await sweepMedia(d)).enabled).toBe(false);
    expect(queries).toEqual([]);
    expect(d.warn).toHaveBeenCalledTimes(1);
  });

  it("queries with the settle cutoff and the batch size", async () => {
    const { store, queries } = fakeStore([]);
    await sweepMedia(deps(store));
    expect(queries).toEqual([
      { createdBefore: at(CONFIG.settleWindowSeconds), batchSize: 5 },
    ]);
  });

  it("never acts on more than batchSize candidates, even if the store returns more", async () => {
    const many = Array.from({ length: 9 }, (_, i) => uploaded(`m${i}`, 50, {}));
    const { store } = fakeStore(many);
    store.findRecoveryCandidates = async () => many;
    const d = deps(store);
    const r = await sweepMedia(d);
    expect(r.examined).toBe(5);
    expect(d.enqueueProcessing).toHaveBeenCalledTimes(5);
  });
});

describe("sweepMedia — actions", () => {
  it("re-enqueues a stalled object, whatever its job rows", async () => {
    const stalled = uploaded("m1", 50, {
      VISUAL: { hasLiveRow: true, decision: null },
      AUDIO: { hasLiveRow: false, decision: null },
    });
    const { store, transitions } = fakeStore([stalled]);
    const d = deps(store);
    const r = await sweepMedia(d);
    expect(d.enqueueProcessing).toHaveBeenCalledWith("m1");
    expect(r.reenqueued).toBe(1);
    expect(transitions).toEqual([]);
  });

  it("settles QUARANTINED when one track is quarantine and the other is missing", async () => {
    const c = uploaded("m1", 100, {
      VISUAL: { hasLiveRow: true, decision: "quarantine" },
    });
    const { store, transitions, lifecycle } = fakeStore([c]);
    await sweepMedia(deps(store));
    expect(transitions).toEqual([{ mediaId: "m1", status: "QUARANTINED" }]);
    expect(lifecycle.get("m1")).toBe("QUARANTINED");
  });

  it("settles QUARANTINED when one track is quarantine and the other undecided", async () => {
    const c = uploaded("m1", 100, {
      VISUAL: { hasLiveRow: true, decision: "quarantine" },
      AUDIO: { hasLiveRow: true, decision: null },
    });
    const { store, transitions } = fakeStore([c]);
    await sweepMedia(deps(store));
    expect(transitions.map((t) => t.status)).toEqual(["QUARANTINED"]);
  });

  it("counts an undecided track as review and records the technical ground", async () => {
    const c = uploaded("m1", 100, {
      VISUAL: { hasLiveRow: true, decision: "approved" },
      AUDIO: { hasLiveRow: true, decision: null },
    });
    const { store, transitions } = fakeStore([c]);
    await sweepMedia(deps(store));
    expect(transitions).toEqual([
      { mediaId: "m1", status: "REVIEW", ground: "technical" },
    ]);
  });

  it("emits the resolved event only for a settlement it made", async () => {
    const c = uploaded("m1", 100, {});
    const { store, lifecycle } = fakeStore([c]);
    lifecycle.set("m1", "APPROVED");
    const emitResolved = vi.fn(async () => {});
    const r = await sweepMedia(deps(store, { emitResolved }));
    expect(r.settled).toBe(0);
    expect(emitResolved).not.toHaveBeenCalled();
  });

  it("produces one transition when two sweepers run concurrently", async () => {
    const c = uploaded("m1", 100, {
      VISUAL: { hasLiveRow: true, decision: null },
    });
    const { store, transitions } = fakeStore([c]);
    const [a, b] = await Promise.all([
      sweepMedia(deps(store)),
      sweepMedia(deps(store)),
    ]);
    expect(transitions).toHaveLength(1);
    expect(a.settled + b.settled).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
  });

  it("repairs a promotion through the pinned promotion", async () => {
    const tenant = "caaaaaaaaaaaaaaaaaaaaaaaa";
    const upload = "cuuuuuuuuuuuuuuuuuuuuuuu1";
    const hash = "c".repeat(64);
    const storage = new MockStoragePort({
      [`processing/${tenant}/${upload}`]: Buffer.from("cleaned"),
    });
    const version = (await storage.headObject(`processing/${tenant}/${upload}`)).versionId!;
    const approved: RecoveryCandidate = {
      mediaId: "m1",
      lifecycle: "APPROVED",
      createdAt: at(50),
      tracks: {},
      casObjectPresent: false,
    };
    const { store } = fakeStore([approved]);
    store.findMedia = async () => ({
      lifecycle: "APPROVED",
      tenantId: tenant,
      uploadId: upload,
      contentHash: hash,
      stagingVersionId: version,
    });
    const emitResolved = vi.fn(async () => {});
    const r = await sweepMedia(deps(store, { storage, emitResolved }));
    expect(r.repaired).toBe(1);
    expect((await storage.headObject(`cas/${tenant}/${hash}`)).exists).toBe(true);
    // The completion that approved it could not announce "ready" (its promotion
    // failed), so the repair does, once the bytes are servable.
    expect(emitResolved).toHaveBeenCalledTimes(1);
    expect(emitResolved).toHaveBeenCalledWith({ mediaId: "m1", status: "ready" });
  });

  it("announces nothing when the repair cannot promote", async () => {
    const approved: RecoveryCandidate = {
      mediaId: "m1",
      lifecycle: "APPROVED",
      createdAt: at(50),
      tracks: {},
      casObjectPresent: false,
    };
    const { store } = fakeStore([approved]);
    store.findMedia = async () => ({
      lifecycle: "APPROVED",
      tenantId: "caaaaaaaaaaaaaaaaaaaaaaaa",
      uploadId: "cuuuuuuuuuuuuuuuuuuuuuuu1",
      contentHash: "c".repeat(64),
      stagingVersionId: "v-gone", // nothing in storage: the pinned bytes are unresolvable
    });
    const emitResolved = vi.fn(async () => {});
    const r = await sweepMedia(deps(store, { emitResolved }));
    expect(r.repaired).toBe(0);
    expect(emitResolved).not.toHaveBeenCalled();
  });

  it("promotes before announcing when the age-bound settle itself lands on APPROVED", async () => {
    const tenant = "caaaaaaaaaaaaaaaaaaaaaaaa";
    const upload = "cuuuuuuuuuuuuuuuuuuuuuuu1";
    const hash = "c".repeat(64);
    const storage = new MockStoragePort({
      [`processing/${tenant}/${upload}`]: Buffer.from("cleaned"),
    });
    const version = (await storage.headObject(`processing/${tenant}/${upload}`)).versionId!;
    const c = uploaded("m1", 100, {
      VISUAL: { hasLiveRow: true, decision: "approved" },
      AUDIO: { hasLiveRow: true, decision: "approved" },
    });
    const { store, lifecycle } = fakeStore([c]);
    store.findMedia = async () => ({
      lifecycle: lifecycle.get("m1")!,
      tenantId: tenant,
      uploadId: upload,
      contentHash: hash,
      stagingVersionId: version,
    });
    const order: string[] = [];
    const emitResolved = vi.fn(async () => {
      order.push(`emit:${(await storage.headObject(`cas/${tenant}/${hash}`)).exists}`);
    });
    const r = await sweepMedia(deps(store, { storage, emitResolved }));
    expect(r.settled).toBe(1);
    expect(lifecycle.get("m1")).toBe("APPROVED");
    // The event is only sent once the object exists at its served key.
    expect(order).toEqual(["emit:true"]);
  });

  it("does not stop the batch when one action throws", async () => {
    const list = [uploaded("m1", 50, {}), uploaded("m2", 50, {})];
    const { store } = fakeStore(list);
    const enqueue = vi
      .fn<(id: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("queue down"))
      .mockResolvedValue(undefined);
    const r = await sweepMedia(deps(store, { enqueueProcessing: enqueue }));
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(r.reenqueued).toBe(1);
    expect(r.skipped).toBe(1);
  });
});
