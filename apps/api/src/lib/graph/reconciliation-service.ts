/**
 * Reconciliation Service
 *
 * Rebuilds graph DB state from Postgres and checks consistency between
 * the two databases. Used for:
 * - Initial bootstrap (populate the graph DB from an existing Postgres DB)
 * - Disaster recovery (rebuild after graph DB data loss)
 * - Periodic consistency checks (daily cron)
 * - Development (reset local Neo4j to match Postgres)
 *
 * Processes records in dependency order:
 *   Users -> Entities -> Ownership -> Posts -> PostSubjects
 *
 * Uses cursor-based pagination to avoid loading all records into memory.
 * Includes a circuit breaker to stop after consecutive failures.
 *
 * @see ./dual-write-strategy.md for the full reconciliation design
 */

import type { PrismaClient } from "@prisma/client";

import type { GraphService } from "./graph-service.js";
import type {
  ReconciliationProgress,
  ReconciliationResult,
  ConsistencyCheckResult,
} from "./dual-write.js";
import type { PostRadius } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_RECORDS_PER_MODEL = 1_000_000;
const CIRCUIT_BREAKER_THRESHOLD = 10;
const MAX_ERRORS_TRACKED = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReconcileOptions {
  /** Batch size for cursor-based pagination. Default: 100. */
  batchSize?: number;
  /** Maximum records per model (circuit breaker). Default: 1_000_000. */
  maxRecordsPerModel?: number;
  /** Clear all graph DB data before rebuilding. Default: false. */
  clearFirst?: boolean;
  /** Progress callback (called after each batch). */
  onProgress?: (progress: ReconciliationProgress) => void;
}

/** Per-model statistics tracker */
interface ModelStats {
  synced: number;
  failed: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Service for reconciling Postgres data to the graph database.
 *
 * This is a separate service from DualWriteServiceImpl because reconciliation
 * requires direct Prisma access (to stream records from Postgres) while the
 * dual-write service only needs the GraphService for sync calls.
 *
 * Run reconciliation as a one-off task (ECS RunTask or local CLI),
 * not inline with API requests.
 */
export class ReconciliationService {
  private readonly prisma: PrismaClient;
  private readonly graphService: GraphService;

  /**
   * @param prisma - Prisma client for reading from Postgres
   * @param graphService - Graph service for writing to the graph DB
   */
  constructor(prisma: PrismaClient, graphService: GraphService) {
    this.prisma = prisma;
    this.graphService = graphService;
  }

  // =========================================================================
  // Full Reconciliation
  // =========================================================================

  /**
   * Full reconciliation: rebuild all graph state from Postgres.
   *
   * Processes all records in dependency order using cursor-based pagination.
   * Reports progress via the optional callback. Stops processing a model
   * if consecutive failures exceed the circuit breaker threshold.
   *
   * @param options - Reconciliation options
   * @returns Summary of the reconciliation run
   */
  async reconcileAll(options?: ReconcileOptions): Promise<ReconciliationResult> {
    const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
    const maxRecords = options?.maxRecordsPerModel ?? DEFAULT_MAX_RECORDS_PER_MODEL;
    const onProgress = options?.onProgress;

    const startTime = Date.now();
    const errors: Array<{ model: string; recordId: string; error: string }> = [];

    const stats: ReconciliationResult["models"] = {
      users: { synced: 0, failed: 0, total: 0 },
      entities: { synced: 0, failed: 0, total: 0 },
      posts: { synced: 0, failed: 0, total: 0 },
      postSubjects: { synced: 0, failed: 0, total: 0 },
      ownership: { synced: 0, failed: 0, total: 0 },
    };

    // Count totals for progress reporting
    const [userCount, entityCount, postCount, postSubjectCount, ownershipCount] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.entity.count(),
        this.prisma.post.count(),
        this.prisma.postSubject.count(),
        this.prisma.entityOwnership.count(),
      ]);

    stats.users.total = userCount;
    stats.entities.total = entityCount;
    stats.posts.total = postCount;
    stats.postSubjects.total = postSubjectCount;
    stats.ownership.total = ownershipCount;

    // Phase 1: Users
    await this.reconcileUsers(batchSize, maxRecords, stats.users, errors, onProgress);

    // Phase 2: Entities
    await this.reconcileEntities(batchSize, maxRecords, stats.entities, errors, onProgress);

    // Phase 3: Ownership (depends on users + entities)
    await this.reconcileOwnerships(batchSize, maxRecords, stats.ownership, errors, onProgress);

    // Phase 4: Posts (depends on users)
    await this.reconcilePosts(batchSize, maxRecords, stats.posts, errors, onProgress);

    // Phase 5: PostSubjects (depends on posts + entities)
    await this.reconcilePostSubjects(
      batchSize,
      maxRecords,
      stats.postSubjects,
      errors,
      onProgress,
    );

    const durationMs = Date.now() - startTime;
    const totalFailed =
      stats.users.failed +
      stats.entities.failed +
      stats.posts.failed +
      stats.postSubjects.failed +
      stats.ownership.failed;

    return {
      success: totalFailed === 0,
      models: stats,
      durationMs,
      errors: errors.slice(0, MAX_ERRORS_TRACKED),
    };
  }

  // =========================================================================
  // Single Entity Reconciliation
  // =========================================================================

  /**
   * Reconcile a single entity and its related data to the graph.
   *
   * Syncs the entity node, its ownership edges, and any posts about it.
   * Useful for targeted repair after a consistency check finds drift.
   *
   * @param entityId - Entity ID to reconcile
   */
  async reconcileEntity(entityId: string): Promise<void> {
    // Sync the entity node
    const entity = await this.prisma.entity.findUnique({
      where: { id: entityId },
    });

    if (!entity) {
      // Entity was deleted from Postgres — remove from graph
      await this.graphService.removeEntity(entityId);
      return;
    }

    const meta = entity.metadata as any;
    await this.graphService.syncEntity({
      id: entity.id,
      tenantId: entity.tenantId,
      entityType: entity.entityType ?? "unknown",
      name: entity.name,
      breed: meta?.breed ?? undefined,
      lifeStage: entity.lifeStage ?? undefined,
      lat: meta?.lat != null ? Number(meta.lat) : undefined,
      lng: meta?.lng != null ? Number(meta.lng) : undefined,
    });

    // Sync ownership edges
    const ownerships = await this.prisma.entityOwnership.findMany({
      where: { entityId },
    });

    for (const ownership of ownerships) {
      await this.graphService.syncOwnership({
        entityId: ownership.entityId,
        userId: ownership.userId,
        role: ownership.role as "PRIMARY_OWNER" | "CO_OWNER" | "CARETAKER",
      });
    }

    // Sync post subjects where this entity is referenced
    const postSubjects = await this.prisma.postSubject.findMany({
      where: { entityId },
      select: { postId: true },
    });

    // Group by postId and sync all subjects for each post
    const postIds = [...new Set(postSubjects.map((ps) => ps.postId))];
    for (const postId of postIds) {
      const allSubjects = await this.prisma.postSubject.findMany({
        where: { postId },
      });

      await this.graphService.syncPostSubjects({
        postId,
        entityIds: allSubjects.map((s) => s.entityId),
        primaryEntityId: allSubjects.find((s) => s.isPrimary)?.entityId,
      });
    }
  }

  // =========================================================================
  // Consistency Check
  // =========================================================================

  /**
   * Lightweight consistency check without modifying data.
   *
   * Compares record counts between Postgres and the graph DB. The graph service
   * does not expose a generic "count nodes by label" method, so this uses
   * the healthCheck to verify the graph is reachable and then compares
   * known counts.
   *
   * For a more thorough check, use reconcileAll() with a dry-run flag
   * (not yet implemented).
   *
   * @param _sampleSize - Number of records to sample per model (reserved for future use)
   * @returns Consistency check results
   */
  async checkConsistency(_sampleSize?: number): Promise<ConsistencyCheckResult> {
    // Get Postgres counts
    const [pgUsers, pgEntities, pgPosts] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.entity.count(),
      this.prisma.post.count(),
    ]);

    // Verify graph is healthy
    const health = await this.graphService.healthCheck();
    if (!health.healthy) {
      return {
        consistent: false,
        counts: {
          users: { postgres: pgUsers, graph: 0, match: false },
          entities: { postgres: pgEntities, graph: 0, match: false },
          posts: { postgres: pgPosts, graph: 0, match: false },
        },
        mismatches: [
          {
            model: "system",
            recordId: "health",
            issue: `Graph database is unhealthy: ${health.error ?? "unknown error"}`,
          },
        ],
      };
    }

    // Graph node counts are not available via the current GraphService interface.
    // A future enhancement could add a countNodes(label) method. For now, report
    // Postgres counts and mark graph counts as -1 (unknown).
    return {
      consistent: false,
      counts: {
        users: { postgres: pgUsers, graph: -1, match: false },
        entities: { postgres: pgEntities, graph: -1, match: false },
        posts: { postgres: pgPosts, graph: -1, match: false },
      },
      mismatches: [
        {
          model: "system",
          recordId: "counts",
          issue:
            "Graph node count API not yet available. Run reconcileAll() for full verification.",
        },
      ],
    };
  }

  // =========================================================================
  // Internal: Per-Model Reconciliation
  // =========================================================================

  /**
   * Reconcile all users using cursor-based pagination.
   */
  private async reconcileUsers(
    batchSize: number,
    maxRecords: number,
    modelStats: ModelStats,
    errors: Array<{ model: string; recordId: string; error: string }>,
    onProgress?: (progress: ReconciliationProgress) => void,
  ): Promise<void> {
    let cursor: string | undefined;
    let processed = 0;
    let consecutiveFailures = 0;

    while (processed < maxRecords) {
      const users = await this.prisma.user.findMany({
        take: batchSize,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { id: "asc" },
        select: { id: true, role: true },
      });

      if (users.length === 0) break;

      for (const user of users) {
        try {
          await this.graphService.syncUser({ id: user.id, role: user.role });
          modelStats.synced++;
          consecutiveFailures = 0;
        } catch (error) {
          modelStats.failed++;
          consecutiveFailures++;
          if (errors.length < MAX_ERRORS_TRACKED) {
            errors.push({
              model: "user",
              recordId: user.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        processed++;

        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          console.error(
            `[reconciliation] Circuit breaker tripped for users after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
          );
          return;
        }
      }

      cursor = users[users.length - 1]!.id;

      onProgress?.({
        model: "user",
        processed,
        total: modelStats.total,
        errors: modelStats.failed,
      });
    }
  }

  /**
   * Reconcile all entities using cursor-based pagination.
   */
  private async reconcileEntities(
    batchSize: number,
    maxRecords: number,
    modelStats: ModelStats,
    errors: Array<{ model: string; recordId: string; error: string }>,
    onProgress?: (progress: ReconciliationProgress) => void,
  ): Promise<void> {
    let cursor: string | undefined;
    let processed = 0;
    let consecutiveFailures = 0;

    while (processed < maxRecords) {
      const entities = await this.prisma.entity.findMany({
        take: batchSize,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { id: "asc" },
        select: {
          id: true,
          tenantId: true,
          entityType: true,
          name: true,
          metadata: true,
          lifeStage: true,
        },
      });

      if (entities.length === 0) break;

      for (const entity of entities) {
        try {
          const meta = entity.metadata as any;
          await this.graphService.syncEntity({
            id: entity.id,
            tenantId: entity.tenantId,
            entityType: entity.entityType ?? "unknown",
            name: entity.name,
            breed: meta?.breed ?? undefined,
            lifeStage: entity.lifeStage ?? undefined,
            lat: meta?.lat != null ? Number(meta.lat) : undefined,
            lng: meta?.lng != null ? Number(meta.lng) : undefined,
          });
          modelStats.synced++;
          consecutiveFailures = 0;
        } catch (error) {
          modelStats.failed++;
          consecutiveFailures++;
          if (errors.length < MAX_ERRORS_TRACKED) {
            errors.push({
              model: "entity",
              recordId: entity.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        processed++;

        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          console.error(
            `[reconciliation] Circuit breaker tripped for entities after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
          );
          return;
        }
      }

      cursor = entities[entities.length - 1]!.id;

      onProgress?.({
        model: "entity",
        processed,
        total: modelStats.total,
        errors: modelStats.failed,
      });
    }
  }

  /**
   * Reconcile all entity ownerships using cursor-based pagination.
   *
   * EntityOwnership has a composite primary key (entityId, userId),
   * so we use id-based ordering with skip-based pagination.
   */
  private async reconcileOwnerships(
    batchSize: number,
    maxRecords: number,
    modelStats: ModelStats,
    errors: Array<{ model: string; recordId: string; error: string }>,
    onProgress?: (progress: ReconciliationProgress) => void,
  ): Promise<void> {
    let offset = 0;
    let processed = 0;
    let consecutiveFailures = 0;

    while (processed < maxRecords) {
      const ownerships = await this.prisma.entityOwnership.findMany({
        take: batchSize,
        skip: offset,
        orderBy: [{ entityId: "asc" }, { userId: "asc" }],
        select: { entityId: true, userId: true, role: true },
      });

      if (ownerships.length === 0) break;

      for (const ownership of ownerships) {
        try {
          await this.graphService.syncOwnership({
            entityId: ownership.entityId,
            userId: ownership.userId,
            role: ownership.role as "PRIMARY_OWNER" | "CO_OWNER" | "CARETAKER",
          });
          modelStats.synced++;
          consecutiveFailures = 0;
        } catch (error) {
          modelStats.failed++;
          consecutiveFailures++;
          if (errors.length < MAX_ERRORS_TRACKED) {
            errors.push({
              model: "ownership",
              recordId: `${ownership.entityId}:${ownership.userId}`,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        processed++;

        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          console.error(
            `[reconciliation] Circuit breaker tripped for ownership after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
          );
          return;
        }
      }

      offset += ownerships.length;

      onProgress?.({
        model: "ownership",
        processed,
        total: modelStats.total,
        errors: modelStats.failed,
      });
    }
  }

  /**
   * Reconcile all posts using cursor-based pagination.
   */
  private async reconcilePosts(
    batchSize: number,
    maxRecords: number,
    modelStats: ModelStats,
    errors: Array<{ model: string; recordId: string; error: string }>,
    onProgress?: (progress: ReconciliationProgress) => void,
  ): Promise<void> {
    let cursor: string | undefined;
    let processed = 0;
    let consecutiveFailures = 0;

    while (processed < maxRecords) {
      const posts = await this.prisma.post.findMany({
        take: batchSize,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { id: "asc" },
        select: { id: true, authorId: true, radius: true, createdAt: true },
      });

      if (posts.length === 0) break;

      for (const post of posts) {
        try {
          await this.graphService.syncPost({
            id: post.id,
            authorId: post.authorId,
            radius: (post.radius ?? "NORMAL") as PostRadius,
            createdAt: post.createdAt,
          });
          modelStats.synced++;
          consecutiveFailures = 0;
        } catch (error) {
          modelStats.failed++;
          consecutiveFailures++;
          if (errors.length < MAX_ERRORS_TRACKED) {
            errors.push({
              model: "post",
              recordId: post.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        processed++;

        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          console.error(
            `[reconciliation] Circuit breaker tripped for posts after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
          );
          return;
        }
      }

      cursor = posts[posts.length - 1]!.id;

      onProgress?.({
        model: "post",
        processed,
        total: modelStats.total,
        errors: modelStats.failed,
      });
    }
  }

  /**
   * Reconcile all post subjects using cursor-based pagination.
   *
   * Groups by postId and syncs all subjects for each post as a batch,
   * since syncPostSubjects is an idempotent "set" operation.
   */
  private async reconcilePostSubjects(
    batchSize: number,
    maxRecords: number,
    modelStats: ModelStats,
    errors: Array<{ model: string; recordId: string; error: string }>,
    onProgress?: (progress: ReconciliationProgress) => void,
  ): Promise<void> {
    let offset = 0;
    let processed = 0;
    let consecutiveFailures = 0;

    // Get distinct postIds that have subjects
    while (processed < maxRecords) {
      const subjects = await this.prisma.postSubject.findMany({
        take: batchSize,
        skip: offset,
        orderBy: [{ postId: "asc" }, { entityId: "asc" }],
        select: { postId: true, entityId: true, isPrimary: true },
      });

      if (subjects.length === 0) break;

      // Group by postId
      const byPost = new Map<
        string,
        { entityIds: string[]; primaryEntityId?: string }
      >();

      for (const subject of subjects) {
        let entry = byPost.get(subject.postId);
        if (!entry) {
          entry = { entityIds: [] };
          byPost.set(subject.postId, entry);
        }
        entry.entityIds.push(subject.entityId);
        if (subject.isPrimary) {
          entry.primaryEntityId = subject.entityId;
        }
      }

      for (const [postId, data] of byPost) {
        try {
          await this.graphService.syncPostSubjects({
            postId,
            entityIds: data.entityIds,
            primaryEntityId: data.primaryEntityId,
          });
          modelStats.synced += data.entityIds.length;
          consecutiveFailures = 0;
        } catch (error) {
          modelStats.failed += data.entityIds.length;
          consecutiveFailures++;
          if (errors.length < MAX_ERRORS_TRACKED) {
            errors.push({
              model: "postSubject",
              recordId: postId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          console.error(
            `[reconciliation] Circuit breaker tripped for postSubjects after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
          );
          return;
        }
      }

      processed += subjects.length;
      offset += subjects.length;

      onProgress?.({
        model: "postSubject",
        processed,
        total: modelStats.total,
        errors: modelStats.failed,
      });
    }
  }
}
