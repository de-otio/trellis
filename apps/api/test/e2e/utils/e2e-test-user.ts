/**
 * E2E Test User — creates a Cognito user, authenticates via magic link,
 * and provides authenticated fetch for test suites.
 *
 * Works on all environments (dev and prod) via maildummy infrastructure.
 * Test user emails follow the pattern: __e2e_{suiteName}_{timestamp}@maildummy.{env}.example.com
 */

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
import { getMagicLinkFromS3, type MaildummyConfig } from "./maildummy-helper.js";

const region = process.env.AWS_REGION || "eu-central-1";
const stage = process.env.STAGE || process.env.ENVIRONMENT || "dev";

// Cache SSM params across instances (same process)
let _ssmCache: Record<string, string> = {};

async function ssmGet(name: string): Promise<string> {
  if (_ssmCache[name]) return _ssmCache[name];
  const ssm = new SSMClient({ region });
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  if (!res.Parameter?.Value) throw new Error(`SSM parameter ${name} not found`);
  _ssmCache[name] = res.Parameter.Value;
  return res.Parameter.Value;
}

export interface E2eTestUserOptions {
  suiteName: string;
  emailTimeoutSeconds?: number;
}

export class E2eTestUser {
  readonly email: string;
  readonly jwt: string;
  readonly userId: string;

  private userPoolId: string;
  private username: string;
  private invitationCode: string;
  private dynamoTable: string;
  private cookies: Record<string, string> = {};

  private constructor(
    email: string,
    jwt: string,
    userId: string,
    userPoolId: string,
    username: string,
    invitationCode: string,
    dynamoTable: string,
  ) {
    this.email = email;
    this.jwt = jwt;
    this.userId = userId;
    this.userPoolId = userPoolId;
    this.username = username;
    this.invitationCode = invitationCode;
    this.dynamoTable = dynamoTable;
  }

  static async create(options: E2eTestUserOptions): Promise<E2eTestUser> {
    const { suiteName, emailTimeoutSeconds = 60 } = options;

    // Load config from SSM
    const [userPoolId, clientId, maildummyDomain, maildummyBucket] = await Promise.all([
      ssmGet(`/trellis/${stage}/cognito-user-pool-id`),
      ssmGet(`/trellis/${stage}/cognito-app-client-id`),
      ssmGet(`/trellis/${stage}/maildummy/domain`),
      ssmGet(`/trellis/${stage}/maildummy/bucket/name`),
    ]);

    const email = `__e2e_${suiteName}_${Date.now()}@${maildummyDomain}`;
    // User pool is configured for email alias — username must not be in email format.
    // Authentication can still use the email alias in InitiateAuth.
    const username = `e2e-${suiteName.replace(/[^a-zA-Z0-9]/g, "-")}-${Date.now()}`;
    const invitationCode = `e2e-${suiteName.replace(/[^a-zA-Z0-9]/g, "-")}-${Date.now()}`;
    const dynamoTable = `${stage}-trellis`;
    const cognito = new CognitoIdentityProviderClient({ region });
    const dynamo = new DynamoDBClient({ region });

    // 0. Create invitation code in DynamoDB (PreSignUp Lambda requires it)
    await dynamo.send(new PutItemCommand({
      TableName: dynamoTable,
      Item: {
        pk: { S: `invitations:${invitationCode}` },
        sk: { S: "v" },
        used: { BOOL: false },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 3600) }, // 1 hour TTL
      },
    }));

    // 1. Create Cognito user
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
      ClientMetadata: { invitationCode },
      MessageAction: "SUPPRESS",
    }));

    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: username,
      Password: `Tmp-${Date.now()}-${Math.random().toString(36).slice(2)}!`,
      Permanent: true,
    }));

    // 2. Initiate CUSTOM_AUTH (triggers magic link email)
    const initiateRes = await cognito.send(new InitiateAuthCommand({
      AuthFlow: "CUSTOM_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: email },
    }));

    if (initiateRes.ChallengeName !== "CUSTOM_CHALLENGE" || !initiateRes.Session) {
      throw new Error(`Expected CUSTOM_CHALLENGE, got ${initiateRes.ChallengeName}`);
    }

    // 3. Poll maildummy S3 for the magic link email
    const maildummyConfig: MaildummyConfig = { bucketName: maildummyBucket, region };
    const magicLink = await getMagicLinkFromS3(maildummyConfig, email, emailTimeoutSeconds);
    const url = new URL(magicLink);
    const token = url.searchParams.get("token");
    if (!token) throw new Error("No token found in magic link URL");

    // 4. Complete the challenge
    const challengeRes = await cognito.send(new RespondToAuthChallengeCommand({
      ChallengeName: "CUSTOM_CHALLENGE",
      ClientId: clientId,
      ChallengeResponses: { USERNAME: email, ANSWER: token },
      Session: initiateRes.Session,
    }));

    const idToken = challengeRes.AuthenticationResult?.IdToken;
    if (!idToken) throw new Error("No IdToken returned from challenge response");

    // 5. Parse JWT to get userId (sub claim)
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
    const userId = payload.sub;
    if (!userId) throw new Error("No sub claim in JWT");

    console.log(`[E2eTestUser] Created user ${email} (${userId})`);
    return new E2eTestUser(email, idToken, userId, userPoolId, username, invitationCode, dynamoTable);
  }

  /**
   * Authenticated fetch. Tracks Set-Cookie headers for CSRF support.
   */
  async authFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const cookieHeader = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.jwt}`,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(init.headers as Record<string, string> || {}),
    };

    const res = await fetch(url, { ...init, headers });

    // Track cookies from response
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const cookie of setCookie) {
      const match = cookie.match(/^([^=]+)=([^;]*)/);
      if (match) this.cookies[match[1]] = match[2];
    }

    return res;
  }

  /**
   * Get a CSRF token for mutation requests.
   */
  async getCsrfToken(apiUrl: string): Promise<string> {
    const res = await this.authFetch(`${apiUrl}/api/csrf-token`);
    if (!res.ok) throw new Error(`Failed to get CSRF token: ${res.status}`);
    const body = await res.json();
    return body.token;
  }

  /**
   * Delete the Cognito user and invitation code. Call in afterAll / globalTeardown.
   */
  async destroy(): Promise<void> {
    const cognito = new CognitoIdentityProviderClient({ region });
    const dynamo = new DynamoDBClient({ region });

    try {
      await cognito.send(new AdminDeleteUserCommand({
        UserPoolId: this.userPoolId,
        Username: this.username,
      }));
      console.log(`[E2eTestUser] Destroyed user ${this.email}`);
    } catch (err) {
      console.warn(`[E2eTestUser] Failed to destroy ${this.email}:`, err);
    }

    try {
      await dynamo.send(new DeleteItemCommand({
        TableName: this.dynamoTable,
        Key: {
          pk: { S: `invitations:${this.invitationCode}` },
          sk: { S: "v" },
        },
      }));
    } catch (err) {
      console.warn(`[E2eTestUser] Failed to delete invitation code ${this.invitationCode}:`, err);
    }
  }
}
