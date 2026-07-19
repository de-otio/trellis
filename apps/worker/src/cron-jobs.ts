/**
 * cron-jobs.ts — the container's cron registry (WS-2 T7b).
 *
 * Assembles the six scheduled jobs from the extracted `lib/workers/*` cron
 * cores. Cadences mirror the EventBridge rules 1:1; the sixth job —
 * `kv-entries-cleanup` (X5) — is registered on the SCALEWAY profile only:
 * it schedules WS-1's `sweepExpiredKvEntries` over the Postgres `kv_entries`
 * table (DynamoDB TTL does this natively, so the AWS profile has no such
 * job).
 *
 * Locking is inside the cores; this module only supplies cadence + context.
 */

import type { SqlExecutor } from "@de-otio/saas-foundation/kv/postgres";
import { sweepExpiredKvEntries } from "@de-otio/saas-foundation/kv/postgres";
import type { Logger } from "../../api/src/lib/logger.js";
import type { CronLock } from "../../api/src/lib/workers/cron-lock.js";
import { withCronLock } from "../../api/src/lib/workers/cron-lock.js";
import {
  runCleanupCron,
  type CleanupCronContext,
} from "../../api/src/lib/workers/cleanup-cron.js";
import {
  runHourlyCron,
  type HourlyCronContext,
} from "../../api/src/lib/workers/hourly-cron.js";
import {
  runNightlyCron,
  type NightlyCronContext,
} from "../../api/src/lib/workers/nightly-cron.js";
import {
  runMaintenanceCron,
  type MaintenanceCronContext,
} from "../../api/src/lib/workers/maintenance-cron.js";
import {
  runE2eSweeper,
  type E2eSweeperContext,
} from "../../api/src/lib/workers/e2e-sweeper.js";
import type { ScheduledJob } from "./scheduler.js";

export type WorkerProfile = "aws" | "scaleway";

export const KV_ENTRIES_CLEANUP_LOCK_NAME = "kv-entries-cleanup";
export const KV_ENTRIES_CLEANUP_LOCK_TTL_SECONDS = 300;
/** Modest cadence (§3.4 X5): correctness never depends on the sweep. */
export const KV_ENTRIES_CLEANUP_EVERY_MS = 15 * 60 * 1000;

export interface CronJobsInput {
  readonly profile: WorkerProfile;
  readonly logger: Logger;
  readonly cleanup: CleanupCronContext;
  readonly hourly: HourlyCronContext;
  readonly nightly: NightlyCronContext;
  readonly maintenance: MaintenanceCronContext;
  readonly e2eSweeper?: E2eSweeperContext;
  /** Scaleway profile only: the shared KV pool + the cron lock + clock. */
  readonly kvSweep?: {
    readonly executor: SqlExecutor;
    readonly cronLock: CronLock;
    readonly clock: () => number;
  };
}

export function buildCronJobs(input: CronJobsInput): ScheduledJob[] {
  const jobs: ScheduledJob[] = [
    {
      name: "cleanup",
      schedule: { kind: "rate", everyMs: 5 * 60 * 1000 },
      run: () => runCleanupCron(input.cleanup),
    },
    {
      name: "hourly",
      schedule: { kind: "rate", everyMs: 60 * 60 * 1000 },
      run: () => runHourlyCron(input.hourly),
    },
    {
      name: "nightly",
      schedule: { kind: "dailyUtc", hour: 2 },
      run: () => runNightlyCron(input.nightly),
    },
    {
      name: "maintenance",
      schedule: { kind: "dailyUtc", hour: 3 },
      run: () => runMaintenanceCron(input.maintenance),
    },
  ];

  // The e2e sweeper only exists where an identity directory is wired (it is
  // an AWS/e2e-stage concern today; the Scaleway identity port arrives with
  // WS-3.3).
  if (input.e2eSweeper !== undefined) {
    const ctx = input.e2eSweeper;
    jobs.push({
      name: "e2e-sweeper",
      schedule: { kind: "rate", everyMs: 60 * 60 * 1000 },
      run: () => runE2eSweeper(ctx),
    });
  }

  // X5 — the sixth cron, SCALEWAY PROFILE ONLY: schedule WS-1's kv_entries
  // TTL sweep under its own single-fire lock.
  if (input.profile === "scaleway") {
    const sweep = input.kvSweep;
    if (sweep === undefined) {
      throw new Error(
        "scaleway profile requires kvSweep wiring (kv-entries-cleanup, X5)",
      );
    }
    jobs.push({
      name: KV_ENTRIES_CLEANUP_LOCK_NAME,
      schedule: { kind: "rate", everyMs: KV_ENTRIES_CLEANUP_EVERY_MS },
      run: () =>
        withCronLock(
          sweep.cronLock,
          KV_ENTRIES_CLEANUP_LOCK_NAME,
          KV_ENTRIES_CLEANUP_LOCK_TTL_SECONDS,
          input.logger,
          async () => {
            const deleted = await sweepExpiredKvEntries(sweep.executor, sweep.clock);
            if (deleted > 0) {
              input.logger.info("kv_entries TTL sweep", { deleted });
            }
          },
        ),
    });
  }

  return jobs;
}
