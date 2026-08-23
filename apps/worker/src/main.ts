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

import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { createDefaultS3Client } from "@de-otio/saas-foundation/storage";
import { getLogger } from "../../api/src/lib/logger.js";
import {
  getLambdaPrisma,
  resolveDbConnectionString,
} from "../../api/src/lib/lambda-prisma.js";
import { buildSqsUrl } from "../../api/src/lib/sqs-url.js";
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
import { makeIdentityAdminPort } from "../../api/src/lib/identity/identity-provider.js";
import { makeEmailPortFromEnv } from "../../api/src/lib/workers/deletion-email-port.js";
import { assertNightlyPortsWired } from "../../api/src/lib/workers/nightly-ports-guard.js";
import { QueuePoller } from "./consumer.js";
import { makeDefaultSqsClient, makeSqsQueueClient } from "./sqs-queue-client.js";
import { buildDispatchTable, type WorkerQueueName } from "./workers.js";
import { validateRequiredSecrets } from "./startup-validation.js";
import { CronScheduler } from "./scheduler.js";
import { buildCronJobs, type WorkerProfile } from "./cron-jobs.js";
import { startHealthServer } from "./health.js";
import { closeDefaultResources, installShutdownHandlers } from "./shutdown.js";
import { startHatchetHost } from "./hatchet.js";

const stage = process.env.STAGE || "dev";

/** Same URL convention as `env.ts`'s `sqsUrl` — both delegate to the shared
 *  builder so they honour SQS_QUEUE_URL_PREFIX (the real Scaleway MNQ queue
 *  names) and cannot drift. */
function queueUrl(queueName: string): string {
  return buildSqsUrl(queueName, stage);
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

  // Built through the foundation factory, not `new S3Client(...)` directly.
  // Region alone is not enough off-AWS: the SDK reads ONE ambient
  // AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY pair for every service, and on a
  // non-AWS object store that pair legitimately belongs to the queue service.
  // The factory resolves the storage-specific S3_* pair (and the endpoint)
  // instead, so a delete here is authorized rather than silently 403-ing into
  // the purge's retry path.
  const s3 = createDefaultS3Client();
  const mediaBucket = process.env.MEDIA_BUCKET_NAME ?? "";

  // Federation is fail-closed OFF by default (ACTIVITYPUB_ENABLED). When off,
  // the federation-outbox queue is not provisioned (e.g. Scaleway MNQ), so its
  // poller is skipped below — starting it would 404-loop against a missing queue.
  const federationEnabled = process.env.ACTIVITYPUB_ENABLED === "true";

  // GDPR-deletion ports, resolved ONCE and shared by both deletion paths (the
  // immediate `delete-account` queue consumer AND the scheduled nightly cron).
  // Both are provider-neutral (IDENTITY_PROVIDER / EMAIL_SERVICE selectors):
  //   - identity: makeIdentityAdminPort() ⇒ Keycloak on Scaleway, Cognito on
  //     AWS; undefined only when unconfigured (core then skips external-identity
  //     deletion). Wiring it here fixes the previously-unwired queue path too.
  //   - email: the configured provider (scaleway-tem / aws-ses / …) adapted to
  //     the completion-email port; undefined ⇒ no confirmation send.
  const identity = makeIdentityAdminPort();
  const email = makeEmailPortFromEnv();

  // Deploy-time cron gate (D2-A): WORKER_DISABLED_CRONS is a comma-separated
  // list of cron names to omit. Resolved here so the nightly-ports guard below
  // can key off whether the scheduled deletion cron will actually run.
  const disabledJobs = new Set(
    (process.env.WORKER_DISABLED_CRONS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // Fail closed BEFORE starting anything: an enabled nightly cron with an
  // unwired identity port would silently under-delete (DB erased, external
  // identity retained). See nightly-ports-guard.ts.
  assertNightlyPortsWired({
    nightlyEnabled: !disabledJobs.has("nightly"),
    identity,
    email,
    logger,
  });

  const table = buildDispatchTable({
    logger,
    deleteAccount: {
      getDb: () => getLambdaPrisma(),
      // LAZY at-use resolution (finding 4) — never resolved onto a context.
      resolvePseudonymSecret: () => resolvePseudonymSecret(),
      deleteStagingObjects: (keys) => deleteStagingObjects(s3, mediaBucket, keys),
      // IdentityAdminPort (WS-3.3): provider-neutral, resolved above. Ensures
      // the immediate delete-account path also removes the external identity.
      identity,
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
    federationEnabled,
  });

  const sqsClient = makeDefaultSqsClient();
  const pollers: QueuePoller[] = [];
  for (const [name, worker] of Object.entries(table) as Array<
    [WorkerQueueName, (typeof table)[WorkerQueueName]]
  >) {
    // Skip the federation-outbox poller when federation is disabled — the queue
    // is not provisioned then, so polling it just 404-loops. (The handler's
    // off-branch drain only matters when the queue actually exists.)
    if (name === "federation-outbox" && !federationEnabled) continue;
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
    // The KV entries table lives in the SAME Postgres as the app data, so when
    // no explicit KV url is set fall back to the resolved app-DB connection
    // string (decomposed DB_SECRET_* / DB_SECRET_ARN — the same source
    // getLambdaPrisma used above). Avoids a redundant composed-URL secret and
    // keeps ONE DB-credential source across the container. The db-secret gate
    // above already proved this resolves, so the fallback cannot fail here.
    const kvUrl =
      process.env.KV_DATABASE_URL ||
      process.env.DATABASE_URL ||
      (await resolveDbConnectionString(false));
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
        identity, // WS-3.3 IdentityProviderPort (provider-neutral, resolved above)
        email, // WS-5 completion-email port (configured provider, resolved above)
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
      // Deploy-time cron gate (resolved above): WORKER_DISABLED_CRONS is a
      // comma-separated list of cron names to omit. Queue consumers are
      // unaffected. Empty/unset = all crons scheduled.
      disabledJobs,
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

  // ── Hatchet evaluation host (plan 030, Lane B). Returns null unless
  // HATCHET_ENABLED === "true", so this line is inert on every deployment that
  // has not opted in. It is started AFTER the real pollers and scheduler so a
  // failure here can never delay them, and it is deliberately not awaited into
  // the startup gate: the evaluation must not be able to crash-loop the worker.
  const hatchetHost = await startHatchetHost(logger).catch((err) => {
    logger.error("hatchet evaluation host failed to start — continuing without it", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (hatchetHost) void hatchetHost.worker.start();

  // ── Graceful drain (T7c, §3.5): scheduler → pollers (bounded) → pools.
  installShutdownHandlers({
    scheduler,
    pollers,
    drainTimeoutMs: Number(process.env.WORKER_DRAIN_TIMEOUT_MS || 25_000),
    logger,
    closeResources: async () => {
      // Stop the evaluation worker first — it is the least important thing
      // running and the most likely to be wedged.
      if (hatchetHost) {
        await hatchetHost.worker.stop().catch(() => {
          logger.warn("hatchet evaluation host did not stop cleanly — ignoring");
        });
      }
      await closeDefaultResources(logger);
    },
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
