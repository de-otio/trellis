import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend } = vi.hoisted(() => {
  process.env.STAGE = "dev";
  process.env.DYNAMODB_TABLE = "dev-trellis";
  process.env.AWS_REGION = "us-east-1";
  return { mockSend: vi.fn() };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class { send = mockSend; },
  ScanCommand: class { input: any; constructor(input: any) { this.input = input; } },
}));

import { handler } from "../../../src/lambda/tools/get-feature-flags.js";

describe("get-feature-flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed flags with name, enabled, and updatedAt", async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          pk: { S: "feature-toggle:dark-mode" },
          enabled: { BOOL: true },
          updatedAt: { S: "2026-03-18T00:00:00Z" },
        },
        {
          pk: { S: "feature-toggle:activity-pub" },
          enabled: { BOOL: false },
          updatedAt: { S: "2026-03-17T12:00:00Z" },
        },
      ],
    });

    const result = await handler();

    expect(result.flags).toEqual([
      { name: "dark-mode", enabled: true, updatedAt: "2026-03-18T00:00:00Z" },
      { name: "activity-pub", enabled: false, updatedAt: "2026-03-17T12:00:00Z" },
    ]);
  });

  it("returns empty array when scan returns no items", async () => {
    mockSend.mockResolvedValueOnce({ Items: undefined });

    const result = await handler();
    expect(result.flags).toEqual([]);
  });

  it("uses defaults for missing fields", async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ pk: {} }],
    });

    const result = await handler();
    expect(result.flags).toEqual([
      { name: "unknown", enabled: false, updatedAt: null },
    ]);
  });
});
