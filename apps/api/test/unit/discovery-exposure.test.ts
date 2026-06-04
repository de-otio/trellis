/**
 * Unit Tests: Discovery Exposure Counters
 *
 * Covers:
 *   (a) Success path — correct DynamoDB key shape and ADD expression
 *   (b) Failure is observable and non-blocking — rejected client →
 *       recordServedRecommendations still resolves, error logged/metric emitted
 *   (c) Handler wiring — response status and body unchanged when recording rejects
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

// ---------------------------------------------------------------------------
// DynamoDB mock — hoisted so it is available before module imports
// ---------------------------------------------------------------------------

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    send = mockSend;
  },
  UpdateItemCommand: class {
    input: unknown;
    constructor(params: unknown) {
      this.input = params;
    }
  },
}));

// ---------------------------------------------------------------------------
// Graph service mock — needed for handler wiring tests
// ---------------------------------------------------------------------------

const { mockGraphService } = vi.hoisted(() => ({
  mockGraphService: {
    getRecommendations: vi.fn(),
  },
}));

vi.mock("../../src/lib/graph", () => ({
  createGraphServiceFromEnv: vi.fn().mockResolvedValue(mockGraphService),
}));

// ---------------------------------------------------------------------------
// discovery-exposure mock override for handler wiring tests
// We import the real module for unit tests (a) and (b), but for (c) we need
// to control whether it rejects.
// ---------------------------------------------------------------------------

// The real module is used for (a)+(b). For (c) we spy on the module export.
import { recordServedRecommendations, currentMonthBucket } from "../../src/lib/discovery-exposure.js";
import { DiscoveryHandler } from "../../src/lib/discovery-handler.js";

// ---------------------------------------------------------------------------
// Tests: recordServedRecommendations (module unit)
// ---------------------------------------------------------------------------

describe("recordServedRecommendations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) Success path — correct key shape
  describe("success path", () => {
    it("calls DynamoDB UpdateItemCommand with correct pk/sk and ADD expression", async () => {
      mockSend.mockResolvedValue({});

      await recordServedRecommendations(["entity-abc"]);

      expect(mockSend).toHaveBeenCalledTimes(1);

      const command = mockSend.mock.calls[0][0];
      const input = (command as { input: Record<string, unknown> }).input;

      const bucket = currentMonthBucket();
      expect(input.Key).toEqual({
        pk: { S: `discexposure:${bucket}:entity-abc` },
        sk: { S: "v" },
      });
      expect(input.UpdateExpression).toBe("ADD #count :inc");
      expect(input.ExpressionAttributeNames).toEqual({ "#count": "count" });
      expect(input.ExpressionAttributeValues).toEqual({ ":inc": { N: "1" } });
    });

    it("issues one increment per entity in the list", async () => {
      mockSend.mockResolvedValue({});

      await recordServedRecommendations(["entity-1", "entity-2", "entity-3"]);

      expect(mockSend).toHaveBeenCalledTimes(3);

      const bucket = currentMonthBucket();
      const pks = mockSend.mock.calls.map(
        (call) => (call[0] as { input: { Key: { pk: { S: string } } } }).input.Key.pk.S,
      );
      expect(pks).toContain(`discexposure:${bucket}:entity-1`);
      expect(pks).toContain(`discexposure:${bucket}:entity-2`);
      expect(pks).toContain(`discexposure:${bucket}:entity-3`);
    });

    it("uses the current UTC month in yyyy-mm format", async () => {
      mockSend.mockResolvedValue({});

      await recordServedRecommendations(["entity-x"]);

      const now = new Date();
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, "0");
      const expectedBucket = `${year}-${month}`;

      const command = mockSend.mock.calls[0][0];
      const pk = (command as { input: { Key: { pk: { S: string } } } }).input.Key.pk.S;
      expect(pk).toBe(`discexposure:${expectedBucket}:entity-x`);
    });

    it("resolves immediately with no DynamoDB calls when given an empty list", async () => {
      await recordServedRecommendations([]);

      expect(mockSend).not.toHaveBeenCalled();
    });

    it("does not set a TTL attribute on the item", async () => {
      mockSend.mockResolvedValue({});

      await recordServedRecommendations(["entity-notl"]);

      const command = mockSend.mock.calls[0][0];
      const input = (command as { input: Record<string, unknown> }).input;

      // UpdateExpression must not reference ttl
      expect(String(input.UpdateExpression)).not.toContain("ttl");
    });
  });

  // (b) Failure is observable and non-blocking
  describe("failure handling", () => {
    it("resolves (does not throw) when DynamoDB rejects", async () => {
      mockSend.mockRejectedValue(new Error("DynamoDB unavailable"));

      // Must not throw — fire-and-forget callers rely on this
      await expect(recordServedRecommendations(["entity-fail"])).resolves.toBeUndefined();
    });

    it("logs a structured stderr line on failure (exposure.record.failure metric)", async () => {
      mockSend.mockRejectedValue(new Error("network timeout"));

      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await recordServedRecommendations(["entity-metric"]);

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const logged = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(logged) as Record<string, unknown>;

      expect(parsed.exposureRecordFailure).toBe(true);
      expect(parsed.metric).toBe("exposure.record.failure");
      expect(typeof parsed.error).toBe("string");

      stderrSpy.mockRestore();
    });

    it("resolves even when all entities fail", async () => {
      mockSend.mockRejectedValue(new Error("table not found"));

      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        recordServedRecommendations(["e1", "e2", "e3"]),
      ).resolves.toBeUndefined();

      stderrSpy.mockRestore();
    });
  });
});

// ---------------------------------------------------------------------------
// currentMonthBucket helper
// ---------------------------------------------------------------------------

describe("currentMonthBucket", () => {
  it("returns yyyy-mm format", () => {
    const result = currentMonthBucket(new Date("2026-06-15T12:00:00Z"));
    expect(result).toBe("2026-06");
  });

  it("zero-pads single-digit months", () => {
    const result = currentMonthBucket(new Date("2026-03-01T00:00:00Z"));
    expect(result).toBe("2026-03");
  });

  it("uses UTC month, not local time", () => {
    // A moment that is still January in UTC but could be February in UTC+13
    const result = currentMonthBucket(new Date("2026-01-31T23:59:59Z"));
    expect(result).toBe("2026-01");
  });
});

// ---------------------------------------------------------------------------
// (c) Handler wiring — response unchanged when recording rejects
// ---------------------------------------------------------------------------

describe("DiscoveryHandler.handleGetRecommendations — exposure wiring", () => {
  let handler: DiscoveryHandler;
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new DiscoveryHandler();
    mockEnv = { DATABASE_URL: "postgresql://test:test@localhost/test" } as unknown as Env;
  });

  function makeSession(userId = "wiring-user-1") {
    return {
      userId,
      email: "u@example.com",
      role: "END_USER" as const,
      expiresAt: Date.now() + 3_600_000,
      sessionType: "user" as const,
      lastActivityAt: Date.now(),
    };
  }

  it("returns 200 with recommendations and exposure recording failure does not affect response", async () => {
    const fakeRecs = [
      { entityId: "dog-1", confidence: 0.9, reason: "shared_connections" as const, sharedCount: 3 },
      { entityId: "dog-2", confidence: 0.7, reason: "same_breed" as const, sharedCount: 0 },
    ];
    mockGraphService.getRecommendations.mockResolvedValue(fakeRecs);
    // Simulate DynamoDB failure in the exposure module
    mockSend.mockRejectedValue(new Error("DynamoDB throttled"));

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const session = makeSession();
    const request = new Request(
      "https://api.example.com/api/discover/recommendations",
      { method: "GET" },
    );

    const response = await handler.handleGetRecommendations(request, session, mockEnv, {} as any);

    // Status and body must be unaffected by the exposure recording failure
    expect(response.status).toBe(200);
    const body = await response.json() as { recommendations: typeof fakeRecs };
    expect(body.recommendations).toEqual(fakeRecs);

    stderrSpy.mockRestore();
  });

  it("returns 200 with empty recommendations when graph returns []", async () => {
    mockGraphService.getRecommendations.mockResolvedValue([]);
    mockSend.mockResolvedValue({});

    const session = makeSession("wiring-user-2");
    const request = new Request(
      "https://api.example.com/api/discover/recommendations",
      { method: "GET" },
    );

    const response = await handler.handleGetRecommendations(request, session, mockEnv, {} as any);

    expect(response.status).toBe(200);
    const body = await response.json() as { recommendations: unknown[] };
    expect(body.recommendations).toEqual([]);
    // Empty list → no DynamoDB calls
    expect(mockSend).not.toHaveBeenCalled();
  });
});
