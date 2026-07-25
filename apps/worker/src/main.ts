/**
 * main.ts — worker-container composition root (WS-2 T7a increment).
 *
 * Scope of this increment: startup secret validation (finding 2) + queue
 * pollers with the finding-3 dispatch/ack semantics. The in-process cron
 * scheduler (T7b) and the hardened health server / graceful drain /
 * per-queue tuning (T7c) land in the next increments — `shutdown()` here is
 * the minimal at-least-once-safe drain the pollers already support.
 *
 * This runtime is deployed on the SCALEWAY profile only; AWS keeps
 * EventBridge + Lambda. Provider selection (SQS_ENDPOINT, KV_PROVIDER, …)
 * arrives via env exactly as for the API — this file is the ONE place in
 * apps/worker that reads process.env.
 */

import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getLogger } from "../../api/src/lib/logger.js";
import { getLambdaPrisma } from "../../api/src/lib/lambda-prisma.js";
import { resolvePseudonymSecret } from "../../api/src/lib/services/user-data-deletion.js";
import { deleteStagingObjects } from "../../api/src/lib/media/staging-object-cleanup.js";
import {
  getKvStore,
  makeKvSqlExecutor,
  setKvSqlExecutor,
  getKvSqlExecutor,
  resolveKvProvider,
} from "../../api/src/lib/kv/kv-provider.js";
import { makeKvCronLock } from "../../api/src/lib/workers/cron-lock.js";
import { noopMetrics } from "../../api/src/lib/workers/metrics-port.js";
import { QueuePoller } from "./consumer.js";
import { makeDefaultSqsClient, makeSqsQueueClient } from "./sqs-queue-client.js";
import { buildDispatchTable, type WorkerQueueName } from "./workers.js";
import { validateRequiredSecrets } from "./startup-validation.js";
import { CronScheduler } from "./scheduler.js";
import { buildCronJobs, type WorkerProfile } from "./cron-jobs.js";
import { startHealthServer } from "./health.js";
import { closeDefaultResources, installShutdownHandlers } from "./shutdown.js";

const stage = process.env.STAGE || "dev";

/** Same URL convention as `env.ts`'s `sqsUrl` (SQS_ENDPOINT-overridable). */
function queueUrl(queueName: string): string {
  const base =
    process.env.SQS_ENDPOINT ||
    `https://sqs.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com`;
  const accountId = process.env.AWS_ACCOUNT_ID || "000000000000";
  return `${base}/${accountId}/${stage}-${queueName}`;
}

/** Per-queue concurrency budget (§3.6: media low — transcode is heavy). */
const CONCURRENCY: Record<WorkerQueueName, number> = {
  "delete-account": 2,
  "media-processing": 2,
  "media-completion": 2,
  "link-check": 1,
  "followers-events": 1,
  "federation-outbox": 1,
  "user-export": 1,
};

async function main(): Promise<void> {
  const logger = getLogger();

  // ── Fail-closed startup gate (finding 2, §3.1): refuse to start without
  // the DB secret and the pseudonym tombstone HMAC key. Values are proven
  // present and DISCARDED — nothing is retained on any context.
  await validateRequiredSecrets(
    [
      {
        name: "db-secret",
        resolve: async () => {
          // Presence proof: the Prisma factory resolves the DB secret; a
          // successful client build implies a non-empty credential set.
          await getLambdaPrisma();
          return "ok";
        },
      },
      { name: "pseudonym-tombstone-key", resolve: () => resolvePseudonymSecret() },
    ],
    logger,
  );

  const s3 = new S3Client({ region: process.env.AWS_REGION });
  const mediaBucket = process.env.MEDIA_BUCKET_NAME ?? "";

  const table = buildDispatchTable({
    logger,
    deleteAccount: {
      getDb: () => getLambdaPrisma(),
      // LAZY at-use resolution (finding 4) — never resolved onto a context.
      resolvePseudonymSecret: () => resolvePseudonymSecret(),
      deleteStagingObjects: (keys) => deleteStagingObjects(s3, mediaBucket, keys),
      // IdentityAdminPort: wired by the consuming deployment (WS-3.3 will
      // supply the provider-neutral impl; Cognito-backed until then).
      identity: undefined,
    },
    media: {
      // Completion deps are injected by the consuming deployment at startup
      // (setMediaProcessingDeps + a CompletionDeps bag). Absent ⇒ the media
      // workers fail closed (throw → no-ack), never silently drop.
      completionDeps: undefined,
    },
    // T11 (finding 9): the PII-schema-bearing export worker is injected from
    // the PRIVATE consuming package; un-wired ⇒ the queue fails closed.
    exportWorker: undefined,
    federationEnabled: process.env.ACTIVITYPUB_ENABLED === "true",
  });

  const sqsClient = makeDefaultSqsClient();
  const pollers: QueuePoller[] = [];
  for (const [name, worker] of Object.entries(table) as Array<
    [WorkerQueueName, (typeof table)[WorkerQueueName]]
  >) {
    const poller = new QueuePoller(
      makeSqsQueueClient(sqsClient, { queueUrl: queueUrl(name) }),
      worker,
      { queueName: name, concurrency: CONCURRENCY[name], logger },
    );
    poller.start();
    pollers.push(poller);
  }
  // ── Cron scheduler (T7b): the six cadences; single-fire lives INSIDE the
  // cores via CronLock over WS-1's KvStore (`cron` namespace). Profile:
  // KV_PROVIDER=postgres ⇒ scaleway (PostgresKvStore + kv-entries-cleanup);
  // default ⇒ aws-shaped wiring (DynamoKvStore; no kv sweep). Note the
  // container itself is only DEPLOYED on the Scaleway profile — the aws
  // wiring exists so CI can run it against LocalStack (§3.1).
  const profile: WorkerProfile = resolveKvProvider() === "postgres" ? "scaleway" : "aws";
  if (profile === "scaleway" && getKvSqlExecutor() === undefined) {
    const kvUrl = process.env.KV_DATABASE_URL || process.env.DATABASE_URL;
    if (!kvUrl) {
      throw new Error("KV_PROVIDER=postgres requires KV_DATABASE_URL or DATABASE_URL");
    }
    setKvSqlExecutor(await makeKvSqlExecutor(kvUrl));
  }
  const cronKv = getKvStore("cron");
  const cronLock = makeKvCronLock(cronKv);
  const clock = Date.now;
  const getDb = (): ReturnType<typeof getLambdaPrisma> => getLambdaPrisma();
  const lazyPseudonym = (): Promise<string> => resolvePseudonymSecret();
  const stagingCleanup = (keys: string[]): ReturnType<typeof deleteStagingObjects> =>
    deleteStagingObjects(s3, mediaBucket, keys);

  const scheduler = new CronScheduler(
    buildCronJobs({
      profile,
      logger,
      cleanup: { logger, cronLock },
      hourly: {
        getDb,
        logger,
        metrics: noopMetrics, // OTel/Cockpit adapter arrives with WS-5
        cronLock,
        clock,
        configSource: process.env,
      },
      nightly: {
        getDb,
        logger,
        metrics: noopMetrics,
        cronLock,
        clock,
        identity: undefined, // WS-3.3 IdentityProviderPort
        email: undefined, // WS-5 email-provider factory
        resolvePseudonymSecret: lazyPseudonym,
        deleteStagingObjects: stagingCleanup,
        objectStore: {
          deleteObjects: async (keys) => {
            await s3.send(
              new DeleteObjectsCommand({
                Bucket: mediaBucket,
                Delete: { Objects: keys.map((Key) => ({ Key })) },
              }),
            );
          },
        },
        getAppEnv: async () => {
          const { buildEnv } = await import("../../api/src/env.js");
          return buildEnv();
        },
      },
      maintenance: { getDb, logger, cronLock, cronKv, clock },
      // e2e-sweeper: only wired where an identity directory exists (AWS/e2e
      // stages via Lambda today; container wiring arrives with WS-3.3).
      e2eSweeper: undefined,
      kvSweep:
        profile === "scaleway"
          ? { executor: getKvSqlExecutor()!, cronLock, clock }
          : undefined,
    }),
    { logger },
  );
  scheduler.start();

  // ── Health endpoint (T7c, finding 10): fixed-body, loopback/internal
  // bind only. WORKER_HEALTH_HOST exists for pod-internal binds (e.g.
  // 0.0.0.0 inside an isolated pod network) — WS-4 must NOT route it
  // publicly (verified in T8's wiring inputs).
  startHealthServer({
    host: process.env.WORKER_HEALTH_HOST || "127.0.0.1",
    port: Number(process.env.WORKER_HEALTH_PORT || 8081),
    isReady: async () => {
      // Ready = pollers exist and the DB answers. Any probe error ⇒ unready
      // (logged, never echoed).
      const db = await getLambdaPrisma();
      await db.$queryRaw`SELECT 1`;
      return pollers.length > 0;
    },
    logger,
  });

  // ── Graceful drain (T7c, §3.5): scheduler → pollers (bounded) → pools.
  installShutdownHandlers({
    scheduler,
    pollers,
    drainTimeoutMs: Number(process.env.WORKER_DRAIN_TIMEOUT_MS || 25_000),
    logger,
    closeResources: () => closeDefaultResources(logger),
  });

  logger.info("worker runtime started", {
    stage,
    profile,
    queues: Object.keys(table),
  });
}

// Only run when executed directly (not when imported by tests).
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isDirectRun) {
  main().catch((err) => {
    // Startup failure (incl. the finding-2 gate): exit non-zero so the
    // orchestrator crash-loops and alarms.
    console.error("worker startup failed:", err);
    process.exit(1);
  });
}

export { main };
