/**
 * Unit Tests: Pre Signup Lambda
 *
 * Tests for the Cognito pre-signup trigger that validates invitation codes
 * against DynamoDB before allowing registration.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDynamoSend } = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  const DynamoDBClient = vi.fn();
  DynamoDBClient.prototype.send = mockDynamoSend;
  return {
    DynamoDBClient,
    GetItemCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
  };
});

vi.mock("@aws-sdk/util-dynamodb", () => ({
  marshall: vi.fn((obj: any) => {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") result[k] = { S: v };
      else if (typeof v === "number") result[k] = { N: String(v) };
      else if (typeof v === "boolean") result[k] = { BOOL: v };
    }
    return result;
  }),
  unmarshall: vi.fn((item: any) => {
    const result: any = {};
    for (const [k, v] of Object.entries(item) as any) {
      if (v.S !== undefined) result[k] = v.S;
      else if (v.N !== undefined) result[k] = parseInt(v.N, 10);
      else if (v.BOOL !== undefined) result[k] = v.BOOL;
    }
    return result;
  }),
}));

describe("PreSignup Lambda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.AWS_REGION = "us-east-1";
    process.env.DYNAMODB_TABLE = "test-table";
  });

  async function loadHandler() {
    const mod = await import("../../../src/lambda/pre-signup.js");
    return mod.handler;
  }

  function makeEvent(invitationCode?: string, clientMetadata?: Record<string, string>) {
    return {
      request: {
        userAttributes: {
          email: "user@example.com",
          ...(invitationCode ? { "custom:invitationCode": invitationCode } : {}),
        },
        clientMetadata: clientMetadata || {},
      },
      response: {
        autoConfirmUser: false,
        autoVerifyEmail: false,
        autoVerifyPhone: false,
      },
    } as any;
  }

  it("should accept a valid invitation code and auto-confirm the invited user", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        pk: { S: "invitations:VALID-CODE" },
        sk: { S: "v" },
        used: { BOOL: false },
        ttl: { N: String(now + 3600) },
      },
    });

    const handler = await loadHandler();
    const event = makeEvent("VALID-CODE");

    const result = await handler(event, {} as any, () => {});

    // Passwordless magic-link sign-in needs a CONFIRMED user; invited sign-ups
    // are auto-confirmed/verified (entry is gated by the invitation code, and
    // the magic-link challenge is the real email-ownership/access gate).
    expect(result!.response.autoConfirmUser).toBe(true);
    expect(result!.response.autoVerifyEmail).toBe(true);
  });

  it("should throw when no invitation code is provided", async () => {
    const handler = await loadHandler();
    const event = makeEvent();

    await expect(handler(event, {} as any, () => {})).rejects.toThrow(
      "An invitation code is required to register.",
    );
  });

  it("should throw when invitation code is not found in DynamoDB", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: undefined });

    const handler = await loadHandler();
    const event = makeEvent("INVALID-CODE");

    await expect(handler(event, {} as any, () => {})).rejects.toThrow(
      "Invalid or expired invitation code.",
    );
  });

  it("should throw when invitation code has already been used", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        pk: { S: "invitations:USED-CODE" },
        sk: { S: "v" },
        used: { BOOL: true },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 3600) },
      },
    });

    const handler = await loadHandler();
    const event = makeEvent("USED-CODE");

    await expect(handler(event, {} as any, () => {})).rejects.toThrow(
      "This invitation code has already been used.",
    );
  });

  it("should throw when invitation code has expired", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        pk: { S: "invitations:EXPIRED-CODE" },
        sk: { S: "v" },
        used: { BOOL: false },
        ttl: { N: String(Math.floor(Date.now() / 1000) - 100) }, // expired
      },
    });

    const handler = await loadHandler();
    const event = makeEvent("EXPIRED-CODE");

    await expect(handler(event, {} as any, () => {})).rejects.toThrow(
      "This invitation code has expired.",
    );
  });

  it("should accept invitation code from clientMetadata", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        pk: { S: "invitations:META-CODE" },
        sk: { S: "v" },
        used: { BOOL: false },
        ttl: { N: String(now + 3600) },
      },
    });

    const handler = await loadHandler();
    const event = makeEvent(undefined, { invitationCode: "META-CODE" });

    const result = await handler(event, {} as any, () => {});
    expect(result!.response.autoConfirmUser).toBe(true);
  });

  it("should throw when DynamoDB fails (allows Lambda retry)", async () => {
    mockDynamoSend.mockRejectedValueOnce(new Error("DynamoDB unavailable"));

    const handler = await loadHandler();
    const event = makeEvent("VALID-CODE");

    await expect(handler(event, {} as any, () => {})).rejects.toThrow("DynamoDB unavailable");
  });
});
