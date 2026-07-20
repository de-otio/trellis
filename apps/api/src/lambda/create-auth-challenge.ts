import { randomBytes, createHash } from "node:crypto";
import { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { Logger } from "@aws-lambda-powertools/logger";
import { createEmailProvider, emailProviderConfigFromEnv } from "../lib/email-provider.js";
import { buildMagicLinkEmail } from "../lib/identity/magic-link-email.js";

const logger = new Logger({ serviceName: "create-auth-challenge" });

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
// Email provider built once at module scope from env (region precedence lives
// in emailProviderConfigFromEnv, shared with the API). The underlying SES SDK
// is a lazy, cached dynamic import inside AWSSESProvider, so it stays an
// esbuild external and the SESClient is reused across warm invocations.
const emailProvider = createEmailProvider(emailProviderConfigFromEnv(process.env));
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

  // Send magic link email via the email-provider abstraction (AWS SES by
  // default, role-based auth). Subject/HTML/text content is unchanged —
  // extracted VERBATIM to the shared S-8 template (WS-3.3) so the app-owned
  // email is identical on every identity provider.
  const magicLink = `https://${DOMAIN}/auth/verify?token=${token}&email=${encodeURIComponent(email)}`;
  const content = buildMagicLinkEmail(magicLink);
  try {
    await emailProvider.sendEmail({
      from: `Trellis <noreply@${DOMAIN}>`,
      to: email,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
  } catch (err) {
    logger.error("Failed to send magic link email", { error: err });
    throw err;
  }

  event.response.privateChallengeParameters = { token };
  event.response.publicChallengeParameters = { email };
  event.response.challengeMetadata = "MAGIC_LINK";

  return event;
};
