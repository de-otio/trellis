import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { marshall } from "@aws-sdk/util-dynamodb";
import { PrismaClient } from "@prisma/client";

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });
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

  // 3. Clean up expired security events
  try {
    const result = await db.securityEvent.deleteMany({
      where: {
        retentionUntil: { lte: new Date() },
      },
    });
    if (result.count > 0) {
      console.log(JSON.stringify({ level: "info", msg: "Expired security events cleaned", deleted: result.count }));
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Security event cleanup failed", error: String(err) }));
  }

  console.log(JSON.stringify({ level: "info", msg: "Hourly cron complete" }));
};
