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

  // Auto-confirm and auto-verify invited users.
  //
  // Registration is passwordless (magic-link CUSTOM_AUTH). An UNCONFIRMED user
  // cannot initiate that flow, so without auto-confirm an invited sign-up would
  // create an account that can never sign in. This is safe because:
  //   - entry is already gated by a single-use invitation code (checked above);
  //   - access still requires answering the magic-link challenge, i.e. receiving
  //     and clicking a link sent to this exact address — the link, not this
  //     flag, is the real proof of email ownership and the access gate.
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;

  return event;
};
