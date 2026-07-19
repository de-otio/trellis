/**
 * Thin AWS entrypoint for the maintenance cron (WS-2 T2).
 *
 * EventBridge `cron(3:00 daily)`. The work lives in
 * `lib/workers/maintenance-cron.ts`; this entrypoint wires the AWS concretes:
 * Prisma via `getLambdaPrisma`, and the `cron`-namespace `DynamoKvStore` for
 * both the `CronLock` and the stale-lock sweep.
 */

import { Logger } from "@aws-lambda-powertools/logger";
import { getLambdaPrisma as getPrisma } from "../lib/lambda-prisma.js";
import { getKvStore } from "../lib/kv/kv-provider.js";
import { getLogger } from "../lib/logger.js";
import { makeKvCronLock } from "../lib/workers/cron-lock.js";
import { runMaintenanceCron } from "../lib/workers/maintenance-cron.js";

const logger = new Logger({ serviceName: "maintenance-cron" });

export const handler = async (): Promise<void> => {
  try {
    const cronKv = getKvStore("cron");
    await runMaintenanceCron({
      db: await getPrisma(),
      logger: getLogger(),
      cronLock: makeKvCronLock(cronKv),
      cronKv,
      clock: Date.now,
    });
  } catch (err) {
    logger.error("Maintenance cron failed", { error: err });
    throw err;
  }
};
