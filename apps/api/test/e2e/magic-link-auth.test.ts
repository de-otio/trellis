/**
 * Magic Link Authentication E2E Tests
 *
 * Tests the full Cognito CUSTOM_AUTH magic link flow:
 * 1. InitiateAuth triggers magic link email
 * 2. Email is captured by maildummy in S3
 * 3. Token from email completes authentication
 * 4. Resulting JWT grants API access
 *
 * NOT safe for production — creates and deletes test users.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient, PutItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { getMagicLinkFromS3, type MaildummyConfig } from "./utils/maildummy-helper.js";
import { getApiUrl } from "../utils/test-config.js";


const region = process.env.AWS_REGION || "eu-central-1";
const stage = process.env.STAGE || process.env.ENVIRONMENT || "dev";

const cognito = new CognitoIdentityProviderClient({ region });
const ssm = new SSMClient({ region });
const dynamo = new DynamoDBClient({ region });
const dynamoTable = `${stage}-trellis`;

async function ssmGet(name: string): Promise<string> {
  const res = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  if (!res.Parameter?.Value) throw new Error(`SSM parameter ${name} not found`);
  return res.Parameter.Value;
}

// Auto-skips if maildummy SSM parameters are not available.
// Once the Testing stack is deployed, these tests run automatically.
describe("Magic Link Authentication", () => {
  const API_URL = getApiUrl();

  let userPoolId: string;
  let clientId: string;
  let maildummyConfig: MaildummyConfig;
  let testEmail: string;

  // Shared state across tests (flow test 1 -> 2 -> 3)
  let flowSession: string;
  let flowToken: string;
  let flowIdToken: string;

  // Track all created usernames and invitation codes for cleanup
  const createdUsernames: string[] = [];
  const createdInvitationCodes: string[] = [];

  let maildummyAvailable = false;

  beforeAll(async () => {
    // Load configuration from SSM — skip gracefully if unavailable
    try {
      [userPoolId, clientId] = await Promise.all([
        ssmGet(`/trellis/${stage}/cognito-user-pool-id`),
        ssmGet(`/trellis/${stage}/cognito-app-client-id`),
      ]);
    } catch {
      console.warn("[magic-link-auth] Cognito SSM params not available, tests will skip");
      return;
    }

    try {
      const [maildummyDomain, maildummyBucket] = await Promise.all([
        ssmGet(`/trellis/${stage}/maildummy/domain`),
        ssmGet(`/trellis/${stage}/maildummy/bucket/name`),
      ]);

      maildummyConfig = {
        bucketName: maildummyBucket,
        region,
      };

      testEmail = `__e2e_magic_${Date.now()}@${maildummyDomain}`;
      maildummyAvailable = true;
    } catch {
      console.warn("[magic-link-auth] Maildummy SSM params not available, tests will skip");
    }
  }, 30_000);

  afterAll(async () => {
    // Clean up all test users
    for (const username of createdUsernames) {
      try {
        await cognito.send(
          new AdminDeleteUserCommand({
            UserPoolId: userPoolId,
            Username: username,
          }),
        );
      } catch (err) {
        console.warn(`Failed to delete test user ${username}:`, err);
      }
    }
    // Clean up invitation codes
    for (const code of createdInvitationCodes) {
      try {
        await dynamo.send(new DeleteItemCommand({
          TableName: dynamoTable,
          Key: { pk: { S: `invitations:${code}` }, sk: { S: "v" } },
        }));
      } catch {}
    }
  }, 30_000);

  /**
   * Helper: create a Cognito user with the given email.
   * Generates a non-email username (required when pool uses email alias).
   * The user is added to the cleanup list automatically.
   */
  async function createTestUser(email: string): Promise<void> {
    // User pool uses email as alias — Username must not be in email format
    const username = `e2e-magic-${Date.now()}`;
    const invitationCode = `e2e-magic-${Date.now()}`;

    // Create invitation code in DynamoDB (PreSignUp Lambda requires it)
    await dynamo.send(new PutItemCommand({
      TableName: dynamoTable,
      Item: {
        pk: { S: `invitations:${invitationCode}` },
        sk: { S: "v" },
        used: { BOOL: false },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 3600) },
      },
    }));
    createdInvitationCodes.push(invitationCode);

    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: username,
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
        ClientMetadata: { invitationCode },
        MessageAction: "SUPPRESS", // Don't send the welcome email
      }),
    );

    // Set a temporary password so the user is confirmed
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: username,
        Password: `Tmp-${Date.now()}-${Math.random().toString(36).slice(2)}!`,
        Permanent: true,
      }),
    );

    createdUsernames.push(username);
  }

  it("sends a magic link email when initiating CUSTOM_AUTH", async () => {
    if (!maildummyAvailable) return;
    // 1. Create test user
    await createTestUser(testEmail);

    // 2. Initiate CUSTOM_AUTH flow — Cognito triggers the "Create Auth Challenge" Lambda
    //    which sends the magic link email
    const initiateRes = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: "CUSTOM_AUTH",
        ClientId: clientId,
        AuthParameters: {
          USERNAME: testEmail,
        },
      }),
    );

    // The response should contain a session and a CUSTOM_CHALLENGE
    expect(initiateRes.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(initiateRes.Session).toBeDefined();
    flowSession = initiateRes.Session!;

    // 3. Poll maildummy S3 bucket for the email (up to 60s for SES delivery)
    const magicLink = await getMagicLinkFromS3(maildummyConfig, testEmail, 60);
    expect(magicLink).toBeDefined();

    // 4. Extract token from the magic link URL
    const url = new URL(magicLink);
    const token = url.searchParams.get("token");
    expect(token).toBeTruthy();
    expect(token!.length).toBeGreaterThan(0);

    flowToken = token!;
  }, 90_000);

  it("completes sign-in with valid magic link token", async () => {
    if (!maildummyAvailable) return;
    // Depends on test 1 having populated flowSession and flowToken
    expect(flowSession).toBeDefined();
    expect(flowToken).toBeDefined();

    const challengeRes = await cognito.send(
      new RespondToAuthChallengeCommand({
        ChallengeName: "CUSTOM_CHALLENGE",
        ClientId: clientId,
        ChallengeResponses: {
          USERNAME: testEmail,
          ANSWER: flowToken,
        },
        Session: flowSession,
      }),
    );

    // Should return tokens on success
    expect(challengeRes.AuthenticationResult).toBeDefined();
    expect(challengeRes.AuthenticationResult!.IdToken).toBeDefined();
    expect(challengeRes.AuthenticationResult!.AccessToken).toBeDefined();
    expect(challengeRes.AuthenticationResult!.RefreshToken).toBeDefined();

    // Verify IdToken is a valid JWT structure (3 base64 parts)
    const idToken = challengeRes.AuthenticationResult!.IdToken!;
    const parts = idToken.split(".");
    expect(parts).toHaveLength(3);

    flowIdToken = idToken;
  }, 30_000);

  it("JWT from magic link auth grants API access", async () => {
    if (!maildummyAvailable) return;
    expect(flowIdToken).toBeDefined();

    const res = await fetch(`${API_URL}/api/user/profile`, {
      headers: {
        Authorization: `Bearer ${flowIdToken}`,
      },
    });

    // Should be authenticated (not 401)
    expect(res.status).not.toBe(401);
    // Accept 200 (profile exists) or 404 (new user, no profile yet) — both prove auth worked
    expect([200, 404]).toContain(res.status);
  }, 15_000);

  it("rejects invalid magic link token", async () => {
    if (!maildummyAvailable) return;
    // Create a fresh user and initiate auth to get a valid session
    const invalidTokenEmail = `__e2e_invalid_${Date.now()}@${testEmail.split("@")[1]}`;
    await createTestUser(invalidTokenEmail);

    const initiateRes = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: "CUSTOM_AUTH",
        ClientId: clientId,
        AuthParameters: {
          USERNAME: invalidTokenEmail,
        },
      }),
    );

    expect(initiateRes.Session).toBeDefined();

    // Respond with a fake token — should be rejected
    await expect(
      cognito.send(
        new RespondToAuthChallengeCommand({
          ChallengeName: "CUSTOM_CHALLENGE",
          ClientId: clientId,
          ChallengeResponses: {
            USERNAME: invalidTokenEmail,
            ANSWER: "completely-fake-invalid-token-12345",
          },
          Session: initiateRes.Session!,
        }),
      ),
    ).rejects.toThrow();
  }, 30_000);

  it("rejects already-used magic link token", async () => {
    if (!maildummyAvailable) return;
    // The flowToken from tests 1-2 was already consumed successfully.
    // Attempting to use it again with a new session should fail.

    // We need a new session because the old one was consumed too.
    // Initiate a fresh CUSTOM_AUTH flow for the same user.
    const reInitRes = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: "CUSTOM_AUTH",
        ClientId: clientId,
        AuthParameters: {
          USERNAME: testEmail,
        },
      }),
    );

    expect(reInitRes.Session).toBeDefined();

    // Try using the old (already-used) token with the new session
    // The token was a one-time code stored in the challenge; reusing it should fail.
    await expect(
      cognito.send(
        new RespondToAuthChallengeCommand({
          ChallengeName: "CUSTOM_CHALLENGE",
          ClientId: clientId,
          ChallengeResponses: {
            USERNAME: testEmail,
            ANSWER: flowToken,
          },
          Session: reInitRes.Session!,
        }),
      ),
    ).rejects.toThrow();
  }, 30_000);
});
