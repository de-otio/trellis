import {
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE = process.env.DYNAMODB_TABLE!;

export const handler = async () => {
  const { Items } = await dynamo.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(pk, :prefix)",
      ExpressionAttributeValues: {
        ":prefix": { S: "feature-toggle:" },
      },
    }),
  );

  const flags = (Items ?? []).map((item) => ({
    name: item.pk?.S?.replace("feature-toggle:", "") ?? "unknown",
    enabled: item.enabled?.BOOL ?? false,
    updatedAt: item.updatedAt?.S ?? null,
  }));

  return { flags };
};
