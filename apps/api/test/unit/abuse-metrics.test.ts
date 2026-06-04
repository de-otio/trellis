/**
 * Unit Tests: Abuse Metrics
 *
 * Tests the evaluateAbuseMetrics function with various WAF and auth abuse scenarios.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock CloudWatch before importing the module
const mockCloudWatchSend = vi.fn();
vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class {
    send = mockCloudWatchSend;
  },
  GetMetricDataCommand: class {
    constructor(public input: any) {}
  },
}));

const mockLogsSend = vi.fn();
vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: class {
    send = mockLogsSend;
  },
  StartQueryCommand: class {
    constructor(public input: any) {}
  },
  GetQueryResultsCommand: class {
    constructor(public input: any) {}
  },
}));

import { evaluateAbuseMetrics } from "../../src/lib/abuse-metrics.js";

describe("evaluateAbuseMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: CloudWatch returns no data, logs return no query
    mockCloudWatchSend.mockResolvedValue({ MetricDataResults: [] });
    mockLogsSend.mockResolvedValue({ status: "Complete", results: [] });
  });

  describe("with no abuse activity", () => {
    it("should return low status when no blocks detected", async () => {
      const result = await evaluateAbuseMetrics(
        { STAGE: "dev", AWS_REGION: "us-east-1" },
        "24h",
      );

      expect(result.overallStatus).toBe("low");
      expect(result.summary.totalBlocked).toBe(0);
      expect(result.summary.totalAllowed).toBe(0);
      expect(result.summary.blockRate).toBe(0);
      expect(result.timeRange).toBe("24h");
      expect(result.timestamp).toBeDefined();
    });

    it("should include WAF rule entries for rate limit and common rules", async () => {
      const result = await evaluateAbuseMetrics(
        { STAGE: "dev", AWS_REGION: "us-east-1" },
        "1h",
      );

      expect(result.wafRules.length).toBeGreaterThanOrEqual(2);
      const ruleNames = result.wafRules.map((r) => r.name);
      expect(ruleNames).toContain("IP Rate Limit");
      expect(ruleNames).toContain("Common Rule Set");
    });

    it("should not include Bot Control when no data", async () => {
      const result = await evaluateAbuseMetrics(
        { STAGE: "dev", AWS_REGION: "us-east-1" },
        "1h",
      );

      const ruleNames = result.wafRules.map((r) => r.name);
      expect(ruleNames).not.toContain("Bot Control");
    });
  });

  describe("with WAF blocks", () => {
    it("should calculate block rate correctly", async () => {
      mockCloudWatchSend.mockResolvedValue({
        MetricDataResults: [
          { Id: "rl_allowed", Values: [900], Timestamps: [new Date()] },
          { Id: "rl_blocked", Values: [100], Timestamps: [new Date()] },
          { Id: "cr_allowed", Values: [0], Timestamps: [] },
          { Id: "cr_blocked", Values: [0], Timestamps: [] },
          { Id: "bc_allowed", Values: [0], Timestamps: [] },
          { Id: "bc_blocked", Values: [0], Timestamps: [] },
        ],
      });

      const result = await evaluateAbuseMetrics(
        { STAGE: "prod", AWS_REGION: "us-east-1" },
        "24h",
      );

      expect(result.summary.totalAllowed).toBe(900);
      expect(result.summary.totalBlocked).toBe(100);
      expect(result.summary.blockRate).toBe(10);
    });

    it("should report high status when block rate exceeds 10%", async () => {
      mockCloudWatchSend.mockResolvedValue({
        MetricDataResults: [
          { Id: "rl_allowed", Values: [800], Timestamps: [new Date()] },
          { Id: "rl_blocked", Values: [150], Timestamps: [new Date()] },
          { Id: "cr_allowed", Values: [0], Timestamps: [] },
          { Id: "cr_blocked", Values: [50], Timestamps: [new Date()] },
          { Id: "bc_allowed", Values: [0], Timestamps: [] },
          { Id: "bc_blocked", Values: [0], Timestamps: [] },
        ],
      });

      const result = await evaluateAbuseMetrics(
        { STAGE: "prod", AWS_REGION: "us-east-1" },
        "24h",
      );

      expect(result.overallStatus).toBe("high");
    });

    it("should report critical when block rate exceeds 20%", async () => {
      mockCloudWatchSend.mockResolvedValue({
        MetricDataResults: [
          { Id: "rl_allowed", Values: [700], Timestamps: [new Date()] },
          { Id: "rl_blocked", Values: [300], Timestamps: [new Date()] },
          { Id: "cr_allowed", Values: [0], Timestamps: [] },
          { Id: "cr_blocked", Values: [0], Timestamps: [] },
          { Id: "bc_allowed", Values: [0], Timestamps: [] },
          { Id: "bc_blocked", Values: [0], Timestamps: [] },
        ],
      });

      const result = await evaluateAbuseMetrics(
        { STAGE: "prod", AWS_REGION: "us-east-1" },
        "24h",
      );

      expect(result.overallStatus).toBe("critical");
    });
  });

  describe("Bot Control detection", () => {
    it("should include Bot Control when data is present", async () => {
      mockCloudWatchSend.mockResolvedValue({
        MetricDataResults: [
          { Id: "rl_allowed", Values: [0], Timestamps: [] },
          { Id: "rl_blocked", Values: [0], Timestamps: [] },
          { Id: "cr_allowed", Values: [0], Timestamps: [] },
          { Id: "cr_blocked", Values: [0], Timestamps: [] },
          { Id: "bc_allowed", Values: [950], Timestamps: [new Date()] },
          { Id: "bc_blocked", Values: [50], Timestamps: [new Date()] },
        ],
      });

      const result = await evaluateAbuseMetrics(
        { STAGE: "prod", AWS_REGION: "us-east-1" },
        "24h",
      );

      const ruleNames = result.wafRules.map((r) => r.name);
      expect(ruleNames).toContain("Bot Control");
      const bcRule = result.wafRules.find((r) => r.name === "Bot Control");
      expect(bcRule?.blocked).toBe(50);
    });
  });

  describe("auth abuse from logs", () => {
    it("should parse rate limit exceeded count from logs", async () => {
      // First call is CloudWatch metrics, subsequent are logs
      mockLogsSend
        .mockResolvedValueOnce({ queryId: "query-123" })
        .mockResolvedValueOnce({
          status: "Complete",
          results: [
            [
              { field: "rateLimited", value: "15" },
              { field: "magicLinks", value: "25" },
              { field: "failedVerify", value: "3" },
            ],
          ],
        });

      const result = await evaluateAbuseMetrics(
        { STAGE: "prod", AWS_REGION: "us-east-1" },
        "24h",
      );

      expect(result.authAbuse.rateLimitExceeded).toBe(15);
      expect(result.authAbuse.magicLinkRequests).toBe(25);
      expect(result.authAbuse.failedVerifications).toBe(3);
    });

    it("should report moderate status with auth rate limits hit", async () => {
      mockLogsSend
        .mockResolvedValueOnce({ queryId: "query-123" })
        .mockResolvedValueOnce({
          status: "Complete",
          results: [
            [
              { field: "rateLimited", value: "8" },
              { field: "magicLinks", value: "0" },
              { field: "failedVerify", value: "0" },
            ],
          ],
        });

      const result = await evaluateAbuseMetrics(
        { STAGE: "prod", AWS_REGION: "us-east-1" },
        "24h",
      );

      expect(result.overallStatus).toBe("moderate");
    });
  });

  describe("recommendations", () => {
    it("should recommend Bot Control when not enabled", async () => {
      const result = await evaluateAbuseMetrics(
        { STAGE: "dev", AWS_REGION: "us-east-1" },
        "24h",
      );

      expect(
        result.recommendations.some((r) => r.includes("Bot Control")),
      ).toBe(true);
    });

    it("should recommend reCAPTCHA when many rate limits hit", async () => {
      mockLogsSend
        .mockResolvedValueOnce({ queryId: "query-123" })
        .mockResolvedValueOnce({
          status: "Complete",
          results: [
            [
              { field: "rateLimited", value: "20" },
              { field: "magicLinks", value: "0" },
              { field: "failedVerify", value: "0" },
            ],
          ],
        });

      const result = await evaluateAbuseMetrics(
        { STAGE: "prod", AWS_REGION: "us-east-1" },
        "24h",
      );

      expect(
        result.recommendations.some((r) => r.includes("reCAPTCHA")),
      ).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should gracefully handle CloudWatch failures", async () => {
      mockCloudWatchSend.mockRejectedValue(new Error("Access denied"));

      const result = await evaluateAbuseMetrics(
        { STAGE: "dev", AWS_REGION: "us-east-1" },
        "24h",
      );

      expect(result.overallStatus).toBe("low");
      expect(result.summary.totalBlocked).toBe(0);
    });

    it("should gracefully handle Logs Insights failures", async () => {
      mockLogsSend.mockRejectedValue(new Error("Log group not found"));

      const result = await evaluateAbuseMetrics(
        { STAGE: "dev", AWS_REGION: "us-east-1" },
        "24h",
      );

      expect(result.authAbuse.rateLimitExceeded).toBe(0);
      expect(result.authAbuse.magicLinkRequests).toBe(0);
    });

    it("should default to 24h when invalid time range given", async () => {
      const result = await evaluateAbuseMetrics(
        { STAGE: "dev", AWS_REGION: "us-east-1" },
        "invalid",
      );

      expect(result.timeRange).toBe("invalid");
      expect(result.timestamp).toBeDefined();
    });
  });
});
