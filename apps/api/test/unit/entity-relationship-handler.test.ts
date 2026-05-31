import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import type { Session } from "../../src/lib/session-cookie.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";

// ---------------------------------------------------------------------------
// Named graph error classes (mirroring what the real graph module exports)
// ---------------------------------------------------------------------------

class GraphNotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "GraphNotFoundError";
  }
}

class GraphConflictError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "GraphConflictError";
  }
}

class GraphAuthorizationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "GraphAuthorizationError";
  }
}

class GraphConnectionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "GraphConnectionError";
  }
}

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGraphService, mockPrisma } = vi.hoisted(() => ({
  mockGraphService: {
    createEntityRelationship: vi.fn(),
    confirmEntityRelationship: vi.fn(),
    rejectEntityRelationship: vi.fn(),
    removeEntityRelationship: vi.fn(),
    getEntityRelationships: vi.fn(),
    getPendingEntityRelationships: vi.fn(),
  },
  mockPrisma: {
    entityOwnership: { findFirst: vi.fn() },
  },
}));

vi.mock("../../src/lib/graph", () => ({
  createGraphServiceFromEnv: vi.fn().mockResolvedValue(mockGraphService),
}));

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

// Import after mocks
import { EntityRelationshipHandler } from "../../src/lib/entity-relationship-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockEnv = { DATABASE_URL: "postgresql://test:test@localhost/test" } as unknown as Env;
const mockRequestContext = {} as TrellisRequestContext;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    userId: "user-123",
    email: "u@example.com",
    role: "END_USER",
    expiresAt: Date.now() + 3_600_000,
    sessionType: "user",
    lastActivityAt: Date.now(),
    ...overrides,
  } as Session;
}

function makeJsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeGetRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

function makeDeleteRequest(url: string): Request {
  return new Request(url, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EntityRelationshipHandler", () => {
  let handler: EntityRelationshipHandler;
  let session: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new EntityRelationshipHandler();
    session = makeSession();
  });

  // =========================================================================
  // handleCreate
  // =========================================================================

  describe("handleCreate", () => {
    const validBody = {
      entityId: "entity-a",
      relatedEntityId: "entity-b",
      type: "PACK_MATE",
    };

    it("returns 201 with the created relationship on success", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue({ entityId: "entity-a", userId: "user-123" });
      mockGraphService.createEntityRelationship.mockResolvedValue({
        id: "rel-1",
        status: "PENDING",
        type: "PACK_MATE",
      });

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships",
        "POST",
        validBody,
      );

      const response = await handler.handleCreate(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.id).toBe("rel-1");
      expect(body.status).toBe("PENDING");
    });

    it("calls graph service with all required fields", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue({ entityId: "entity-a", userId: "user-123" });
      mockGraphService.createEntityRelationship.mockResolvedValue({ id: "rel-1" });

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships",
        "POST",
        validBody,
      );

      await handler.handleCreate(request, session, mockEnv, mockRequestContext);

      expect(mockGraphService.createEntityRelationship).toHaveBeenCalledWith({
        entityId: "entity-a",
        relatedEntityId: "entity-b",
        type: "PACK_MATE",
        proposedByUserId: "user-123",
      });
    });

    it("returns 400 on invalid relationship type", async () => {
      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships",
        "POST",
        { ...validBody, type: "ENEMY" },
      );

      const response = await handler.handleCreate(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when entityId is missing", async () => {
      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships",
        "POST",
        { relatedEntityId: "entity-b", type: "SIBLING" },
      );

      const response = await handler.handleCreate(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when entityId equals relatedEntityId (self-relationship)", async () => {
      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships",
        "POST",
        { entityId: "entity-a", relatedEntityId: "entity-a", type: "SIBLING" },
      );

      const response = await handler.handleCreate(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("same entity");
    });

    it("returns 400 on invalid JSON body", async () => {
      const request = new Request("https://api.example.com/api/entity-relationships", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{{bad}}",
      });

      const response = await handler.handleCreate(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toBe("Invalid JSON body");
    });

    it("returns 403 when caller does not own entityId", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue(null);

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships",
        "POST",
        validBody,
      );

      const response = await handler.handleCreate(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
    });

    it("returns 409 when graph service throws GraphConflictError", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue({ entityId: "entity-a", userId: "user-123" });
      mockGraphService.createEntityRelationship.mockRejectedValue(
        new GraphConflictError("already exists"),
      );

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships",
        "POST",
        validBody,
      );

      const response = await handler.handleCreate(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("CONFLICT");
    });

    it("accepts all valid relationship types", async () => {
      const validTypes = ["PACK_MATE", "SIBLING", "PLAYMATE", "PARENT", "OFFSPRING", "WALK_BUDDY"];
      mockPrisma.entityOwnership.findFirst.mockResolvedValue({ entityId: "entity-a", userId: "user-123" });
      mockGraphService.createEntityRelationship.mockResolvedValue({ id: "rel-1" });

      for (const type of validTypes) {
        vi.clearAllMocks();
        mockPrisma.entityOwnership.findFirst.mockResolvedValue({ entityId: "entity-a", userId: "user-123" });
        mockGraphService.createEntityRelationship.mockResolvedValue({ id: "rel-1" });

        const request = makeJsonRequest(
          "https://api.example.com/api/entity-relationships",
          "POST",
          { entityId: "entity-a", relatedEntityId: "entity-b", type },
        );

        const response = await handler.handleCreate(request, session, mockEnv, mockRequestContext);
        expect(response.status).toBe(201);
      }
    });
  });

  // =========================================================================
  // handleConfirm
  // =========================================================================

  describe("handleConfirm", () => {
    const validBody = { entityId: "entity-a", relatedEntityId: "entity-b" };

    it("returns 200 with the confirmed relationship on success", async () => {
      mockGraphService.confirmEntityRelationship.mockResolvedValue({
        id: "rel-1",
        status: "CONFIRMED",
      });

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/confirm",
        "POST",
        validBody,
      );

      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("CONFIRMED");
    });

    it("calls graph service with entityId, relatedEntityId, and userId", async () => {
      mockGraphService.confirmEntityRelationship.mockResolvedValue({ id: "rel-1" });

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/confirm",
        "POST",
        validBody,
      );

      await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(mockGraphService.confirmEntityRelationship).toHaveBeenCalledWith(
        "entity-a",
        "entity-b",
        "user-123",
      );
    });

    it("returns 400 when relatedEntityId is missing", async () => {
      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/confirm",
        "POST",
        { entityId: "entity-a" },
      );

      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 on invalid JSON body", async () => {
      const request = new Request("https://api.example.com/api/entity-relationships/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });

      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
    });

    it("returns 404 when graph service throws GraphNotFoundError", async () => {
      mockGraphService.confirmEntityRelationship.mockRejectedValue(
        new GraphNotFoundError("relationship not found"),
      );

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/confirm",
        "POST",
        validBody,
      );

      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("NOT_FOUND");
    });

    it("returns 403 when graph service throws GraphAuthorizationError", async () => {
      mockGraphService.confirmEntityRelationship.mockRejectedValue(
        new GraphAuthorizationError("not authorized to confirm"),
      );

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/confirm",
        "POST",
        validBody,
      );

      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(403);
    });
  });

  // =========================================================================
  // handleReject
  // =========================================================================

  describe("handleReject", () => {
    const validBody = { entityId: "entity-a", relatedEntityId: "entity-b" };

    it("returns 204 on successful rejection", async () => {
      mockGraphService.rejectEntityRelationship.mockResolvedValue(undefined);

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/reject",
        "POST",
        validBody,
      );

      const response = await handler.handleReject(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(204);
    });

    it("calls graph service with entityId, relatedEntityId, and userId", async () => {
      mockGraphService.rejectEntityRelationship.mockResolvedValue(undefined);

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/reject",
        "POST",
        validBody,
      );

      await handler.handleReject(request, session, mockEnv, mockRequestContext);

      expect(mockGraphService.rejectEntityRelationship).toHaveBeenCalledWith(
        "entity-a",
        "entity-b",
        "user-123",
      );
    });

    it("returns 400 when entityId is missing", async () => {
      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/reject",
        "POST",
        { relatedEntityId: "entity-b" },
      );

      const response = await handler.handleReject(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 403 when graph service throws GraphAuthorizationError", async () => {
      mockGraphService.rejectEntityRelationship.mockRejectedValue(
        new GraphAuthorizationError("not your relationship"),
      );

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/reject",
        "POST",
        validBody,
      );

      const response = await handler.handleReject(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
    });

    it("returns 404 when graph service throws GraphNotFoundError", async () => {
      mockGraphService.rejectEntityRelationship.mockRejectedValue(
        new GraphNotFoundError("relationship not found"),
      );

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/reject",
        "POST",
        validBody,
      );

      const response = await handler.handleReject(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(404);
    });
  });

  // =========================================================================
  // handleRemove
  // =========================================================================

  describe("handleRemove", () => {
    it("returns 204 on successful removal", async () => {
      mockGraphService.removeEntityRelationship.mockResolvedValue(undefined);

      const request = makeDeleteRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a&relatedEntityId=entity-b",
      );

      const response = await handler.handleRemove(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(204);
    });

    it("calls graph service with entityId, relatedEntityId, and userId", async () => {
      mockGraphService.removeEntityRelationship.mockResolvedValue(undefined);

      const request = makeDeleteRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a&relatedEntityId=entity-b",
      );

      await handler.handleRemove(request, session, mockEnv, mockRequestContext);

      expect(mockGraphService.removeEntityRelationship).toHaveBeenCalledWith(
        "entity-a",
        "entity-b",
        "user-123",
      );
    });

    it("returns 400 when entityId is missing", async () => {
      const request = makeDeleteRequest(
        "https://api.example.com/api/entity-relationships?relatedEntityId=entity-b",
      );

      const response = await handler.handleRemove(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("entityId");
    });

    it("returns 400 when relatedEntityId is missing", async () => {
      const request = makeDeleteRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a",
      );

      const response = await handler.handleRemove(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
    });

    it("returns 400 when both params are missing", async () => {
      const request = makeDeleteRequest(
        "https://api.example.com/api/entity-relationships",
      );

      const response = await handler.handleRemove(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
    });

    it("returns 404 when graph service throws GraphNotFoundError", async () => {
      mockGraphService.removeEntityRelationship.mockRejectedValue(
        new GraphNotFoundError("relationship not found"),
      );

      const request = makeDeleteRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a&relatedEntityId=entity-b",
      );

      const response = await handler.handleRemove(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("NOT_FOUND");
    });

    it("returns 503 when graph service throws GraphConnectionError", async () => {
      mockGraphService.removeEntityRelationship.mockRejectedValue(
        new GraphConnectionError("Graph DB unreachable"),
      );

      const request = makeDeleteRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a&relatedEntityId=entity-b",
      );

      const response = await handler.handleRemove(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(503);
    });
  });

  // =========================================================================
  // handleGetForEntity
  // =========================================================================

  describe("handleGetForEntity", () => {
    const fakeRelationships = [{ id: "rel-1", type: "PACK_MATE", status: "CONFIRMED" }];

    it("returns 400 when entityId is missing", async () => {
      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships",
      );

      const response = await handler.handleGetForEntity(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toBe("entityId is required");
    });

    it("returns 400 on invalid type filter", async () => {
      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a&type=ENEMY",
      );

      const response = await handler.handleGetForEntity(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("Invalid type");
    });

    it("returns 400 on invalid status filter", async () => {
      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a&status=MAYBE",
      );

      const response = await handler.handleGetForEntity(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("PENDING, CONFIRMED, or REJECTED");
    });

    it("returns 200 with relationships list on success", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue({ entityId: "entity-a", userId: "user-123" });
      mockGraphService.getEntityRelationships.mockResolvedValue(fakeRelationships);

      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a",
      );

      const response = await handler.handleGetForEntity(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.relationships).toEqual(fakeRelationships);
    });

    it("owner sees the requested status filter (not forced to CONFIRMED)", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue({ entityId: "entity-a", userId: "user-123" });
      mockGraphService.getEntityRelationships.mockResolvedValue([]);

      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a&status=PENDING",
      );

      await handler.handleGetForEntity(request, session, mockEnv, mockRequestContext);

      expect(mockGraphService.getEntityRelationships).toHaveBeenCalledWith(
        "entity-a",
        expect.objectContaining({ status: "PENDING" }),
      );
    });

    it("non-owner is forced to see only CONFIRMED relationships regardless of status param", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue(null); // not the owner
      mockGraphService.getEntityRelationships.mockResolvedValue([]);

      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a&status=PENDING",
      );

      await handler.handleGetForEntity(request, session, mockEnv, mockRequestContext);

      expect(mockGraphService.getEntityRelationships).toHaveBeenCalledWith(
        "entity-a",
        expect.objectContaining({ status: "CONFIRMED" }),
      );
    });

    it("non-owner with no status param is still forced to CONFIRMED", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue(null);
      mockGraphService.getEntityRelationships.mockResolvedValue(fakeRelationships);

      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a",
      );

      await handler.handleGetForEntity(request, session, mockEnv, mockRequestContext);

      expect(mockGraphService.getEntityRelationships).toHaveBeenCalledWith(
        "entity-a",
        expect.objectContaining({ status: "CONFIRMED" }),
      );
    });

    it("passes type filter when provided", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue({ entityId: "entity-a", userId: "user-123" });
      mockGraphService.getEntityRelationships.mockResolvedValue([]);

      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a&type=SIBLING",
      );

      await handler.handleGetForEntity(request, session, mockEnv, mockRequestContext);

      expect(mockGraphService.getEntityRelationships).toHaveBeenCalledWith(
        "entity-a",
        expect.objectContaining({ type: "SIBLING" }),
      );
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue(null);
      mockGraphService.getEntityRelationships.mockRejectedValue(
        new GraphConnectionError("Graph DB unreachable"),
      );

      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships?entityId=entity-a",
      );

      const response = await handler.handleGetForEntity(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(503);
    });
  });

  // =========================================================================
  // handleGetPending
  // =========================================================================

  describe("handleGetPending", () => {
    it("returns 200 with pending relationships for the session user", async () => {
      const pending = [{ id: "rel-2", status: "PENDING", type: "PACK_MATE" }];
      mockGraphService.getPendingEntityRelationships.mockResolvedValue(pending);

      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships/pending",
      );

      const response = await handler.handleGetPending(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.relationships).toEqual(pending);
    });

    it("calls graph service with session userId", async () => {
      mockGraphService.getPendingEntityRelationships.mockResolvedValue([]);

      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships/pending",
      );

      await handler.handleGetPending(request, session, mockEnv, mockRequestContext);

      expect(mockGraphService.getPendingEntityRelationships).toHaveBeenCalledWith("user-123");
    });

    it("returns 200 with empty array when no pending relationships", async () => {
      mockGraphService.getPendingEntityRelationships.mockResolvedValue([]);

      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships/pending",
      );

      const response = await handler.handleGetPending(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.relationships).toEqual([]);
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.getPendingEntityRelationships.mockRejectedValue(
        new GraphConnectionError("Graph DB timeout"),
      );

      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships/pending",
      );

      const response = await handler.handleGetPending(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.getPendingEntityRelationships.mockRejectedValue(new Error("boom"));

      const request = makeGetRequest(
        "https://api.example.com/api/entity-relationships/pending",
      );

      const response = await handler.handleGetPending(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("INTERNAL_ERROR");
    });
  });

  // =========================================================================
  // mapGraphError (private — exercised via public methods)
  // =========================================================================

  describe("mapGraphError (exercised via handleConfirm)", () => {
    const validBody = { entityId: "entity-a", relatedEntityId: "entity-b" };

    it("maps SyntaxError to 400 VALIDATION_ERROR", async () => {
      const request = new Request("https://api.example.com/api/entity-relationships/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{{syntax error",
      });

      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toBe("Invalid JSON body");
    });

    it("maps GraphNotFoundError to 404 NOT_FOUND", async () => {
      mockGraphService.confirmEntityRelationship.mockRejectedValue(
        new GraphNotFoundError("not found"),
      );

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/confirm",
        "POST",
        validBody,
      );

      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("NOT_FOUND");
          });

    it("maps GraphConflictError to 409 CONFLICT", async () => {
      mockGraphService.confirmEntityRelationship.mockRejectedValue(
        new GraphConflictError("already exists"),
      );

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/confirm",
        "POST",
        validBody,
      );

      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("CONFLICT");
          });

    it("maps GraphAuthorizationError to 403 FORBIDDEN", async () => {
      mockGraphService.confirmEntityRelationship.mockRejectedValue(
        new GraphAuthorizationError("forbidden"),
      );

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/confirm",
        "POST",
        validBody,
      );

      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
          });

    it("maps GraphConnectionError to 503 service_unavailable", async () => {
      mockGraphService.confirmEntityRelationship.mockRejectedValue(
        new GraphConnectionError("Graph DB down"),
      );

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/confirm",
        "POST",
        validBody,
      );

      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
      expect(body.message).toBeUndefined();
    });

    it("returns 503 with Retry-After and no URI on GraphConnectionError (E2)", async () => {
      mockGraphService.confirmEntityRelationship.mockRejectedValue(
        new GraphConnectionError("bolt+s://abc.databases.neo4j.io:7687 connection refused"),
      );

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/confirm",
        "POST",
        validBody,
      );

      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
      expect(JSON.stringify(body)).not.toMatch(/bolt|neo4j\.io|username|password/i);
    });

    it("returns 503 with jitter delay on pool-acquire-timeout (E3)", async () => {
      mockGraphService.confirmEntityRelationship.mockRejectedValue(
        new GraphConnectionError("connection acquisition timed out"),
      );

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/confirm",
        "POST",
        validBody,
      );

      const start = Date.now();
      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);
      const elapsed = Date.now() - start;

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
      expect(elapsed).toBeGreaterThanOrEqual(50);
    });

    it("maps generic Error to 500 INTERNAL_ERROR and logs it", async () => {
      mockGraphService.confirmEntityRelationship.mockRejectedValue(new Error("completely unexpected"));

      const request = makeJsonRequest(
        "https://api.example.com/api/entity-relationships/confirm",
        "POST",
        validBody,
      );

      const response = await handler.handleConfirm(request, session, mockEnv, mockRequestContext);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("INTERNAL_ERROR");
          });
  });
});
