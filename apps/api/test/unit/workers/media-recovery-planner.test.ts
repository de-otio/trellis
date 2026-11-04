import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  planRecovery,
  type MediaRecoverySweepConfig,
  type RecoveryCandidate,
  type RecoveryTrackState,
} from "../../../src/lib/workers/media-recovery-sweep.js";
import type { MediaLifecycle } from "../../../src/lib/media/media-lifecycle.js";

// Obviously-mock values; none is, or resembles, operative config.
const SETTLE = 100;
const MAX = 400;
const CONFIG: MediaRecoverySweepConfig = {
  settleWindowSeconds: SETTLE,
  maxMediaAgeSeconds: MAX,
  batchSize: 10,
};
const NOW = new Date("2030-01-01T00:00:00Z");
const FC = { seed: 0x5eed, numRuns: 500 } as const;

const at = (ageSeconds: number): Date =>
  new Date(NOW.getTime() - ageSeconds * 1000);

function candidate(over: Partial<RecoveryCandidate> & { age: number }): RecoveryCandidate {
  const { age, ...rest } = over;
  return {
    mediaId: "m",
    lifecycle: "UPLOADED",
    createdAt: at(age),
    tracks: {
      VISUAL: { hasLiveRow: true, decision: null },
      AUDIO: { hasLiveRow: true, decision: null },
    },
    casObjectPresent: false,
    ...rest,
  };
}

const plan = (media: RecoveryCandidate[]) =>
  planRecovery({ media, now: NOW, config: CONFIG });

describe("planRecovery — rules", () => {
  it("re-enqueues an UPLOADED object past the window with a track missing a live row", () => {
    const placeholder: RecoveryTrackState = { hasLiveRow: false, decision: null };
    expect(
      plan([
        candidate({
          age: SETTLE + 1,
          tracks: {
            VISUAL: { hasLiveRow: true, decision: null },
            AUDIO: placeholder,
          },
        }),
      ]),
    ).toEqual([{ kind: "reenqueue-processing", mediaId: "m" }]);
  });

  it("re-enqueues an UPLOADED object with no tracks at all", () => {
    expect(plan([candidate({ age: SETTLE + 1, tracks: {} })])).toEqual([
      { kind: "reenqueue-processing", mediaId: "m" },
    ]);
  });

  it("leaves a fully started UPLOADED object alone until the age bound", () => {
    expect(plan([candidate({ age: MAX - 1 })])).toEqual([]);
  });

  it("settles at exactly the age bound, ahead of re-enqueueing", () => {
    expect(plan([candidate({ age: MAX, tracks: {} })])).toEqual([
      { kind: "settle-technical", mediaId: "m" },
    ]);
  });

  it("repairs an APPROVED object whose content-addressed object is absent", () => {
    expect(
      plan([candidate({ age: SETTLE + 1, lifecycle: "APPROVED", casObjectPresent: false })]),
    ).toEqual([{ kind: "repair-promotion", mediaId: "m" }]);
    expect(
      plan([candidate({ age: SETTLE + 1, lifecycle: "APPROVED", casObjectPresent: true })]),
    ).toEqual([]);
  });

  it("does nothing inside the settle window", () => {
    expect(plan([candidate({ age: SETTLE, tracks: {} })])).toEqual([]);
    expect(plan([candidate({ age: SETTLE, lifecycle: "APPROVED" })])).toEqual([]);
  });
});

const lifecycleArb = fc.constantFrom<MediaLifecycle>(
  "AWAITING_UPLOAD",
  "UPLOADED",
  "APPROVED",
  "REVIEW",
  "QUARANTINED",
  "REJECTED",
  "UPLOAD_FAILED",
);
const trackArb = fc.option(
  fc.record({
    hasLiveRow: fc.boolean(),
    decision: fc.constantFrom<RecoveryTrackState["decision"]>(
      null,
      "approved",
      "review",
      "quarantine",
    ),
  }),
  { nil: undefined },
);
const candidateArb = fc.record({
  mediaId: fc.uuid(),
  lifecycle: lifecycleArb,
  age: fc.integer({ min: 0, max: 2 * MAX }),
  VISUAL: trackArb,
  AUDIO: trackArb,
  casObjectPresent: fc.boolean(),
});

type Gen = typeof candidateArb extends fc.Arbitrary<infer T> ? T : never;

function build(g: Gen): RecoveryCandidate {
  return {
    mediaId: g.mediaId,
    lifecycle: g.lifecycle,
    createdAt: at(g.age),
    tracks: {
      ...(g.VISUAL !== undefined && { VISUAL: g.VISUAL }),
      ...(g.AUDIO !== undefined && { AUDIO: g.AUDIO }),
    },
    casObjectPresent: g.casObjectPresent,
  };
}

describe("planRecovery — properties", () => {
  it("maps every candidate to at most one action, in order", () => {
    fc.assert(
      fc.property(fc.array(candidateArb, { maxLength: 12 }), (gs) => {
        const media = gs.map(build);
        const actions = plan(media);
        const ids = actions.map((a) => a.mediaId);
        expect(new Set(ids).size).toBe(ids.length);
        const order = media.map((m) => m.mediaId);
        const positions = ids.map((id) => order.indexOf(id));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
      }),
      FC,
    );
  });

  it("settles technical exactly when an UPLOADED object's age reaches the bound", () => {
    fc.assert(
      fc.property(candidateArb, (g) => {
        const c = build(g);
        const settled = plan([c]).some((a) => a.kind === "settle-technical");
        expect(settled).toBe(c.lifecycle === "UPLOADED" && g.age >= MAX);
      }),
      FC,
    );
  });

  it("takes no action on a fresh item, whatever its state", () => {
    fc.assert(
      fc.property(candidateArb, fc.integer({ min: 0, max: SETTLE }), (g, age) => {
        expect(plan([build({ ...g, age })])).toEqual([]);
      }),
      FC,
    );
  });

  it("only ever re-enqueues UPLOADED and only ever repairs APPROVED", () => {
    fc.assert(
      fc.property(candidateArb, (g) => {
        const c = build(g);
        for (const a of plan([c])) {
          if (a.kind === "reenqueue-processing") expect(c.lifecycle).toBe("UPLOADED");
          if (a.kind === "repair-promotion") expect(c.lifecycle).toBe("APPROVED");
        }
      }),
      FC,
    );
  });
});
