/**
 * Unit Tests: OpenAI Budget
 *
 * Tests the atomic counter-based budget limiter for OpenAI API calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend } = vi.hoisted(() => {
  const mockSend = vi.fn();
  return { mockSend };
});

vi.mock("@aws-sdk/client-dynamodb", () => {
  return {
    DynamoDBClient: class { send = mockSend; },
    UpdateItemCommand: class { input: any; constructor(params: any) { this.input = params; } },
    GetItemCommand: class { input: any; constructor(params: any) { this.input = params; } },
  };
});

import { OpenAiBudget, type OpenAiBudgetConfig } from "../../src/lib/openai-budget.js";

describe("OpenAiBudget", () => {
  let config: OpenAiBudgetConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      enabled: true,
      maxRequestsPerHour: 100,
      maxRequestsPerDay: 500,
    };
  });

  describe("tryConsume", () => {
    it("should allow calls when under budget", async () => {
      // First call: hourly increment returns 1
      mockSend.mockResolvedValueOnce({
        Attributes: { count: { N: "1" } },
      });
      // Second call: daily increment returns 1
      mockSend.mockResolvedValueOnce({
        Attributes: { count: { N: "1" } },
      });

      const budget = new OpenAiBudget(config);
      const allowed = await budget.tryConsume();

      expect(allowed).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("should block when hourly limit exceeded", async () => {
      mockSend.mockResolvedValueOnce({
        Attributes: { count: { N: "101" } },
      });

      const budget = new OpenAiBudget(config);
      const allowed = await budget.tryConsume();

      expect(allowed).toBe(false);
      // Should not increment daily counter
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("should block when daily limit exceeded", async () => {
      // Hourly OK
      mockSend.mockResolvedValueOnce({
        Attributes: { count: { N: "50" } },
      });
      // Daily exceeded
      mockSend.mockResolvedValueOnce({
        Attributes: { count: { N: "501" } },
      });

      const budget = new OpenAiBudget(config);
      const allowed = await budget.tryConsume();

      expect(allowed).toBe(false);
    });

    it("should fail-open when DynamoDB errors", async () => {
      mockSend.mockRejectedValueOnce(new Error("DynamoDB unavailable"));

      const budget = new OpenAiBudget(config);
      const allowed = await budget.tryConsume();

      expect(allowed).toBe(true);
    });

    it("should bypass all checks when disabled", async () => {
      config.enabled = false;

      const budget = new OpenAiBudget(config);
      const allowed = await budget.tryConsume();

      expect(allowed).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should allow calls at exactly the limit", async () => {
      // Exactly at hourly limit (100) — should be allowed
      mockSend.mockResolvedValueOnce({
        Attributes: { count: { N: "100" } },
      });
      mockSend.mockResolvedValueOnce({
        Attributes: { count: { N: "100" } },
      });

      const budget = new OpenAiBudget(config);
      const allowed = await budget.tryConsume();

      expect(allowed).toBe(true);
    });

    it("should use correct TTL for hourly counter (2 hours)", async () => {
      mockSend.mockResolvedValueOnce({ Attributes: { count: { N: "1" } } });
      mockSend.mockResolvedValueOnce({ Attributes: { count: { N: "1" } } });

      const budget = new OpenAiBudget(config);
      await budget.tryConsume();

      const firstCall = mockSend.mock.calls[0][0];
      const ttlValue = parseInt(firstCall.input.ExpressionAttributeValues[":ttl"].N, 10);
      const nowEpoch = Math.floor(Date.now() / 1000);
      // TTL should be ~2 hours from now (within 5s tolerance)
      expect(ttlValue).toBeGreaterThan(nowEpoch + 7195);
      expect(ttlValue).toBeLessThan(nowEpoch + 7205);
    });
  });

  describe("getStatus", () => {
    it("should return current counters", async () => {
      mockSend.mockResolvedValueOnce({
        Item: { count: { N: "42" } },
      });
      mockSend.mockResolvedValueOnce({
        Item: { count: { N: "350" } },
      });

      const budget = new OpenAiBudget(config);
      const status = await budget.getStatus();

      expect(status.hourlyUsed).toBe(42);
      expect(status.dailyUsed).toBe(350);
      expect(status.hourlyLimit).toBe(100);
      expect(status.dailyLimit).toBe(500);
      expect(status.exceeded).toBe(false);
    });

    it("should report exceeded when hourly limit reached", async () => {
      mockSend.mockResolvedValueOnce({ Item: { count: { N: "100" } } });
      mockSend.mockResolvedValueOnce({ Item: { count: { N: "100" } } });

      const budget = new OpenAiBudget(config);
      const status = await budget.getStatus();

      expect(status.exceeded).toBe(true);
    });

    it("should report exceeded when daily limit reached", async () => {
      mockSend.mockResolvedValueOnce({ Item: { count: { N: "10" } } });
      mockSend.mockResolvedValueOnce({ Item: { count: { N: "500" } } });

      const budget = new OpenAiBudget(config);
      const status = await budget.getStatus();

      expect(status.exceeded).toBe(true);
    });

    it("should return zeros when disabled", async () => {
      config.enabled = false;

      const budget = new OpenAiBudget(config);
      const status = await budget.getStatus();

      expect(status.hourlyUsed).toBe(0);
      expect(status.dailyUsed).toBe(0);
      expect(status.exceeded).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should return zeros on DynamoDB error", async () => {
      mockSend.mockRejectedValueOnce(new Error("DynamoDB error"));

      const budget = new OpenAiBudget(config);
      const status = await budget.getStatus();

      expect(status.hourlyUsed).toBe(0);
      expect(status.exceeded).toBe(false);
    });

    it("should handle missing counter items", async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const budget = new OpenAiBudget(config);
      const status = await budget.getStatus();

      expect(status.hourlyUsed).toBe(0);
      expect(status.dailyUsed).toBe(0);
    });
  });
});
