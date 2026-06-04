import { randomBytes, createHash } from "node:crypto";
import { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "create-auth-challenge" });

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const ses = new SESClient({ region: process.env.SES_REGION || process.env.AWS_REGION });
const TABLE = process.env.DYNAMODB_TABLE!;
const DOMAIN = process.env.DOMAIN!;

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 900; // 15 minutes

export const handler = async (event: any) => {
  const email = event.request.userAttributes?.email;
  if (!email) {
    throw new Error("Email attribute is required for magic link authentication");
  }
  const now = Math.floor(Date.now() / 1000);

  // Bot protection is handled by AWS WAF at the infrastructure layer.
  // Rate limiting below is defence-in-depth at the application level.
  const ratePk = `magic-rate:${email}`;
  try {
    const rateResult = await dynamo.send(new GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: ratePk }, sk: { S: "v" } },
    }));

    if (rateResult.Item) {
      const count = parseInt(rateResult.Item.count?.N || "0", 10);
      const ttl = parseInt(rateResult.Item.ttl?.N || "0", 10);
      if (count >= RATE_LIMIT_MAX && ttl > now) {
        throw new Error("RATE_LIMIT_EXCEEDED: Too many magic link requests. Please wait before trying again.");
      }
    }

    // Increment or create rate limit counter
    await dynamo.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: ratePk }, sk: { S: "v" } },
      UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, #ttl = if_not_exists(#ttl, :ttl)",
      ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":zero": { N: "0" },
        ":one": { N: "1" },
        ":ttl": { N: String(now + RATE_LIMIT_WINDOW_SECONDS) },
      },
    }));
  } catch (err: any) {
    if (err?.message?.startsWith("RATE_LIMIT_EXCEEDED")) {
      throw err;
    }
    logger.error("Rate limit check failed, proceeding with token generation", { error: err });
  }

  const token = randomBytes(32).toString("base64url");

  // S1.1 — Hash the token before storing in DynamoDB
  const tokenHash = createHash("sha256").update(token).digest("hex");

  // Store hashed token in DynamoDB with 5-minute TTL
  try {
    await dynamo.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        pk: { S: `magic-link:${tokenHash}` },
        sk: { S: "v" },
        email: { S: email },
        createdAt: { N: String(now) },
        ttl: { N: String(now + 300) },
      },
    }));
  } catch (err) {
    logger.error("Failed to store magic link token", { error: err });
    throw err;
  }

  // Send magic link email via SES
  const magicLink = `https://${DOMAIN}/auth/verify?token=${token}&email=${encodeURIComponent(email)}`;
  try {
    await ses.send(new SendEmailCommand({
      Source: `Trellis <noreply@${DOMAIN}>`,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: "Sign in to Trellis" },
        Body: {
          Html: {
            Data: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
                <h2 style="color: #1a1a1a; margin-bottom: 24px;">Sign in to Trellis</h2>
                <p style="color: #4a4a4a; font-size: 16px; line-height: 1.5;">Click the button below to sign in. This link expires in 5 minutes.</p>
                <a href="${magicLink}" style="display: inline-block; background: #2563eb; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; margin: 24px 0;">Sign in to Trellis</a>
                <p style="color: #9a9a9a; font-size: 13px; margin-top: 32px;">If you didn't request this, you can safely ignore this email.</p>
              </div>`,
          },
          Text: {
            Data: `Sign in to Trellis\n\nClick this link to sign in (expires in 5 minutes):\n${magicLink}\n\nIf you didn't request this, ignore this email.`,
          },
        },
      },
    }));
  } catch (err) {
    logger.error("Failed to send magic link email", { error: err });
    throw err;
  }

  event.response.privateChallengeParameters = { token };
  event.response.publicChallengeParameters = { email };
  event.response.challengeMetadata = "MAGIC_LINK";

  return event;
};
