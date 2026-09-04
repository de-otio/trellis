/**
 * Thin AWS entrypoint for the cleanup cron (WS-2 T2).
 *
 * EventBridge `rate(5 minutes)`. The work (and the single-fire lock) lives in
 * `lib/workers/cleanup-cron.ts`; this entrypoint wires the AWS-concrete
 * `CronLock` — `DynamoKvStore` over the `cron` namespace, whose on-the-wire
 * conditional PutItem has the same acquire/skip outcome as the old inline
 * `attribute_not_exists(pk) OR #ttl < :now` write (T2 behavior test).
 */

import { Logger } from "@aws-lambda-powertools/logger";
import { getKvStore } from "../lib/kv/kv-provider.js";
import { getLogger } from "../lib/logger.js";
import { makeKvCronLock } from "../lib/workers/cron-lock.js";
import { runCleanupCron } from "../lib/workers/cleanup-cron.js";

const logger = new Logger({ serviceName: "cleanup-cron" });

export const handler = async (): Promise<void> => {
  try {
    await runCleanupCron({
      logger: getLogger(),
      cronLock: makeKvCronLock(getKvStore("cron")),
    });
  } catch (err) {
    logger.error("Cleanup cron failed", { error: err });
    throw err;
  }
};
