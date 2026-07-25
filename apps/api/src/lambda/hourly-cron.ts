/**
 * Thin AWS entrypoint for the hourly cron (WS-2 T3a).
 *
 * EventBridge `rate(1 hour)`. The work lives in `lib/workers/hourly-cron.ts`;
 * this entrypoint wires the AWS concretes: Prisma via `getLambdaPrisma`, the
 * `cron`-namespace `DynamoKvStore` CronLock, and the EMF MetricsPort adapter
 * (Trellis/Retention namespace — keeps the `PruneFailed` /
 * `PruneCircuitBreakerTripped` alarms byte-identical).
 */

import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics } from "@aws-lambda-powertools/metrics";
import { getLambdaPrisma as getPrisma } from "../lib/lambda-prisma.js";
import { getKvStore } from "../lib/kv/kv-provider.js";
import { getLogger } from "../lib/logger.js";
import { makeKvCronLock } from "../lib/workers/cron-lock.js";
import { runHourlyCron } from "../lib/workers/hourly-cron.js";
import { makeEmfMetricsPort } from "./emf-metrics-adapter.js";

const logger = new Logger({ serviceName: "hourly-cron" });
const metrics = new Metrics({
  namespace: "Trellis/Retention",
  serviceName: "hourly-cron",
});

export const handler = async (): Promise<void> => {
  try {
    await runHourlyCron({
      getDb: () => getPrisma(),
      logger: getLogger(),
      metrics: makeEmfMetricsPort(metrics),
      cronLock: makeKvCronLock(getKvStore("cron")),
      clock: Date.now,
      configSource: process.env,
    });
  } catch (err) {
    logger.error("Hourly cron failed", { error: err });
    throw err;
  }
};
