import type { PreSignUpTriggerEvent, PreSignUpTriggerHandler } from "aws-lambda";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE = process.env.DYNAMODB_TABLE!;

export const handler: PreSignUpTriggerHandler = async (event) => {
  const invitationCode = (event.request.userAttributes["custom:invitationCode"] ||
                          event.request.clientMetadata?.invitationCode) as string | undefined;

  if (!invitationCode) {
    throw new Error("An invitation code is required to register.");
  }

  // Check invitation code in DynamoDB
  const result = await dynamo.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: `invitations:${invitationCode}`, sk: "v" }),
  }));

  if (!result.Item) {
    throw new Error("Invalid or expired invitation code.");
  }

  const invitation = unmarshall(result.Item);
  if (invitation.used) {
    throw new Error("This invitation code has already been used.");
  }
  if (invitation.ttl && invitation.ttl < Math.floor(Date.now() / 1000)) {
    throw new Error("This invitation code has expired.");
  }

  // Auto-confirm and auto-verify for invited users
  event.response.autoConfirmUser = false;
  event.response.autoVerifyEmail = false;

  return event;
};
