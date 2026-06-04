/**
 * Unit Tests: Cleanup Cron Lambda
 *
 * Tests for the cron Lambda that acquires a DynamoDB lock
 * before performing cleanup operations.
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
    PutItemCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
    DeleteItemCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
    QueryCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
  };
});

vi.mock("@aws-sdk/util-dynamodb", () => ({
  marshall: vi.fn((obj: any) => {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") result[k] = { S: v };
      else if (typeof v === "number") result[k] = { N: String(v) };
    }
    return result;
  }),
}));

describe("CleanupCron Lambda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.AWS_REGION = "us-east-1";
    process.env.DYNAMODB_TABLE = "test-table";
  });

  async function loadHandler() {
    const mod = await import("../../../src/lambda/cleanup-cron.js");
    return mod.handler;
  }

  it("should acquire lock and run cleanup successfully", async () => {
    // Lock acquisition succeeds
    mockDynamoSend.mockResolvedValue({});

    const handler = await loadHandler();

    await expect(handler()).resolves.toBeUndefined();
    // At least the lock acquisition call
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should skip execution when lock is already held (another execution running)", async () => {
    // Lock acquisition fails (ConditionalCheckFailedException)
    const condError = new Error("ConditionalCheckFailedException");
    condError.name = "ConditionalCheckFailedException";
    mockDynamoSend.mockRejectedValueOnce(condError);

    const handler = await loadHandler();

    // Should not throw — just skip
    await expect(handler()).resolves.toBeUndefined();
  });

  it("should be idempotent — multiple invocations are safe", async () => {
    mockDynamoSend.mockResolvedValue({});

    const handler = await loadHandler();

    await handler();
    await handler();

    // Both should complete without error
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("should return void (no return value)", async () => {
    mockDynamoSend.mockResolvedValue({});

    const handler = await loadHandler();
    const result = await handler();

    expect(result).toBeUndefined();
  });
});
