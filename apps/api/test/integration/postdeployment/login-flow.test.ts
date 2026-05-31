/**
 * Post-Deployment Integration Tests: Login Flow
 *
 * Tests that the pre-auth endpoints required for login are accessible
 * and that the Cognito custom auth flow (magic link) is functional.
 *
 * Production-safe: creates and cleans up its own test users via Cognito Admin API.
 * Uses maildummy to intercept magic link emails when available.
 *
 * This test verifies:
 * - Health endpoint returns 200
 * - CSRF token endpoint is accessible without auth
 * - Cognito InitiateAuth (CUSTOM_AUTH) doesn't crash the Lambda
 * - Full magic link flow: send → intercept → verify → get JWT (when maildummy available)
 * - Frontend serves text/html (not binary/octet-stream)
 *
 * Prerequisites:
 * - API must be running (deployed)
 * - AWS credentials with SSM read access
 * - Maildummy infrastructure deployed (for full flow test)
 *
 * Usage:
 *   STAGE=dev AWS_REGION=eu-central-1 npm run test:postdeployment:api
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getApiUrl, getFrontendUrl } from "../../utils/test-config.js";

const API_URL = getApiUrl();
const region = process.env.AWS_REGION || "eu-central-1";
const stage = process.env.STAGE || process.env.ENVIRONMENT || "dev";

// Lazy-loaded AWS clients and config
let userPoolId: string;
let clientId: string;
let maildummyBucket: string | undefined;
let maildummyDomain: string | undefined;
let ssmAvailable = false;

async function ssmGet(name: string): Promise<string | undefined> {
  try {
    const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region });
    const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return res.Parameter?.Value;
  } catch {
    return undefined;
  }
}

describe("Login Flow — Pre-Auth Endpoints", () => {
  it("GET /health returns 200 with ok:true", async () => {
    const response = await fetch(`${API_URL}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  it("GET /api/csrf-token does not return 401 or 500", async () => {
    const response = await fetch(`${API_URL}/api/csrf-token`);
    // CSRF token endpoint must be accessible for the login flow.
    // MUST NOT return 401 (auth required) or 500 (server error).
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(500);
    console.log(`[login-flow] GET /api/csrf-token → ${response.status}`);
  });
});

describe("Login Flow — Cognito Custom Auth", () => {
  beforeAll(async () => {
    // Load Cognito config from env or SSM
    userPoolId =
      process.env.COGNITO_USER_POOL_ID ||
      (await ssmGet(`/trellis/${stage}/cognito-user-pool-id`)) ||
      "";
    clientId =
      process.env.COGNITO_APP_CLIENT_ID ||
      (await ssmGet(`/trellis/${stage}/cognito-app-client-id`)) ||
      "";

    ssmAvailable = !!(userPoolId && clientId);

    if (ssmAvailable) {
      // Try to load maildummy config (optional — full flow test)
      maildummyDomain = await ssmGet(`/trellis/${stage}/maildummy/domain`);
      maildummyBucket = await ssmGet(`/trellis/${stage}/maildummy/bucket/name`);
    }
  }, 15_000);

  it("Cognito InitiateAuth does not crash the Lambda", async () => {
    if (!ssmAvailable) {
      console.warn("[login-flow] Cognito config not available, skipping");
      return;
    }

    // Call InitiateAuth with a non-existent user.
    // Cognito should return UserNotFoundException BEFORE invoking the Lambda.
    // UserLambdaValidationException with unexpected errors means the Lambda crashed.
    const cognitoUrl = `https://cognito-idp.${region}.amazonaws.com/`;
    const response = await fetch(cognitoUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: "CUSTOM_AUTH",
        ClientId: clientId,
        AuthParameters: {
          USERNAME: `postdeploy-smoke-${Date.now()}`,
        },
      }),
    });

    const body = await response.json();
    const errorType = body.__type?.split("#").pop();
    console.log(`[login-flow] Cognito InitiateAuth → ${response.status} ${errorType || "OK"}`);

    if (body.__type === "UserLambdaValidationException") {
      // "Email attribute is required" is expected for users without email —
      // it means the Lambda ran but the user has no email attribute.
      // Other errors indicate a real Lambda crash.
      const isExpectedGuard = body.message?.includes("Email attribute is required");
      if (!isExpectedGuard) {
        expect.fail(
          `CreateAuthChallenge Lambda crashed: ${body.message}. ` +
          `Login flow is broken. Check Lambda logs and IAM permissions.`,
        );
      }
    }

    // UserNotFoundException, NotAuthorizedException, or our email guard are acceptable
    expect([200, 400]).toContain(response.status);
  });

  it("Full magic link flow: send → intercept → verify → JWT", async () => {
    if (!maildummyDomain || !maildummyBucket) {
      console.warn("[login-flow] Maildummy not available, skipping full flow test");
      return;
    }

    const {
      CognitoIdentityProviderClient,
      InitiateAuthCommand,
      RespondToAuthChallengeCommand,
      AdminCreateUserCommand,
      AdminDeleteUserCommand,
      AdminSetUserPasswordCommand,
    } = await import("@aws-sdk/client-cognito-identity-provider");
    const { getMagicLinkFromS3 } = await import("../../e2e/utils/maildummy-helper.js");

    const cognito = new CognitoIdentityProviderClient({ region });
    const { DynamoDBClient, PutItemCommand, DeleteItemCommand } = await import("@aws-sdk/client-dynamodb");
    const dynamo = new DynamoDBClient({ region });

    const testEmail = `postdeploy-${Date.now()}@${maildummyDomain}`;
    const testUsername = `postdeploy-${Date.now()}`;
    const invitationCode = `test-${Date.now()}`;
    const dynamoTable = `${stage}-trellis`;

    try {
      // 0. Create a test invitation code in DynamoDB (PreSignUp Lambda requires it)
      await dynamo.send(new PutItemCommand({
        TableName: dynamoTable,
        Item: {
          pk: { S: `invitations:${invitationCode}` },
          sk: { S: "v" },
          used: { BOOL: false },
          ttl: { N: String(Math.floor(Date.now() / 1000) + 300) },
        },
      }));

      // 1. Create test user in Cognito
      // Use a non-email username when pool is configured for email alias
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: testUsername,
          UserAttributes: [
            { Name: "email", Value: testEmail },
            { Name: "email_verified", Value: "true" },
          ],
          ClientMetadata: { invitationCode },
          MessageAction: "SUPPRESS",
        }),
      );
      await cognito.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: testUsername,
          Password: `Tmp-${Date.now()}-${Math.random().toString(36).slice(2)}!`,
          Permanent: true,
        }),
      );

      // 2. Initiate CUSTOM_AUTH flow — triggers CreateAuthChallenge Lambda
      const initiateRes = await cognito.send(
        new InitiateAuthCommand({
          AuthFlow: "CUSTOM_AUTH",
          ClientId: clientId,
          AuthParameters: { USERNAME: testEmail },
        }),
      );

      expect(initiateRes.ChallengeName).toBe("CUSTOM_CHALLENGE");
      expect(initiateRes.Session).toBeDefined();
      console.log("[login-flow] Magic link email triggered");

      // 3. Poll maildummy S3 bucket for the captured email
      const magicLink = await getMagicLinkFromS3(
        { bucketName: maildummyBucket!, region },
        testEmail,
        60,
      );
      expect(magicLink).toBeDefined();
      console.log(`[login-flow] Magic link intercepted: ${magicLink.substring(0, 60)}...`);

      // 4. Extract token and complete the auth challenge
      const token = new URL(magicLink).searchParams.get("token");
      expect(token).toBeTruthy();

      const challengeRes = await cognito.send(
        new RespondToAuthChallengeCommand({
          ChallengeName: "CUSTOM_CHALLENGE",
          ClientId: clientId,
          ChallengeResponses: { USERNAME: testEmail, ANSWER: token! },
          Session: initiateRes.Session!,
        }),
      );

      expect(challengeRes.AuthenticationResult).toBeDefined();
      expect(challengeRes.AuthenticationResult!.IdToken).toBeDefined();
      console.log("[login-flow] JWT tokens received — full auth cycle complete");

      // 5. Verify the JWT grants API access
      const apiRes = await fetch(`${API_URL}/api/user/profile`, {
        headers: { Authorization: `Bearer ${challengeRes.AuthenticationResult!.IdToken!}` },
      });
      // 200 (profile exists) or 404 (new user) — both prove auth worked
      expect(apiRes.status).not.toBe(401);
      console.log(`[login-flow] API access with JWT → ${apiRes.status}`);
    } finally {
      // Clean up test user and invitation
      try {
        await cognito.send(
          new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: testUsername }),
        );
      } catch (err) {
        console.warn(`[login-flow] Cleanup: failed to delete test user ${testUsername}:`, err);
      }
      try {
        await dynamo.send(new DeleteItemCommand({
          TableName: dynamoTable,
          Key: { pk: { S: `invitations:${invitationCode}` }, sk: { S: "v" } },
        }));
      } catch {}

    }
  }, 120_000);
});

describe("Login Flow — Frontend Serving", () => {
  it("Frontend serves text/html, not binary/octet-stream", async () => {
    let frontendUrl: string;
    try {
      frontendUrl = getFrontendUrl();
    } catch {
      frontendUrl = stage === "prod" ? "https://example.com" : `https://${stage}.example.com`;
    }

    const response = await fetch(frontendUrl);
    expect(response.status).toBe(200);

    const contentType = response.headers.get("content-type") || "";
    expect(contentType.toLowerCase()).toContain("text/html");

    const body = await response.text();
    expect(body).toContain("flutter");
    console.log(`[login-flow] Frontend ${frontendUrl} → ${response.status} content-type: ${contentType}`);
  });
});
