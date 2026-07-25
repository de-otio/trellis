/**
 * WS-2 test-critique finding 2 — CONTAINER wiring of the nightly cron.
 *
 * startup-validation proves the container refuses to boot without the
 * pseudonym key, and nightly-cron's own suite proves the core's gate — but
 * no test mounted the CONTAINER composition: main.ts's capability bag
 * (`lazyPseudonym`, main.ts:140) threaded through `buildCronJobs`
 * (cron-jobs.ts "nightly" entry) into `runNightlyCron`'s fail-closed gate
 * (nightly-cron.ts). A wiring regression (e.g. cron-jobs passing a different
 * resolver, or the bag resolving eagerly onto the context) would be
 * invisible to both suites. This suite builds the bag EXACTLY as main.ts
 * does — lazy arrow over an injected resolver — runs the scheduled job the
 * container would run, and proves:
 *
 *  - empty/unresolvable pseudonym secret ⇒ the gate throws BEFORE any
 *    scheduled-deletion side-effect (no user lookup, no deleteUserData path,
 *    no staging cleanup, no object-store delete);
 *  - the bag's injected resolver is the one the core consumes (call
 *    observed on the SAME spy — no stub leakage / no ambient fallback).
 */

import { describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import { buildCronJobs } from "../../../../worker/src/cron-jobs.js";
import { makeKvCronLock } from "../../../src/lib/workers/cron-lock.js";
import { noopMetrics } from "../../../src/lib/workers/metrics-port.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

/** The nightly-relevant Prisma surface, all spies (deletion side-effects). */
function makeFakeDb() {
  return {
    mediaFile: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    invitation: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn().mockResolvedValue({}),
    },
    deletionAuditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

/**
 * Assemble the container's cron registry the way main.ts does (aws profile —
 * the kv-sweep sixth job is orthogonal to this finding) and return the
 * "nightly" job plus every injected spy.
 */
function mountContainerNightly(resolver: () => Promise<string>) {
  const logger = makeLogger();
  const db = makeFakeDb();
  const kv = new MemoryKvStore();
  const cronLock = makeKvCronLock(kv);
  const clock = Date.now;
  const getDb = async () => db as never;
  // EXACTLY main.ts:140 — the lazy arrow over the container's resolver.
  const lazyPseudonym = (): Promise<string> => resolver();
  const deleteStagingObjects = vi
    .fn()
    .mockResolvedValue({ requested: 0, failedBatches: 0, truncated: false });
  const objectStoreDelete = vi.fn().mockResolvedValue(undefined);

  const jobs = buildCronJobs({
    profile: "aws",
    logger,
    cleanup: { logger, cronLock },
    hourly: { getDb, logger, metrics: noopMetrics, cronLock, clock, configSource: {} },
    nightly: {
      getDb,
      logger,
      metrics: noopMetrics,
      cronLock,
      clock,
      identity: undefined,
      email: undefined,
      resolvePseudonymSecret: lazyPseudonym,
      deleteStagingObjects,
      objectStore: { deleteObjects: objectStoreDelete },
      // main.ts lazily builds the app Env for steps 5/6; those steps are
      // fail-open by design, so a throwing stub proves the deletion step's
      // behavior is independent of them.
      getAppEnv: async () => {
        throw new Error("app Env not available in this test");
      },
    },
    maintenance: { getDb, logger, cronLock, cronKv: kv, clock },
    e2eSweeper: undefined,
    kvSweep: undefined,
  });

  const nightly = jobs.find((j) => j.name === "nightly");
  expect(nightly).toBeDefined();
  return { nightly: nightly!, logger, db, deleteStagingObjects, objectStoreDelete };
}

describe("container-wired nightly cron — pseudonym-secret fail-closed (critic F2)", () => {
  it.each([
    ["empty string", vi.fn().mockResolvedValue("")],
    ["whitespace-only", vi.fn().mockResolvedValue(" \t\n")],
    ["resolution failure", vi.fn().mockRejectedValue(new Error("secret store down"))],
  ])(
    "%s secret ⇒ the core throws BEFORE any scheduled-deletion side-effect",
    async (_label, resolver) => {
      const m = mountContainerNightly(resolver);

      const result = await m.nightly.run();
      expect((result as { acquired: boolean }).acquired).toBe(true); // lock held; step 4 failed inside

      // The bag's resolver WAS consumed — the container wiring, not a stub.
      expect(resolver).toHaveBeenCalledTimes(1);

      // Fail-closed BEFORE any deletion side-effect: no user lookup for
      // scheduled deletions, no pending-count, no user.delete, no staging
      // cleanup, no object-store delete, no audit row.
      expect(m.db.user.findMany).not.toHaveBeenCalled();
      expect(m.db.user.count).not.toHaveBeenCalled();
      expect(m.db.user.delete).not.toHaveBeenCalled();
      expect(m.deleteStagingObjects).not.toHaveBeenCalled();
      expect(m.objectStoreDelete).not.toHaveBeenCalled();
      expect(m.db.deletionAuditLog.create).not.toHaveBeenCalled();

      // And the failure is surfaced (step-4 catch), not swallowed silently.
      expect(m.logger.error).toHaveBeenCalledWith(
        "Scheduled deletion processing failed",
        expect.anything(),
      );
    },
  );

  it("a NON-empty secret from the SAME wiring passes the gate (deletion query runs; resolver consumed lazily)", async () => {
    const resolver = vi.fn().mockResolvedValue("container-wired-secret");
    const m = mountContainerNightly(resolver);

    // Lazy (finding 4): building the bag must NOT resolve the secret.
    expect(resolver).not.toHaveBeenCalled();

    const result = await m.nightly.run();
    expect((result as { acquired: boolean }).acquired).toBe(true);

    // The gate passed and step 4 proceeded to the scheduled-deletion query —
    // through the SAME resolver spy the bag injected (no stub leakage).
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(m.db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletionConfirmedAt: { not: null },
        }),
      }),
    );
    // No users scheduled ⇒ still no deletion side-effects.
    expect(m.db.user.delete).not.toHaveBeenCalled();
    expect(m.logger.error).not.toHaveBeenCalledWith(
      "Scheduled deletion processing failed",
      expect.anything(),
    );
  });
});
