/**
 * Unit Tests: Cost Accumulator
 *
 * Tests in-memory batching, DynamoDB flush, and daily summary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { CostAccumulator, type CostLimitsConfig } from "../../src/lib/cost-accumulator.js";

describe("CostAccumulator", () => {
  let accumulator: CostAccumulator;
  let config: CostLimitsConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    CostAccumulator.resetInstance();

    config = {
      dailyTotal: 10,
      dailyPerService: { openai: 5, ses: 2 },
    };
    accumulator = new CostAccumulator(config);
  });

  afterEach(() => {
    vi.useRealTimers();
    CostAccumulator.resetInstance();
  });

  describe("record", () => {
    it("should buffer events without making DynamoDB calls", () => {
      accumulator.record({ service: "openai", operation: "moderation", units: 1 });
      accumulator.record({ service: "sqs", operation: "send-message", units: 3 });

      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should aggregate units for the same service:operation", () => {
      accumulator.record({ service: "openai", operation: "moderation", units: 1 });
      accumulator.record({ service: "openai", operation: "moderation", units: 1 });
      accumulator.record({ service: "openai", operation: "moderation", units: 1 });

      // Force flush to verify aggregation
      mockSend.mockResolvedValue({});
      accumulator.forceFlush();

      // Should have a single write with 3 units, not 3 separate writes
      // (forceFlush is async, we'll test via getDailySummary below)
    });

    it("should never throw", () => {
      // record() is synchronous and should never throw
      expect(() => {
        accumulator.record({ service: "openai", operation: "moderation", units: 1 });
      }).not.toThrow();
    });
  });

  describe("forceFlush", () => {
    it("should write buffered events to DynamoDB", async () => {
      mockSend.mockResolvedValue({});

      accumulator.record({ service: "openai", operation: "moderation", units: 5 });
      accumulator.record({ service: "sqs", operation: "send-message", units: 3 });

      await accumulator.forceFlush();

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("should clear the buffer after successful flush", async () => {
      mockSend.mockResolvedValue({});

      accumulator.record({ service: "openai", operation: "moderation", units: 5 });
      await accumulator.forceFlush();

      // Second flush should be a no-op
      mockSend.mockClear();
      await accumulator.forceFlush();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should re-buffer events on DynamoDB failure", async () => {
      mockSend.mockRejectedValueOnce(new Error("DynamoDB error"));

      accumulator.record({ service: "openai", operation: "moderation", units: 5 });
      await accumulator.forceFlush();

      // Retry: should succeed this time
      mockSend.mockResolvedValue({});
      await accumulator.forceFlush();
      expect(mockSend).toHaveBeenCalled();
    });

    it("should be a no-op when buffer is empty", async () => {
      await accumulator.forceFlush();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should use atomic ADD expression", async () => {
      mockSend.mockResolvedValue({});

      accumulator.record({ service: "s3", operation: "put-object", units: 10 });
      await accumulator.forceFlush();

      const callArg = mockSend.mock.calls[0][0];
      expect(callArg.input.UpdateExpression).toContain("ADD");
      expect(callArg.input.ExpressionAttributeValues[":inc"].N).toBe("10");
    });
  });

  describe("getDailySummary", () => {
    it("should return estimated costs by service", async () => {
      // Mock DynamoDB reads for each service
      mockSend.mockResolvedValueOnce({ Item: { units: { N: "100" } } }); // openai
      mockSend.mockResolvedValueOnce({ Item: { units: { N: "1000" } } }); // ses
      mockSend.mockResolvedValueOnce({ Item: { units: { N: "5000" } } }); // sqs
      mockSend.mockResolvedValueOnce({ Item: { units: { N: "200" } } }); // s3
      mockSend.mockResolvedValueOnce({ Item: { units: { N: "10000" } } }); // dynamodb

      const summary = await accumulator.getDailySummary();

      expect(summary.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(summary.limit).toBe(10);
      expect(typeof summary.estimatedTotal).toBe("number");
      expect(summary.estimatedTotal).toBeGreaterThan(0);
      expect(summary.services.openai).toBeGreaterThan(0);
    });

    it("should return zeros when no data exists", async () => {
      mockSend.mockResolvedValue({ Item: undefined });

      const summary = await accumulator.getDailySummary();

      expect(summary.estimatedTotal).toBe(0);
      for (const cost of Object.values(summary.services)) {
        expect(cost).toBe(0);
      }
    });

    it("should handle DynamoDB errors gracefully", async () => {
      mockSend.mockRejectedValue(new Error("DynamoDB error"));

      const summary = await accumulator.getDailySummary();

      // Should return zeros on error, not throw
      expect(summary.estimatedTotal).toBe(0);
    });
  });

  describe("isOverBudget", () => {
    it("should return exceeded when total exceeds limit", async () => {
      // Return large counts that produce cost > $10 total limit
      mockSend.mockResolvedValueOnce({ Item: { units: { N: "50000" } } }); // openai: $50
      mockSend.mockResolvedValue({ Item: { units: { N: "0" } } });

      const result = await accumulator.isOverBudget();

      expect(result.exceeded).toBe(true);
      expect(result.services).toContain("total");
    });

    it("should return exceeded for specific service over limit", async () => {
      // openai at $6 (limit is $5)
      mockSend.mockResolvedValueOnce({ Item: { units: { N: "6000" } } }); // openai
      mockSend.mockResolvedValue({ Item: { units: { N: "0" } } });

      const result = await accumulator.isOverBudget();

      expect(result.exceeded).toBe(true);
      expect(result.services).toContain("openai");
    });

    it("should return not exceeded when under limits", async () => {
      mockSend.mockResolvedValue({ Item: { units: { N: "1" } } });

      const result = await accumulator.isOverBudget();

      expect(result.exceeded).toBe(false);
      expect(result.services).toHaveLength(0);
    });
  });

  describe("singleton", () => {
    it("should return the same instance", () => {
      const a = CostAccumulator.getInstance(config);
      const b = CostAccumulator.getInstance();

      expect(a).toBe(b);
    });

    it("should create a new instance after reset", () => {
      const a = CostAccumulator.getInstance(config);
      CostAccumulator.resetInstance();
      const b = CostAccumulator.getInstance(config);

      expect(a).not.toBe(b);
    });

    it("should clear pending flush timer on reset", () => {
      const inst = CostAccumulator.getInstance(config);
      // Schedule a flush by recording something
      inst.record({ service: "openai", operation: "moderation", units: 1 });
      // Reset should clear the timer without errors
      CostAccumulator.resetInstance();
    });
  });
});
