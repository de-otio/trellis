/**
 * Unit Tests: Verify Auth Challenge Lambda
 *
 * Tests for the Cognito verify auth challenge trigger that performs
 * timing-safe comparison of magic link tokens and cleans up DynamoDB.
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
    DeleteItemCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
  };
});

describe("VerifyAuthChallenge Lambda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.AWS_REGION = "us-east-1";
    process.env.DYNAMODB_TABLE = "test-table";
    mockDynamoSend.mockResolvedValue({});
  });

  async function loadHandler() {
    const mod = await import("../../../src/lambda/verify-auth-challenge.js");
    return mod.handler;
  }

  function makeEvent(answer: string, expectedToken: string) {
    return {
      request: {
        challengeAnswer: answer,
        privateChallengeParameters: { token: expectedToken },
      },
      response: {
        answerCorrect: false,
      },
    };
  }

  it("should set answerCorrect to true when tokens match", async () => {
    const handler = await loadHandler();
    const token = "valid-token-abc123";
    const event = makeEvent(token, token);

    const result = await handler(event);

    expect(result.response.answerCorrect).toBe(true);
  });

  it("should set answerCorrect to false when tokens do not match", async () => {
    const handler = await loadHandler();
    const event = makeEvent("wrong-token", "expected-token");

    const result = await handler(event);

    expect(result.response.answerCorrect).toBe(false);
  });

  it("should delete the magic link token from DynamoDB on correct answer", async () => {
    const handler = await loadHandler();
    const token = "valid-token-xyz";
    const event = makeEvent(token, token);

    await handler(event);

    // Should have called DynamoDB DeleteItemCommand
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
    const deleteCall = mockDynamoSend.mock.calls[0][0];
    expect(deleteCall.input.TableName).toBe("test-table");
    // The key should be the SHA-256 hash of the token
    expect(deleteCall.input.Key.pk.S).toMatch(/^magic-link:/);
    expect(deleteCall.input.Key.sk.S).toBe("v");
  });

  it("should NOT delete the token from DynamoDB on wrong answer", async () => {
    const handler = await loadHandler();
    const event = makeEvent("wrong", "expected");

    await handler(event);

    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it("should still return answerCorrect=true even if DynamoDB delete fails", async () => {
    mockDynamoSend.mockRejectedValueOnce(new Error("DynamoDB error"));

    const handler = await loadHandler();
    const token = "valid-token";
    const event = makeEvent(token, token);

    const result = await handler(event);

    // Answer is still correct even though cleanup failed
    expect(result.response.answerCorrect).toBe(true);
  });

  it("should set answerCorrect to false when tokens differ in length", async () => {
    const handler = await loadHandler();
    const event = makeEvent("short", "much-longer-token-string");

    const result = await handler(event);

    expect(result.response.answerCorrect).toBe(false);
  });

  it("should always return the event object", async () => {
    const handler = await loadHandler();
    const event = makeEvent("a", "b");

    const result = await handler(event);

    expect(result).toBe(event);
  });
});
