/**
 * Dual-Write Service Implementation
 *
 * Manages the consistency between Postgres (source of truth) and the graph
 * database (Neo4j AuraDB / Docker Neo4j locally). Handlers call DualWriteService methods
 * after a successful Prisma write to sync the corresponding graph state.
 *
 * Key responsibilities:
 * - Inline retry with exponential backoff + jitter
 * - Critical vs non-critical operation distinction
 * - Async retry queue fallback for non-critical failures
 * - In-memory failure tracking for MVP (SQS integration later)
 *
 * @see ./dual-write-strategy.md for the full design rationale
 * @see ./dual-write.ts for the interface definition
 */

import { randomUUID } from "node:crypto";

import type { GraphService } from "./graph-service.js";
import type {
  DualWriteConfig,
  DualWriteFailure,
  DualWriteOperation,
  DualWritePayload,
  DualWriteService,
  DualWriteSyncResult,
  ReconciliationProgress,
  ReconciliationResult,
  ConsistencyCheckResult,
} from "./dual-write.js";
import { GraphSyncError } from "./dual-write.js";
import type {
  SyncUserInput,
  SyncEntityInput,
  SyncPostInput,
  SyncPostSubjectsInput,
  SyncOwnershipInput,
} from "./types.js";
import {
  GraphConnectionError,
  GraphQueryError,
  GraphTimeoutError,
  GraphNotFoundError,
  GraphConflictError,
  GraphAuthorizationError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_RETRY_DELAY_MS = 100;
const MAX_FAILURE_QUEUE_SIZE = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether an error is retryable.
 *
 * Retryable: connection errors, transient query errors, timeouts.
 * Non-retryable: not-found, conflict, authorization (these won't succeed on retry).
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof GraphConnectionError) return true;
  if (error instanceof GraphQueryError) return true;
  if (error instanceof GraphTimeoutError) return true;
  if (error instanceof GraphNotFoundError) return false;
  if (error instanceof GraphConflictError) return false;
  if (error instanceof GraphAuthorizationError) return false;
  // Unknown errors are treated as retryable (conservative approach)
  return true;
}

/**
 * Calculate delay for exponential backoff with jitter.
 *
 * @param attempt - Retry attempt number (1-based)
 * @param baseDelayMs - Base delay in milliseconds
 * @returns Delay in milliseconds
 */
function retryDelay(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * baseDelayMs;
  return exponential + jitter;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Default implementation of the DualWriteService interface.
 *
 * Wraps a GraphService instance with retry logic and failure handling.
 * Handlers call this instead of GraphService.sync* directly, so that
 * retry, logging, and async fallback are centralized.
 */
export class DualWriteServiceImpl implements DualWriteService {
  private readonly graphService: GraphService;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly enableAsyncRetry: boolean;

  /**
   * In-memory queue of failed syncs for async retry.
   * In production this would be backed by SQS (GRAPH_SYNC_QUEUE).
   * For MVP, failures are accumulated here and can be processed via
   * processRetry() or reconciliation.
   */
  private readonly failureQueue: DualWriteFailure[] = [];

  /**
   * @param graphService - The underlying GraphService instance
   * @param config - Optional retry and queue configuration
   */
  constructor(graphService: GraphService, config?: DualWriteConfig) {
    this.graphService = graphService;
    this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseRetryDelayMs = config?.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
    this.enableAsyncRetry = config?.enableAsyncRetry ?? true;
  }

  // =========================================================================
  // Node Sync (non-critical)
  // =========================================================================

  /** @inheritdoc */
  async syncUser(input: SyncUserInput): Promise<DualWriteSyncResult> {
    return this.executeNonCritical("syncUser", { operation: "syncUser", input }, () =>
      this.graphService.syncUser(input),
    );
  }

  /** @inheritdoc */
  async syncEntity(input: SyncEntityInput): Promise<DualWriteSyncResult> {
    return this.executeNonCritical("syncEntity", { operation: "syncEntity", input }, () =>
      this.graphService.syncEntity(input),
    );
  }

  /** @inheritdoc */
  async syncPost(input: SyncPostInput): Promise<DualWriteSyncResult> {
    return this.executeNonCritical("syncPost", { operation: "syncPost", input }, () =>
      this.graphService.syncPost(input),
    );
  }

  /** @inheritdoc */
  async syncPostSubjects(input: SyncPostSubjectsInput): Promise<DualWriteSyncResult> {
    return this.executeNonCritical(
      "syncPostSubjects",
      { operation: "syncPostSubjects", input },
      () => this.graphService.syncPostSubjects(input),
    );
  }

  // =========================================================================
  // Node Removal
  // =========================================================================

  /** @inheritdoc */
  async removeUser(userId: string): Promise<void> {
    return this.executeCritical("removeUser", { operation: "removeUser", userId }, () =>
      this.graphService.removeUser(userId),
    );
  }

  /** @inheritdoc */
  async removeEntity(entityId: string): Promise<void> {
    return this.executeCritical(
      "removeEntity",
      { operation: "removeEntity", entityId },
      () => this.graphService.removeEntity(entityId),
    );
  }

  /** @inheritdoc */
  async removePost(postId: string): Promise<DualWriteSyncResult> {
    return this.executeNonCritical("removePost", { operation: "removePost", postId }, () =>
      this.graphService.removePost(postId),
    );
  }

  // =========================================================================
  // Ownership Sync (critical)
  // =========================================================================

  /** @inheritdoc */
  async syncOwnership(input: SyncOwnershipInput): Promise<void> {
    return this.executeCritical(
      "syncOwnership",
      { operation: "syncOwnership", input },
      () => this.graphService.syncOwnership(input),
    );
  }

  /** @inheritdoc */
  async removeOwnership(entityId: string, userId: string): Promise<void> {
    return this.executeCritical(
      "removeOwnership",
      { operation: "removeOwnership", entityId, userId },
      () => this.graphService.removeOwnership(entityId, userId),
    );
  }

  // =========================================================================
  // Async Retry Processing
  // =========================================================================

  /** @inheritdoc */
  async processRetry(failure: DualWriteFailure): Promise<void> {
    const fn = this.getGraphServiceCall(failure.payload);
    await fn();
  }

  // =========================================================================
  // Reconciliation (delegated to ReconciliationService)
  // =========================================================================

  /** @inheritdoc */
  async reconcile(_options?: {
    batchSize?: number;
    maxRecordsPerModel?: number;
    clearFirst?: boolean;
    onProgress?: (progress: ReconciliationProgress) => void;
  }): Promise<ReconciliationResult> {
    // Reconciliation requires Prisma access and is implemented separately
    // in ReconciliationService. This method exists on the interface so that
    // callers have a single entry point; in practice, use ReconciliationService directly.
    throw new Error(
      "reconcile() must be called via ReconciliationService, not DualWriteServiceImpl. " +
        "Use ReconciliationService.reconcileAll() instead.",
    );
  }

  /** @inheritdoc */
  async checkConsistency(_sampleSize?: number): Promise<ConsistencyCheckResult> {
    // Same as reconcile — requires Prisma, delegated to ReconciliationService.
    throw new Error(
      "checkConsistency() must be called via ReconciliationService, not DualWriteServiceImpl. " +
        "Use ReconciliationService.checkConsistency() instead.",
    );
  }

  // =========================================================================
  // Public Accessors (for testing and queue workers)
  // =========================================================================

  /**
   * Get a snapshot of the in-memory failure queue.
   * In production, this would read from SQS instead.
   */
  getFailureQueue(): ReadonlyArray<DualWriteFailure> {
    return [...this.failureQueue];
  }

  /**
   * Get the number of queued failures.
   */
  getFailureCount(): number {
    return this.failureQueue.length;
  }

  // =========================================================================
  // Internal: Retry Engine
  // =========================================================================

  /**
   * Execute a non-critical graph sync with inline retry and async fallback.
   *
   * On success: returns { status: "synced" }.
   * On failure after retries: enqueues for async retry and returns
   * { status: "queued", failureId } or { status: "failed", error }.
   */
  private async executeNonCritical(
    operation: DualWriteOperation,
    payload: DualWritePayload,
    fn: () => Promise<void>,
  ): Promise<DualWriteSyncResult> {
    const result = await this.executeWithRetry(operation, fn);

    if (result.success) {
      return { status: "synced" };
    }

    // All inline retries failed — enqueue for async retry
    if (this.enableAsyncRetry) {
      const failure = this.enqueueFailure(operation, payload, result.attempts, result.error);
      return { status: "queued", failureId: failure.id };
    }

    return { status: "failed", error: result.error };
  }

  /**
   * Execute a critical graph sync with inline retry.
   *
   * On success: returns void.
   * On failure after retries: enqueues for async retry AND throws GraphSyncError.
   */
  private async executeCritical(
    operation: DualWriteOperation,
    payload: DualWritePayload,
    fn: () => Promise<void>,
  ): Promise<void> {
    const result = await this.executeWithRetry(operation, fn);

    if (result.success) {
      return;
    }

    // Critical operations still enqueue for async retry
    if (this.enableAsyncRetry) {
      this.enqueueFailure(operation, payload, result.attempts, result.error);
    }

    throw new GraphSyncError(operation, result.error, result.attempts);
  }

  /**
   * Execute a function with inline retry (exponential backoff + jitter).
   *
   * @returns Success/failure result with attempt count and last error message.
   */
  private async executeWithRetry(
    operation: DualWriteOperation,
    fn: () => Promise<void>,
  ): Promise<{ success: true } | { success: false; attempts: number; error: string }> {
    const totalAttempts = 1 + this.maxRetries;
    let lastError: unknown;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        await fn();
        return { success: true };
      } catch (error) {
        lastError = error;

        // Non-retryable errors fail immediately
        if (!isRetryableError(error)) {
          console.error(
            `[dual-write] ${operation} failed with non-retryable error (attempt ${attempt}/${totalAttempts}):`,
            error instanceof Error ? error.message : String(error),
          );
          return {
            success: false,
            attempts: attempt,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        // Log and maybe sleep before retry
        if (attempt < totalAttempts) {
          const delay = retryDelay(attempt, this.baseRetryDelayMs);
          console.warn(
            `[dual-write] ${operation} failed (attempt ${attempt}/${totalAttempts}), retrying in ${Math.round(delay)}ms:`,
            error instanceof Error ? error.message : String(error),
          );
          await sleep(delay);
        }
      }
    }

    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    console.error(
      `[dual-write] ${operation} failed after all ${totalAttempts} attempts: ${errorMessage}`,
    );

    return {
      success: false,
      attempts: totalAttempts,
      error: errorMessage,
    };
  }

  // =========================================================================
  // Internal: Failure Queue
  // =========================================================================

  /**
   * Enqueue a failed sync for async retry.
   *
   * MVP: stores in an in-memory array (bounded to MAX_FAILURE_QUEUE_SIZE).
   * Production: would send to SQS GRAPH_SYNC_QUEUE.
   */
  private enqueueFailure(
    operation: DualWriteOperation,
    payload: DualWritePayload,
    inlineAttempts: number,
    lastError: string,
  ): DualWriteFailure {
    const failure: DualWriteFailure = {
      id: randomUUID(),
      operation,
      payload,
      postgresWriteAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      inlineAttempts,
      lastError,
    };

    // Bounded queue to prevent unbounded memory growth
    if (this.failureQueue.length < MAX_FAILURE_QUEUE_SIZE) {
      this.failureQueue.push(failure);
    } else {
      console.error(
        `[dual-write] Failure queue is full (${MAX_FAILURE_QUEUE_SIZE} items), dropping failure for ${operation}`,
      );
    }

    return failure;
  }

  // =========================================================================
  // Internal: Payload -> GraphService Call Mapping
  // =========================================================================

  /**
   * Map a DualWritePayload to the corresponding GraphService method call.
   * Used by processRetry() to replay failed operations.
   */
  private getGraphServiceCall(payload: DualWritePayload): () => Promise<void> {
    switch (payload.operation) {
      case "syncUser":
        return () => this.graphService.syncUser(payload.input);
      case "removeUser":
        return () => this.graphService.removeUser(payload.userId);
      case "syncEntity":
        return () => this.graphService.syncEntity(payload.input);
      case "removeEntity":
        return () => this.graphService.removeEntity(payload.entityId);
      case "syncPost":
        return () => this.graphService.syncPost(payload.input);
      case "removePost":
        return () => this.graphService.removePost(payload.postId);
      case "syncPostSubjects":
        return () => this.graphService.syncPostSubjects(payload.input);
      case "syncOwnership":
        return () => this.graphService.syncOwnership(payload.input);
      case "removeOwnership":
        return () =>
          this.graphService.removeOwnership(payload.entityId, payload.userId);
      default: {
        const _exhaustive: never = payload;
        throw new Error(`Unknown dual-write operation: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
}
