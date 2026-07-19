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

import { S3Client } from "@aws-sdk/client-s3";
import { getLogger } from "../../api/src/lib/logger.js";
import { getLambdaPrisma } from "../../api/src/lib/lambda-prisma.js";
import { resolvePseudonymSecret } from "../../api/src/lib/services/user-data-deletion.js";
import { deleteStagingObjects } from "../../api/src/lib/media/staging-object-cleanup.js";
import { QueuePoller } from "./consumer.js";
import { makeDefaultSqsClient, makeSqsQueueClient } from "./sqs-queue-client.js";
import { buildDispatchTable, type WorkerQueueName } from "./workers.js";
import { validateRequiredSecrets } from "./startup-validation.js";

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
  logger.info("worker runtime started", {
    stage,
    queues: Object.keys(table),
  });

  // Minimal drain (T7c hardens this to the server.ts-mirrored sequence).
  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutdown requested — draining pollers", { signal });
    await Promise.allSettled(pollers.map((p) => p.stop()));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
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
