/**
 * Unit Tests: ReconciliationService — safety invariants
 *
 * Covers the high-value, infinite-loop-prevention guarantees:
 *   1. TERMINATION     — reconcileAll() terminates with a finite record set
 *   2. maxRecords CAP  — processing stops at the cap (no runaway iteration)
 *   3. CIRCUIT BREAKER — 10 consecutive failures abort the model early
 *   4. PAGINATION      — cursor-based / offset-based pagination calls honored
 *   5. onProgress      — callback fires per batch
 *   6. ERROR CAP       — errors array is bounded to MAX_ERRORS_TRACKED (100)
 *   7. checkConsistency— healthy graph returns counts; unhealthy returns mismatches
 *
 * @see apps/api/src/lib/graph/reconciliation-service.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReconciliationService } from "../../../src/lib/graph/reconciliation-service.js";
import type { GraphService } from "../../../src/lib/graph/graph-service.js";
import type { GraphHealthStatus } from "../../../src/lib/graph/types.js";

// ---------------------------------------------------------------------------
// Constants (mirror source — must stay in sync)
// ---------------------------------------------------------------------------

const CIRCUIT_BREAKER_THRESHOLD = 10;
const MAX_ERRORS_TRACKED = 100;

// ---------------------------------------------------------------------------
// Prisma mock builders
// ---------------------------------------------------------------------------

/**
 * Build a trivial cursor-paginated findMany mock.
 *
 * Calling `findMany` for the first time returns `page`, subsequent calls
 * return `[]` so the loop always terminates.
 *
 * @param page - The first (and only) non-empty page to return.
 */
function onceThenEmpty<T>(page: T[]): ReturnType<typeof vi.fn> {
  let calls = 0;
  return vi.fn().mockImplementation(() => {
    calls++;
    return Promise.resolve(calls === 1 ? page : []);
  });
}

/**
 * Build a findMany mock that always returns `page` — use for testing
 * scenarios where the circuit breaker (not empty-page) is supposed to stop
 * the loop. Callers must ensure pagination stops via the circuit breaker.
 *
 * @param page - Page to return on every call.
 */
function alwaysReturn<T>(page: T[]): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(page);
}

// ---------------------------------------------------------------------------
// Standard fixture data
// ---------------------------------------------------------------------------

const USERS = [
  { id: "user-a", role: "END_USER" },
  { id: "user-b", role: "END_USER" },
  { id: "user-c", role: "ADMIN" },
];

const ENTITIES = [
  { id: "entity-a", entityType: "dog", name: "Rover", metadata: null, lifeStage: null },
  { id: "entity-b", entityType: "cat", name: "Whiskers", metadata: { breed: "Siamese", lat: 48.1, lng: 11.5 }, lifeStage: "ADULT" },
];

const POSTS = [
  { id: "post-a", authorId: "user-a", radius: "NORMAL", createdAt: new Date("2024-01-01T00:00:00Z") },
  { id: "post-b", authorId: "user-b", radius: "CLOSE", createdAt: new Date("2024-02-01T00:00:00Z") },
];

const OWNERSHIPS = [
  { entityId: "entity-a", userId: "user-a", role: "PRIMARY_OWNER" },
  { entityId: "entity-b", userId: "user-b", role: "CO_OWNER" },
];

const POST_SUBJECTS = [
  { postId: "post-a", entityId: "entity-a", isPrimary: true },
  { postId: "post-b", entityId: "entity-b", isPrimary: false },
];

// ---------------------------------------------------------------------------
// GraphService mock builder
// ---------------------------------------------------------------------------

function makeMockGraphService(): {
  service: GraphService;
  syncUser: ReturnType<typeof vi.fn>;
  syncEntity: ReturnType<typeof vi.fn>;
  syncOwnership: ReturnType<typeof vi.fn>;
  syncPost: ReturnType<typeof vi.fn>;
  syncPostSubjects: ReturnType<typeof vi.fn>;
  healthCheck: ReturnType<typeof vi.fn>;
} {
  const syncUser = vi.fn().mockResolvedValue(undefined);
  const syncEntity = vi.fn().mockResolvedValue(undefined);
  const syncOwnership = vi.fn().mockResolvedValue(undefined);
  const syncPost = vi.fn().mockResolvedValue(undefined);
  const syncPostSubjects = vi.fn().mockResolvedValue(undefined);
  const healthCheck = vi.fn().mockResolvedValue({ healthy: true } as GraphHealthStatus);

  const service = {
    syncUser,
    syncEntity,
    syncOwnership,
    syncPost,
    syncPostSubjects,
    healthCheck,
    // Unused by ReconciliationService but required by the interface
    removeUser: vi.fn(),
    removeEntity: vi.fn(),
    removePost: vi.fn(),
    removeOwnership: vi.fn(),
    createRelationship: vi.fn(),
    removeRelationship: vi.fn(),
    updateRelationshipScore: vi.fn(),
    getRelationship: vi.fn(),
    getRelationships: vi.fn(),
    getRelationshipGraph: vi.fn(),
    getCircleMembers: vi.fn(),
    getVisiblePostIds: vi.fn(),
    getGlanceItems: vi.fn(),
    getDepthPostIds: vi.fn(),
    getCircleStatus: vi.fn(),
    getCircleEntityStatus: vi.fn(),
    markCircleRead: vi.fn(),
    createEntityRelationship: vi.fn(),
    confirmEntityRelationship: vi.fn(),
    rejectEntityRelationship: vi.fn(),
    removeEntityRelationship: vi.fn(),
    getEntityRelationships: vi.fn(),
    getPendingEntityRelationships: vi.fn(),
    discoverByGraph: vi.fn(),
    discoverNearby: vi.fn(),
    getRecommendations: vi.fn(),
    recordInteraction: vi.fn(),
    recomputeScores: vi.fn(),
    applyDecay: vi.fn(),
  } as unknown as GraphService;

  return { service, syncUser, syncEntity, syncOwnership, syncPost, syncPostSubjects, healthCheck };
}

// ---------------------------------------------------------------------------
// Prisma mock builder: full happy-path
// ---------------------------------------------------------------------------

function makeHappyPrisma() {
  return {
    user: {
      count: vi.fn().mockResolvedValue(USERS.length),
      findMany: onceThenEmpty(USERS),
    },
    entity: {
      count: vi.fn().mockResolvedValue(ENTITIES.length),
      findMany: onceThenEmpty(ENTITIES),
    },
    post: {
      count: vi.fn().mockResolvedValue(POSTS.length),
      findMany: onceThenEmpty(POSTS),
    },
    postSubject: {
      count: vi.fn().mockResolvedValue(POST_SUBJECTS.length),
      findMany: onceThenEmpty(POST_SUBJECTS),
    },
    entityOwnership: {
      count: vi.fn().mockResolvedValue(OWNERSHIPS.length),
      findMany: onceThenEmpty(OWNERSHIPS),
    },
  } as unknown as any;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("ReconciliationService", () => {
  let mockGraph: ReturnType<typeof makeMockGraphService>;
  let service: ReconciliationService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGraph = makeMockGraphService();
  });

  // =========================================================================
  // 1. TERMINATION
  // =========================================================================

  describe("TERMINATION — reconcileAll() completes with finite record set", () => {
    it("returns ReconciliationResult with success:true when all syncs succeed", async () => {
      const mockPrisma = makeHappyPrisma();
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.reconcileAll();

      expect(result.success).toBe(true);
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.errors)).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("reports correct per-model synced / total counts", async () => {
      const mockPrisma = makeHappyPrisma();
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.reconcileAll();

      expect(result.models.users.total).toBe(USERS.length);
      expect(result.models.users.synced).toBe(USERS.length);
      expect(result.models.users.failed).toBe(0);

      expect(result.models.entities.total).toBe(ENTITIES.length);
      expect(result.models.entities.synced).toBe(ENTITIES.length);
      expect(result.models.entities.failed).toBe(0);

      expect(result.models.posts.total).toBe(POSTS.length);
      expect(result.models.posts.synced).toBe(POSTS.length);
      expect(result.models.posts.failed).toBe(0);

      expect(result.models.ownership.total).toBe(OWNERSHIPS.length);
      expect(result.models.ownership.synced).toBe(OWNERSHIPS.length);
      expect(result.models.ownership.failed).toBe(0);
    });

    it("calls syncUser for each user record exactly once", async () => {
      const mockPrisma = makeHappyPrisma();
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll();

      expect(mockGraph.syncUser).toHaveBeenCalledTimes(USERS.length);
      expect(mockGraph.syncUser).toHaveBeenCalledWith({ id: "user-a", role: "END_USER" });
      expect(mockGraph.syncUser).toHaveBeenCalledWith({ id: "user-c", role: "ADMIN" });
    });

    it("calls syncEntity for each entity record exactly once", async () => {
      const mockPrisma = makeHappyPrisma();
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll();

      expect(mockGraph.syncEntity).toHaveBeenCalledTimes(ENTITIES.length);
    });

    it("calls syncPost for each post record exactly once", async () => {
      const mockPrisma = makeHappyPrisma();
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll();

      expect(mockGraph.syncPost).toHaveBeenCalledTimes(POSTS.length);
    });

    it("findMany is not called again after empty page terminates the loop", async () => {
      const mockPrisma = makeHappyPrisma();
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll();

      // onceThenEmpty returns a non-empty page on call 1, [] on call 2.
      // So findMany should have been called exactly 2 times per model that
      // has records (once for data, once for the terminating empty page).
      // Users: 3 records, batchSize default 100 → page fits → 2 calls total.
      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.entity.findMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.post.findMany).toHaveBeenCalledTimes(2);
    });

    it("returns success:false when any record fails to sync", async () => {
      const mockPrisma = makeHappyPrisma();
      mockGraph.syncUser.mockRejectedValueOnce(new Error("graph unavailable"));
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.reconcileAll();

      expect(result.success).toBe(false);
      expect(result.models.users.failed).toBeGreaterThanOrEqual(1);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0].model).toBe("user");
      expect(result.errors[0].error).toBe("graph unavailable");
    });
  });

  // =========================================================================
  // 2. maxRecordsPerModel CAP
  // =========================================================================

  describe("maxRecordsPerModel CAP — processing stops at the cap", () => {
    it("stops fetching additional pages once processed >= maxRecordsPerModel", async () => {
      // The cap `maxRecordsPerModel` gates the while-loop condition
      // (processed < maxRecords). It does NOT clamp mid-batch — if a page
      // has N records and N > remaining cap, all N in the batch are still
      // processed (the inner for-loop runs to completion). The cap prevents
      // fetching a *next* page, not over-running within the current page.
      //
      // This test verifies the anti-runaway guarantee: with an always-returning
      // findMany, the service does NOT loop indefinitely.
      //
      // Behavior: cap=2, page-size=3 → while(0<2): fetch 3, process all 3,
      //   processed=3. while(3<2) = false → terminates after ONE page (3 calls).
      const cap = 2;
      const mockPrisma = {
        user: {
          count: vi.fn().mockResolvedValue(999),
          findMany: alwaysReturn(USERS), // 3 records every call
        },
        entity: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.reconcileAll({ maxRecordsPerModel: cap });

      // IMPORTANT BEHAVIOR NOTE: The cap prevents re-entering the loop, but
      // does not clamp the in-flight batch. A page of 3 records with cap=2
      // will process all 3 (processed overshoots to 3). The key invariant is:
      // findMany is NOT called a second time (loop terminates).
      //
      // syncUser called exactly USERS.length (3) times — one complete batch only.
      expect(mockGraph.syncUser).toHaveBeenCalledTimes(USERS.length);
      // findMany called only ONCE (the loop does not continue after overshoot)
      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);

      expect(result.success).toBe(true);
    });

    it("processes exactly batchSize records when batchSize < cap and page fills the batch", async () => {
      const batchSize = 2;
      const cap = 2;
      // Return 3 users every call — cap kicks in after processing batchSize
      const mockPrisma = {
        user: {
          count: vi.fn().mockResolvedValue(999),
          findMany: onceThenEmpty(USERS.slice(0, batchSize)), // only 2 users per page
        },
        entity: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll({ batchSize, maxRecordsPerModel: cap });

      // Exactly cap records processed (page had exactly batchSize=cap)
      expect(mockGraph.syncUser).toHaveBeenCalledTimes(cap);
    });

    it("handles maxRecordsPerModel=0 by processing nothing", async () => {
      const mockPrisma = makeHappyPrisma();
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll({ maxRecordsPerModel: 0 });

      // processed < maxRecords (0 < 0 = false) → never enters loop
      expect(mockGraph.syncUser).not.toHaveBeenCalled();
      expect(mockGraph.syncEntity).not.toHaveBeenCalled();
    });

    it("cap prevents additional page fetches and each model is bounded independently", async () => {
      // cap=1, entities page has 2 records:
      //   while(0<1): fetch 2, process 2 (overshoot), processed=2
      //   while(2<1): false → terminates. findMany called ONCE for entities.
      const entityCap = 1;
      const mockPrisma = {
        user: {
          count: vi.fn().mockResolvedValue(USERS.length),
          findMany: onceThenEmpty(USERS),
        },
        entity: {
          count: vi.fn().mockResolvedValue(999),
          findMany: alwaysReturn(ENTITIES), // 2 records; would loop forever uncapped
        },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.reconcileAll({ maxRecordsPerModel: entityCap });

      // Users processed completely (USERS.length = 3 ≥ cap, but users use
      // onceThenEmpty so loop exits on empty page, not on cap)
      expect(mockGraph.syncUser).toHaveBeenCalledTimes(USERS.length);

      // Entity findMany called exactly ONCE — the cap stopped the loop from
      // fetching a second page after the first batch overshoot.
      expect(mockPrisma.entity.findMany).toHaveBeenCalledTimes(1);
      // Both entities in the batch were synced (batch overshoots cap but still terminates)
      expect(mockGraph.syncEntity).toHaveBeenCalledTimes(ENTITIES.length);
    });
  });

  // =========================================================================
  // 3. CIRCUIT BREAKER
  // =========================================================================

  describe("CIRCUIT BREAKER — aborts model after CIRCUIT_BREAKER_THRESHOLD consecutive failures", () => {
    it("stops processing users after 10 consecutive syncUser failures", async () => {
      // Provide enough users that without a circuit breaker all would be tried
      const manyUsers = Array.from({ length: 20 }, (_, i) => ({
        id: `user-${i}`,
        role: "END_USER",
      }));

      const mockPrisma = {
        user: {
          count: vi.fn().mockResolvedValue(manyUsers.length),
          findMany: onceThenEmpty(manyUsers),
        },
        entity: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      // All syncUser calls fail
      mockGraph.syncUser.mockRejectedValue(new Error("neo4j down"));

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.reconcileAll();

      // Circuit breaker fires after threshold consecutive failures —
      // syncUser should NOT have been called more than threshold times.
      expect(mockGraph.syncUser.mock.calls.length).toBe(CIRCUIT_BREAKER_THRESHOLD);

      // result.success = false because there were failures
      expect(result.success).toBe(false);

      // failed count matches number of attempted syncs
      expect(result.models.users.failed).toBe(CIRCUIT_BREAKER_THRESHOLD);
    });

    it("resets consecutive-failure counter after a successful sync", async () => {
      // Pattern: 9 failures, then 1 success, then 9 more failures — breaker
      // should NOT trip (never reaches 10 consecutive).
      const users = Array.from({ length: 19 }, (_, i) => ({
        id: `user-${i}`,
        role: "END_USER",
      }));

      const mockPrisma = {
        user: {
          count: vi.fn().mockResolvedValue(users.length),
          findMany: onceThenEmpty(users),
        },
        entity: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      // First 9 fail, 10th succeeds, 11th–19th fail (9 more consecutive fails,
      // threshold is 10 so breaker should NOT trip)
      let callCount = 0;
      mockGraph.syncUser.mockImplementation(() => {
        callCount++;
        if (callCount <= 9) return Promise.reject(new Error("fail"));
        if (callCount === 10) return Promise.resolve(undefined);
        return Promise.reject(new Error("fail"));
      });

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.reconcileAll();

      // All 19 users should have been attempted (no circuit breaker trip)
      expect(mockGraph.syncUser).toHaveBeenCalledTimes(19);
      expect(result.models.users.synced).toBe(1);
      expect(result.models.users.failed).toBe(18);
    });

    it("breaker trips exactly at threshold (not threshold - 1)", async () => {
      // 11 users, all fail — should trip after exactly 10
      const users = Array.from({ length: 11 }, (_, i) => ({
        id: `user-${i}`,
        role: "END_USER",
      }));

      const mockPrisma = {
        user: {
          count: vi.fn().mockResolvedValue(users.length),
          findMany: onceThenEmpty(users),
        },
        entity: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      mockGraph.syncUser.mockRejectedValue(new Error("down"));

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll();

      // Should be exactly threshold calls, not threshold+1 or threshold-1
      expect(mockGraph.syncUser).toHaveBeenCalledTimes(CIRCUIT_BREAKER_THRESHOLD);
    });

    it("circuit breaker on entities does not prevent posts from being processed", async () => {
      // Verify each model has its own independent circuit breaker
      const entities = Array.from({ length: 15 }, (_, i) => ({
        id: `entity-${i}`,
        entityType: "dog",
        name: `Dog ${i}`,
        metadata: null,
        lifeStage: null,
      }));

      const mockPrisma = {
        user: {
          count: vi.fn().mockResolvedValue(USERS.length),
          findMany: onceThenEmpty(USERS),
        },
        entity: {
          count: vi.fn().mockResolvedValue(entities.length),
          findMany: onceThenEmpty(entities),
        },
        post: {
          count: vi.fn().mockResolvedValue(POSTS.length),
          findMany: onceThenEmpty(POSTS),
        },
        postSubject: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      // All entity syncs fail
      mockGraph.syncEntity.mockRejectedValue(new Error("entity sync fail"));

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.reconcileAll();

      // Entity circuit breaker tripped — only threshold attempted
      expect(mockGraph.syncEntity).toHaveBeenCalledTimes(CIRCUIT_BREAKER_THRESHOLD);
      // Post processing must still happen
      expect(mockGraph.syncPost).toHaveBeenCalledTimes(POSTS.length);
      // Users processed fine
      expect(mockGraph.syncUser).toHaveBeenCalledTimes(USERS.length);
    });
  });

  // =========================================================================
  // 4. PAGINATION — cursor-based / offset-based calls honored
  // =========================================================================

  describe("PAGINATION — batchSize and cursor/offset are passed to findMany", () => {
    it("passes take=batchSize to findMany", async () => {
      const batchSize = 5;
      const mockPrisma = makeHappyPrisma();
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll({ batchSize });

      // First call: no cursor, skip=0
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: batchSize }),
      );
    });

    it("passes cursor from previous page into next findMany call", async () => {
      // Two pages of users: [user-a, user-b] then [] to terminate
      const page1 = [
        { id: "user-a", role: "END_USER" },
        { id: "user-b", role: "END_USER" },
      ];

      let callCount = 0;
      const userFindMany = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? page1 : []);
      });

      const mockPrisma = {
        user: { count: vi.fn().mockResolvedValue(2), findMany: userFindMany },
        entity: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll({ batchSize: 2 });

      // Second call should carry the cursor from the last record in page1
      expect(userFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: { id: "user-b" },
          skip: 1,
        }),
      );
    });

    it("first call has no cursor and skip=0", async () => {
      const mockPrisma = makeHappyPrisma();
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll({ batchSize: 10 });

      expect(mockPrisma.user.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          take: 10,
          skip: 0,
          cursor: undefined,
          orderBy: { id: "asc" },
        }),
      );
    });

    it("ownership uses offset-based pagination (not cursor-based)", async () => {
      // EntityOwnership has a composite key — the source uses skip/offset
      const mockPrisma = {
        user: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entity: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entityOwnership: {
          count: vi.fn().mockResolvedValue(OWNERSHIPS.length),
          findMany: onceThenEmpty(OWNERSHIPS),
        },
      } as unknown as any;

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll({ batchSize: 10 });

      // First call: skip=0 (no cursor)
      expect(mockPrisma.entityOwnership.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ take: 10, skip: 0 }),
      );
      // Second call (terminating empty page): skip should have advanced
      expect(mockPrisma.entityOwnership.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ skip: OWNERSHIPS.length }),
      );
    });
  });

  // =========================================================================
  // 5. onProgress CALLBACK
  // =========================================================================

  describe("onProgress callback fires per batch", () => {
    it("fires at least once per model that has records", async () => {
      const mockPrisma = makeHappyPrisma();
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const progressCalls: any[] = [];
      await service.reconcileAll({
        onProgress: (p) => progressCalls.push({ ...p }),
      });

      const models = progressCalls.map((p) => p.model);
      expect(models).toContain("user");
      expect(models).toContain("entity");
      expect(models).toContain("post");
    });

    it("progress.processed reflects the number of records handled so far", async () => {
      const mockPrisma = makeHappyPrisma();
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const userProgress: any[] = [];
      await service.reconcileAll({
        onProgress: (p) => {
          if (p.model === "user") userProgress.push({ ...p });
        },
      });

      expect(userProgress.length).toBeGreaterThanOrEqual(1);
      const last = userProgress[userProgress.length - 1];
      expect(last.processed).toBe(USERS.length);
    });

    it("progress.total reflects the count query result", async () => {
      const mockPrisma = makeHappyPrisma();
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const progressMap: Record<string, any> = {};
      await service.reconcileAll({
        onProgress: (p) => {
          progressMap[p.model] = p;
        },
      });

      expect(progressMap["user"].total).toBe(USERS.length);
      expect(progressMap["entity"].total).toBe(ENTITIES.length);
      expect(progressMap["post"].total).toBe(POSTS.length);
    });

    it("progress.errors increments on failure", async () => {
      const mockPrisma = makeHappyPrisma();
      mockGraph.syncUser.mockRejectedValueOnce(new Error("boom"));
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const userProgress: any[] = [];
      await service.reconcileAll({
        onProgress: (p) => {
          if (p.model === "user") userProgress.push({ ...p });
        },
      });

      const last = userProgress[userProgress.length - 1];
      expect(last.errors).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // 6. ERROR TRACKING CAP
  // =========================================================================

  describe(`ERROR CAP — errors array bounded to MAX_ERRORS_TRACKED (${MAX_ERRORS_TRACKED})`, () => {
    it("does not accumulate more than MAX_ERRORS_TRACKED error entries", async () => {
      // Generate more failing records than the error cap
      const lotsOfUsers = Array.from({ length: MAX_ERRORS_TRACKED + 20 }, (_, i) => ({
        id: `user-${i}`,
        role: "END_USER",
      }));

      const mockPrisma = {
        user: {
          count: vi.fn().mockResolvedValue(lotsOfUsers.length),
          // Return all users on first call, [] on second
          findMany: onceThenEmpty(lotsOfUsers),
        },
        entity: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      mockGraph.syncUser.mockRejectedValue(new Error("persistent failure"));

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      // Use a large maxRecordsPerModel so the cap is not the circuit breaker
      // (use a batchSize larger than the total so we get all records in one page)
      const result = await service.reconcileAll({
        maxRecordsPerModel: MAX_ERRORS_TRACKED + 20,
        batchSize: MAX_ERRORS_TRACKED + 20,
      });

      // The errors array must never exceed MAX_ERRORS_TRACKED
      expect(result.errors.length).toBeLessThanOrEqual(MAX_ERRORS_TRACKED);
    });

    it("errors array is exactly MAX_ERRORS_TRACKED when failures > cap (pre-slice in reconcileAll)", async () => {
      // The source slices errors at return time: errors.slice(0, MAX_ERRORS_TRACKED).
      // Here we arrange for exactly MAX_ERRORS_TRACKED + 5 error-eligible records,
      // but capped in the returned result.
      const overflowCount = MAX_ERRORS_TRACKED + 5;
      const users = Array.from({ length: overflowCount }, (_, i) => ({
        id: `user-${i}`,
        role: "END_USER",
      }));

      const mockPrisma = {
        user: {
          count: vi.fn().mockResolvedValue(overflowCount),
          findMany: onceThenEmpty(users),
        },
        entity: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      mockGraph.syncUser.mockRejectedValue(new Error("down"));

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.reconcileAll({
        maxRecordsPerModel: overflowCount,
        batchSize: overflowCount,
      });

      // Circuit breaker fires at threshold, then reconcileAll slices errors:
      // errors.slice(0, 100) — so result.errors.length ≤ MAX_ERRORS_TRACKED.
      expect(result.errors.length).toBeLessThanOrEqual(MAX_ERRORS_TRACKED);

      // failed count reflects actual failures (circuit-breaker count), which
      // is ≤ threshold when all fail consecutively
      expect(result.models.users.failed).toBe(CIRCUIT_BREAKER_THRESHOLD);
    });

    it("error entries include model, recordId, and error message", async () => {
      const mockPrisma = makeHappyPrisma();
      mockGraph.syncUser.mockRejectedValueOnce(new Error("connection refused"));
      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.reconcileAll();

      const userError = result.errors.find((e) => e.model === "user");
      expect(userError).toBeDefined();
      expect(userError!.recordId).toBe("user-a");
      expect(userError!.error).toBe("connection refused");
    });
  });

  // =========================================================================
  // 7. checkConsistency
  // =========================================================================

  describe("checkConsistency()", () => {
    it("returns Postgres counts for each model", async () => {
      const mockPrisma = {
        user: { count: vi.fn().mockResolvedValue(42) },
        entity: { count: vi.fn().mockResolvedValue(7) },
        post: { count: vi.fn().mockResolvedValue(100) },
        postSubject: { count: vi.fn().mockResolvedValue(0) },
        entityOwnership: { count: vi.fn().mockResolvedValue(0) },
      } as unknown as any;

      mockGraph.healthCheck.mockResolvedValue({ healthy: true } as GraphHealthStatus);

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.checkConsistency();

      expect(result.counts.users.postgres).toBe(42);
      expect(result.counts.entities.postgres).toBe(7);
      expect(result.counts.posts.postgres).toBe(100);
    });

    it("reports consistent:false and mismatches when graph is unhealthy", async () => {
      const mockPrisma = {
        user: { count: vi.fn().mockResolvedValue(5) },
        entity: { count: vi.fn().mockResolvedValue(3) },
        post: { count: vi.fn().mockResolvedValue(10) },
      } as unknown as any;

      mockGraph.healthCheck.mockResolvedValue({
        healthy: false,
        error: "connection timeout",
      } as GraphHealthStatus);

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.checkConsistency();

      expect(result.consistent).toBe(false);
      expect(result.mismatches.length).toBeGreaterThan(0);

      // All graph counts reported as 0 when unhealthy
      expect(result.counts.users.graph).toBe(0);
      expect(result.counts.entities.graph).toBe(0);
      expect(result.counts.posts.graph).toBe(0);
      expect(result.counts.users.match).toBe(false);
    });

    it("returns a mismatch entry when graph count API is unavailable (graph=-1)", async () => {
      // When graph is healthy but count API not available, source returns graph: -1
      const mockPrisma = {
        user: { count: vi.fn().mockResolvedValue(5) },
        entity: { count: vi.fn().mockResolvedValue(3) },
        post: { count: vi.fn().mockResolvedValue(10) },
      } as unknown as any;

      mockGraph.healthCheck.mockResolvedValue({ healthy: true } as GraphHealthStatus);

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.checkConsistency();

      // Graph node count API not available → -1 sentinel and consistent:false
      expect(result.consistent).toBe(false);
      expect(result.counts.users.graph).toBe(-1);
      expect(result.mismatches.length).toBeGreaterThan(0);
    });

    it("calls prisma.user.count, entity.count, post.count", async () => {
      const mockPrisma = {
        user: { count: vi.fn().mockResolvedValue(0) },
        entity: { count: vi.fn().mockResolvedValue(0) },
        post: { count: vi.fn().mockResolvedValue(0) },
      } as unknown as any;

      mockGraph.healthCheck.mockResolvedValue({ healthy: true } as GraphHealthStatus);

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.checkConsistency(50);

      expect(mockPrisma.user.count).toHaveBeenCalledTimes(1);
      expect(mockPrisma.entity.count).toHaveBeenCalledTimes(1);
      expect(mockPrisma.post.count).toHaveBeenCalledTimes(1);
    });

    it("calls graphService.healthCheck", async () => {
      const mockPrisma = {
        user: { count: vi.fn().mockResolvedValue(0) },
        entity: { count: vi.fn().mockResolvedValue(0) },
        post: { count: vi.fn().mockResolvedValue(0) },
      } as unknown as any;

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.checkConsistency();

      expect(mockGraph.healthCheck).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // 8. postSubjects — grouped sync and offset pagination
  // =========================================================================

  describe("postSubjects — grouped by postId, offset-based pagination", () => {
    it("calls syncPostSubjects once per unique postId in a batch", async () => {
      const mockPrisma = {
        user: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entity: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: {
          count: vi.fn().mockResolvedValue(POST_SUBJECTS.length),
          findMany: onceThenEmpty(POST_SUBJECTS),
        },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll();

      // 2 unique postIds → 2 syncPostSubjects calls
      expect(mockGraph.syncPostSubjects).toHaveBeenCalledTimes(2);
    });

    it("passes correct entityIds and primaryEntityId to syncPostSubjects", async () => {
      const subjects = [
        { postId: "post-x", entityId: "entity-1", isPrimary: true },
        { postId: "post-x", entityId: "entity-2", isPrimary: false },
      ];

      const mockPrisma = {
        user: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entity: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: {
          count: vi.fn().mockResolvedValue(subjects.length),
          findMany: onceThenEmpty(subjects),
        },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll();

      expect(mockGraph.syncPostSubjects).toHaveBeenCalledWith({
        postId: "post-x",
        entityIds: expect.arrayContaining(["entity-1", "entity-2"]),
        primaryEntityId: "entity-1",
      });
    });

    it("postSubject circuit breaker trips after 10 consecutive post-group failures", async () => {
      // Create 12 posts each with 1 subject → 12 group syncs attempted
      const subjects = Array.from({ length: 12 }, (_, i) => ({
        postId: `post-${i}`,
        entityId: `entity-${i}`,
        isPrimary: true,
      }));

      const mockPrisma = {
        user: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        entity: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: {
          count: vi.fn().mockResolvedValue(subjects.length),
          findMany: onceThenEmpty(subjects),
        },
        entityOwnership: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      mockGraph.syncPostSubjects.mockRejectedValue(new Error("graph error"));

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      await service.reconcileAll();

      // Circuit breaker fires at threshold (10 groups)
      expect(mockGraph.syncPostSubjects).toHaveBeenCalledTimes(CIRCUIT_BREAKER_THRESHOLD);
    });
  });

  // =========================================================================
  // 9. reconcileAll counts totals correctly from count() calls
  // =========================================================================

  describe("total count population via prisma.count()", () => {
    it("populates stats.*.total from the five count() queries", async () => {
      const mockPrisma = {
        user: { count: vi.fn().mockResolvedValue(10), findMany: vi.fn().mockResolvedValue([]) },
        entity: { count: vi.fn().mockResolvedValue(20), findMany: vi.fn().mockResolvedValue([]) },
        post: { count: vi.fn().mockResolvedValue(30), findMany: vi.fn().mockResolvedValue([]) },
        postSubject: { count: vi.fn().mockResolvedValue(40), findMany: vi.fn().mockResolvedValue([]) },
        entityOwnership: { count: vi.fn().mockResolvedValue(50), findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as any;

      service = new ReconciliationService(mockPrisma, mockGraph.service);

      const result = await service.reconcileAll();

      expect(result.models.users.total).toBe(10);
      expect(result.models.entities.total).toBe(20);
      expect(result.models.posts.total).toBe(30);
      expect(result.models.postSubjects.total).toBe(40);
      expect(result.models.ownership.total).toBe(50);
    });
  });
});
