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

import { handler } from "../../../src/lambda/tools/search-logs.js";

describe("search-logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("returns results with default query", async () => {
    mockSend
      .mockResolvedValueOnce({ queryId: "q-123" })
      .mockResolvedValueOnce({
        status: "Complete",
        results: [
          [
            { field: "@timestamp", value: "2026-03-18T00:00:00Z" },
            { field: "@message", value: "ERROR something" },
          ],
        ],
        statistics: { recordsMatched: 1 },
      });

    const result = await handler({});

    expect(result.status).toBe("Complete");
    expect(result.matchCount).toBe(1);
    expect(result.results).toEqual([
      { "@timestamp": "2026-03-18T00:00:00Z", "@message": "ERROR something" },
    ]);

    const startCall = mockSend.mock.calls[0][0];
    expect(startCall.input.logGroupName).toBe("/trellis/dev/api");
    expect(startCall.input.queryString).toContain("limit 50");
  });

  it("appends | limit when custom query is missing one", async () => {
    mockSend
      .mockResolvedValueOnce({ queryId: "q-456" })
      .mockResolvedValueOnce({ status: "Complete", results: [], statistics: {} });

    await handler({ query: "fields @message | sort @timestamp desc" });

    const startCall = mockSend.mock.calls[0][0];
    expect(startCall.input.queryString).toBe(
      "fields @message | sort @timestamp desc | limit 100",
    );
  });

  it("does not modify custom query that already has | limit", async () => {
    mockSend
      .mockResolvedValueOnce({ queryId: "q-789" })
      .mockResolvedValueOnce({ status: "Complete", results: [], statistics: {} });

    const query = "fields @message | limit 10";
    await handler({ query });

    const startCall = mockSend.mock.calls[0][0];
    expect(startCall.input.queryString).toBe(query);
  });

  it("caps minutes at 120", async () => {
    mockSend
      .mockResolvedValueOnce({ queryId: "q-cap" })
      .mockResolvedValueOnce({ status: "Complete", results: [], statistics: {} });

    await handler({ minutes: 999 });

    const startCall = mockSend.mock.calls[0][0];
    const timeRange = startCall.input.endTime - startCall.input.startTime;
    expect(timeRange).toBeLessThanOrEqual(120 * 60 + 1);
    expect(timeRange).toBeGreaterThanOrEqual(120 * 60 - 1);
  });

  it("returns timeout status after max poll iterations", async () => {
    mockSend.mockResolvedValueOnce({ queryId: "q-slow" });
    for (let i = 0; i < 10; i++) {
      mockSend.mockResolvedValueOnce({ status: "Running" });
    }

    const result = await handler({});

    expect(result.status).toBe("Timeout");
    expect(result.queryId).toBe("q-slow");
  }, 30000);

  it("throws when query status is Failed", async () => {
    mockSend
      .mockResolvedValueOnce({ queryId: "q-fail" })
      .mockResolvedValueOnce({ status: "Failed" });

    await expect(handler({})).rejects.toThrow("Query Failed");
  });

  it("throws when queryId is missing", async () => {
    mockSend.mockResolvedValueOnce({});

    await expect(handler({})).rejects.toThrow(
      "Failed to start CloudWatch Logs Insights query",
    );
  });
});
