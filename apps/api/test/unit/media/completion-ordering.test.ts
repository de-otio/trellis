// Completion ordering (lane L1): pre-check on rows, read-only re-fetch, then ONE
// transaction that claims, persists, reads the sibling and settles with a
// compare-and-set; promotion happens only after the commit.
//
// The store fake below has real transaction semantics (per-media lock, buffered
// claims/decisions, rollback on throw) so the ordering is exercised for real:
// a test that passes against a store with no isolation would prove nothing.

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  processCompletion,
  type CompletionDeps,
  type CompletionStore,
  type ModerationJobRow,
  type OtherTrackState,
  type RecordOutcome,
} from "../../../src/lib/workers/media-completion.js";
import type { MediaLifecycle, ModerationDecision } from "../../../src/lib/media/media-lifecycle.js";
import type { Track } from "../../../src/lib/media/track-verdict.js";
import {
  ModerationJobPendingError,
  type ModerationVerdict,
} from "../../../src/lib/media/moderation-provider.js";
import type { StoragePort } from "../../../src/lib/media/media-ports.js";

const TENANT = "c0000000000000000000000aa";
const UPLOAD = "c1111111111111111111111bb";
const HASH = "a".repeat(64);
const PIN = "v-pinned-1";
const MEDIA = "media-1";
const JOB_V = "job-v";
const JOB_A = "job-a";

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}
const macrotask = () => new Promise<void>((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// World: one media object, optional VISUAL + AUDIO job rows, a transactional
// store over it, and the ports the shell talks to.
// ---------------------------------------------------------------------------

interface LifecycleWrite {
  readonly from: MediaLifecycle;
  readonly to: MediaLifecycle;
  readonly via: "completion" | "external";
}

class World {
  lifecycle: MediaLifecycle = "UPLOADED";
  stagingVersionId: string | null = PIN;
  readonly claimed = new Set<string>();
  readonly decisions = new Map<string, ModerationDecision | null>();
  readonly jobs = new Map<string, ModerationJobRow>();
  readonly lifecycleWrites: LifecycleWrite[] = [];
  readonly emitted: { mediaId: string; status: string }[] = [];
  readonly storageCalls: string[] = [];
  readonly errors: unknown[] = [];

  // Provider behaviour (each call may throw / pend).
  visual: () => Promise<ModerationVerdict> = async () => verdict("approved");
  visualCalls = 0;
  transcript: () => Promise<{
    status: "COMPLETED" | "FAILED" | "IN_PROGRESS";
    transcript?: string;
  }> = async () => ({ status: "COMPLETED", transcript: "" });
  text: () => Promise<ModerationVerdict> = async () => verdict("approved");
  copyFails = false;
  persistStatusFailsOnce = false;

  // Hooks / scheduling.
  afterPreCheck?: () => void | Promise<void>;
  afterPersist?: (jobId: string) => void | Promise<void>;
  onStatusWrite?: () => void;
  step: () => Promise<void> = async () => {};

  private tail: Promise<void> = Promise.resolve();

  constructor(opts: {
    tracks: readonly Track[];
    rowExtras?: Partial<ModerationJobRow>;
    /** Tracks whose decision is already persisted (a sibling that finished earlier). */
    decided?: Partial<Record<Track, ModerationDecision>>;
  }) {
    for (const t of opts.tracks) {
      this.jobs.set(t === "VISUAL" ? JOB_V : JOB_A, {
        mediaId: MEDIA,
        track: t,
        thresholdSnapshot: { v: 1 },
        priority: "interactive",
        ...(opts.rowExtras ?? {}),
      } as ModerationJobRow);
      this.decisions.set(t === "VISUAL" ? JOB_V : JOB_A, opts.decided?.[t] ?? null);
    }
  }

  /** A writer that does not take part in the completion transaction. */
  externalWrite(to: MediaLifecycle): void {
    this.lifecycleWrites.push({ from: this.lifecycle, to, via: "external" });
    this.lifecycle = to;
  }

  private siblingState(
    job: string,
    overlay: Map<string, ModerationDecision | null>,
  ): OtherTrackState {
    const other = job === JOB_V ? JOB_A : JOB_V;
    if (!this.jobs.has(other)) return { state: "absent" };
    const d = overlay.has(other) ? overlay.get(other)! : (this.decisions.get(other) ?? null);
    return d === null ? { state: "pending" } : { state: "decided", decision: d };
  }

  private jobIdFor(mediaId: string, track: Track): string {
    return track === "VISUAL" ? JOB_V : JOB_A;
  }

  private writeLifecycle(
    to: MediaLifecycle,
    expectedFrom: MediaLifecycle | undefined,
    undo: (() => void)[] | null,
  ): { count: number } {
    this.onStatusWrite?.();
    if (expectedFrom !== undefined && this.lifecycle !== expectedFrom) return { count: 0 };
    const from = this.lifecycle;
    this.lifecycleWrites.push({ from, to, via: "completion" });
    this.lifecycle = to;
    undo?.push(() => {
      this.lifecycle = from;
      this.lifecycleWrites.pop();
    });
    return { count: 1 };
  }

  private async persistStatusGuard(): Promise<void> {
    if (this.persistStatusFailsOnce) {
      this.persistStatusFailsOnce = false;
      throw new Error("status write failed");
    }
  }

  /** The transactional store. Top-level methods are autocommit (read paths). */
  readonly store: CompletionStore = {
    claimMessage: async (key) => {
      await this.step();
      if (this.claimed.has(key)) return false;
      this.claimed.add(key);
      return true;
    },
    findJobByJobId: async (jobId) => {
      await this.step();
      return this.jobs.get(jobId) ?? null;
    },
    persistTrackDecision: async (jobId, decision) => {
      await this.step();
      this.decisions.set(jobId, decision);
      await this.afterPersist?.(jobId);
    },
    readOtherTrack: async (mediaId, thisTrack) => {
      await this.step();
      return this.siblingState(this.jobIdFor(mediaId, thisTrack), new Map());
    },
    readTrackDecision: async (jobId) => {
      await this.step();
      return this.decisions.get(jobId) ?? null;
    },
    findMedia: async () => {
      await this.step();
      const m = {
        lifecycle: this.lifecycle,
        tenantId: TENANT,
        uploadId: UPLOAD,
        contentHash: HASH,
        stagingVersionId: this.stagingVersionId,
      };
      return m;
    },
    persistMediaStatus: async (_mediaId, status, options) => {
      await this.step();
      await this.persistStatusGuard();
      return this.writeLifecycle(status, options?.expectedFrom, null);
    },
    inTransaction: async (_mediaId, fn) => {
      await this.step();
      const prev = this.tail;
      let release!: () => void;
      this.tail = new Promise<void>((r) => (release = r));
      await prev;
      const claims = new Set<string>();
      const decisions = new Map<string, ModerationDecision | null>();
      const undo: (() => void)[] = [];
      const tx = {
        claimMessage: async (key: string) => {
          await this.step();
          if (this.claimed.has(key) || claims.has(key)) return false;
          claims.add(key);
          return true;
        },
        persistTrackDecision: async (jobId: string, d: ModerationDecision) => {
          await this.step();
          decisions.set(jobId, d);
          await this.afterPersist?.(jobId);
        },
        readOtherTrack: async (mediaId: string, thisTrack: Track) => {
          await this.step();
          return this.siblingState(this.jobIdFor(mediaId, thisTrack), decisions);
        },
        persistMediaStatus: async (
          _m: string,
          status: MediaLifecycle,
          options?: { expectedFrom: MediaLifecycle },
        ) => {
          await this.step();
          await this.persistStatusGuard();
          return this.writeLifecycle(status, options?.expectedFrom, undo);
        },
      };
      try {
        const out = await fn(tx as never);
        for (const k of claims) this.claimed.add(k);
        for (const [k, v] of decisions) this.decisions.set(k, v);
        return out;
      } catch (e) {
        for (const u of undo.reverse()) u();
        throw e;
      } finally {
        release();
      }
    },
  };

  deps(): CompletionDeps {
    const storage: StoragePort = {
      getObject: async () => {
        throw new Error("unused");
      },
      putObject: async () => {},
      copyObject: async () => {
        this.storageCalls.push("copyObject");
        if (this.copyFails) throw new Error("copy failed");
      },
      deleteObject: async () => {
        this.storageCalls.push("deleteObject");
      },
      headObject: async (key: string, o?: { versionId?: string }) => {
        // Pinned staging version exists; nothing at the cas key yet.
        return { exists: o?.versionId !== undefined };
      },
    };
    const world = this;
    return {
      store: this.store,
      moderation: {
        moderateImage: async () => verdict("review"),
        startVideoModeration: async () => ({ jobId: "x" }),
        getVideoModeration: async () => {
          world.visualCalls++;
          await world.step();
          return world.visual();
        },
      },
      transcribe: {
        startTranscription: async () => ({ jobId: "x" }),
        getTranscription: async () => {
          await world.step();
          return world.transcript();
        },
      },
      textModeration: {
        moderateText: async () => {
          await world.step();
          return world.text();
        },
      },
      storage,
      reinterpretVisual: (v) => v.decision,
      emitResolved: async (p) => {
        world.emitted.push(p);
      },
      log: { error: (_m, d) => world.errors.push(d) },
    };
  }

  // The pre-check reads happen in findMedia; hook the moment right after it.
  withAfterPreCheck(fn: () => void | Promise<void>): this {
    this.afterPreCheck = fn;
    const orig = this.store.findMedia.bind(this.store);
    (this.store as { findMedia: CompletionStore["findMedia"] }).findMedia = async (id) => {
      const r = await orig(id);
      await this.afterPreCheck?.();
      return r;
    };
    return this;
  }
}

function verdict(decision: ModerationDecision): ModerationVerdict {
  return { decision, labels: [], provider: "fake" };
}
const body = (track: Track, jobId: string) => JSON.stringify({ track, jobId });
const visualBody = body("VISUAL", JOB_V);
const audioBody = body("AUDIO", JOB_A);

// ---------------------------------------------------------------------------
// Problem 1 — the claim must not precede the re-fetch.
// ---------------------------------------------------------------------------

describe("re-fetch failure does not strand the track", () => {
  it("a throwing provider read is a retry with no claim; the redelivery applies the decision", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"], decided: { AUDIO: "approved" } });
    let calls = 0;
    w.visual = async () => {
      if (++calls === 1) throw new Error("provider unavailable");
      return verdict("approved");
    };

    const first = await processCompletion(visualBody, w.deps());
    expect(first.kind).toBe("retry");
    expect(w.claimed.size).toBe(0);
    expect(w.decisions.get(JOB_V)).toBeNull();

    const second = await processCompletion(visualBody, w.deps());
    expect(second).toEqual({ kind: "applied", status: "APPROVED" });
    expect(w.lifecycle).toBe("APPROVED");
  });

  it("a text-provider outage on the audio track is a retry, then the redelivery succeeds", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"], decided: { VISUAL: "approved" } });
    let calls = 0;
    w.text = async () => {
      if (++calls === 1) throw new Error("text provider outage");
      return verdict("approved");
    };

    const first = await processCompletion(audioBody, w.deps());
    expect(first.kind).toBe("retry");
    expect(w.claimed.size).toBe(0);

    const second = await processCompletion(audioBody, w.deps());
    expect(second).toEqual({ kind: "applied", status: "APPROVED" });
  });
});

// ---------------------------------------------------------------------------
// Problem 2 — an unfinished job is not an errored job.
// ---------------------------------------------------------------------------

describe("an unfinished job is acknowledged, not held", () => {
  it("a pending visual job is not-terminal and writes nothing", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"] });
    w.visual = async () => {
      throw new ModerationJobPendingError();
    };

    const out = await processCompletion(visualBody, w.deps());
    expect(out).toEqual({ kind: "not-terminal" });
    expect(w.claimed.size).toBe(0);
    expect(w.decisions.get(JOB_V)).toBeNull();
    expect(w.lifecycleWrites).toEqual([]);
    expect(w.lifecycle).toBe("UPLOADED");
    expect(w.emitted).toEqual([]);
  });

  it("an in-progress transcription is not-terminal and writes nothing", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"] });
    w.transcript = async () => ({ status: "IN_PROGRESS" });

    const out = await processCompletion(audioBody, w.deps());
    expect(out).toEqual({ kind: "not-terminal" });
    expect(w.claimed.size).toBe(0);
    expect(w.lifecycleWrites).toEqual([]);
    expect(w.lifecycle).toBe("UPLOADED");
  });
});

// ---------------------------------------------------------------------------
// Problem 3 — a pending sibling is not an errored sibling.
// ---------------------------------------------------------------------------

describe("sibling fan-in", () => {
  it("track A with B pending is awaiting-sibling; B then settles with a correct fan-in", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"] });

    const a = await processCompletion(visualBody, w.deps());
    expect(a).toEqual({ kind: "awaiting-sibling" });
    expect(w.lifecycle).toBe("UPLOADED");
    expect(w.lifecycleWrites).toEqual([]);
    expect(w.decisions.get(JOB_V)).toBe("approved");
    expect(w.emitted).toEqual([]);

    const b = await processCompletion(audioBody, w.deps());
    expect(b).toEqual({ kind: "applied", status: "APPROVED" });
    expect(w.lifecycle).toBe("APPROVED");
    expect(w.emitted).toEqual([{ mediaId: MEDIA, status: "ready" }]);
  });

  it("the second track's weaker verdict wins the fan-in (review, not approved)", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"] });
    w.text = async () => verdict("review");

    expect((await processCompletion(visualBody, w.deps())).kind).toBe("awaiting-sibling");
    const b = await processCompletion(audioBody, w.deps());
    expect(b).toEqual({ kind: "applied", status: "REVIEW" });
    expect(w.storageCalls).not.toContain("copyObject");
  });

  it("a quarantine settles at once, even with the sibling pending; the late sibling cannot undo it", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"] });
    w.visual = async () => verdict("quarantine");

    const a = await processCompletion(visualBody, w.deps());
    expect(a).toEqual({ kind: "applied", status: "QUARANTINED" });
    expect(w.lifecycle).toBe("QUARANTINED");

    // The audio track now completes approved. It must neither promote nor move
    // the item: the item is no longer UPLOADED, so this delivery is a duplicate.
    const b = await processCompletion(audioBody, w.deps());
    expect(b).toEqual({ kind: "duplicate" });
    expect(w.lifecycle).toBe("QUARANTINED");
    expect(w.storageCalls).not.toContain("copyObject");
    expect(w.emitted.filter((e) => e.status === "ready")).toEqual([]);
  });
});

describe("an errored track waits for its sibling", () => {
  // The audio track errors when the transcription job FAILED; the visual
  // sibling is still pending. The errored track must not settle REVIEW at once:
  // a sibling that later quarantines has to win.
  const erroredAudio = (w: World): void => {
    w.transcript = async () => ({ status: "FAILED" });
  };

  it("errored track with a pending sibling is awaiting-sibling, not an immediate REVIEW", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"] });
    erroredAudio(w);

    const a = await processCompletion(audioBody, w.deps());

    expect(a).toEqual({ kind: "awaiting-sibling" });
    expect(w.lifecycle).toBe("UPLOADED");
    expect(w.lifecycleWrites).toEqual([]);
    // Persisted as a terminal review marker, so the sibling reads it as decided.
    expect(w.decisions.get(JOB_A)).toBe("review");
    expect(w.emitted).toEqual([]);
  });

  it("the sibling then quarantines: QUARANTINED, not REVIEW", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"] });
    erroredAudio(w);
    w.visual = async () => verdict("quarantine");

    expect((await processCompletion(audioBody, w.deps())).kind).toBe("awaiting-sibling");
    const b = await processCompletion(visualBody, w.deps());

    expect(b).toEqual({ kind: "applied", status: "QUARANTINED" });
    expect(w.lifecycle).toBe("QUARANTINED");
    expect(w.storageCalls).not.toContain("copyObject");
  });

  it("the sibling then approves: REVIEW (technical), never APPROVED, nothing promoted", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"] });
    erroredAudio(w);

    expect((await processCompletion(audioBody, w.deps())).kind).toBe("awaiting-sibling");
    const b = await processCompletion(visualBody, w.deps());

    expect(b).toEqual({ kind: "applied", status: "REVIEW" });
    expect(w.lifecycle).toBe("REVIEW");
    expect(w.storageCalls).not.toContain("copyObject");
    expect(w.emitted).toEqual([{ mediaId: MEDIA, status: "not-ready" }]);
  });

  it("an errored track whose sibling is already decided settles at once (REVIEW)", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"], decided: { VISUAL: "approved" } });
    erroredAudio(w);

    const a = await processCompletion(audioBody, w.deps());

    expect(a).toEqual({ kind: "applied", status: "REVIEW" });
  });

  it("an errored track whose sibling already quarantined is a duplicate (the item is settled)", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"] });
    erroredAudio(w);
    w.visual = async () => verdict("quarantine");

    expect((await processCompletion(visualBody, w.deps())).kind).toBe("applied");
    expect(await processCompletion(audioBody, w.deps())).toEqual({ kind: "duplicate" });
    expect(w.lifecycle).toBe("QUARANTINED");
  });
});

// ---------------------------------------------------------------------------
// Concurrency: both tracks completing at once settle exactly once.
// ---------------------------------------------------------------------------

describe("both tracks completing concurrently", () => {
  for (const order of ["visual-first", "audio-first"] as const) {
    it(`exactly one settles (${order})`, async () => {
      const w = new World({ tracks: ["VISUAL", "AUDIO"] });
      const firstJob = order === "visual-first" ? JOB_V : JOB_A;
      const firstBody = order === "visual-first" ? visualBody : audioBody;
      const secondBody = order === "visual-first" ? audioBody : visualBody;

      // Hold the first delivery inside its critical section, right after it
      // persisted its own decision, while the second delivery starts.
      const held = gate();
      const reached = gate();
      w.afterPersist = async (jobId) => {
        if (jobId === firstJob) {
          reached.open();
          await held.promise;
        }
      };

      const p1 = processCompletion(firstBody, w.deps());
      await reached.promise;
      const p2 = processCompletion(secondBody, w.deps());
      await macrotask();
      await macrotask();
      held.open();
      const outcomes = await Promise.all([p1, p2]);

      const kinds = outcomes.map((o: RecordOutcome) => o.kind).sort();
      expect(kinds).toEqual(["applied", "awaiting-sibling"]);
      expect(w.lifecycle).toBe("APPROVED");
      expect(w.lifecycleWrites.filter((x) => x.to === "APPROVED")).toHaveLength(1);
      expect(w.emitted).toEqual([{ mediaId: MEDIA, status: "ready" }]);
      expect(w.storageCalls.filter((c) => c === "copyObject")).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Pre-check on rows.
// ---------------------------------------------------------------------------

describe("pre-check on rows (no provider call)", () => {
  it("a job row pinned to a different version than the media's is unroutable", async () => {
    const w = new World({ tracks: ["VISUAL"], rowExtras: { pinnedVersion: "v-other" } });
    const out = await processCompletion(visualBody, w.deps());
    expect(out).toEqual({ kind: "unroutable" });
    expect(w.visualCalls).toBe(0);
    expect(w.claimed.size).toBe(0);
    expect(w.lifecycle).toBe("UPLOADED");
  });

  it("a superseded job row is unroutable", async () => {
    const w = new World({ tracks: ["VISUAL"], rowExtras: { superseded: true } });
    const out = await processCompletion(visualBody, w.deps());
    expect(out).toEqual({ kind: "unroutable" });
    expect(w.visualCalls).toBe(0);
    expect(w.claimed.size).toBe(0);
  });

  it("a row pinned to the media's current version is routed", async () => {
    const w = new World({
      tracks: ["VISUAL", "AUDIO"],
      rowExtras: { pinnedVersion: PIN, superseded: false },
      decided: { AUDIO: "approved" },
    });
    expect(await processCompletion(visualBody, w.deps())).toEqual({
      kind: "applied",
      status: "APPROVED",
    });
  });

  it("a row without the optional fields is not made unroutable by that rule", async () => {
    const w = new World({ tracks: ["VISUAL"] });
    const row = w.jobs.get(JOB_V)!;
    expect("pinnedVersion" in row).toBe(false);
    expect("superseded" in row).toBe(false);
    w.stagingVersionId = "any-version"; // would mismatch if the rule applied
    expect((await processCompletion(visualBody, w.deps())).kind).toBe("applied");
  });

  it("a track that is already decided is a duplicate without a provider call", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"] });
    w.decisions.set(JOB_V, "approved");
    const out = await processCompletion(visualBody, w.deps());
    expect(out).toEqual({ kind: "duplicate" });
    expect(w.visualCalls).toBe(0);
  });

  it("an item that is no longer UPLOADED is a duplicate without a provider call", async () => {
    const w = new World({ tracks: ["VISUAL"] });
    w.lifecycle = "REVIEW";
    const out = await processCompletion(visualBody, w.deps());
    expect(out).toEqual({ kind: "duplicate" });
    expect(w.visualCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Problem 4 — the claim commits together with the rest, or not at all.
// ---------------------------------------------------------------------------

describe("claim is atomic with the status write", () => {
  it("a failed status write rolls the claim back; the redelivery applies", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"], decided: { AUDIO: "approved" } });
    w.persistStatusFailsOnce = true;

    const first = await processCompletion(visualBody, w.deps());
    expect(first.kind).toBe("retry");
    expect(w.claimed.size).toBe(0);
    expect(w.decisions.get(JOB_V)).toBeNull();
    expect(w.lifecycle).toBe("UPLOADED");

    const second = await processCompletion(visualBody, w.deps());
    expect(second).toEqual({ kind: "applied", status: "APPROVED" });
  });
});

// ---------------------------------------------------------------------------
// Problem 5 — the lifecycle write is a compare-and-set.
// ---------------------------------------------------------------------------

describe("lifecycle write is a compare-and-set", () => {
  it("an item moved to REVIEW between the pre-check and the commit is a lost-race: no promotion", async () => {
    const w = new World({
      tracks: ["VISUAL", "AUDIO"],
      decided: { AUDIO: "approved" },
    }).withAfterPreCheck(() => {
      w.externalWrite("REVIEW");
    });

    const out = await processCompletion(visualBody, w.deps());
    expect(out).toEqual({ kind: "lost-race" });
    expect(w.lifecycle).toBe("REVIEW");
    expect(w.storageCalls).not.toContain("copyObject");
    expect(w.emitted).toEqual([]);
    // The track decision is kept; the lifecycle was never written by us.
    expect(w.decisions.get(JOB_V)).toBe("approved");
    expect(w.lifecycleWrites.filter((x) => x.via === "completion")).toEqual([]);
  });

  it("a promotion failure after commit leaves APPROVED, throws nothing, and reports applied", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"], decided: { AUDIO: "approved" } });
    w.copyFails = true;

    const out = await processCompletion(visualBody, w.deps());
    expect(out).toEqual({ kind: "applied", status: "APPROVED" });
    expect(w.lifecycle).toBe("APPROVED");
    expect(w.errors.length).toBeGreaterThan(0);
    // Nothing is announced as ready while there is nothing servable.
    expect(w.emitted).toEqual([]);
  });

  it("promotion happens after the status write, never before", async () => {
    const w = new World({ tracks: ["VISUAL", "AUDIO"], decided: { AUDIO: "approved" } });
    const order: string[] = [];
    const deps = w.deps();
    const origCopy = deps.storage.copyObject.bind(deps.storage);
    w.onStatusWrite = () => order.push("status");
    const origTx = w.store.inTransaction.bind(w.store);
    (w.store as { inTransaction: CompletionStore["inTransaction"] }).inTransaction = async (
      id,
      fn,
    ) => {
      const r = await origTx(id, fn);
      order.push("commit");
      return r;
    };
    (deps.storage as { copyObject: StoragePort["copyObject"] }).copyObject = async (a, b, c) => {
      order.push("copy");
      return origCopy(a, b, c);
    };

    await processCompletion(visualBody, deps);
    // The status write is inside the transaction, so it precedes the commit;
    // the object copy only starts once the commit has returned.
    expect(order).toEqual(["status", "commit", "copy"]);
  });
});

// ---------------------------------------------------------------------------
// Property: whatever the interleaving, APPROVED is only ever written from
// UPLOADED, and an external decision is never overwritten by a completion.
// ---------------------------------------------------------------------------

describe("property — random interleavings never approve from a non-UPLOADED item", () => {
  it("every write to APPROVED came from UPLOADED", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat(40), { minLength: 30, maxLength: 80 }),
        fc.constantFrom<MediaLifecycle>("REVIEW", "QUARANTINED", "REJECTED"),
        fc.nat(25),
        fc.constantFrom<ModerationDecision>("approved", "review"),
        async (picks, externalState, externalAfter, audioVerdict) => {
          const w = new World({ tracks: ["VISUAL", "AUDIO"] });
          w.text = async () => verdict(audioVerdict);

          // Cooperative scheduler: every store/provider step parks until the
          // driver (steered by `picks`) resumes it, so the three tasks
          // interleave in an arbitrary but reproducible order.
          const waiting: (() => void)[] = [];
          w.step = () => new Promise<void>((r) => waiting.push(r));

          const external = (async () => {
            for (let i = 0; i < externalAfter % 12; i++) await w.step();
            w.externalWrite(externalState);
          })();
          const tasks = [
            processCompletion(visualBody, w.deps()),
            processCompletion(audioBody, w.deps()),
            external,
          ];
          let done = 0;
          for (const t of tasks)
            t.then(
              () => done++,
              () => done++,
            );

          let i = 0;
          for (let guard = 0; done < tasks.length; guard++) {
            if (guard > 20000) throw new Error("scheduler did not converge");
            await macrotask();
            if (waiting.length > 0) {
              waiting.splice(picks[i++ % picks.length]! % waiting.length, 1)[0]!();
            }
          }

          const results = await Promise.all(tasks);
          for (const r of results.slice(0, 2) as RecordOutcome[]) {
            expect([
              "applied",
              "awaiting-sibling",
              "duplicate",
              "lost-race",
              "not-terminal",
              "retry",
            ]).toContain(r.kind);
          }
          for (const wr of w.lifecycleWrites) {
            if (wr.to === "APPROVED") expect(wr.from).toBe("UPLOADED");
          }
          // An external decision that landed first is never overwritten.
          const extIdx = w.lifecycleWrites.findIndex((x) => x.via === "external");
          if (extIdx >= 0) {
            expect(
              w.lifecycleWrites.slice(extIdx + 1).filter((x) => x.via === "completion"),
            ).toEqual([]);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
