import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { getSecret } from "@aws-lambda-powertools/parameters/secrets";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  batchedPruneExpired,
  resolveInteractionEventConfig,
} from "../lib/graph/postgres/interaction-events.js";

// AWS Lambda Powertools: structured logging (auto request-id/cold-start
// context), EMF metrics (no PutMetricData API call), and cached + KMS-decrypted
// Secrets Manager access. ECS uses the parallel toolchain (pino getLogger +
// foundation secret resolver); Powertools is Lambda-only.
const logger = new Logger({ serviceName: "hourly-cron" });
const metrics = new Metrics({
  namespace: "Trellis/Retention",
  serviceName: "hourly-cron",
});

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE = process.env.DYNAMODB_TABLE!;

let prisma: PrismaClient | null = null;

interface DbSecret {
  username: string;
  password: string;
  host: string;
  port: string | number;
  dbname: string;
}

async function getPrisma(): Promise<PrismaClient> {
  if (prisma) return prisma;
  // getSecret caches + KMS-decrypts; transform:"json" parses the secret value.
  const { username, password, host, port, dbname } = (await getSecret(
    process.env.DB_SECRET_ARN!,
    { transform: "json" },
  )) as unknown as DbSecret;
  // Prisma 7 removed the `datasources` constructor option; the connection URL
  // is now supplied via a driver adapter.
  const adapter = new PrismaPg({
    connectionString: `postgresql://${username}:${encodeURIComponent(password)}@${host}:${port}/${dbname}?connection_limit=1`,
  });
  prisma = new PrismaClient({ adapter });
  return prisma;
}

export const handler = async (): Promise<void> => {
  const now = Math.floor(Date.now() / 1000);

  // Acquire cron lock (prevent overlapping executions)
  try {
    await dynamo.send(new PutItemCommand({
      TableName: TABLE,
      Item: marshall({
        pk: "cron:hourly",
        sk: "lock",
        ttl: now + 3600, // 1 hour TTL
        lockedAt: now,
      }),
      ConditionExpression: "attribute_not_exists(pk) OR #ttl < :now",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: marshall({ ":now": now }),
    }));
  } catch {
    logger.info("Hourly cron already running, skipping");
    return;
  }

  logger.info("Hourly cron started");

  const db = await getPrisma();

  // 1. Clean up stale PENDING/FAILED media records (older than 1 hour)
  try {
    const oneHourAgo = new Date(Date.now() - 3600000);
    const staleMedia = await db.mediaFile.findMany({
      where: {
        uploadStatus: { in: ["PENDING", "FAILED"] },
        createdAt: { lt: oneHourAgo },
      },
      take: 100,
      select: { id: true },
    });

    if (staleMedia.length > 0) {
      const result = await db.mediaFile.deleteMany({
        where: { id: { in: staleMedia.map((m) => m.id) } },
      });
      logger.info("Stale media cleaned", { deleted: result.count });
    }
  } catch (err) {
    logger.error("Stale media cleanup failed", { error: err });
  }

  // 2. Soft-delete orphaned media past 24h grace period
  try {
    const gracePeriodCutoff = new Date(Date.now() - 24 * 3600000);
    const result = await db.mediaFile.updateMany({
      where: {
        attachedToPost: false,
        orphanedAt: { lte: gracePeriodCutoff },
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    if (result.count > 0) {
      logger.info("Orphaned media soft-deleted", { count: result.count });
    }
  } catch (err) {
    logger.error("Orphaned media cleanup failed", { error: err });
  }

  const eventConfig = resolveInteractionEventConfig();

  // 3. Clean up expired security events (retentionUntil < now).
  //    Surveillance-hardening Phase 0 (P2): retrofitted from a single unbounded
  //    deleteMany to the SAME batched helper as InteractionEvent — a mass-expiry
  //    backlog on one deleteMany would lock the table.
  try {
    const cutoff = new Date();
    const result = await batchedPruneExpired({
      findExpiredIds: async (take) => {
        const rows = await db.securityEvent.findMany({
          where: { retentionUntil: { lt: cutoff } },
          select: { id: true },
          take,
        });
        return rows.map((r) => r.id);
      },
      deleteByIds: async (ids) => {
        const res = await db.securityEvent.deleteMany({ where: { id: { in: ids } } });
        return res.count;
      },
      batchSize: eventConfig.pruneBatchSize,
      maxIterations: eventConfig.pruneMaxIterations,
    });
    if (result.deleted > 0 || result.circuitBreakerTripped) {
      logger.info("Expired security events cleaned", { deleted: result.deleted, circuitBreakerTripped: result.circuitBreakerTripped });
    }
    emitPruneMetrics("SecurityEvent", result, false);
  } catch (err) {
    logger.error("Security event cleanup failed", { error: err });
    emitPruneMetrics("SecurityEvent", { deleted: 0, circuitBreakerTripped: false }, true);
  }

  // 4. Prune expired InteractionEvent rows (expiresAt < now), batched with a
  //    circuit breaker (Surveillance-hardening Phase 0, P2). Silent retention
  //    failure converts the behavioral log into the unbounded surveillance
  //    asset the threat model forbids — so prune failure / a tripped breaker
  //    raises a CloudWatch metric to alarm on.
  try {
    const { InteractionEventOps } = await import("../lib/graph/postgres/interaction-events.js");
    const ops = new InteractionEventOps(db, eventConfig);
    const result = await ops.prune(new Date());
    if (result.deleted > 0 || result.circuitBreakerTripped) {
      logger.info("Expired interaction events pruned", { deleted: result.deleted, circuitBreakerTripped: result.circuitBreakerTripped });
    }
    emitPruneMetrics("InteractionEvent", result, false);
  } catch (err) {
    logger.error("Interaction event pruning failed", { error: err });
    emitPruneMetrics("InteractionEvent", { deleted: 0, circuitBreakerTripped: false }, true);
  }

  // All retention metrics are emitted per-table via singleMetric() (immediate
  // EMF), so there's nothing buffered on `metrics` to publish here.
  logger.info("Hourly cron complete");
};

/**
 * Emit retention-pruning metrics as EMF (Trellis/Retention namespace), fail-
 * open. `Pruned` counts deleted rows; `PruneFailed` flags an exception;
 * `PruneCircuitBreakerTripped` flags a drained-iteration-cap backlog — alarm on
 * the latter two so retention never silently stops. A per-table `singleMetric`
 * isolates the `Table` dimension so the two tables don't cross-contaminate.
 */
function emitPruneMetrics(
  table: "SecurityEvent" | "InteractionEvent",
  result: { deleted: number; circuitBreakerTripped: boolean },
  failed: boolean,
): void {
  try {
    const m = metrics.singleMetric();
    m.addDimension("Table", table);
    m.addMetric("Pruned", MetricUnit.Count, result.deleted);
    m.addMetric("PruneFailed", MetricUnit.Count, failed ? 1 : 0);
    m.addMetric("PruneCircuitBreakerTripped", MetricUnit.Count, result.circuitBreakerTripped ? 1 : 0);
  } catch (err) {
    logger.error("Retention metrics emit failed", { table, error: err });
  }
}
