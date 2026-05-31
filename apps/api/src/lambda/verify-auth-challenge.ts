import { timingSafeEqual, createHash } from "node:crypto";
import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE = process.env.DYNAMODB_TABLE!;

export const handler = async (event: any) => {
  const answer = event.request.challengeAnswer as string;
  const expected = event.request.privateChallengeParameters.token as string;

  const answerBuf = Buffer.from(answer);
  const expectedBuf = Buffer.from(expected);

  const correct =
    answerBuf.length === expectedBuf.length &&
    timingSafeEqual(answerBuf, expectedBuf);

  event.response.answerCorrect = correct;

  if (correct) {
    // S1.1 — Hash the token to compute the DynamoDB key (tokens are stored hashed)
    const tokenHash = createHash("sha256").update(expected).digest("hex");
    try {
      await dynamo.send(new DeleteItemCommand({
        TableName: TABLE,
        Key: {
          pk: { S: `magic-link:${tokenHash}` },
          sk: { S: "v" },
        },
      }));
    } catch (err) {
      console.error("Failed to delete magic link token", err);
    }
  }

  return event;
};
