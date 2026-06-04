import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { marshall } from "@aws-sdk/util-dynamodb";
import { PrismaClient } from "@prisma/client";
import {
  batchedPruneExpired,
  resolveInteractionEventConfig,
} from "../lib/graph/postgres/interaction-events.js";

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });
const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION });
const TABLE = process.env.DYNAMODB_TABLE!;

let prisma: PrismaClient | null = null;

async function getPrisma(): Promise<PrismaClient> {
  if (prisma) return prisma;
  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN! }));
  const { username, password, host, port, dbname } = JSON.parse(secret.SecretString!);
  prisma = new PrismaClient({
    datasources: { db: { url: `postgresql://${username}:${encodeURIComponent(password)}@${host}:${port}/${dbname}?connection_limit=1` } },
  });
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
    console.log(JSON.stringify({ level: "info", msg: "Hourly cron already running, skipping" }));
    return;
  }

  console.log(JSON.stringify({ level: "info", msg: "Hourly cron started" }));

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
      console.log(JSON.stringify({ level: "info", msg: "Stale media cleaned", deleted: result.count }));
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Stale media cleanup failed", error: String(err) }));
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
      console.log(JSON.stringify({ level: "info", msg: "Orphaned media soft-deleted", count: result.count }));
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Orphaned media cleanup failed", error: String(err) }));
  }

  const eventConfig = resolveInteractionEventConfig();

  // 3. Clean up expired security events (retentionUntil < now).
  //    Surveillance-hardening Phase 0 (P2): retrofitted from a single unbounded
  //    deleteMany to the SAME batched helper as InteractionEvent — a mass-expiry
  //    backlog on one deleteMany would lock the table.
  try {
    const now = new Date();
    const result = await batchedPruneExpired({
      findExpiredIds: async (take) => {
        const rows = await db.securityEvent.findMany({
          where: { retentionUntil: { lt: now } },
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
      console.log(JSON.stringify({ level: "info", msg: "Expired security events cleaned", deleted: result.deleted, circuitBreakerTripped: result.circuitBreakerTripped }));
    }
    await emitPruneMetrics("SecurityEvent", result, false);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Security event cleanup failed", error: String(err) }));
    await emitPruneMetrics("SecurityEvent", { deleted: 0, circuitBreakerTripped: false }, true);
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
      console.log(JSON.stringify({ level: "info", msg: "Expired interaction events pruned", deleted: result.deleted, circuitBreakerTripped: result.circuitBreakerTripped }));
    }
    await emitPruneMetrics("InteractionEvent", result, false);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Interaction event pruning failed", error: String(err) }));
    await emitPruneMetrics("InteractionEvent", { deleted: 0, circuitBreakerTripped: false }, true);
  }

  console.log(JSON.stringify({ level: "info", msg: "Hourly cron complete" }));
};

/**
 * Emit retention-pruning metrics to CloudWatch (Trellis/Retention namespace),
 * fail-open. `Pruned` counts deleted rows; `PruneFailed` flags an exception;
 * `PruneCircuitBreakerTripped` flags a drained-iteration-cap backlog — alarm on
 * the latter two so retention never silently stops.
 */
async function emitPruneMetrics(
  table: "SecurityEvent" | "InteractionEvent",
  result: { deleted: number; circuitBreakerTripped: boolean },
  failed: boolean,
): Promise<void> {
  try {
    const timestamp = new Date();
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: "Trellis/Retention",
        MetricData: [
          { MetricName: "Pruned", Value: result.deleted, Unit: "Count", Timestamp: timestamp, Dimensions: [{ Name: "Table", Value: table }] },
          { MetricName: "PruneFailed", Value: failed ? 1 : 0, Unit: "Count", Timestamp: timestamp, Dimensions: [{ Name: "Table", Value: table }] },
          { MetricName: "PruneCircuitBreakerTripped", Value: result.circuitBreakerTripped ? 1 : 0, Unit: "Count", Timestamp: timestamp, Dimensions: [{ Name: "Table", Value: table }] },
        ],
      }),
    );
  } catch (cwErr) {
    console.error(JSON.stringify({ level: "error", msg: "Retention metrics emit failed", table, error: String(cwErr) }));
  }
}
