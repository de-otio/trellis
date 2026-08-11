import { describe, expect, it } from "vitest";

import {
  isAcceptableProviderDimension,
  ModerationMetrics,
  ModerationMetricsConfigError,
  UNKNOWN_PROVIDER_DIMENSION,
} from "../../../src/lib/media/moderation-metrics.js";
import {
  createMediaBytesAccess,
  MediaBytesAccessConfigError,
  MediaBytesTooLargeError,
} from "../../../src/lib/media/media-bytes-access.js";
import { MockStoragePort } from "../../../src/lib/media/media-ports.js";

const DECLARED = ["mock", "frame-sampling"];
const WINDOW_MS = 60_000;

/** A frozen, hand-advanced clock: no ambient time anywhere in these tests. */
function frozenClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function metrics(over: Partial<{ unpinnedTaxonomy: boolean; providerActive: boolean }> = {}) {
  const clock = frozenClock();
  const m = new ModerationMetrics({
    declaredProviders: DECLARED,
    windowMs: WINDOW_MS,
    now: clock.now,
    ...over,
  });
  return { m, clock };
}

describe("ModerationMetrics — construction", () => {
  it("refuses a config without a clock, a window, or a declared provider list", () => {
    const clock = frozenClock();
    expect(
      () =>
        new ModerationMetrics({
          declaredProviders: DECLARED,
          windowMs: 0,
          now: clock.now,
        }),
    ).toThrow(ModerationMetricsConfigError);
    expect(
      () =>
        new ModerationMetrics({
          declaredProviders: undefined as never,
          windowMs: WINDOW_MS,
          now: clock.now,
        }),
    ).toThrow(ModerationMetricsConfigError);
    expect(
      () =>
        new ModerationMetrics({
          declaredProviders: DECLARED,
          windowMs: WINDOW_MS,
          now: undefined as never,
        }),
    ).toThrow(ModerationMetricsConfigError);
  });
});

describe("ModerationMetrics — the public payload reveals nothing about uploads", () => {
  it("carries exactly one boolean", () => {
    const { m } = metrics({ providerActive: true });
    const payload = m.publicHealth();

    expect(payload).toEqual({ moderationProviderActive: true });
    expect(Object.keys(payload)).toEqual(["moderationProviderActive"]);
  });

  it("carries no counters and no category vocabulary, even after activity", () => {
    const { m, clock } = metrics({ providerActive: true });
    m.recordDecision("mock", "quarantine");
    m.recordDecision("mock", "approved");
    clock.advance(WINDOW_MS * 2);

    const serialized = JSON.stringify(m.publicHealth());

    expect(serialized).not.toContain("quarantine");
    expect(serialized).not.toContain("approved");
    expect(serialized).not.toContain("review");
    expect(serialized).not.toMatch(/\d/);
  });

  it("reports an inactive provider as inactive", () => {
    const { m } = metrics();
    expect(m.publicHealth().moderationProviderActive).toBe(false);
  });
});

describe("ModerationMetrics — closed windows only", () => {
  it("does not report the window still accumulating", () => {
    // This is the anti-oracle control: upload a probe now, and there is nothing
    // to read back now.
    const { m } = metrics();
    m.recordDecision("mock", "quarantine");

    expect(m.snapshot().windows).toEqual([]);
  });

  it("reports a window once it has closed", () => {
    const { m, clock } = metrics();
    m.recordDecision("mock", "quarantine");
    m.recordDecision("mock", "quarantine");
    m.recordDecision("mock", "approved");

    clock.advance(WINDOW_MS);
    // Touch the new window so the old one is definitely behind us.
    m.recordDecision("mock", "review");

    const snap = m.snapshot();
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0].decisions).toEqual({
      "mock:quarantine": 2,
      "mock:approved": 1,
    });
  });

  it("counts infrastructure faults separately from cautious verdicts", () => {
    // Fail-closed is otherwise indistinguishable from healthy caution.
    const { m, clock } = metrics();
    m.recordInfraFault("mock");
    m.recordDecision("mock", "review");
    clock.advance(WINDOW_MS);

    const snap = m.snapshot();
    expect(snap.windows[0].infraFaults).toEqual({ mock: 1 });
    expect(snap.windows[0].decisions).toEqual({ "mock:review": 1 });
  });

  it("retains a bounded number of windows", () => {
    const { m, clock } = metrics();
    for (let i = 0; i < 50; i += 1) {
      m.recordDecision("mock", "approved");
      clock.advance(WINDOW_MS);
    }
    expect(m.snapshot().windows.length).toBeLessThanOrEqual(12);
  });

  it("surfaces an unpinned taxonomy as a standing flag", () => {
    expect(metrics({ unpinnedTaxonomy: true }).m.snapshot().unpinnedTaxonomy).toBe(
      true,
    );
    expect(metrics().m.snapshot().unpinnedTaxonomy).toBe(false);
  });
});

describe("provider names used as metric dimensions", () => {
  it("accepts a declared, well-formed name", () => {
    expect(isAcceptableProviderDimension("mock", DECLARED)).toBe(true);
  });

  it("rejects an undeclared name even when it is well-formed", () => {
    expect(isAcceptableProviderDimension("some-other-provider", DECLARED)).toBe(
      false,
    );
  });

  it("rejects hostile and over-long values", () => {
    const hostile: unknown[] = [
      "",
      "x".repeat(65),
      "mock provider",
      "mock/../etc",
      "mock\ttab",
      "-leading-dash",
      42,
      null,
      undefined,
      { toString: () => "mock" },
    ];
    for (const value of hostile) {
      expect(isAcceptableProviderDimension(value, DECLARED)).toBe(false);
    }
  });

  it("records an unacceptable name under a fixed placeholder, not as a new dimension", () => {
    const { m, clock } = metrics();
    m.recordDecision("x".repeat(500), "review");
    m.recordDecision("undeclared-provider", "review");
    clock.advance(WINDOW_MS);

    const decisions = m.snapshot().windows[0].decisions;
    expect(decisions).toEqual({ [`${UNKNOWN_PROVIDER_DIMENSION}:review`]: 2 });
  });
});

describe("MediaBytesAccess", () => {
  it("refuses to construct without a positive cap", () => {
    const storage = new MockStoragePort();
    for (const bad of [0, -1, Number.NaN, undefined as never]) {
      expect(() => createMediaBytesAccess(storage, { maxBytes: bad })).toThrow(
        MediaBytesAccessConfigError,
      );
    }
  });

  it("reads an object within the cap", async () => {
    const storage = new MockStoragePort({ "cas/t/h": Buffer.from("hello") });
    const access = createMediaBytesAccess(storage, { maxBytes: 1024 });

    await expect(access.read({ key: "cas/t/h" })).resolves.toEqual(
      Buffer.from("hello"),
    );
  });

  it("throws a typed error rather than loading an over-cap object", async () => {
    const storage = new MockStoragePort({
      "cas/t/h": Buffer.alloc(4096, 0x41),
    });
    const access = createMediaBytesAccess(storage, { maxBytes: 16 });

    await expect(access.read({ key: "cas/t/h" })).rejects.toBeInstanceOf(
      MediaBytesTooLargeError,
    );
  });

  it("reads exactly at the cap without complaining", async () => {
    const storage = new MockStoragePort({ "cas/t/h": Buffer.alloc(16, 0x41) });
    const access = createMediaBytesAccess(storage, { maxBytes: 16 });

    await expect(access.read({ key: "cas/t/h" })).resolves.toHaveLength(16);
  });

  it("pins the read to the recorded version rather than the current bytes", async () => {
    const storage = new MockStoragePort({ "cas/t/h": Buffer.from("original") });
    const access = createMediaBytesAccess(storage, { maxBytes: 1024 });
    // Overwrite the key after the pin was captured.
    await storage.putObject("cas/t/h", Buffer.from("swapped!"), "text/plain");

    const bytes = await access.read({
      key: "cas/t/h",
      pin: { kind: "versionId", value: "mock-version-1" },
    });

    expect(bytes.toString()).toBe("original");
  });

  it("exposes its cap so an adapter can refuse early", () => {
    const access = createMediaBytesAccess(new MockStoragePort(), {
      maxBytes: 2048,
    });
    expect(access.maxBytes).toBe(2048);
  });
});
