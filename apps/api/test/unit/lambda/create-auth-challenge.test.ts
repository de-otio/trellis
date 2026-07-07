/**
 * Unit Tests: Create Auth Challenge Lambda
 *
 * Tests for the Cognito custom auth challenge trigger that generates
 * magic link tokens, stores hashed tokens in DynamoDB, and sends emails via SES.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDynamoSend, mockSesSend } = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
  mockSesSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  const DynamoDBClient = vi.fn();
  DynamoDBClient.prototype.send = mockDynamoSend;
  return {
    DynamoDBClient,
    PutItemCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
    GetItemCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
    UpdateItemCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
  };
});



vi.mock("@aws-sdk/client-ses", () => {
  const SESClient = vi.fn();
  SESClient.prototype.send = mockSesSend;
  return {
    SESClient,
    SendEmailCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
  };
});

describe("CreateAuthChallenge Lambda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.AWS_REGION = "us-east-1";
    process.env.DYNAMODB_TABLE = "test-table";
    process.env.DOMAIN = "trellis.test";
    delete process.env.RECAPTCHA_SECRET_KEY;
    // Default: rate limit check returns no existing item, DynamoDB writes succeed, SES succeeds
    mockDynamoSend.mockResolvedValue({});
    mockSesSend.mockResolvedValue({});
  });

  async function loadHandler() {
    const mod = await import("../../../src/lambda/create-auth-challenge.js");
    return mod.handler;
  }

  function makeEvent(email = "user@example.com", clientMetadata?: Record<string, string>) {
    return {
      request: {
        userAttributes: { email },
        ...(clientMetadata ? { clientMetadata } : {}),
      },
      response: {
        privateChallengeParameters: {},
        publicChallengeParameters: {},
        challengeMetadata: "",
      },
    };
  }

  it("should generate a token, store it hashed in DynamoDB, send email, and set response parameters", async () => {
    const handler = await loadHandler();
    const event = makeEvent();

    const result = await handler(event);

    // Should have called DynamoDB: rate limit GET, rate limit UPDATE, token PUT
    expect(mockDynamoSend).toHaveBeenCalledTimes(3);
    // Should have sent email via SES
    expect(mockSesSend).toHaveBeenCalledTimes(1);

    // Response should have token in privateChallengeParameters
    expect(result.response.privateChallengeParameters.token).toBeDefined();
    expect(typeof result.response.privateChallengeParameters.token).toBe("string");
    expect(result.response.privateChallengeParameters.token.length).toBeGreaterThan(0);

    // publicChallengeParameters should contain email
    expect(result.response.publicChallengeParameters.email).toBe("user@example.com");

    // challengeMetadata should be set
    expect(result.response.challengeMetadata).toBe("MAGIC_LINK");
  });

  it("should send via the email abstraction with content + token/hash intact", async () => {
    const handler = await loadHandler();
    const event = makeEvent();

    const result = await handler(event);

    // Routed through the email-provider abstraction → AWS SES SDK send().
    expect(mockSesSend).toHaveBeenCalledTimes(1);
    const sesInput = mockSesSend.mock.calls[0][0].input;

    // From / to / subject preserved exactly.
    expect(sesInput.Source).toBe("Trellis <noreply@trellis.test>");
    expect(sesInput.Destination.ToAddresses).toEqual(["user@example.com"]);
    expect(sesInput.Message.Subject.Data).toBe("Sign in to Trellis");

    // The token issued to the caller must appear in the email body...
    const token = result.response.privateChallengeParameters.token as string;
    expect(sesInput.Message.Body.Html.Data).toContain(
      `token=${token}`,
    );
    expect(sesInput.Message.Body.Text.Data).toContain(
      `token=${token}`,
    );
    expect(sesInput.Message.Body.Html.Data).toContain("Sign in to Trellis");

    // ...and DynamoDB must store the SHA-256 hash of that same token, never
    // the token itself.
    const putCall = mockDynamoSend.mock.calls[2][0];
    const expectedHash = createHash("sha256").update(token).digest("hex");
    expect(putCall.input.Item.pk.S).toBe(`magic-link:${expectedHash}`);
    expect(putCall.input.Item.pk.S).not.toContain(token);
    expect(putCall.input.Item.email.S).toBe("user@example.com");
  });

  it("should store the token with a 5-minute TTL in DynamoDB", async () => {
    const handler = await loadHandler();
    const event = makeEvent();

    await handler(event);

    // The third DynamoDB call is the PutItemCommand for the token
    const putCall = mockDynamoSend.mock.calls[2][0];
    expect(putCall.input.TableName).toBe("test-table");
    // The pk should start with magic-link: (hashed token)
    expect(putCall.input.Item.pk.S).toMatch(/^magic-link:/);
    expect(putCall.input.Item.sk.S).toBe("v");
    // TTL should be ~300 seconds from now
    const ttl = parseInt(putCall.input.Item.ttl.N, 10);
    const now = Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(now + 290);
    expect(ttl).toBeLessThan(now + 310);
  });

  it("should throw RATE_LIMIT_EXCEEDED when rate limit is hit", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        count: { N: "5" },
        ttl: { N: String(now + 600) },
      },
    });

    const handler = await loadHandler();
    const event = makeEvent();

    await expect(handler(event)).rejects.toThrow("RATE_LIMIT_EXCEEDED");
  });

  it("should proceed even if rate limit check fails (non-rate-limit DynamoDB error)", async () => {
    // First call (rate limit GET) fails with a transient error
    mockDynamoSend.mockRejectedValueOnce(new Error("DynamoDB transient error"));
    // Subsequent calls succeed
    mockDynamoSend.mockResolvedValue({});
    mockSesSend.mockResolvedValue({});

    const handler = await loadHandler();
    const event = makeEvent();

    const result = await handler(event);
    // Should still succeed — transient rate limit errors are swallowed
    expect(result.response.privateChallengeParameters.token).toBeDefined();
    expect(result.response.challengeMetadata).toBe("MAGIC_LINK");
  });

  it("should throw when DynamoDB PutItem for token storage fails", async () => {
    // Rate limit GET returns empty (no rate limit)
    mockDynamoSend.mockResolvedValueOnce({});
    // Rate limit UPDATE succeeds
    mockDynamoSend.mockResolvedValueOnce({});
    // Token PutItem fails
    mockDynamoSend.mockRejectedValueOnce(new Error("DynamoDB write failure"));

    const handler = await loadHandler();
    const event = makeEvent();

    await expect(handler(event)).rejects.toThrow("DynamoDB write failure");
  });

  it("should throw when SES email send fails", async () => {
    mockSesSend.mockRejectedValueOnce(new Error("SES failure"));

    const handler = await loadHandler();
    const event = makeEvent();

    await expect(handler(event)).rejects.toThrow("SES failure");
  });

  it("should be idempotent — duplicate invocation generates a new token", async () => {
    const handler = await loadHandler();

    const result1 = await handler(makeEvent());
    const result2 = await handler(makeEvent());

    // Each invocation gets its own token (they should differ)
    expect(result1.response.privateChallengeParameters.token).toBeDefined();
    expect(result2.response.privateChallengeParameters.token).toBeDefined();
    // Both calls should have been successful
    expect(result1.response.challengeMetadata).toBe("MAGIC_LINK");
    expect(result2.response.challengeMetadata).toBe("MAGIC_LINK");
  });

});
