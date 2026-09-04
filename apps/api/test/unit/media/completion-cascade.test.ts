// completion-cascade.test.ts — the deferred lane's CALL SITE (plan 031 C1).
//
// What these tests pin down, and why each has a negative control:
//
//  - The escalate branch NEVER burns the settle path's dedupe claim — a retried
//    delivery must re-route and re-trigger, not vanish as a "duplicate". The
//    negative control is the settle branch, which DOES claim and DOES dedupe.
//  - The escalation is its own job row with its own jobId, and the dedupe key
//    handed to the trigger derives from THAT id — deriving it from the parent's
//    id is the silent-discard bug plan 031 §status documents.
//  - A `deferred` row re-fetches from the EscalationResultPort and is
//    re-clamped: `approved` survives only under `allowApprove: true`.
//  - A taxonomy-pin failure settles; it must never escalate (guaranteed-useless
//    spend). A disabled lane settles everything ("lane-closed").

import { describe, expect, it } from "vitest";

import {
  processCompletion,
  type CompletionCascade,
  type CompletionDeps,
  type CompletionStore,
  type CreatedEscalationJob,
  type DeferredEscalationRequest,
  type EscalationJobSpec,
  type ModerationJobRow,
  type OtherTrackState,
} from "../../../src/lib/workers/media-completion.js";
import { completionEnvelopeBody } from "../../../src/lib/media/completion-envelope.js";
import { deriveDedupeKey } from "../../../src/lib/media/dedupe-key.js";
import type { LabelPolicyExplanation } from "../../../src/lib/media/label-policy.js";
import type {
  MediaModerationProvider,
  ModerationVerdict,
} from "../../../src/lib/media/moderation-provider.js";
import type { ModerationDecision } from "../../../src/lib/media/media-lifecycle.js";
import type { StoragePort, TranscribePort } from "../../../src/lib/media/media-ports.js";
import type { TextModerationProvider } from "../../../src/lib/media/text-moderation.js";

// Valid CUIDs (c + 24 [a-z0-9]) so the cas-keys allowlists pass when the worker
// derives keys from the row's identity columns.
const TENANT = "c0000000000000000000000aa";
const UPLOAD = "c1111111111111111111111bb";
const HASH = "a".repeat(64);
const JOB = "prov-job-1";
const MEDIA = "media-1";
const ESC_JOB = "esc-job-1";

function fakeVerdict(decision: ModerationDecision): ModerationVerdict {
  return { decision, labels: [], provider: "fake" };
}

interface World {
  deps: CompletionDeps;
  calls: string[];
  triggers: DeferredEscalationRequest[];
  escalationSpecs: EscalationJobSpec[];
  claimed: Set<string>;
  trackDecisions: Map<string, ModerationDecision>;
}

function world(opts: {
  jobPriority?: "interactive" | "deferred";
  explanation?: LabelPolicyExplanation;
  cascade?: Partial<CompletionCascade> | false;
  withCreateEscalationJob?: boolean;
  escalationResult?: ModerationDecision | null | "no-port";
  providerVerdict?: ModerationVerdict | null;
  allowApprove?: boolean;
}): World {
  const calls: string[] = [];
  const triggers: DeferredEscalationRequest[] = [];
  const escalationSpecs: EscalationJobSpec[] = [];
  const claimed = new Set<string>();
  const trackDecisions = new Map<string, ModerationDecision>();

  const jobs = new Map<string, ModerationJobRow>([
    [
      JOB,
      {
        mediaId: MEDIA,
        track: "VISUAL",
        thresholdSnapshot: { v: 1 },
        priority: opts.jobPriority ?? "interactive",
      },
    ],
  ]);

  const store: CompletionStore = {
    async claimMessage(key) {
      calls.push("claimMessage");
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    async findJobByJobId(jobId) {
      return jobs.get(jobId) ?? null;
    },
    async persistTrackDecision(jobId, decision) {
      calls.push("persistTrackDecision");
      trackDecisions.set(jobId, decision);
    },
    async readOtherTrack(): Promise<OtherTrackState> {
      return { state: "absent" };
    },
    async findMedia() {
      return {
        lifecycle: "UPLOADED" as const,
        tenantId: TENANT,
        uploadId: UPLOAD,
        contentHash: HASH,
        stagingVersionId: "v-pinned-1",
      };
    },
    async persistMediaStatus() {
      calls.push("persistMediaStatus");
    },
    ...(opts.withCreateEscalationJob === false
      ? {}
      : {
          async createEscalationJob(
            spec: EscalationJobSpec,
          ): Promise<CreatedEscalationJob> {
            calls.push("createEscalationJob");
            escalationSpecs.push(spec);
            // parent_job_id-unique semantics: same parent → same row/jobId.
            return { jobId: ESC_JOB };
          },
        }),
  };

  const moderation: MediaModerationProvider = {
    async moderateImage() {
      throw new Error("unused");
    },
    async startVideoModeration() {
      return { jobId: "x" };
    },
    async getVideoModeration() {
      calls.push("getVideoModeration");
      const v = opts.providerVerdict;
      if (v === null) return null as unknown as ModerationVerdict;
      return v ?? fakeVerdict("review");
    },
  };

  const transcribe: TranscribePort = {
    async startTranscription() {
      return { jobId: "x" };
    },
    async getTranscription() {
      return { status: "COMPLETED" as const, transcript: "" };
    },
  };

  const textModeration: TextModerationProvider = {
    async moderateText() {
      return fakeVerdict("review");
    },
  };

  const storage: StoragePort = {
    async getObject() {
      throw new Error("unused");
    },
    async putObject() {},
    async copyObject() {},
    async deleteObject() {},
    async headObject() {
      return { exists: true };
    },
  };

  const cascade: CompletionCascade | undefined =
    opts.cascade === false
      ? undefined
      : {
          config: { tau: 0.9, enabled: true },
          lane: {
            concurrency: 2,
            perTenantRateLimit: 10,
            evictionWindowMs: 3_600_000,
            allowApprove: opts.allowApprove === true,
          },
          deferredThresholdSnapshot: { deferred: true, v: 99 },
          trigger: async (req) => {
            calls.push("trigger");
            triggers.push(req);
          },
          ...(opts.cascade ?? {}),
        };

  const deps: CompletionDeps = {
    store,
    moderation,
    transcribe,
    textModeration,
    storage,
    reinterpretVisual: () => "review",
    emitResolved: async () => {},
    explainVisual: opts.explanation === undefined ? undefined : () => opts.explanation!,
    cascade,
    escalationResults:
      opts.escalationResult === "no-port"
        ? undefined
        : { get: async () => opts.escalationResult ?? null },
  };

  return { deps, calls, triggers, escalationSpecs, claimed, trackDecisions };
}

const BODY = completionEnvelopeBody({ track: "VISUAL", jobId: JOB });

const GREY_BAND: LabelPolicyExplanation = {
  decision: "review",
  ground: "over-review-bar",
  drivingConfidence: 0.42,
};

describe("processCompletion — the deferred lane's call site (plan 031 C1)", () => {
  it("escalates a grey-band review: own row, own dedupe key, no claim, no verdict", async () => {
    const w = world({ explanation: GREY_BAND });

    const outcome = await processCompletion(BODY, w.deps);

    expect(outcome).toEqual({ kind: "escalated", escalationJobId: ESC_JOB });
    // The row is the parent's child, carrying the DEFERRED lane's snapshot.
    expect(w.escalationSpecs).toEqual([
      {
        mediaId: MEDIA,
        track: "VISUAL",
        parentJobId: JOB,
        thresholdSnapshot: { deferred: true, v: 99 },
      },
    ]);
    // The trigger's dedupe key derives from the ESCALATION row's jobId. The
    // parent-derived key is the silent-discard bug — assert both directions.
    expect(w.triggers).toHaveLength(1);
    const req = w.triggers[0];
    expect(req.jobId).toBe(ESC_JOB);
    expect(req.tenantId).toBe(TENANT);
    expect(req.cause).toBe("grey-band");
    expect(req.confidence).toBe(0.42);
    expect(req.dedupeKey).toBe(
      deriveDedupeKey({ contentHash: HASH, jobId: ESC_JOB, track: "VISUAL" }),
    );
    expect(req.dedupeKey).not.toBe(
      deriveDedupeKey({ contentHash: HASH, jobId: JOB, track: "VISUAL" }),
    );
    // No settle-path side effects: no claim burned, no verdict, no status.
    expect(w.calls).not.toContain("claimMessage");
    expect(w.calls).not.toContain("persistTrackDecision");
    expect(w.calls).not.toContain("persistMediaStatus");
  });

  it("a retried delivery re-routes and re-triggers — never a duplicate", async () => {
    const w = world({ explanation: GREY_BAND });

    const first = await processCompletion(BODY, w.deps);
    const second = await processCompletion(BODY, w.deps);

    expect(first.kind).toBe("escalated");
    expect(second.kind).toBe("escalated"); // NOT "duplicate"
    expect(w.triggers).toHaveLength(2);
    // Same parent → same escalation row → the SAME key both times, so the
    // engine's idempotency (not the message dedupe) absorbs the repeat.
    expect(w.triggers[0].dedupeKey).toBe(w.triggers[1].dedupeKey);
    expect(w.claimed.size).toBe(0);
  });

  it("negative control: the settle branch claims, and its redelivery IS a duplicate", async () => {
    const confident: LabelPolicyExplanation = {
      decision: "review",
      ground: "over-review-bar",
      drivingConfidence: 0.95, // >= τ 0.9 → settle "confident"
    };
    const w = world({ explanation: confident });

    const first = await processCompletion(BODY, w.deps);
    const second = await processCompletion(BODY, w.deps);

    expect(first.kind).toBe("applied");
    expect(second.kind).toBe("duplicate");
    expect(w.calls).toContain("claimMessage");
    expect(w.triggers).toHaveLength(0);
    // The precomputed route decision is used — the provider is fetched once
    // per delivery, never twice.
    expect(w.calls.filter((c) => c === "getVideoModeration")).toHaveLength(2);
    expect(w.trackDecisions.get(JOB)).toBe("review");
  });

  it("a taxonomy-pin failure settles — escalating it is guaranteed-useless spend", async () => {
    const pinFailed: LabelPolicyExplanation = {
      decision: "review",
      ground: "taxonomy-pin-failed",
      drivingConfidence: null,
    };
    const w = world({ explanation: pinFailed });

    const outcome = await processCompletion(BODY, w.deps);

    expect(outcome.kind).toBe("applied");
    expect(w.triggers).toHaveLength(0);
  });

  it("a closed lane (enabled: false) settles everything", async () => {
    const w = world({
      explanation: GREY_BAND,
      cascade: { config: { tau: 0.9, enabled: false } },
    });

    const outcome = await processCompletion(BODY, w.deps);

    expect(outcome.kind).toBe("applied");
    expect(w.triggers).toHaveLength(0);
  });

  it("no cascade wired ⇒ pre-cascade behaviour, verbatim", async () => {
    const w = world({ cascade: false, explanation: GREY_BAND });

    const outcome = await processCompletion(BODY, w.deps);

    expect(outcome.kind).toBe("applied");
    expect(w.triggers).toHaveLength(0);
    expect(w.calls[0]).toBe("claimMessage"); // original order: claim, then fetch
  });

  it("an unreadable provider verdict falls through to the errored settle path", async () => {
    const w = world({ explanation: GREY_BAND, providerVerdict: null });

    const outcome = await processCompletion(BODY, w.deps);

    expect(outcome.kind).toBe("applied");
    expect(w.triggers).toHaveLength(0);
    // errored ⇒ nothing persisted on the track, claim WAS burned (settle path).
    expect(w.calls).toContain("claimMessage");
    expect(w.calls).not.toContain("persistTrackDecision");
  });

  it("cascade configured without createEscalationJob throws — a wiring bug must surface", async () => {
    const w = world({ explanation: GREY_BAND, withCreateEscalationJob: false });

    await expect(processCompletion(BODY, w.deps)).rejects.toThrow(
      /createEscalationJob/,
    );
    expect(w.claimed.size).toBe(0); // still pre-claim: the retry can escalate
  });

  describe("deferred rows re-fetch from the EscalationResultPort", () => {
    it("clamps approved → review while the lane ships closed", async () => {
      const w = world({ jobPriority: "deferred", escalationResult: "approved" });

      const outcome = await processCompletion(BODY, w.deps);

      expect(outcome.kind).toBe("applied");
      expect(w.trackDecisions.get(JOB)).toBe("review");
    });

    it("negative control: allowApprove: true lets approved through", async () => {
      const w = world({
        jobPriority: "deferred",
        escalationResult: "approved",
        allowApprove: true,
      });

      await processCompletion(BODY, w.deps);

      expect(w.trackDecisions.get(JOB)).toBe("approved");
    });

    it("quarantine passes through unclamped", async () => {
      const w = world({ jobPriority: "deferred", escalationResult: "quarantine" });

      await processCompletion(BODY, w.deps);

      expect(w.trackDecisions.get(JOB)).toBe("quarantine");
    });

    it("a missing result is errored — persisted as nothing, never approved", async () => {
      const w = world({ jobPriority: "deferred", escalationResult: null });

      const outcome = await processCompletion(BODY, w.deps);

      expect(outcome.kind).toBe("applied");
      expect(w.trackDecisions.has(JOB)).toBe(false);
    });

    it("a missing port is errored too — fail closed, not a crash", async () => {
      const w = world({ jobPriority: "deferred", escalationResult: "no-port" });

      const outcome = await processCompletion(BODY, w.deps);

      expect(outcome.kind).toBe("applied");
      expect(w.trackDecisions.has(JOB)).toBe(false);
    });

    it("never consults the media provider for a deferred row", async () => {
      const w = world({ jobPriority: "deferred", escalationResult: "review" });

      await processCompletion(BODY, w.deps);

      expect(w.calls).not.toContain("getVideoModeration");
    });
  });
});
