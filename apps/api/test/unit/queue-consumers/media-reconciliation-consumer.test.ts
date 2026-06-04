/**
 * Unit Tests: Media Reconciliation Queue Consumer
 *
 * Verifies the ack/retry DLQ contract:
 *  - Success  → reconcileBatch called with message bodies, ackAll called, retryAll NOT called
 *  - Failure  → retryAll called, ackAll NOT called, function does NOT throw
 *  - Empty    → reconcileBatch called with [], ackAll called (no crash)
 *  - Env      → MediaReconciliationService constructed with the env argument
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock primitives — must be available before vi.mock factories run
// ---------------------------------------------------------------------------
const { reconcileBatchMock, mockLoggerInfo, mockLoggerError } = vi.hoisted(() => ({
  reconcileBatchMock: vi.fn<[], Promise<void>>(),
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Capture the env passed to MediaReconciliationService constructor
let capturedEnv: unknown;

vi.mock("../../../src/lib/services/media-reconciliation-service", () => ({
  MediaReconciliationService: class {
    constructor(env: unknown) {
      capturedEnv = env;
    }
    reconcileBatch = reconcileBatchMock;
  },
}));

vi.mock("../../../src/lib/logger", () => ({
  getLogger: () => ({
    info: mockLoggerInfo,
    error: mockLoggerError,
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  Logger: class {},
}));

// ---------------------------------------------------------------------------
// Module under test (import AFTER mocks are registered)
// ---------------------------------------------------------------------------
import { handleMediaReconciliation } from "../../../src/lib/queue-consumers/media-reconciliation-consumer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBatch(
  bodies: Record<string, unknown>[] = [
    { batchId: "batch-1", uploads: [{ contentHash: "abc123" }] },
    { batchId: "batch-2", uploads: [{ contentHash: "def456" }] },
  ],
) {
  return {
    messages: bodies.map((body) => ({ body })),
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

const env = {} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleMediaReconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEnv = undefined;
  });

  describe("SUCCESS: reconcileBatch resolves", () => {
    it("calls reconcileBatch once with the array of message bodies (in order)", async () => {
      reconcileBatchMock.mockResolvedValue(undefined);
      const batch = makeBatch();

      await handleMediaReconciliation(batch as any, env);

      expect(reconcileBatchMock).toHaveBeenCalledOnce();
      expect(reconcileBatchMock).toHaveBeenCalledWith([
        batch.messages[0].body,
        batch.messages[1].body,
      ]);
    });

    it("calls batch.ackAll() once on success", async () => {
      reconcileBatchMock.mockResolvedValue(undefined);
      const batch = makeBatch();

      await handleMediaReconciliation(batch as any, env);

      expect(batch.ackAll).toHaveBeenCalledOnce();
    });

    it("does NOT call batch.retryAll() on success", async () => {
      reconcileBatchMock.mockResolvedValue(undefined);
      const batch = makeBatch();

      await handleMediaReconciliation(batch as any, env);

      expect(batch.retryAll).not.toHaveBeenCalled();
    });
  });

  describe("FAILURE: reconcileBatch rejects", () => {
    it("calls batch.retryAll() once on failure", async () => {
      reconcileBatchMock.mockRejectedValue(new Error("db exploded"));
      const batch = makeBatch();

      await handleMediaReconciliation(batch as any, env);

      expect(batch.retryAll).toHaveBeenCalledOnce();
    });

    it("does NOT call batch.ackAll() on failure", async () => {
      reconcileBatchMock.mockRejectedValue(new Error("db exploded"));
      const batch = makeBatch();

      await handleMediaReconciliation(batch as any, env);

      expect(batch.ackAll).not.toHaveBeenCalled();
    });

    it("does NOT throw (swallows error so SQS redelivers → DLQ after max retries)", async () => {
      reconcileBatchMock.mockRejectedValue(new Error("network timeout"));
      const batch = makeBatch();

      // If the function throws, this assertion itself would fail
      await expect(
        handleMediaReconciliation(batch as any, env),
      ).resolves.toBeUndefined();
    });
  });

  describe("EMPTY BATCH: messages = []", () => {
    it("calls reconcileBatch with an empty array", async () => {
      reconcileBatchMock.mockResolvedValue(undefined);
      const batch = makeBatch([]);

      await handleMediaReconciliation(batch as any, env);

      expect(reconcileBatchMock).toHaveBeenCalledOnce();
      expect(reconcileBatchMock).toHaveBeenCalledWith([]);
    });

    it("calls ackAll() even when batch is empty (no crash)", async () => {
      reconcileBatchMock.mockResolvedValue(undefined);
      const batch = makeBatch([]);

      await handleMediaReconciliation(batch as any, env);

      expect(batch.ackAll).toHaveBeenCalledOnce();
    });

    it("does NOT call retryAll() for an empty batch", async () => {
      reconcileBatchMock.mockResolvedValue(undefined);
      const batch = makeBatch([]);

      await handleMediaReconciliation(batch as any, env);

      expect(batch.retryAll).not.toHaveBeenCalled();
    });
  });

  describe("SERVICE CONSTRUCTION", () => {
    it("constructs MediaReconciliationService with the env argument", async () => {
      reconcileBatchMock.mockResolvedValue(undefined);
      const specificEnv = { MEDIA_BUCKET_R2: "mock-bucket" } as any;
      const batch = makeBatch();

      await handleMediaReconciliation(batch as any, specificEnv);

      expect(capturedEnv).toBe(specificEnv);
    });
  });
});
