/**
 * Dual-Write Service Interface
 *
 * Manages the consistency between Postgres (source of truth) and
 * the graph database (Neo4j AuraDB / Docker Neo4j locally). Handlers
 * call DualWriteService methods after a successful Prisma write to sync
 * the corresponding graph state.
 *
 * Write flow:
 *   1. Handler writes to Postgres via Prisma (source of truth)
 *   2. Handler calls DualWriteService.sync* (graph projection)
 *   3. DualWriteService calls GraphService.sync* with inline retry
 *   4. On failure: enqueues for async retry (non-critical) or throws (critical)
 *
 * Handlers never call GraphService.sync* directly — all dual-writes
 * go through this service so retry and failure handling are centralized.
 *
 * @see ./dual-write-strategy.md for the full design rationale
 * @see ./graph-service.ts for the underlying GraphService interface
 */

import type { GraphService } from "./graph-service.js";
import type {
  SyncUserInput,
  SyncEntityInput,
  SyncPostInput,
  SyncPostSubjectsInput,
  SyncOwnershipInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the DualWriteService */
export interface DualWriteConfig {
  /**
   * Maximum number of inline retry attempts (excluding the initial attempt).
   * Default: 2 (total of 3 attempts).
   */
  maxRetries?: number;

  /**
   * Base delay in milliseconds for exponential backoff between retries.
   * Actual delay is baseRetryDelayMs * 2^(attempt-1) + random jitter.
   * Default: 100.
   */
  baseRetryDelayMs?: number;

  /**
   * Whether to enqueue failed non-critical syncs for async retry.
   * When false, failures are logged but not queued (useful for local dev
   * where there is no SQS queue).
   * Default: true.
   */
  enableAsyncRetry?: boolean;
}

// ---------------------------------------------------------------------------
// Failure Tracking
// ---------------------------------------------------------------------------

/** Serializable record of a failed dual-write, sent to the async retry queue */
export interface DualWriteFailure {
  /** Unique ID for this failure (for deduplication) */
  id: string;

  /** Which sync operation failed */
  operation: DualWriteOperation;

  /** The input payload for the sync method (JSON-serializable) */
  payload: DualWritePayload;

  /** ISO timestamp of the original Postgres write */
  postgresWriteAt: string;

  /** ISO timestamp of the last failed attempt */
  lastAttemptAt: string;

  /** Number of inline attempts made before queuing */
  inlineAttempts: number;

  /** The error message from the last failed attempt */
  lastError: string;
}

/** All dual-write operation types (maps to GraphService sync methods) */
export type DualWriteOperation =
  | "syncUser"
  | "removeUser"
  | "syncEntity"
  | "removeEntity"
  | "syncPost"
  | "removePost"
  | "syncPostSubjects"
  | "syncOwnership"
  | "removeOwnership";

/**
 * Discriminated union of all possible sync payloads.
 * Each variant carries the data needed to call the corresponding
 * GraphService method.
 */
export type DualWritePayload =
  | { operation: "syncUser"; input: SyncUserInput }
  | { operation: "removeUser"; userId: string }
  | { operation: "syncEntity"; input: SyncEntityInput }
  | { operation: "removeEntity"; entityId: string }
  | { operation: "syncPost"; input: SyncPostInput }
  | { operation: "removePost"; postId: string }
  | { operation: "syncPostSubjects"; input: SyncPostSubjectsInput }
  | { operation: "syncOwnership"; input: SyncOwnershipInput }
  | { operation: "removeOwnership"; entityId: string; userId: string };

// ---------------------------------------------------------------------------
// Deletion Tombstone (GDPR compliance)
// ---------------------------------------------------------------------------

/**
 * Records a pending deletion that must be propagated to the graph database.
 *
 * When a user or entity is deleted from Postgres, a tombstone is created to
 * track whether the corresponding graph node has been removed. A daily
 * reconciliation job processes unsynced tombstones to ensure GDPR compliance
 * ("without undue delay" — target: within 24-48 hours).
 *
 * @see dual-write-strategy.md — "Tombstone Pattern for Deletions"
 */
export interface DeletionTombstone {
  /** Unique tombstone ID */
  id: string;
  /** What type of node was deleted */
  targetType: "user" | "entity" | "post";
  /** ID of the deleted node */
  targetId: string;
  /** When the Postgres deletion occurred */
  deletedAt: string;
  /** Whether the graph node has been successfully removed */
  graphSynced: boolean;
  /** When the graph node was successfully removed (null if not yet synced) */
  graphSyncedAt: string | null;
}

// ---------------------------------------------------------------------------
// Sync Result
// ---------------------------------------------------------------------------

/** Outcome of a dual-write attempt */
export type DualWriteSyncResult =
  | { status: "synced" }
  | { status: "queued"; failureId: string }
  | { status: "failed"; error: string };

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Progress callback for reconciliation (for logging/UI) */
export interface ReconciliationProgress {
  /** Which model is currently being reconciled */
  model: "user" | "entity" | "post" | "postSubject" | "ownership";
  /** Records processed so far for this model */
  processed: number;
  /** Total records to process for this model (may be approximate) */
  total: number;
  /** Records that failed to sync */
  errors: number;
}

/** Final result of a full reconciliation run */
export interface ReconciliationResult {
  /** Whether reconciliation completed without fatal errors */
  success: boolean;
  /** Per-model statistics */
  models: {
    users: { synced: number; failed: number; total: number };
    entities: { synced: number; failed: number; total: number };
    posts: { synced: number; failed: number; total: number };
    postSubjects: { synced: number; failed: number; total: number };
    ownership: { synced: number; failed: number; total: number };
  };
  /** Total time in milliseconds */
  durationMs: number;
  /** Errors encountered (truncated to first 100) */
  errors: Array<{ model: string; recordId: string; error: string }>;
}

/** Result of a lightweight consistency check */
export interface ConsistencyCheckResult {
  /** Whether counts match across both databases */
  consistent: boolean;
  /** Per-model count comparison */
  counts: {
    users: { postgres: number; graph: number; match: boolean };
    entities: { postgres: number; graph: number; match: boolean };
    posts: { postgres: number; graph: number; match: boolean };
  };
  /** Sample mismatches found (if any) */
  mismatches: Array<{
    model: string;
    recordId: string;
    issue: string;
  }>;
}

// ---------------------------------------------------------------------------
// DualWriteService Interface
// ---------------------------------------------------------------------------

/**
 * Manages dual-writes between Postgres and the graph database.
 *
 * Each sync method corresponds to a Postgres write that needs to be
 * reflected in the graph. The service handles inline retry and async
 * fallback so handlers don't need to worry about graph sync failures.
 *
 * Critical operations (deletions, ownership changes) throw on failure
 * so the handler can return an error to the client. Non-critical
 * operations (user/entity/post sync) return success even if the graph
 * write fails, because the data can be synced later.
 */
export interface DualWriteService {
  // =========================================================================
  // Node Sync (non-critical)
  // =========================================================================

  /**
   * Sync a user node to the graph after Postgres create/update.
   *
   * Non-critical: returns success even if graph sync fails.
   * The graph node is a lightweight reference (id, email, role).
   *
   * @param input - User data from the Postgres write
   * @returns Sync outcome (synced, queued, or failed)
   */
  syncUser(input: SyncUserInput): Promise<DualWriteSyncResult>;

  /**
   * Sync an entity node to the graph after Postgres create/update.
   *
   * Non-critical: returns success even if graph sync fails.
   * The graph node includes properties needed for graph-side filtering
   * (entityType, breed, lifeStage, lat/lng).
   *
   * @param input - Entity data from the Postgres write
   * @returns Sync outcome
   */
  syncEntity(input: SyncEntityInput): Promise<DualWriteSyncResult>;

  /**
   * Sync a post node to the graph after Postgres create.
   *
   * Non-critical: returns success even if graph sync fails.
   * The graph node is a reference (id, authorId, radius, createdAt).
   * Post content stays in Postgres.
   *
   * @param input - Post data from the Postgres write
   * @returns Sync outcome
   */
  syncPost(input: SyncPostInput): Promise<DualWriteSyncResult>;

  /**
   * Sync post-subject edges to the graph after PostSubject create/update/delete.
   *
   * Non-critical: returns success even if graph sync fails.
   * This is an idempotent "set" operation — all existing ABOUT edges for
   * the post are replaced with the given entity IDs.
   *
   * @param input - Post subject data (postId + all entityIds)
   * @returns Sync outcome
   */
  syncPostSubjects(input: SyncPostSubjectsInput): Promise<DualWriteSyncResult>;

  // =========================================================================
  // Node Removal (critical)
  // =========================================================================

  /**
   * Remove a user node from the graph after Postgres deletion.
   *
   * Critical: throws if graph sync fails after all retries.
   * Removing a user cascades to all their relationship edges in the graph.
   *
   * @param userId - User ID to remove
   * @throws GraphSyncError if the graph write fails after all retries
   */
  removeUser(userId: string): Promise<void>;

  /**
   * Remove an entity node from the graph after Postgres deletion.
   *
   * Critical: throws if graph sync fails after all retries.
   * Removing an entity cascades to all connected edges (RELATES_TO,
   * OWNS, ABOUT, entity-to-entity relationships).
   *
   * @param entityId - Entity ID to remove
   * @throws GraphSyncError if the graph write fails after all retries
   */
  removeEntity(entityId: string): Promise<void>;

  /**
   * Remove a post node from the graph after Postgres deletion.
   *
   * Non-critical: returns success even if graph sync fails.
   * An orphan post node in the graph is harmless — it will be
   * cleaned up by reconciliation.
   *
   * @param postId - Post ID to remove
   * @returns Sync outcome
   */
  removePost(postId: string): Promise<DualWriteSyncResult>;

  // =========================================================================
  // Ownership Sync (critical)
  // =========================================================================

  /**
   * Sync an ownership edge to the graph after Postgres create/update.
   *
   * Critical: throws if graph sync fails after all retries.
   * Ownership affects circle tier resolution (owned entities are always
   * pinned at tier 0 with score 1.0), so stale ownership in the graph
   * would cause incorrect visibility.
   *
   * @param input - Ownership data from the Postgres write
   * @throws GraphSyncError if the graph write fails after all retries
   */
  syncOwnership(input: SyncOwnershipInput): Promise<void>;

  /**
   * Remove an ownership edge from the graph after Postgres deletion.
   *
   * Critical: throws if graph sync fails after all retries.
   * Removing ownership unpins the entity from tier 0 and removes
   * the OWNS edge. The RELATES_TO edge is kept (the user may still
   * want to follow the entity).
   *
   * @param entityId - Entity ID
   * @param userId - User ID
   * @throws GraphSyncError if the graph write fails after all retries
   */
  removeOwnership(entityId: string, userId: string): Promise<void>;

  // =========================================================================
  // Async Retry Processing
  // =========================================================================

  /**
   * Process a single failed dual-write from the async retry queue.
   *
   * Called by the queue worker (Lambda or ECS task) when it receives
   * a DualWriteFailure message from the GRAPH_SYNC_QUEUE.
   *
   * @param failure - The serialized failure record from the queue
   * @throws If the sync still fails (SQS will retry based on visibility timeout)
   */
  processRetry(failure: DualWriteFailure): Promise<void>;

  // =========================================================================
  // Reconciliation
  // =========================================================================

  /**
   * Full reconciliation: rebuild all graph DB state from Postgres.
   *
   * Processes all records in dependency order:
   *   Users -> Entities -> Ownership -> Posts -> PostSubjects
   *
   * Uses cursor-based pagination to avoid loading all records into memory.
   * Batches graph writes (configurable batch size, default 100).
   * Reports progress via the optional callback.
   *
   * This is a heavy operation — run it as a one-off task (ECS RunTask),
   * not inline with API requests.
   *
   * @param options - Reconciliation options
   * @returns Summary of the reconciliation run
   */
  reconcile(options?: {
    /** Batch size for graph writes. Default: 100. */
    batchSize?: number;
    /** Maximum records per model (circuit breaker). Default: 1_000_000. */
    maxRecordsPerModel?: number;
    /** Clear all graph DB data before rebuilding. Default: false. */
    clearFirst?: boolean;
    /** Progress callback (called after each batch). */
    onProgress?: (progress: ReconciliationProgress) => void;
  }): Promise<ReconciliationResult>;

  /**
   * Lightweight consistency check without modifying data.
   *
   * Compares record counts between Postgres and the graph DB, and samples
   * a set of records to verify graph properties match Postgres.
   *
   * Suitable for scheduled runs (daily cron — daily frequency ensures
   * deletion tombstones are resolved within GDPR timelines).
   *
   * @param sampleSize - Number of records to sample per model. Default: 100.
   * @returns Consistency check results
   */
  checkConsistency(sampleSize?: number): Promise<ConsistencyCheckResult>;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown by critical dual-write operations when the graph sync fails
 * after all inline retries.
 *
 * The Postgres write has already committed. The handler should return
 * an error indicating partial failure and the operation should be
 * retried via the async queue.
 */
export class GraphSyncError extends Error {
  readonly code = "GRAPH_SYNC_ERROR";

  constructor(
    /** Which operation failed */
    readonly operation: DualWriteOperation,
    /** The underlying error message */
    message: string,
    /** Number of retry attempts made */
    readonly attempts: number,
    options?: ErrorOptions,
  ) {
    super(`Graph sync failed for ${operation} after ${attempts} attempts: ${message}`, options);
    this.name = "GraphSyncError";
  }
}
