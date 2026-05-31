/**
 * Unit Tests: Entity-to-Entity Relationships in Neo4jGraphService
 *
 * Tests cover:
 * - createEntityRelationship: ownership check, conflict detection, auto-confirm
 *   logic for PACK_MATE, PENDING creation for other types
 * - confirmEntityRelationship: ownership check, status guard, symmetric
 *   reciprocal creation (SIBLING, PLAYMATE, WALK_BUDDY), asymmetric pair
 *   creation (PARENT→OFFSPRING), PACK_MATE symmetric confirm
 * - rejectEntityRelationship: ownership check, not-found guard, status update
 * - removeEntityRelationship: ownership check (either entity), not-found guard,
 *   deletion of both A→B and B→A edges
 * - getEntityRelationships: unfiltered, type filter, status filter
 * - getPendingEntityRelationships: returns pending where user owns target
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Neo4jGraphService } from "../../../src/lib/graph/neo4j-graph-service.js";
import {
  GraphAuthorizationError,
  GraphConflictError,
  GraphNotFoundError,
} from "../../../src/lib/graph/errors.js";
import type { EntityRelationship, EntityRelationshipStatus } from "../../../src/lib/graph/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock Neo4j record that returns a value by key name. */
function mockRecord(data: Record<string, unknown>) {
  return {
    get: (key: string) => data[key],
  };
}

/** Build a mock QueryResult with given records. */
function mockResult(records: ReturnType<typeof mockRecord>[]) {
  return { records };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_A = "user-alice";
const USER_B = "user-bob";
const ENTITY_LUNA = "entity-luna";
const ENTITY_ROCKY = "entity-rocky";
const SINCE_ISO = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Neo4jGraphService — Entity Relationships", () => {
  let service: Neo4jGraphService;
  let executeQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new Neo4jGraphService();

    // Spy on the internal executeQuery helper so tests can control what the
    // "database" returns without needing a real Neo4j instance.
    executeQuery = vi
      .spyOn(service, "executeQuery")
      .mockResolvedValue(mockResult([]));
  });

  // =========================================================================
  // createEntityRelationship
  // =========================================================================

  describe("createEntityRelationship", () => {
    it("throws GraphAuthorizationError when proposing user does not own the source entity", async () => {
      // ownership check returns empty → not an owner
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await expect(
        service.createEntityRelationship({
          entityId: ENTITY_LUNA,
          relatedEntityId: ENTITY_ROCKY,
          type: "SIBLING",
          proposedByUserId: USER_A,
        }),
      ).rejects.toThrow(GraphAuthorizationError);

      expect(executeQuery).toHaveBeenCalledTimes(1);
    });

    it("throws GraphNotFoundError when either entity does not exist in the graph", async () => {
      // 1. ownership check → owns entity
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      // 2. entity existence check → empty (entity not found)
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await expect(
        service.createEntityRelationship({
          entityId: ENTITY_LUNA,
          relatedEntityId: ENTITY_ROCKY,
          type: "SIBLING",
          proposedByUserId: USER_A,
        }),
      ).rejects.toThrow(GraphNotFoundError);

      expect(executeQuery).toHaveBeenCalledTimes(2);
    });

    it("throws GraphConflictError when relationship of same type already exists", async () => {
      // 1. ownership check → owns entity
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      // 2. entity existence check → both entities found
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ aId: ENTITY_LUNA, bId: ENTITY_ROCKY })]),
      );
      // 3. existing relationship check → relationship exists
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ status: "PENDING" })]),
      );

      await expect(
        service.createEntityRelationship({
          entityId: ENTITY_LUNA,
          relatedEntityId: ENTITY_ROCKY,
          type: "SIBLING",
          proposedByUserId: USER_A,
        }),
      ).rejects.toThrow(GraphConflictError);
    });

    it("creates a PENDING relationship for SIBLING type (non-auto-confirm)", async () => {
      // 1. ownership check
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      // 2. entity existence
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ aId: ENTITY_LUNA, bId: ENTITY_ROCKY })]),
      );
      // 3. existing relationship check → none
      executeQuery.mockResolvedValueOnce(mockResult([]));
      // 4. CREATE edge call
      executeQuery.mockResolvedValueOnce(mockResult([]));

      const result = await service.createEntityRelationship({
        entityId: ENTITY_LUNA,
        relatedEntityId: ENTITY_ROCKY,
        type: "SIBLING",
        proposedByUserId: USER_A,
      });

      expect(result).toMatchObject<Partial<EntityRelationship>>({
        entityId: ENTITY_LUNA,
        relatedEntityId: ENTITY_ROCKY,
        type: "SIBLING",
        status: "PENDING",
        proposedByUserId: USER_A,
      });
      expect(result.since).toBeInstanceOf(Date);

      // Only 4 calls (no auto-confirm check for non-PACK_MATE)
      expect(executeQuery).toHaveBeenCalledTimes(4);
    });

    it("creates PENDING PACK_MATE when user owns one entity with CARETAKER role only", async () => {
      // 1. ownership check (proposer owns LUNA, any role is fine for ownership)
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "CARETAKER" })]),
      );
      // 2. entity existence
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ aId: ENTITY_LUNA, bId: ENTITY_ROCKY })]),
      );
      // 3. existing relationship check → none
      executeQuery.mockResolvedValueOnce(mockResult([]));
      // 4. shared owner check (PACK_MATE auto-confirm) → no shared owner with PRIMARY/CO_OWNER
      executeQuery.mockResolvedValueOnce(mockResult([]));
      // 5. CREATE PENDING edge
      executeQuery.mockResolvedValueOnce(mockResult([]));

      const result = await service.createEntityRelationship({
        entityId: ENTITY_LUNA,
        relatedEntityId: ENTITY_ROCKY,
        type: "PACK_MATE",
        proposedByUserId: USER_A,
      });

      expect(result.status).toBe("PENDING");
    });

    it("auto-confirms PACK_MATE when same user owns both entities with PRIMARY_OWNER role", async () => {
      // 1. ownership check
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      // 2. entity existence
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ aId: ENTITY_LUNA, bId: ENTITY_ROCKY })]),
      );
      // 3. existing relationship check → none
      executeQuery.mockResolvedValueOnce(mockResult([]));
      // 4. shared owner check → user owns both with PRIMARY_OWNER
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ userId: USER_A })]),
      );
      // 5. CREATE bidirectional CONFIRMED edges
      executeQuery.mockResolvedValueOnce(mockResult([]));

      const result = await service.createEntityRelationship({
        entityId: ENTITY_LUNA,
        relatedEntityId: ENTITY_ROCKY,
        type: "PACK_MATE",
        proposedByUserId: USER_A,
      });

      expect(result.status).toBe("CONFIRMED");
      // 5 calls: ownership, entities, existing check, shared owner, create
      expect(executeQuery).toHaveBeenCalledTimes(5);

      // The CREATE call should have created bidirectional edges (check query contains both directions)
      const createCall = executeQuery.mock.calls[4][0] as string;
      // The query creates both (a)->(b) and (b)->(a)
      expect(createCall).toContain("CREATE (a)-[:ENTITY_RELATES");
      expect(createCall).toContain("CREATE (b)-[:ENTITY_RELATES");
    });

    it("auto-confirms PACK_MATE when same user owns both entities with CO_OWNER role", async () => {
      // 1. ownership check
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "CO_OWNER" })]),
      );
      // 2. entity existence
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ aId: ENTITY_LUNA, bId: ENTITY_ROCKY })]),
      );
      // 3. existing relationship check → none
      executeQuery.mockResolvedValueOnce(mockResult([]));
      // 4. shared owner check → user owns both with CO_OWNER
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ userId: USER_A })]),
      );
      // 5. CREATE bidirectional CONFIRMED edges
      executeQuery.mockResolvedValueOnce(mockResult([]));

      const result = await service.createEntityRelationship({
        entityId: ENTITY_LUNA,
        relatedEntityId: ENTITY_ROCKY,
        type: "PACK_MATE",
        proposedByUserId: USER_A,
      });

      expect(result.status).toBe("CONFIRMED");
    });
  });

  // =========================================================================
  // confirmEntityRelationship
  // =========================================================================

  describe("confirmEntityRelationship", () => {
    it("throws GraphAuthorizationError when confirming user does not own the target entity", async () => {
      // ownership of relatedEntityId returns empty
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await expect(
        service.confirmEntityRelationship(ENTITY_LUNA, ENTITY_ROCKY, USER_B),
      ).rejects.toThrow(GraphAuthorizationError);
    });

    it("throws GraphNotFoundError when relationship does not exist", async () => {
      // 1. ownership → owns target
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      // 2. relationship check → not found
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await expect(
        service.confirmEntityRelationship(ENTITY_LUNA, ENTITY_ROCKY, USER_B),
      ).rejects.toThrow(GraphNotFoundError);
    });

    it("throws GraphConflictError when relationship is already CONFIRMED", async () => {
      // 1. ownership → owns target
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      // 2. relationship check → already CONFIRMED
      executeQuery.mockResolvedValueOnce(
        mockResult([
          mockRecord({
            type: "SIBLING",
            status: "CONFIRMED",
            proposedByUserId: USER_A,
            since: SINCE_ISO,
          }),
        ]),
      );

      await expect(
        service.confirmEntityRelationship(ENTITY_LUNA, ENTITY_ROCKY, USER_B),
      ).rejects.toThrow(GraphConflictError);
    });

    it("throws GraphConflictError when relationship is already REJECTED", async () => {
      // 1. ownership → owns target
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      // 2. relationship check → REJECTED
      executeQuery.mockResolvedValueOnce(
        mockResult([
          mockRecord({
            type: "SIBLING",
            status: "REJECTED",
            proposedByUserId: USER_A,
            since: SINCE_ISO,
          }),
        ]),
      );

      await expect(
        service.confirmEntityRelationship(ENTITY_LUNA, ENTITY_ROCKY, USER_B),
      ).rejects.toThrow(GraphConflictError);
    });

    it("confirms SIBLING and creates reverse B→A edge (symmetric)", async () => {
      // 1. ownership check
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      // 2. relationship check → PENDING SIBLING
      executeQuery.mockResolvedValueOnce(
        mockResult([
          mockRecord({
            type: "SIBLING",
            status: "PENDING",
            proposedByUserId: USER_A,
            since: SINCE_ISO,
          }),
        ]),
      );
      // 3. SET r.status = 'CONFIRMED' on A→B
      executeQuery.mockResolvedValueOnce(mockResult([]));
      // 4. reverse edge check (B→A SIBLING) → not found
      executeQuery.mockResolvedValueOnce(mockResult([]));
      // 5. CREATE reverse B→A SIBLING CONFIRMED
      executeQuery.mockResolvedValueOnce(mockResult([]));

      const result = await service.confirmEntityRelationship(
        ENTITY_LUNA,
        ENTITY_ROCKY,
        USER_B,
      );

      expect(result).toMatchObject<Partial<EntityRelationship>>({
        entityId: ENTITY_LUNA,
        relatedEntityId: ENTITY_ROCKY,
        type: "SIBLING",
        status: "CONFIRMED",
        proposedByUserId: USER_A,
      });
      expect(executeQuery).toHaveBeenCalledTimes(5);

      // CREATE call should be for the reverse direction
      const createQuery = executeQuery.mock.calls[4][0] as string;
      expect(createQuery).toContain("CREATE (b)-[:ENTITY_RELATES");
    });

    it("confirms PLAYMATE and creates reverse B→A edge (symmetric)", async () => {
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      executeQuery.mockResolvedValueOnce(
        mockResult([
          mockRecord({
            type: "PLAYMATE",
            status: "PENDING",
            proposedByUserId: USER_A,
            since: SINCE_ISO,
          }),
        ]),
      );
      executeQuery.mockResolvedValueOnce(mockResult([])); // SET CONFIRMED
      executeQuery.mockResolvedValueOnce(mockResult([])); // reverse check
      executeQuery.mockResolvedValueOnce(mockResult([])); // CREATE reverse

      const result = await service.confirmEntityRelationship(
        ENTITY_LUNA,
        ENTITY_ROCKY,
        USER_B,
      );

      expect(result.type).toBe("PLAYMATE");
      expect(result.status).toBe("CONFIRMED");
    });

    it("confirms WALK_BUDDY and creates reverse B→A edge (symmetric)", async () => {
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "CO_OWNER" })]),
      );
      executeQuery.mockResolvedValueOnce(
        mockResult([
          mockRecord({
            type: "WALK_BUDDY",
            status: "PENDING",
            proposedByUserId: USER_A,
            since: SINCE_ISO,
          }),
        ]),
      );
      executeQuery.mockResolvedValueOnce(mockResult([])); // SET CONFIRMED
      executeQuery.mockResolvedValueOnce(mockResult([])); // reverse check
      executeQuery.mockResolvedValueOnce(mockResult([])); // CREATE reverse

      const result = await service.confirmEntityRelationship(
        ENTITY_LUNA,
        ENTITY_ROCKY,
        USER_B,
      );

      expect(result.type).toBe("WALK_BUDDY");
      expect(result.status).toBe("CONFIRMED");
    });

    it("confirms PACK_MATE and creates reverse B→A edge (symmetric)", async () => {
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      executeQuery.mockResolvedValueOnce(
        mockResult([
          mockRecord({
            type: "PACK_MATE",
            status: "PENDING",
            proposedByUserId: USER_A,
            since: SINCE_ISO,
          }),
        ]),
      );
      executeQuery.mockResolvedValueOnce(mockResult([])); // SET CONFIRMED
      executeQuery.mockResolvedValueOnce(mockResult([])); // reverse check → not found
      executeQuery.mockResolvedValueOnce(mockResult([])); // CREATE reverse

      const result = await service.confirmEntityRelationship(
        ENTITY_LUNA,
        ENTITY_ROCKY,
        USER_B,
      );

      expect(result.type).toBe("PACK_MATE");
      expect(result.status).toBe("CONFIRMED");
    });

    it("confirms PARENT and creates B→A OFFSPRING edge (asymmetric)", async () => {
      // 1. ownership check
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      // 2. relationship check → PENDING PARENT (Luna→Rocky: Luna is parent)
      executeQuery.mockResolvedValueOnce(
        mockResult([
          mockRecord({
            type: "PARENT",
            status: "PENDING",
            proposedByUserId: USER_A,
            since: SINCE_ISO,
          }),
        ]),
      );
      // 3. SET CONFIRMED on A→B PARENT edge
      executeQuery.mockResolvedValueOnce(mockResult([]));
      // 4. reverse edge check: Rocky→Luna OFFSPRING → not found
      executeQuery.mockResolvedValueOnce(mockResult([]));
      // 5. CREATE B→A OFFSPRING edge
      executeQuery.mockResolvedValueOnce(mockResult([]));

      const result = await service.confirmEntityRelationship(
        ENTITY_LUNA,
        ENTITY_ROCKY,
        USER_B,
      );

      expect(result.type).toBe("PARENT");
      expect(result.status).toBe("CONFIRMED");

      // The CREATE call should use 'OFFSPRING' as the inverse type
      const createQuery = executeQuery.mock.calls[4][0] as string;
      expect(createQuery).toContain("$inverseType");
      const createParams = executeQuery.mock.calls[4][1] as Record<string, unknown>;
      expect(createParams.inverseType).toBe("OFFSPRING");
    });

    it("confirms OFFSPRING and creates B→A PARENT edge (asymmetric)", async () => {
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      executeQuery.mockResolvedValueOnce(
        mockResult([
          mockRecord({
            type: "OFFSPRING",
            status: "PENDING",
            proposedByUserId: USER_A,
            since: SINCE_ISO,
          }),
        ]),
      );
      executeQuery.mockResolvedValueOnce(mockResult([])); // SET CONFIRMED
      executeQuery.mockResolvedValueOnce(mockResult([])); // reverse check
      executeQuery.mockResolvedValueOnce(mockResult([])); // CREATE reverse

      const result = await service.confirmEntityRelationship(
        ENTITY_LUNA,
        ENTITY_ROCKY,
        USER_B,
      );

      expect(result.type).toBe("OFFSPRING");
      const createParams = executeQuery.mock.calls[4][1] as Record<string, unknown>;
      expect(createParams.inverseType).toBe("PARENT");
    });

    it("updates existing reverse edge to CONFIRMED when it already exists (symmetric)", async () => {
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      executeQuery.mockResolvedValueOnce(
        mockResult([
          mockRecord({
            type: "SIBLING",
            status: "PENDING",
            proposedByUserId: USER_A,
            since: SINCE_ISO,
          }),
        ]),
      );
      executeQuery.mockResolvedValueOnce(mockResult([])); // SET CONFIRMED
      // reverse check → already exists
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ status: "PENDING" })]),
      );
      // SET CONFIRMED on reverse edge
      executeQuery.mockResolvedValueOnce(mockResult([]));

      const result = await service.confirmEntityRelationship(
        ENTITY_LUNA,
        ENTITY_ROCKY,
        USER_B,
      );

      expect(result.status).toBe("CONFIRMED");

      // 5th call should be SET r.status = 'CONFIRMED' (not CREATE)
      const updateQuery = executeQuery.mock.calls[4][0] as string;
      expect(updateQuery).toContain("SET r.status = 'CONFIRMED'");
      expect(updateQuery).not.toContain("CREATE");
    });
  });

  // =========================================================================
  // rejectEntityRelationship
  // =========================================================================

  describe("rejectEntityRelationship", () => {
    it("throws GraphAuthorizationError when rejecting user does not own the target entity", async () => {
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await expect(
        service.rejectEntityRelationship(ENTITY_LUNA, ENTITY_ROCKY, USER_B),
      ).rejects.toThrow(GraphAuthorizationError);
    });

    it("throws GraphNotFoundError when relationship does not exist", async () => {
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await expect(
        service.rejectEntityRelationship(ENTITY_LUNA, ENTITY_ROCKY, USER_B),
      ).rejects.toThrow(GraphNotFoundError);
    });

    it("sets relationship status to REJECTED", async () => {
      // 1. ownership check
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      // 2. relationship check → PENDING
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ status: "PENDING" })]),
      );
      // 3. SET REJECTED
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await service.rejectEntityRelationship(ENTITY_LUNA, ENTITY_ROCKY, USER_B);

      expect(executeQuery).toHaveBeenCalledTimes(3);

      const rejectQuery = executeQuery.mock.calls[2][0] as string;
      expect(rejectQuery).toContain("SET r.status = 'REJECTED'");
    });
  });

  // =========================================================================
  // removeEntityRelationship
  // =========================================================================

  describe("removeEntityRelationship", () => {
    it("throws GraphAuthorizationError when user does not own either entity", async () => {
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await expect(
        service.removeEntityRelationship(ENTITY_LUNA, ENTITY_ROCKY, USER_A),
      ).rejects.toThrow(GraphAuthorizationError);
    });

    it("throws GraphNotFoundError when relationship does not exist", async () => {
      // 1. ownership check → owns an entity
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ ownedEntityId: ENTITY_LUNA })]),
      );
      // 2. relationship check → not found
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await expect(
        service.removeEntityRelationship(ENTITY_LUNA, ENTITY_ROCKY, USER_A),
      ).rejects.toThrow(GraphNotFoundError);
    });

    it("deletes A→B edge and the reciprocal B→A edge", async () => {
      // 1. ownership check → owns source entity
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ ownedEntityId: ENTITY_LUNA })]),
      );
      // 2. relationship check → found
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ type: "SIBLING" })]),
      );
      // 3. DELETE A→B
      executeQuery.mockResolvedValueOnce(mockResult([]));
      // 4. OPTIONAL MATCH + DELETE B→A
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await service.removeEntityRelationship(ENTITY_LUNA, ENTITY_ROCKY, USER_A);

      expect(executeQuery).toHaveBeenCalledTimes(4);

      // Check forward delete query
      const deleteForward = executeQuery.mock.calls[2][0] as string;
      expect(deleteForward).toContain("DELETE r");
      expect(deleteForward).toContain(`id: $entityId`);
      expect(deleteForward).toContain(`id: $relatedEntityId`);

      // Check reverse delete query (uses OPTIONAL MATCH to handle non-existent reverse)
      const deleteReverse = executeQuery.mock.calls[3][0] as string;
      expect(deleteReverse).toContain("OPTIONAL MATCH");
      expect(deleteReverse).toContain("DELETE r");
    });

    it("allows removal by owner of the target entity (not just source)", async () => {
      // USER_B owns ROCKY (the target)
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ ownedEntityId: ENTITY_ROCKY })]),
      );
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ type: "SIBLING" })]),
      );
      executeQuery.mockResolvedValueOnce(mockResult([]));
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await expect(
        service.removeEntityRelationship(ENTITY_LUNA, ENTITY_ROCKY, USER_B),
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // getEntityRelationships
  // =========================================================================

  describe("getEntityRelationships", () => {
    const relRecord = mockRecord({
      relatedEntityId: ENTITY_ROCKY,
      type: "SIBLING",
      status: "CONFIRMED",
      proposedByUserId: USER_A,
      since: SINCE_ISO,
    });

    it("returns all relationships for an entity when no filters provided", async () => {
      executeQuery.mockResolvedValueOnce(mockResult([relRecord]));

      const result = await service.getEntityRelationships(ENTITY_LUNA);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject<Partial<EntityRelationship>>({
        entityId: ENTITY_LUNA,
        relatedEntityId: ENTITY_ROCKY,
        type: "SIBLING",
        status: "CONFIRMED",
        proposedByUserId: USER_A,
      });
      expect(result[0].since).toBeInstanceOf(Date);
    });

    it("passes type filter to query parameters", async () => {
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await service.getEntityRelationships(ENTITY_LUNA, { type: "PACK_MATE" });

      const query = executeQuery.mock.calls[0][0] as string;
      expect(query).toContain("r.type = $type");
      const params = executeQuery.mock.calls[0][1] as Record<string, unknown>;
      expect(params.type).toBe("PACK_MATE");
    });

    it("passes status filter to query parameters", async () => {
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await service.getEntityRelationships(ENTITY_LUNA, { status: "PENDING" });

      const query = executeQuery.mock.calls[0][0] as string;
      expect(query).toContain("r.status = $status");
      const params = executeQuery.mock.calls[0][1] as Record<string, unknown>;
      expect(params.status).toBe("PENDING");
    });

    it("passes both type and status filters when both are provided", async () => {
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await service.getEntityRelationships(ENTITY_LUNA, {
        type: "SIBLING",
        status: "CONFIRMED",
      });

      const query = executeQuery.mock.calls[0][0] as string;
      expect(query).toContain("r.type = $type");
      expect(query).toContain("r.status = $status");
    });

    it("returns empty array when no relationships exist", async () => {
      executeQuery.mockResolvedValueOnce(mockResult([]));

      const result = await service.getEntityRelationships(ENTITY_LUNA);

      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getPendingEntityRelationships
  // =========================================================================

  describe("getPendingEntityRelationships", () => {
    it("returns pending relationships where user owns the target entity", async () => {
      const pendingRecord = mockRecord({
        entityId: ENTITY_LUNA,
        relatedEntityId: ENTITY_ROCKY,
        type: "SIBLING",
        proposedByUserId: USER_A,
        since: SINCE_ISO,
      });

      executeQuery.mockResolvedValueOnce(mockResult([pendingRecord]));

      const result = await service.getPendingEntityRelationships(USER_B);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject<Partial<EntityRelationship>>({
        entityId: ENTITY_LUNA,
        relatedEntityId: ENTITY_ROCKY,
        type: "SIBLING",
        status: "PENDING",
        proposedByUserId: USER_A,
      });
    });

    it("returns empty array when user has no pending requests", async () => {
      executeQuery.mockResolvedValueOnce(mockResult([]));

      const result = await service.getPendingEntityRelationships(USER_B);

      expect(result).toEqual([]);
    });

    it("passes userId to query and filters for PENDING status", async () => {
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await service.getPendingEntityRelationships(USER_B);

      const query = executeQuery.mock.calls[0][0] as string;
      expect(query).toContain("status: 'PENDING'");
      const params = executeQuery.mock.calls[0][1] as Record<string, unknown>;
      expect(params.userId).toBe(USER_B);
    });

    it("returns all fields as EntityRelationship objects with correct types", async () => {
      const types: EntityRelationship["type"][] = [
        "PACK_MATE",
        "SIBLING",
        "PLAYMATE",
        "WALK_BUDDY",
        "PARENT",
        "OFFSPRING",
      ];

      for (const type of types) {
        vi.clearAllMocks();
        executeQuery = vi.spyOn(service, "executeQuery").mockResolvedValueOnce(
          mockResult([
            mockRecord({
              entityId: ENTITY_LUNA,
              relatedEntityId: ENTITY_ROCKY,
              type,
              proposedByUserId: USER_A,
              since: SINCE_ISO,
            }),
          ]),
        );

        const result = await service.getPendingEntityRelationships(USER_B);

        expect(result[0].type).toBe(type);
        const status: EntityRelationshipStatus = result[0].status;
        expect(status).toBe("PENDING");
      }
    });
  });

  // =========================================================================
  // Query parameterization (security)
  // =========================================================================

  describe("Query parameterization (SECURITY)", () => {
    it("createEntityRelationship uses only $-prefixed params, no string interpolation of user data", async () => {
      // Ownership check
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ role: "PRIMARY_OWNER" })]),
      );
      // Entity check
      executeQuery.mockResolvedValueOnce(
        mockResult([mockRecord({ aId: ENTITY_LUNA, bId: ENTITY_ROCKY })]),
      );
      // Existing check → none
      executeQuery.mockResolvedValueOnce(mockResult([]));
      // Create
      executeQuery.mockResolvedValueOnce(mockResult([]));

      await service.createEntityRelationship({
        entityId: ENTITY_LUNA,
        relatedEntityId: ENTITY_ROCKY,
        type: "SIBLING",
        proposedByUserId: USER_A,
      });

      for (const call of executeQuery.mock.calls) {
        const query = call[0] as string;
        const params = call[1] as Record<string, unknown>;
        // Verify entityId is not directly in the query string (must be parameterized)
        expect(query).not.toContain(ENTITY_LUNA);
        expect(query).not.toContain(ENTITY_ROCKY);
        expect(query).not.toContain(USER_A);
        // Verify parameters object is passed
        expect(params).toBeDefined();
      }
    });
  });
});
