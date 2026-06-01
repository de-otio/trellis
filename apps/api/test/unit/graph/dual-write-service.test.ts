/**
 * Unit Tests: DualWriteServiceImpl — retry / backoff / critical-vs-noncritical / enqueue
 *
 * All timing is driven by fake timers (vi.useFakeTimers) so the suite runs in
 * milliseconds with no real wall-clock backoff.
 *
 * Pattern for operations that involve backoff:
 *   1. Kick off the async call (do NOT await yet).
 *   2. Drain all pending timers with `await vi.runAllTimersAsync()`.
 *   3. Await the promise.
 *
 * @see apps/api/src/lib/graph/dual-write-service.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DualWriteServiceImpl } from "../../../src/lib/graph/dual-write-service.js";
import { GraphSyncError } from "../../../src/lib/graph/dual-write.js";
import {
  GraphConnectionError,
  GraphNotFoundError,
  GraphConflictError,
} from "../../../src/lib/graph/errors.js";
import type {
  DualWriteConfig,
  DualWriteFailure,
} from "../../../src/lib/graph/dual-write.js";
import type { GraphService } from "../../../src/lib/graph/graph-service.js";
import type {
  SyncUserInput,
  SyncEntityInput,
  SyncPostInput,
  SyncPostSubjectsInput,
  SyncOwnershipInput,
} from "../../../src/lib/graph/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_INPUT: SyncUserInput = { id: "user-1", role: "END_USER" };
const ENTITY_INPUT: SyncEntityInput = { id: "entity-1", entityType: "dog", name: "Rex" };
const POST_INPUT: SyncPostInput = {
  id: "post-1",
  authorId: "user-1",
  radius: "NORMAL",
  createdAt: new Date("2024-01-01T00:00:00Z"),
};
const POST_SUBJECTS_INPUT: SyncPostSubjectsInput = {
  postId: "post-1",
  entityIds: ["entity-1"],
};
const OWNERSHIP_INPUT: SyncOwnershipInput = {
  entityId: "entity-1",
  userId: "user-1",
  role: "PRIMARY_OWNER",
};

// ---------------------------------------------------------------------------
// Mock GraphService factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal GraphService mock. Each sync* / remove* method is a
 * separately controlled vi.fn() that resolves to undefined by default.
 */
function makeMockGraphService(): {
  service: GraphService;
  syncUser: ReturnType<typeof vi.fn>;
  removeUser: ReturnType<typeof vi.fn>;
  syncEntity: ReturnType<typeof vi.fn>;
  removeEntity: ReturnType<typeof vi.fn>;
  syncPost: ReturnType<typeof vi.fn>;
  removePost: ReturnType<typeof vi.fn>;
  syncPostSubjects: ReturnType<typeof vi.fn>;
  syncOwnership: ReturnType<typeof vi.fn>;
  removeOwnership: ReturnType<typeof vi.fn>;
} {
  const syncUser = vi.fn().mockResolvedValue(undefined);
  const removeUser = vi.fn().mockResolvedValue(undefined);
  const syncEntity = vi.fn().mockResolvedValue(undefined);
  const removeEntity = vi.fn().mockResolvedValue(undefined);
  const syncPost = vi.fn().mockResolvedValue(undefined);
  const removePost = vi.fn().mockResolvedValue(undefined);
  const syncPostSubjects = vi.fn().mockResolvedValue(undefined);
  const syncOwnership = vi.fn().mockResolvedValue(undefined);
  const removeOwnership = vi.fn().mockResolvedValue(undefined);

  // Cast: we only implement the sync-related methods the service needs.
  const service = {
    syncUser,
    removeUser,
    syncEntity,
    removeEntity,
    syncPost,
    removePost,
    syncPostSubjects,
    syncOwnership,
    removeOwnership,
  } as unknown as GraphService;

  return {
    service,
    syncUser,
    removeUser,
    syncEntity,
    removeEntity,
    syncPost,
    removePost,
    syncPostSubjects,
    syncOwnership,
    removeOwnership,
  };
}

/**
 * Convenience: build a DualWriteServiceImpl with explicit config.
 * Defaults are minimal (maxRetries=2, baseRetryDelayMs=10) for speed.
 */
function makeService(
  mock: ReturnType<typeof makeMockGraphService>,
  config?: DualWriteConfig,
): DualWriteServiceImpl {
  return new DualWriteServiceImpl(mock.service, {
    maxRetries: 2,
    baseRetryDelayMs: 10,
    enableAsyncRetry: true,
    ...config,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("DualWriteServiceImpl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Non-critical sync: SUCCESS on first attempt
  // =========================================================================

  describe("non-critical sync – success on first attempt", () => {
    it("syncUser: returns {status:'synced'} and calls GraphService once", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      const result = await svc.syncUser(USER_INPUT);

      expect(result).toEqual({ status: "synced" });
      expect(mock.syncUser).toHaveBeenCalledOnce();
      expect(mock.syncUser).toHaveBeenCalledWith(USER_INPUT);
      expect(svc.getFailureCount()).toBe(0);
    });

    it("syncEntity: returns {status:'synced'} and calls GraphService once", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      const result = await svc.syncEntity(ENTITY_INPUT);

      expect(result).toEqual({ status: "synced" });
      expect(mock.syncEntity).toHaveBeenCalledOnce();
    });

    it("syncPost: returns {status:'synced'} and calls GraphService once", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      const result = await svc.syncPost(POST_INPUT);

      expect(result).toEqual({ status: "synced" });
      expect(mock.syncPost).toHaveBeenCalledOnce();
    });

    it("syncPostSubjects: returns {status:'synced'} and calls GraphService once", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      const result = await svc.syncPostSubjects(POST_SUBJECTS_INPUT);

      expect(result).toEqual({ status: "synced" });
      expect(mock.syncPostSubjects).toHaveBeenCalledOnce();
    });

    it("removePost: returns {status:'synced'} and calls GraphService once", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      const result = await svc.removePost("post-1");

      expect(result).toEqual({ status: "synced" });
      expect(mock.removePost).toHaveBeenCalledOnce();
      expect(mock.removePost).toHaveBeenCalledWith("post-1");
    });
  });

  // =========================================================================
  // Non-critical sync: SUCCESS after a RETRY
  // =========================================================================

  describe("non-critical sync – succeeds on retry", () => {
    it("syncUser fails once, succeeds on retry → {status:'synced'}, called twice, backoff fires", async () => {
      const mock = makeMockGraphService();
      mock.syncUser
        .mockRejectedValueOnce(new GraphConnectionError("transient"))
        .mockResolvedValueOnce(undefined);

      const svc = makeService(mock, { maxRetries: 2, baseRetryDelayMs: 50 });

      const promise = svc.syncUser(USER_INPUT);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ status: "synced" });
      expect(mock.syncUser).toHaveBeenCalledTimes(2);
      expect(svc.getFailureCount()).toBe(0);
    });

    it("syncEntity fails twice, succeeds on third attempt → {status:'synced'}, called 3 times", async () => {
      const mock = makeMockGraphService();
      mock.syncEntity
        .mockRejectedValueOnce(new GraphConnectionError("down"))
        .mockRejectedValueOnce(new GraphConnectionError("down"))
        .mockResolvedValueOnce(undefined);

      const svc = makeService(mock, { maxRetries: 2, baseRetryDelayMs: 10 });

      const promise = svc.syncEntity(ENTITY_INPUT);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ status: "synced" });
      expect(mock.syncEntity).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // Non-critical sync: all attempts fail → QUEUED (enableAsyncRetry=true)
  // =========================================================================

  describe("non-critical sync – all attempts fail, enableAsyncRetry=true", () => {
    it("syncUser returns {status:'queued', failureId} and enqueues one failure", async () => {
      const mock = makeMockGraphService();
      mock.syncUser.mockRejectedValue(new GraphConnectionError("down"));

      const svc = makeService(mock, { maxRetries: 2, enableAsyncRetry: true });

      const promise = svc.syncUser(USER_INPUT);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe("queued");
      expect((result as { status: "queued"; failureId: string }).failureId).toBeDefined();
      expect(typeof (result as { status: "queued"; failureId: string }).failureId).toBe("string");

      const queue = svc.getFailureQueue();
      expect(queue).toHaveLength(1);
      const failure = queue[0];
      expect(failure.operation).toBe("syncUser");
      expect(failure.payload).toMatchObject({ operation: "syncUser", input: USER_INPUT });
      expect(failure.inlineAttempts).toBe(3); // 1 initial + 2 retries
      expect(failure.lastError).toBeDefined();
    });

    it("failure record has the correct structure (id, operation, payload, timestamps, inlineAttempts, lastError)", async () => {
      const mock = makeMockGraphService();
      mock.syncPost.mockRejectedValue(new GraphConnectionError("net error"));

      const svc = makeService(mock, { maxRetries: 2, enableAsyncRetry: true });

      const promise = svc.syncPost(POST_INPUT);
      await vi.runAllTimersAsync();
      await promise;

      const [failure] = svc.getFailureQueue();
      expect(failure.id).toMatch(/^[0-9a-f-]{36}$/); // UUID-shaped
      expect(failure.operation).toBe("syncPost");
      expect(failure.postgresWriteAt).toBeDefined();
      expect(failure.lastAttemptAt).toBeDefined();
      expect(failure.inlineAttempts).toBe(3);
    });

    it("failureId in result matches the id stored in the queue", async () => {
      const mock = makeMockGraphService();
      mock.syncEntity.mockRejectedValue(new GraphConnectionError("down"));

      const svc = makeService(mock, { maxRetries: 1, enableAsyncRetry: true });

      const promise = svc.syncEntity(ENTITY_INPUT);
      await vi.runAllTimersAsync();
      const result = await promise;

      const failureId = (result as { status: "queued"; failureId: string }).failureId;
      const queuedFailure = svc.getFailureQueue().find((f) => f.id === failureId);
      expect(queuedFailure).toBeDefined();
    });
  });

  // =========================================================================
  // Non-critical sync: all attempts fail → FAILED (enableAsyncRetry=false)
  // =========================================================================

  describe("non-critical sync – all attempts fail, enableAsyncRetry=false", () => {
    it("syncUser returns {status:'failed'} and nothing is enqueued", async () => {
      const mock = makeMockGraphService();
      mock.syncUser.mockRejectedValue(new GraphConnectionError("down"));

      const svc = makeService(mock, { maxRetries: 2, enableAsyncRetry: false });

      const promise = svc.syncUser(USER_INPUT);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe("failed");
      expect((result as { status: "failed"; error: string }).error).toBeDefined();
      expect(svc.getFailureCount()).toBe(0);
    });

    it("removePost returns {status:'failed'} with enableAsyncRetry=false", async () => {
      const mock = makeMockGraphService();
      mock.removePost.mockRejectedValue(new GraphConnectionError("net error"));

      const svc = makeService(mock, { maxRetries: 1, enableAsyncRetry: false });

      const promise = svc.removePost("post-99");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe("failed");
      expect(svc.getFailureCount()).toBe(0);
    });
  });

  // =========================================================================
  // Retry count cap: exactly maxRetries+1 attempts, no infinite loop
  // =========================================================================

  describe("retry count is capped at 1 + maxRetries (circuit-breaker)", () => {
    it("with maxRetries=2, a permanently-failing op makes exactly 3 calls", async () => {
      const mock = makeMockGraphService();
      mock.syncUser.mockRejectedValue(new GraphConnectionError("always down"));

      const svc = makeService(mock, { maxRetries: 2, enableAsyncRetry: false });

      const promise = svc.syncUser(USER_INPUT);
      await vi.runAllTimersAsync();
      await promise;

      expect(mock.syncUser).toHaveBeenCalledTimes(3);
    });

    it("with maxRetries=0, makes exactly 1 call (no retries)", async () => {
      const mock = makeMockGraphService();
      mock.syncPost.mockRejectedValue(new GraphConnectionError("down"));

      const svc = makeService(mock, { maxRetries: 0, enableAsyncRetry: false });

      const promise = svc.syncPost(POST_INPUT);
      await vi.runAllTimersAsync();
      await promise;

      expect(mock.syncPost).toHaveBeenCalledTimes(1);
    });

    it("with maxRetries=1, makes exactly 2 calls", async () => {
      const mock = makeMockGraphService();
      mock.syncEntity.mockRejectedValue(new GraphConnectionError("down"));

      const svc = makeService(mock, { maxRetries: 1, enableAsyncRetry: false });

      const promise = svc.syncEntity(ENTITY_INPUT);
      await vi.runAllTimersAsync();
      await promise;

      expect(mock.syncEntity).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Non-retryable errors skip retries immediately
  // =========================================================================

  describe("non-retryable errors", () => {
    it("GraphNotFoundError skips retries: only 1 call, returns failed/queued after 1 attempt", async () => {
      const mock = makeMockGraphService();
      mock.syncUser.mockRejectedValue(new GraphNotFoundError("node missing"));

      // With enableAsyncRetry=false so we can inspect without timer complexity
      const svc = makeService(mock, { maxRetries: 2, enableAsyncRetry: false });

      const result = await svc.syncUser(USER_INPUT);

      // No timers needed – non-retryable errors bail immediately without delay
      expect(mock.syncUser).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("failed");
    });

    it("GraphConflictError skips retries: only 1 call", async () => {
      const mock = makeMockGraphService();
      mock.syncPost.mockRejectedValue(new GraphConflictError("duplicate"));

      const svc = makeService(mock, { maxRetries: 2, enableAsyncRetry: false });

      const result = await svc.syncPost(POST_INPUT);

      expect(mock.syncPost).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("failed");
    });

    it("non-retryable error with enableAsyncRetry=true still enqueues (1 attempt recorded)", async () => {
      const mock = makeMockGraphService();
      mock.syncUser.mockRejectedValue(new GraphNotFoundError("missing"));

      const svc = makeService(mock, { maxRetries: 2, enableAsyncRetry: true });

      const result = await svc.syncUser(USER_INPUT);

      expect(result.status).toBe("queued");
      const [failure] = svc.getFailureQueue();
      expect(failure.inlineAttempts).toBe(1); // bailed after 1
    });
  });

  // =========================================================================
  // Critical operations: success → resolves void, no enqueue
  // =========================================================================

  describe("critical ops – success", () => {
    it("removeUser resolves void and does not enqueue", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      await expect(svc.removeUser("user-1")).resolves.toBeUndefined();
      expect(mock.removeUser).toHaveBeenCalledOnce();
      expect(svc.getFailureCount()).toBe(0);
    });

    it("removeEntity resolves void and does not enqueue", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      await expect(svc.removeEntity("entity-1")).resolves.toBeUndefined();
      expect(mock.removeEntity).toHaveBeenCalledOnce();
      expect(svc.getFailureCount()).toBe(0);
    });

    it("syncOwnership resolves void and does not enqueue", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      await expect(svc.syncOwnership(OWNERSHIP_INPUT)).resolves.toBeUndefined();
      expect(mock.syncOwnership).toHaveBeenCalledOnce();
      expect(svc.getFailureCount()).toBe(0);
    });

    it("removeOwnership resolves void and does not enqueue", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      await expect(svc.removeOwnership("entity-1", "user-1")).resolves.toBeUndefined();
      expect(mock.removeOwnership).toHaveBeenCalledOnce();
      expect(mock.removeOwnership).toHaveBeenCalledWith("entity-1", "user-1");
    });
  });

  // =========================================================================
  // Critical operations: all retries fail → throws GraphSyncError
  // =========================================================================

  /**
   * Helper: kick off a promise that will eventually reject, attach a .catch()
   * immediately so Node never sees an "unhandled rejection", advance fake
   * timers, then return the settled error.
   *
   * Usage:
   *   const err = await settleCritical(svc.removeUser("user-1"));
   *   expect(err).toBeInstanceOf(GraphSyncError);
   */
  async function settleCritical<T>(p: Promise<T>): Promise<unknown> {
    // Attach rejection handler immediately — prevents PromiseRejectionHandledWarning
    const settled: { err: unknown } = { err: undefined };
    p.catch((e) => {
      settled.err = e;
    });
    await vi.runAllTimersAsync();
    // By now the promise has settled; await it to pick up the rejection
    try {
      await p;
      // If we reach here, it resolved — return undefined as a signal
      return undefined;
    } catch (e) {
      return e;
    }
  }

  describe("critical ops – all retries fail → throws GraphSyncError", () => {
    it("removeUser throws GraphSyncError with correct .code, .operation, .attempts", async () => {
      const mock = makeMockGraphService();
      mock.removeUser.mockRejectedValue(new GraphConnectionError("db down"));

      const svc = makeService(mock, { maxRetries: 2 });

      const err = await settleCritical(svc.removeUser("user-1"));

      expect(err).toBeInstanceOf(GraphSyncError);
      expect(err).toMatchObject({
        code: "GRAPH_SYNC_ERROR",
        operation: "removeUser",
        attempts: 3,
        name: "GraphSyncError",
      });
    });

    it("removeEntity throws GraphSyncError", async () => {
      const mock = makeMockGraphService();
      mock.removeEntity.mockRejectedValue(new GraphConnectionError("net error"));

      const svc = makeService(mock, { maxRetries: 1 });

      const err = await settleCritical(svc.removeEntity("entity-1"));

      expect(err).toBeInstanceOf(GraphSyncError);
      expect(err).toMatchObject({
        operation: "removeEntity",
        attempts: 2, // 1 + 1 retry
      });
    });

    it("syncOwnership throws GraphSyncError with operation='syncOwnership'", async () => {
      const mock = makeMockGraphService();
      mock.syncOwnership.mockRejectedValue(new GraphConnectionError("timeout"));

      const svc = makeService(mock, { maxRetries: 2 });

      const err = await settleCritical(svc.syncOwnership(OWNERSHIP_INPUT));

      expect(err).toMatchObject({
        code: "GRAPH_SYNC_ERROR",
        operation: "syncOwnership",
        attempts: 3,
      });
    });

    it("removeOwnership throws GraphSyncError with operation='removeOwnership'", async () => {
      const mock = makeMockGraphService();
      mock.removeOwnership.mockRejectedValue(new GraphConnectionError("down"));

      const svc = makeService(mock, { maxRetries: 2 });

      const err = await settleCritical(svc.removeOwnership("entity-1", "user-1"));

      expect(err).toMatchObject({
        code: "GRAPH_SYNC_ERROR",
        operation: "removeOwnership",
      });
    });

    it("critical op failure message includes operation and attempt count", async () => {
      const mock = makeMockGraphService();
      mock.removeUser.mockRejectedValue(new GraphConnectionError("conn refused"));

      const svc = makeService(mock, { maxRetries: 1 });

      const err = await settleCritical(svc.removeUser("user-1"));

      expect(err).toBeInstanceOf(GraphSyncError);
      const syncErr = err as GraphSyncError;
      expect(syncErr.message).toContain("removeUser");
      expect(syncErr.message).toContain("2"); // 2 total attempts
    });

    it("critical op with enableAsyncRetry=true enqueues AND throws", async () => {
      const mock = makeMockGraphService();
      mock.removeUser.mockRejectedValue(new GraphConnectionError("down"));

      const svc = makeService(mock, { maxRetries: 2, enableAsyncRetry: true });

      const err = await settleCritical(svc.removeUser("user-1"));

      expect(err).toBeInstanceOf(GraphSyncError);
      // Should also enqueue (critical ops enqueue AND throw when enableAsyncRetry=true)
      expect(svc.getFailureCount()).toBe(1);
    });

    it("critical op with enableAsyncRetry=false does NOT enqueue (only throws)", async () => {
      const mock = makeMockGraphService();
      mock.removeUser.mockRejectedValue(new GraphConnectionError("down"));

      const svc = makeService(mock, { maxRetries: 2, enableAsyncRetry: false });

      const err = await settleCritical(svc.removeUser("user-1"));

      expect(err).toBeInstanceOf(GraphSyncError);
      expect(svc.getFailureCount()).toBe(0);
    });
  });

  // =========================================================================
  // GraphSyncError constructor / shape (from dual-write.ts)
  // =========================================================================

  describe("GraphSyncError shape", () => {
    it("has .code === 'GRAPH_SYNC_ERROR' and .name === 'GraphSyncError'", () => {
      const err = new GraphSyncError("syncUser", "db down", 3);
      expect(err.code).toBe("GRAPH_SYNC_ERROR");
      expect(err.name).toBe("GraphSyncError");
      expect(err).toBeInstanceOf(Error);
    });

    it("formats message with operation and attempt count", () => {
      const err = new GraphSyncError("removeEntity", "timeout", 2);
      expect(err.message).toContain("removeEntity");
      expect(err.message).toContain("2");
      expect(err.message).toContain("timeout");
    });

    it("carries .operation and .attempts properties", () => {
      const err = new GraphSyncError("syncOwnership", "refused", 5);
      expect(err.operation).toBe("syncOwnership");
      expect(err.attempts).toBe(5);
    });
  });

  // =========================================================================
  // processRetry: replays the original GraphService call
  // =========================================================================

  describe("processRetry(failure)", () => {
    it("re-dispatches syncUser call to GraphService", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      const failure: DualWriteFailure = {
        id: "fail-abc",
        operation: "syncUser",
        payload: { operation: "syncUser", input: USER_INPUT },
        postgresWriteAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        inlineAttempts: 3,
        lastError: "timeout",
      };

      await svc.processRetry(failure);

      expect(mock.syncUser).toHaveBeenCalledOnce();
      expect(mock.syncUser).toHaveBeenCalledWith(USER_INPUT);
    });

    it("re-dispatches removeUser call to GraphService", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      const failure: DualWriteFailure = {
        id: "fail-xyz",
        operation: "removeUser",
        payload: { operation: "removeUser", userId: "user-42" },
        postgresWriteAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        inlineAttempts: 3,
        lastError: "conn refused",
      };

      await svc.processRetry(failure);

      expect(mock.removeUser).toHaveBeenCalledOnce();
      expect(mock.removeUser).toHaveBeenCalledWith("user-42");
    });

    it("re-dispatches syncOwnership call to GraphService", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      const failure: DualWriteFailure = {
        id: "fail-o",
        operation: "syncOwnership",
        payload: { operation: "syncOwnership", input: OWNERSHIP_INPUT },
        postgresWriteAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        inlineAttempts: 3,
        lastError: "timeout",
      };

      await svc.processRetry(failure);

      expect(mock.syncOwnership).toHaveBeenCalledOnce();
      expect(mock.syncOwnership).toHaveBeenCalledWith(OWNERSHIP_INPUT);
    });

    it("re-dispatches removeOwnership call to GraphService with (entityId, userId)", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      const failure: DualWriteFailure = {
        id: "fail-ro",
        operation: "removeOwnership",
        payload: { operation: "removeOwnership", entityId: "entity-1", userId: "user-1" },
        postgresWriteAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        inlineAttempts: 2,
        lastError: "down",
      };

      await svc.processRetry(failure);

      expect(mock.removeOwnership).toHaveBeenCalledOnce();
      expect(mock.removeOwnership).toHaveBeenCalledWith("entity-1", "user-1");
    });

    it("processRetry re-dispatches removePost", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      const failure: DualWriteFailure = {
        id: "fail-rp",
        operation: "removePost",
        payload: { operation: "removePost", postId: "post-99" },
        postgresWriteAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        inlineAttempts: 3,
        lastError: "net error",
      };

      await svc.processRetry(failure);

      expect(mock.removePost).toHaveBeenCalledOnce();
      expect(mock.removePost).toHaveBeenCalledWith("post-99");
    });

    it("processRetry throws when GraphService still fails (so SQS re-delivers)", async () => {
      const mock = makeMockGraphService();
      mock.syncUser.mockRejectedValue(new GraphConnectionError("still down"));
      const svc = makeService(mock);

      const failure: DualWriteFailure = {
        id: "fail-still",
        operation: "syncUser",
        payload: { operation: "syncUser", input: USER_INPUT },
        postgresWriteAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        inlineAttempts: 3,
        lastError: "down",
      };

      await expect(svc.processRetry(failure)).rejects.toThrow();
    });

    it("processRetry succeeds when GraphService succeeds", async () => {
      const mock = makeMockGraphService();
      // mock.syncUser already resolves by default
      const svc = makeService(mock);

      const failure: DualWriteFailure = {
        id: "fail-ok",
        operation: "syncUser",
        payload: { operation: "syncUser", input: USER_INPUT },
        postgresWriteAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        inlineAttempts: 3,
        lastError: "transient",
      };

      await expect(svc.processRetry(failure)).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Backoff timer verification
  // =========================================================================

  describe("backoff – fake timers ensure no real wall-clock delay", () => {
    it("two retries fire their backoff timers before completing", async () => {
      const mock = makeMockGraphService();
      mock.syncUser
        .mockRejectedValueOnce(new GraphConnectionError("t1"))
        .mockRejectedValueOnce(new GraphConnectionError("t2"))
        .mockResolvedValueOnce(undefined);

      const svc = makeService(mock, { maxRetries: 2, baseRetryDelayMs: 1000 });

      // Suppress any transient rejection warnings from intermediate mock failures
      const promise = svc.syncUser(USER_INPUT);
      promise.catch(() => {});

      // Drain all pending timers (covers 1000ms + 2000ms backoff delays)
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ status: "synced" });
      expect(mock.syncUser).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("multiple concurrent syncUser calls don't share failure queues", async () => {
      const mock = makeMockGraphService();
      mock.syncUser
        .mockRejectedValueOnce(new GraphConnectionError("err"))
        .mockRejectedValueOnce(new GraphConnectionError("err"))
        .mockRejectedValueOnce(new GraphConnectionError("err"))
        .mockRejectedValueOnce(new GraphConnectionError("err"))
        .mockRejectedValueOnce(new GraphConnectionError("err"))
        .mockRejectedValueOnce(new GraphConnectionError("err"));

      const svc = makeService(mock, { maxRetries: 2, enableAsyncRetry: true });

      const p1 = svc.syncUser({ id: "u1", role: "END_USER" });
      const p2 = svc.syncUser({ id: "u2", role: "END_USER" });
      await vi.runAllTimersAsync();
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.status).toBe("queued");
      expect(r2.status).toBe("queued");
      expect(svc.getFailureCount()).toBe(2);
    });

    it("reconcile() throws (must use ReconciliationService)", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      await expect(svc.reconcile()).rejects.toThrow(/ReconciliationService/);
    });

    it("checkConsistency() throws (must use ReconciliationService)", async () => {
      const mock = makeMockGraphService();
      const svc = makeService(mock);

      await expect(svc.checkConsistency()).rejects.toThrow(/ReconciliationService/);
    });

    it("getFailureQueue() returns a snapshot (mutating it does not affect internal queue)", async () => {
      const mock = makeMockGraphService();
      mock.syncUser.mockRejectedValue(new GraphConnectionError("down"));

      const svc = makeService(mock, { maxRetries: 0, enableAsyncRetry: true });

      const promise = svc.syncUser(USER_INPUT);
      await vi.runAllTimersAsync();
      await promise;

      const snapshot = svc.getFailureQueue() as DualWriteFailure[];
      // Mutate the snapshot
      snapshot.pop();

      // Internal queue should be unaffected
      expect(svc.getFailureCount()).toBe(1);
    });
  });
});
