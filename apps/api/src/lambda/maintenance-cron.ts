import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Logger } from "@aws-lambda-powertools/logger";
import { getSecret } from "@aws-lambda-powertools/parameters/secrets";

const logger = new Logger({ serviceName: "maintenance-cron" });

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE = process.env.DYNAMODB_TABLE!;

let prisma: PrismaClient | null = null;

async function getPrisma(): Promise<PrismaClient> {
  if (prisma) return prisma;
  const { username, password, host, port, dbname } = (await getSecret(process.env.DB_SECRET_ARN!, { transform: "json" })) as unknown as {
    username: string;
    password: string;
    host: string;
    port: string | number;
    dbname: string;
  };
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

  // Acquire cron lock
  try {
    await dynamo.send(new PutItemCommand({
      TableName: TABLE,
      Item: marshall({
        pk: "cron:maintenance",
        sk: "lock",
        ttl: now + 3600,
        lockedAt: now,
      }),
      ConditionExpression: "attribute_not_exists(pk) OR #ttl < :now",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: marshall({ ":now": now }),
    }));
  } catch {
    logger.info("Maintenance cron already running, skipping");
    return;
  }

  logger.info("Maintenance cron started");

  const db = await getPrisma();

  // 1. Follow counts removed — relationships now live in graph DB (AuraDB)
  // TODO: Add graph-side consistency check when reconciliation service is wired up

  // 2. Clean up stale DynamoDB cron locks (safety net)
  try {
    const lockKeys = ["cron:hourly", "cron:nightly", "cron:maintenance", "cron:cleanup"];
    for (const pk of lockKeys) {
      const { GetItemCommand } = await import("@aws-sdk/client-dynamodb");
      const { unmarshall } = await import("@aws-sdk/util-dynamodb");
      const result = await dynamo.send(new GetItemCommand({
        TableName: TABLE,
        Key: marshall({ pk, sk: "lock" }),
      }));
      if (result.Item) {
        const item = unmarshall(result.Item);
        // If lock is older than 2 hours, it's stale — delete it
        if (item.lockedAt && item.lockedAt < now - 7200) {
          const { DeleteItemCommand } = await import("@aws-sdk/client-dynamodb");
          await dynamo.send(new DeleteItemCommand({
            TableName: TABLE,
            Key: marshall({ pk, sk: "lock" }),
          }));
          logger.info("Stale cron lock removed", { lock: pk });
        }
      }
    }
  } catch (err) {
    logger.error("Stale lock cleanup failed", { error: err });
  }

  // 3. Vacuum analyze critical tables (via advisory lock to prevent concurrent runs)
  try {
    await db.$executeRaw`SELECT pg_advisory_lock(42)`;
    try {
      await db.$executeRawUnsafe("ANALYZE users");
      await db.$executeRawUnsafe("ANALYZE posts");
      await db.$executeRawUnsafe("ANALYZE media_files");
      await db.$executeRawUnsafe("ANALYZE follows");
      logger.info("ANALYZE completed on critical tables");
    } finally {
      await db.$executeRaw`SELECT pg_advisory_unlock(42)`;
    }
  } catch (err) {
    logger.error("ANALYZE failed", { error: err });
  }

  logger.info("Maintenance cron complete");
};
