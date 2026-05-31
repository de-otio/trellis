import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const RUNTIME_ID = process.env.RUNTIME_ID!;
const TABLE = process.env.DYNAMODB_TABLE!;
const MAX_DAILY = parseInt(process.env.MAX_DAILY_INVOCATIONS ?? "50", 10);
const COOLDOWN_SECONDS = parseInt(process.env.COOLDOWN_SECONDS ?? "300", 10);

function sanitizeAlarmName(raw: string): string {
  // Truncate to 256 chars and strip non-printable characters
  return raw.slice(0, 256).replace(/[^\x20-\x7E]/g, "");
}

function getDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function checkCooldown(alarmName: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: `diag-cooldown:${alarmName}` },
          sk: { S: "v" },
          ttl: { N: String(now + COOLDOWN_SECONDS) },
          createdAt: { N: String(now) },
        },
        ConditionExpression: "attribute_not_exists(pk) OR #t < :now",
        ExpressionAttributeNames: { "#t": "ttl" },
        ExpressionAttributeValues: { ":now": { N: String(now) } },
      }),
    );
    return true; // cooldown acquired, OK to proceed
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") {
      return false; // still in cooldown
    }
    throw err;
  }
}

async function incrementDailyCounter(): Promise<number> {
  const dateKey = getDateKey();
  const ttl = Math.floor(Date.now() / 1000) + 86400 * 2; // 2-day TTL for cleanup

  const result = await dynamo.send(
    new UpdateItemCommand({
      TableName: TABLE,
      Key: {
        pk: { S: `diag-daily:${dateKey}` },
        sk: { S: "v" },
      },
      UpdateExpression: "SET #c = if_not_exists(#c, :zero) + :one, #t = :ttl",
      ExpressionAttributeNames: { "#c": "count", "#t": "ttl" },
      ExpressionAttributeValues: {
        ":zero": { N: "0" },
        ":one": { N: "1" },
        ":ttl": { N: String(ttl) },
      },
      ReturnValues: "ALL_NEW",
    }),
  );

  return parseInt(result.Attributes?.count?.N ?? "1", 10);
}

export const handler = async (event: { Records: any[] }) => {
  for (const record of event.Records) {
    const snsMessage = record.Sns?.Message;
    if (!snsMessage) continue;

    let alarm: any;
    try {
      alarm = JSON.parse(snsMessage);
    } catch {
      console.warn("Failed to parse SNS message as JSON, skipping");
      continue;
    }

    // Only act on ALARM state transitions
    if (alarm.NewStateValue !== "ALARM") {
      console.log(`Skipping non-ALARM state: ${alarm.NewStateValue}`);
      continue;
    }

    const rawAlarmName = alarm.AlarmName ?? "unknown";
    const alarmName = sanitizeAlarmName(rawAlarmName);

    // Per-alarm cooldown
    const cooldownOk = await checkCooldown(alarmName);
    if (!cooldownOk) {
      console.log(`Alarm "${alarmName}" is in cooldown, skipping`);
      continue;
    }

    // Daily invocation cap
    const dailyCount = await incrementDailyCounter();
    if (dailyCount > MAX_DAILY) {
      console.warn(`Daily cap reached (${dailyCount}/${MAX_DAILY}), skipping`);
      continue;
    }

    // Invoke the Bedrock AgentCore runtime
    // TODO: Replace with exact SDK call once @aws-sdk/client-bedrock-agentcore is available.
    // The InvokeAgentRuntime API shape may differ from the placeholder below.
    try {
      const { BedrockAgentRuntimeClient, InvokeAgentCommand } = await import(
        "@aws-sdk/client-bedrock-agent-runtime"
      );
      const agentClient = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION });
      await agentClient.send(
        new InvokeAgentCommand({
          agentId: RUNTIME_ID,
          agentAliasId: "TSTALIASID",
          sessionId: `diag-${alarmName}-${Date.now()}`,
          inputText: JSON.stringify({
            alarmName,
            alarmDescription: alarm.AlarmDescription ?? "",
            newStateReason: alarm.NewStateReason ?? "",
            stateChangeTime: alarm.StateChangeTime ?? "",
            trigger: alarm.Trigger ?? {},
          }),
        }),
      );
      console.log(`Invoked agent for alarm "${alarmName}"`);
    } catch (err) {
      console.error(`Failed to invoke agent for alarm "${alarmName}"`, err);
      throw err;
    }
  }

  return { processed: event.Records.length };
};
