/**
 * Unit Tests: Followers Events
 *
 * Tests for Phase 6: Secure event structure for followers feature
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFollowEvent,
  validateFollowEvent,
  processFollowEvent,
  type FollowEvent,
} from "../../src/lib/followers-events.js";

// Mock extensions registry
vi.mock("../../src/extensions", () => ({
  extensions: [],
  getExtension: vi.fn((entityType: string) => {
    if (entityType === "dog") return { id: "dog" };
    return undefined;
  }),
}));

describe("createFollowEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create a valid follow_created event", () => {
    const followerId = "123e4567-e89b-12d3-a456-426614174000";
    const targetId = "123e4567-e89b-12d3-a456-426614174001";
    const event = createFollowEvent(
      "follow_created",
      followerId,
      "user",
      targetId,
    );

    expect(event.type).toBe("follow_created");
    expect(event.followerId).toBe(followerId);
    expect(event.targetType).toBe("user");
    expect(event.targetId).toBe(targetId);
    expect(event.timestamp).toBeGreaterThan(0);
    expect(event.nonce).toBeDefined();
    expect(event.nonce.length).toBeGreaterThan(0);
  });

  it("should create a valid follow_deleted event", () => {
    const followerId = "123e4567-e89b-12d3-a456-426614174000";
    const targetId = "123e4567-e89b-12d3-a456-426614174001";
    const event = createFollowEvent(
      "follow_deleted",
      followerId,
      "dog",
      targetId,
    );

    expect(event.type).toBe("follow_deleted");
    expect(event.followerId).toBe(followerId);
    expect(event.targetType).toBe("dog");
    expect(event.targetId).toBe(targetId);
    expect(event.timestamp).toBeGreaterThan(0);
    expect(event.nonce).toBeDefined();
  });

  it("should generate unique nonces", () => {
    const followerId = "123e4567-e89b-12d3-a456-426614174000";
    const targetId = "123e4567-e89b-12d3-a456-426614174001";
    const event1 = createFollowEvent(
      "follow_created",
      followerId,
      "user",
      targetId,
    );
    const event2 = createFollowEvent(
      "follow_created",
      followerId,
      "user",
      targetId,
    );

    expect(event1.nonce).not.toBe(event2.nonce);
  });

  it("should throw error for empty followerId", () => {
    expect(() => {
      createFollowEvent(
        "follow_created",
        "",
        "user",
        "123e4567-e89b-12d3-a456-426614174001",
      );
    }).toThrow("Invalid followerId");
  });

  it("should throw error for invalid targetType", () => {
    const followerId = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => {
      createFollowEvent(
        "follow_created",
        followerId,
        "invalid" as any,
        "target-id",
      );
    }).toThrow("Invalid targetType");
  });

  it("should throw error for empty targetId", () => {
    const followerId = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => {
      createFollowEvent("follow_created", followerId, "user", "");
    }).toThrow("Invalid targetId");
  });

  it("should throw error for invalid followerId format (not UUID)", () => {
    expect(() => {
      createFollowEvent(
        "follow_created",
        "not-a-uuid",
        "user",
        "123e4567-e89b-12d3-a456-426614174001",
      );
    }).toThrow("Invalid followerId format");
  });

  it("should accept valid UUID formats", () => {
    const validUuids = [
      "123e4567-e89b-12d3-a456-426614174000",
      "123E4567-E89B-12D3-A456-426614174000", // Uppercase
      "00000000-0000-0000-0000-000000000000",
    ];

    validUuids.forEach((uuid) => {
      const event = createFollowEvent(
        "follow_created",
        uuid,
        "user",
        "123e4567-e89b-12d3-a456-426614174001",
      );
      expect(event.followerId).toBe(uuid);
    });
  });
});

describe("validateFollowEvent", () => {
  const validEvent: FollowEvent = {
    type: "follow_created",
    followerId: "123e4567-e89b-12d3-a456-426614174000",
    targetType: "user",
    targetId: "123e4567-e89b-12d3-a456-426614174001",
    timestamp: Date.now(),
    nonce: "test-nonce-12345",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should validate a valid event", () => {
    const sessionUserId = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => {
      validateFollowEvent(validEvent, sessionUserId);
    }).not.toThrow();
  });

  it("should throw error for invalid event structure", () => {
    const sessionUserId = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => {
      validateFollowEvent(null as any, sessionUserId);
    }).toThrow("Invalid event structure");
  });

  it("should throw error for invalid event type", () => {
    const invalidEvent = { ...validEvent, type: "invalid_type" as any };
    const sessionUserId = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => {
      validateFollowEvent(invalidEvent, sessionUserId);
    }).toThrow("Invalid event type");
  });

  it("should throw error for userId mismatch", () => {
    const sessionUserId = "123e4567-e89b-12d3-a456-426614174999";
    expect(() => {
      validateFollowEvent(validEvent, sessionUserId);
    }).toThrow("Event userId mismatch");
  });

  it("should throw error for invalid targetType", () => {
    const invalidEvent = { ...validEvent, targetType: "invalid" as any };
    const sessionUserId = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => {
      validateFollowEvent(invalidEvent, sessionUserId);
    }).toThrow("Invalid targetType");
  });

  it("should throw error for empty targetId", () => {
    const invalidEvent = { ...validEvent, targetId: "" };
    const sessionUserId = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => {
      validateFollowEvent(invalidEvent, sessionUserId);
    }).toThrow("Invalid targetId");
  });

  it("should throw error for invalid followerId format", () => {
    const invalidEvent = { ...validEvent, followerId: "not-a-uuid" };
    const sessionUserId = "not-a-uuid";
    expect(() => {
      validateFollowEvent(invalidEvent, sessionUserId);
    }).toThrow("Invalid followerId format");
  });

  it("should throw error for old timestamp (replay attack)", () => {
    const oldEvent = {
      ...validEvent,
      timestamp: Date.now() - 400000, // 6+ minutes ago
    };
    const sessionUserId = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => {
      validateFollowEvent(oldEvent, sessionUserId, 300000); // 5 minutes max age
    }).toThrow("Invalid timestamp");
  });

  it("should throw error for future timestamp", () => {
    const futureEvent = {
      ...validEvent,
      timestamp: Date.now() + 2000, // 2 seconds in future
    };
    const sessionUserId = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => {
      validateFollowEvent(futureEvent, sessionUserId);
    }).toThrow("Invalid timestamp");
  });

  it("should accept events within maxAge", () => {
    const recentEvent = {
      ...validEvent,
      timestamp: Date.now() - 100000, // 100 seconds ago
    };
    const sessionUserId = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => {
      validateFollowEvent(recentEvent, sessionUserId, 300000); // 5 minutes max age
    }).not.toThrow();
  });

  it("should throw error for invalid nonce", () => {
    const invalidEvent = { ...validEvent, nonce: "short" }; // Too short
    const sessionUserId = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => {
      validateFollowEvent(invalidEvent, sessionUserId);
    }).toThrow("Invalid nonce");
  });

  it("should throw error for missing nonce", () => {
    const invalidEvent = { ...validEvent, nonce: "" };
    const sessionUserId = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => {
      validateFollowEvent(invalidEvent, sessionUserId);
    }).toThrow("Invalid nonce");
  });
});

describe("processFollowEvent", () => {
  const validEvent: FollowEvent = {
    type: "follow_created",
    followerId: "123e4567-e89b-12d3-a456-426614174000",
    targetType: "user",
    targetId: "123e4567-e89b-12d3-a456-426614174001",
    timestamp: Date.now(),
    nonce: "test-nonce-12345",
  };

  let mockEnv: any;
  let mockProcessor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessor = vi.fn().mockResolvedValue(undefined);
    mockEnv = {
      FOLLOWERS_KV: {
        get: vi.fn(),
        put: vi.fn(),
      },
    };
  });

  it("should process a new event", async () => {
    mockEnv.FOLLOWERS_KV.get.mockResolvedValue(null); // Not processed yet

    await processFollowEvent(validEvent, mockEnv, mockProcessor);

    expect(mockProcessor).toHaveBeenCalledTimes(1);
    expect(mockProcessor).toHaveBeenCalledWith(validEvent);
    expect(mockEnv.FOLLOWERS_KV.get).toHaveBeenCalledWith(
      "event:test-nonce-12345",
    );
    expect(mockEnv.FOLLOWERS_KV.put).toHaveBeenCalledWith(
      "event:test-nonce-12345",
      "processed",
      { expirationTtl: 3600 },
    );
  });

  it("should skip already processed events (idempotency)", async () => {
    mockEnv.FOLLOWERS_KV.get.mockResolvedValue("processed"); // Already processed

    await processFollowEvent(validEvent, mockEnv, mockProcessor);

    expect(mockProcessor).not.toHaveBeenCalled();
    expect(mockEnv.FOLLOWERS_KV.put).not.toHaveBeenCalled();
      });

  it("should throw error for old events", async () => {
    const oldEvent = {
      ...validEvent,
      timestamp: Date.now() - 400000, // 6+ minutes ago
    };
    mockEnv.FOLLOWERS_KV.get.mockResolvedValue(null);

    await expect(
      processFollowEvent(oldEvent, mockEnv, mockProcessor),
    ).rejects.toThrow("Event too old");

    expect(mockProcessor).not.toHaveBeenCalled();
      });

  it("should throw error for invalid event data", async () => {
    const invalidEvent = {
      ...validEvent,
      followerId: "", // Invalid
    };
    mockEnv.FOLLOWERS_KV.get.mockResolvedValue(null);

    await expect(
      processFollowEvent(invalidEvent, mockEnv, mockProcessor),
    ).rejects.toThrow("Invalid event data");

    expect(mockProcessor).not.toHaveBeenCalled();
  });

  it("should handle processor errors", async () => {
    const processorError = new Error("Processing failed");
    mockProcessor.mockRejectedValue(processorError);
    mockEnv.FOLLOWERS_KV.get.mockResolvedValue(null);

    await expect(
      processFollowEvent(validEvent, mockEnv, mockProcessor),
    ).rejects.toThrow("Processing failed");

    expect(mockProcessor).toHaveBeenCalledTimes(1);
    expect(mockEnv.FOLLOWERS_KV.put).not.toHaveBeenCalled(); // Should not mark as processed on error
      });

  it("should work without KV (fallback)", async () => {
    const envWithoutKV = {};

    await processFollowEvent(validEvent, envWithoutKV, mockProcessor);

    expect(mockProcessor).toHaveBeenCalledTimes(1);
    expect(mockProcessor).toHaveBeenCalledWith(validEvent);
  });

  it("should validate event structure in consumer", async () => {
    const invalidEvent = {
      type: "follow_created",
      // Missing required fields
    } as any;
    mockEnv.FOLLOWERS_KV.get.mockResolvedValue(null);

    await expect(
      processFollowEvent(invalidEvent, mockEnv, mockProcessor),
    ).rejects.toThrow("Invalid event data");

    expect(mockProcessor).not.toHaveBeenCalled();
  });
});
