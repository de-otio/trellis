import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend } = vi.hoisted(() => {
  process.env.STAGE = "dev";
  process.env.DYNAMODB_TABLE = "dev-trellis";
  process.env.AWS_REGION = "us-east-1";
  return { mockSend: vi.fn() };
});

vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: class { send = mockSend; },
  StartQueryCommand: class { input: any; constructor(input: any) { this.input = input; } },
  GetQueryResultsCommand: class { input: any; constructor(input: any) { this.input = input; } },
}));

import { handler } from "../../../src/lambda/tools/get-errors.js";

describe("get-errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns errorCount and topErrors array", async () => {
    mockSend
      .mockResolvedValueOnce({ queryId: "q-err-1" })
      .mockResolvedValueOnce({
        status: "Complete",
        results: [
          [
            { field: "@message", value: "NullPointerException" },
            { field: "errorCount", value: "15" },
          ],
          [
            { field: "@message", value: "TimeoutError" },
            { field: "errorCount", value: "7" },
          ],
        ],
      });

    const result = await handler({ minutes: 30 });

    expect(result.errorCount).toBe(22);
    expect(result.topErrors).toEqual([
      { message: "NullPointerException", count: 15 },
      { message: "TimeoutError", count: 7 },
    ]);
    expect(result.periodMinutes).toBe(30);
  });

  it("caps minutes at 120", async () => {
    mockSend
      .mockResolvedValueOnce({ queryId: "q-cap" })
      .mockResolvedValueOnce({ status: "Complete", results: [] });

    const result = await handler({ minutes: 500 });
    expect(result.periodMinutes).toBe(120);
  });

  it("returns errorCount 0 for empty results", async () => {
    mockSend
      .mockResolvedValueOnce({ queryId: "q-empty" })
      .mockResolvedValueOnce({ status: "Complete", results: [] });

    const result = await handler({});
    expect(result.errorCount).toBe(0);
    expect(result.topErrors).toEqual([]);
  });

  it("throws on query failure", async () => {
    mockSend
      .mockResolvedValueOnce({ queryId: "q-fail" })
      .mockResolvedValueOnce({ status: "Failed" });

    await expect(handler({})).rejects.toThrow("Query Failed");
  });

  it("throws on query timeout after polling", async () => {
    mockSend.mockResolvedValueOnce({ queryId: "q-timeout" });
    for (let i = 0; i < 10; i++) {
      mockSend.mockResolvedValueOnce({ status: "Running" });
    }

    await expect(handler({})).rejects.toThrow("Query timed out after polling");
  }, 30000);
});
