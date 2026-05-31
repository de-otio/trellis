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
    console.log(JSON.stringify({ level: "info", msg: "Maintenance cron already running, skipping" }));
    return;
  }

  console.log(JSON.stringify({ level: "info", msg: "Maintenance cron started" }));

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
          console.log(JSON.stringify({ level: "info", msg: "Stale cron lock removed", lock: pk }));
        }
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Stale lock cleanup failed", error: String(err) }));
  }

  // 3. Vacuum analyze critical tables (via advisory lock to prevent concurrent runs)
  try {
    await db.$executeRaw`SELECT pg_advisory_lock(42)`;
    try {
      await db.$executeRawUnsafe("ANALYZE users");
      await db.$executeRawUnsafe("ANALYZE posts");
      await db.$executeRawUnsafe("ANALYZE media_files");
      await db.$executeRawUnsafe("ANALYZE follows");
      console.log(JSON.stringify({ level: "info", msg: "ANALYZE completed on critical tables" }));
    } finally {
      await db.$executeRaw`SELECT pg_advisory_unlock(42)`;
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "ANALYZE failed", error: String(err) }));
  }

  console.log(JSON.stringify({ level: "info", msg: "Maintenance cron complete" }));
};
