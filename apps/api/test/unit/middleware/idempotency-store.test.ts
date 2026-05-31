/**
 * Unit Tests: Idempotency Store (DynamoIdempotencyStore)
 *
 * Tests the DynamoDB-backed store for idempotency records.
 * DynamoDBClient is mocked at the sdk level.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPk,
  isInFlight,
  IDEMPOTENCY_TTL_SECONDS,
  IN_FLIGHT_SENTINEL,
  DynamoIdempotencyStore,
  type IdempotencyRecord,
  type StoredRecord,
} from "../../../src/lib/middleware/idempotency-store.js";

// ─── Mock DynamoDB client ────────────────────────────────────────────────────

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-dynamodb")>();
  return {
    ...actual,
    DynamoDBClient: class {
      send = mockSend;
    },
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    pk: "idem#test-key",
    requestHash: "abc123",
    responseStatus: 200,
    responseBody: '{"ok":true}',
    responseHeaders: { "content-type": "application/json" },
    expiresAt: nowSec + IDEMPOTENCY_TTL_SECONDS,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildPk", () => {
  it("prefixes with idem# and a default 'anon' scope when no scope is supplied", () => {
    expect(buildPk("my-key")).toBe("idem#anon#my-key");
  });

  it("includes the supplied scope in the pk", () => {
    expect(buildPk("my-key", "t:tenant-a")).toBe("idem#t:tenant-a#my-key");
  });

  it("handles UUIDs in both the key and the scope", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(buildPk(uuid, "t:abc")).toBe(`idem#t:abc#${uuid}`);
  });

  it("HIGH-1: same raw key with different scopes produces distinct pks", () => {
    const a = buildPk("Idemp-Key-Reused", "t:tenant-a");
    const b = buildPk("Idemp-Key-Reused", "t:tenant-b");
    expect(a).not.toBe(b);
  });

  it("sanitises scope so unusual characters cannot collide with another scope", () => {
    // A scope with a `#` could otherwise nest into the existing pk
    // structure; the sanitiser collapses such characters to underscores.
    const a = buildPk("k", "t:legit");
    const b = buildPk("k", "t#legit");
    expect(a).not.toBe(b);
    expect(b).toMatch(/^idem#t_legit#k$/);
  });
});

describe("isInFlight", () => {
  it("returns true for in-flight sentinel record", () => {
    const r: StoredRecord = {
      pk: "idem#k",
      requestHash: "h",
      responseStatus: 0,
      responseBody: IN_FLIGHT_SENTINEL,
      responseHeaders: {},
      expiresAt: Math.floor(Date.now() / 1000) + 100,
    };
    expect(isInFlight(r)).toBe(true);
  });

  it("returns false for a resolved record", () => {
    const r = makeRecord();
    expect(isInFlight(r)).toBe(false);
  });
});

describe("IDEMPOTENCY_TTL_SECONDS", () => {
  it("equals 24 hours", () => {
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
  });
});

describe("DynamoIdempotencyStore", () => {
  let store: DynamoIdempotencyStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new DynamoIdempotencyStore("test-idempotency-table");
  });

  // ── get ────────────────────────────────────────────────────────────────────

  describe("get", () => {
    it("returns null when item not found", async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });
      const result = await store.get("idem#missing");
      expect(result).toBeNull();
    });

    it("returns unmarshalled record when found", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const record = makeRecord({ expiresAt: nowSec + 3600 });
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: record.pk },
          requestHash: { S: record.requestHash },
          responseStatus: { N: String(record.responseStatus) },
          responseBody: { S: record.responseBody },
          responseHeaders: { M: {} },
          expiresAt: { N: String(record.expiresAt) },
        },
      });
      const result = await store.get("idem#test-key");
      expect(result).not.toBeNull();
      expect(result?.pk).toBe(record.pk);
    });

    it("returns null for expired record (client-side TTL enforcement)", async () => {
      const pastSec = Math.floor(Date.now() / 1000) - 1;
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: "idem#test-key" },
          requestHash: { S: "h" },
          responseStatus: { N: "200" },
          responseBody: { S: '{"ok":true}' },
          responseHeaders: { M: {} },
          expiresAt: { N: String(pastSec) },
        },
      });
      const result = await store.get("idem#test-key");
      expect(result).toBeNull();
    });
  });

  // ── putIfAbsent ────────────────────────────────────────────────────────────

  describe("putIfAbsent", () => {
    it("returns true when conditional write succeeds", async () => {
      mockSend.mockResolvedValueOnce({});
      const record = makeRecord();
      const result = await store.putIfAbsent(record);
      expect(result).toBe(true);
    });

    it("returns false on ConditionalCheckFailedException", async () => {
      const { ConditionalCheckFailedException } = await import("@aws-sdk/client-dynamodb");
      const err = new ConditionalCheckFailedException({ message: "Condition failed", $metadata: {} });
      mockSend.mockRejectedValueOnce(err);
      const record = makeRecord();
      const result = await store.putIfAbsent(record);
      expect(result).toBe(false);
    });

    it("re-throws non-conditional errors", async () => {
      mockSend.mockRejectedValueOnce(new Error("DynamoDB unavailable"));
      const record = makeRecord();
      await expect(store.putIfAbsent(record)).rejects.toThrow("DynamoDB unavailable");
    });
  });

  // ── resolve ────────────────────────────────────────────────────────────────

  describe("resolve", () => {
    it("puts the resolved record unconditionally", async () => {
      mockSend.mockResolvedValueOnce({});
      const record = makeRecord({ responseStatus: 201 });
      await store.resolve(record);
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("propagates DynamoDB errors", async () => {
      mockSend.mockRejectedValueOnce(new Error("write failed"));
      await expect(store.resolve(makeRecord())).rejects.toThrow("write failed");
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("sends a DeleteItemCommand", async () => {
      mockSend.mockResolvedValueOnce({});
      await store.delete("idem#k");
      expect(mockSend).toHaveBeenCalledOnce();
    });
  });
});
