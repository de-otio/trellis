import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

// ---------------------------------------------------------------------------
// Graph service mock (hoisted so vi.mock factories can close over it)
// ---------------------------------------------------------------------------

const { mockGraphService } = vi.hoisted(() => ({
  mockGraphService: {
    createRelationship: vi.fn(),
    removeRelationship: vi.fn(),
    updateRelationshipScore: vi.fn(),
    getRelationship: vi.fn(),
    getRelationships: vi.fn(),
    getRelationshipGraph: vi.fn(),
  }}));

vi.mock("../../src/lib/graph", () => ({
  createGraphServiceFromEnv: vi.fn().mockResolvedValue(mockGraphService),
}));

import { RelationshipHandler } from "../../src/lib/relationship-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Custom error classes that mirror the graph service error naming convention */
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

class GraphConnectionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "GraphConnectionError";
  }
}

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

const mockEnv = { DATABASE_URL: "postgresql://test:test@localhost/test" } as unknown as Env;
const mockRequestContext = {} as TrellisRequestContext;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RelationshipHandler", () => {
  let handler: RelationshipHandler;
  let session: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new RelationshipHandler();
    session = makeSession();
  });

  // -------------------------------------------------------------------------
  // handleCreateRelationship
  // -------------------------------------------------------------------------

  describe("handleCreateRelationship", () => {
    function postRequest(body: unknown): Request {
      return new Request("https://api.example.com/api/relationships", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("creates a relationship and returns 201", async () => {
      const created = { id: "rel-1", tier: 1 };
      mockGraphService.createRelationship.mockResolvedValue(created);

      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toEqual(created);
      expect(mockGraphService.createRelationship).toHaveBeenCalledWith({
        userId: "user-123",
        targetType: "user",
        targetId: "user-456",
        connectionMethod: "discovery",
      });
    });

    // Inverted from "accepts an explicit connectionMethod" (V1). That test
    // encoded the privilege escalation as intended behaviour: naming "code"
    // scored the new edge 0.7, which is tier 0 — the target's inner circle —
    // so one unilateral request granted the caller read access to a stranger's
    // close-friends posts. The method is now server-decided.
    it("rejects a client-supplied connectionMethod instead of trusting it", async () => {
      mockGraphService.createRelationship.mockResolvedValue({ id: "rel-2" });

      const response = await handler.handleCreateRelationship(
        postRequest({
          targetType: "entity",
          targetId: "ent-1",
          connectionMethod: "code",
        }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.message).toMatch(/determined by the server/);
      // The escalation must not reach the graph at all, not merely be
      // downgraded on the way through.
      expect(mockGraphService.createRelationship).not.toHaveBeenCalled();
    });

    it("always records a relationship it creates as discovery", async () => {
      mockGraphService.createRelationship.mockResolvedValue({ id: "rel-3" });

      await handler.handleCreateRelationship(
        postRequest({ targetType: "entity", targetId: "ent-1" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(mockGraphService.createRelationship).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionMethod: "discovery",
          targetType: "entity",
        }),
      );
    });

    it("returns 400 when targetType is missing", async () => {
      const response = await handler.handleCreateRelationship(
        postRequest({ targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when targetType is invalid", async () => {
      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "group", targetId: "g-1" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when targetId is empty string", async () => {
      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "user", targetId: "" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when targetId exceeds max length", async () => {
      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "user", targetId: "x".repeat(101) }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when connectionMethod is invalid", async () => {
      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "user", targetId: "user-456", connectionMethod: "spam" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when user tries to create relationship with themselves", async () => {
      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "user", targetId: "user-123" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/yourself/i);
    });

    it("allows entity targetId that matches userId (self-relation guard is user-only)", async () => {
      mockGraphService.createRelationship.mockResolvedValue({ id: "rel-3" });

      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "entity", targetId: "user-123" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(201);
    });

    it("returns 400 on invalid JSON body (SyntaxError)", async () => {
      const request = new Request("https://api.example.com/api/relationships", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });

      const response = await handler.handleCreateRelationship(
        request,
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/invalid json/i);
    });

    it("returns 404 when graph service throws GraphNotFoundError", async () => {
      mockGraphService.createRelationship.mockRejectedValue(new GraphNotFoundError("not found"));

      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("NOT_FOUND");
    });

    it("returns 409 when graph service throws GraphConflictError", async () => {
      mockGraphService.createRelationship.mockRejectedValue(new GraphConflictError("already exists"));

      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("CONFLICT");
    });

    it("returns 503 when graph service throws GraphConnectionError", async () => {
      mockGraphService.createRelationship.mockRejectedValue(new GraphConnectionError("unreachable"));

      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
    });

    it("returns 503 with Retry-After and no URI on GraphConnectionError (E2)", async () => {
      mockGraphService.createRelationship.mockRejectedValue(
        new GraphConnectionError("bolt+s://abc.databases.neo4j.io:7687 connection refused"),
      );

      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
      expect(JSON.stringify(body)).not.toMatch(/bolt|neo4j\.io|username|password/i);
    });

    it("returns 503 with jitter delay on pool-acquire-timeout (E3)", async () => {
      mockGraphService.createRelationship.mockRejectedValue(
        new GraphConnectionError("connection acquisition timed out"),
      );

      const start = Date.now();
      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );
      const elapsed = Date.now() - start;

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
      expect(elapsed).toBeGreaterThanOrEqual(50);
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.createRelationship.mockRejectedValue(new Error("boom"));

      const response = await handler.handleCreateRelationship(
        postRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("INTERNAL_ERROR");
    });
  });

  // -------------------------------------------------------------------------
  // handleRemoveRelationship
  // -------------------------------------------------------------------------

  describe("handleRemoveRelationship", () => {
    function deleteRequest(params: Record<string, string> = {}): Request {
      const url = new URL("https://api.example.com/api/relationships");
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return new Request(url.toString(), { method: "DELETE" });
    }

    it("removes a relationship and returns 204", async () => {
      mockGraphService.removeRelationship.mockResolvedValue(undefined);

      const response = await handler.handleRemoveRelationship(
        deleteRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(204);
      expect(mockGraphService.removeRelationship).toHaveBeenCalledWith("user-123", "user", "user-456");
    });

    it("works with entity targetType", async () => {
      mockGraphService.removeRelationship.mockResolvedValue(undefined);

      const response = await handler.handleRemoveRelationship(
        deleteRequest({ targetType: "entity", targetId: "ent-99" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(204);
      expect(mockGraphService.removeRelationship).toHaveBeenCalledWith("user-123", "entity", "ent-99");
    });

    it("returns 400 when targetType is missing", async () => {
      const response = await handler.handleRemoveRelationship(
        deleteRequest({ targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when targetId is missing", async () => {
      const response = await handler.handleRemoveRelationship(
        deleteRequest({ targetType: "user" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when targetType is invalid", async () => {
      const response = await handler.handleRemoveRelationship(
        deleteRequest({ targetType: "group", targetId: "g-1" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.removeRelationship.mockRejectedValue(new GraphConnectionError("down"));

      const response = await handler.handleRemoveRelationship(
        deleteRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(503);
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.removeRelationship.mockRejectedValue(new Error("db exploded"));

      const response = await handler.handleRemoveRelationship(
        deleteRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // handleUpdateScore
  // -------------------------------------------------------------------------

  describe("handleUpdateScore", () => {
    function putRequest(body: unknown): Request {
      return new Request("https://api.example.com/api/relationships/score", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("updates the score and returns 200 with the relationship", async () => {
      const updated = { id: "rel-1", manualScore: 0.8 };
      mockGraphService.updateRelationshipScore.mockResolvedValue(updated);

      const response = await handler.handleUpdateScore(
        putRequest({ targetType: "user", targetId: "user-456", manualScore: 0.8 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(updated);
      expect(mockGraphService.updateRelationshipScore).toHaveBeenCalledWith({
        userId: "user-123",
        targetType: "user",
        targetId: "user-456",
        manualScore: 0.8,
      });
    });

    it("accepts null manualScore", async () => {
      mockGraphService.updateRelationshipScore.mockResolvedValue({ id: "rel-1", manualScore: null });

      const response = await handler.handleUpdateScore(
        putRequest({ targetType: "user", targetId: "user-456", manualScore: null }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      expect(mockGraphService.updateRelationshipScore).toHaveBeenCalledWith(
        expect.objectContaining({ manualScore: null }),
      );
    });

    it("accepts boundary score values 0 and 1", async () => {
      mockGraphService.updateRelationshipScore.mockResolvedValue({});

      for (const score of [0, 1]) {
        const response = await handler.handleUpdateScore(
          putRequest({ targetType: "user", targetId: "user-456", manualScore: score }),
          session,
          mockEnv,
          mockRequestContext,
        );
        expect(response.status).toBe(200);
      }
    });

    it("returns 400 when manualScore is out of range (> 1)", async () => {
      const response = await handler.handleUpdateScore(
        putRequest({ targetType: "user", targetId: "user-456", manualScore: 1.5 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when manualScore is negative", async () => {
      const response = await handler.handleUpdateScore(
        putRequest({ targetType: "user", targetId: "user-456", manualScore: -0.1 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when targetType is missing", async () => {
      const response = await handler.handleUpdateScore(
        putRequest({ targetId: "user-456", manualScore: 0.5 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 on invalid JSON body", async () => {
      const request = new Request("https://api.example.com/api/relationships/score", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{bad json",
      });

      const response = await handler.handleUpdateScore(
        request,
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 404 on GraphNotFoundError", async () => {
      mockGraphService.updateRelationshipScore.mockRejectedValue(new GraphNotFoundError("nope"));

      const response = await handler.handleUpdateScore(
        putRequest({ targetType: "user", targetId: "user-456", manualScore: 0.5 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.updateRelationshipScore.mockRejectedValue(new GraphConnectionError("down"));

      const response = await handler.handleUpdateScore(
        putRequest({ targetType: "user", targetId: "user-456", manualScore: 0.5 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(503);
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.updateRelationshipScore.mockRejectedValue(new Error("boom"));

      const response = await handler.handleUpdateScore(
        putRequest({ targetType: "user", targetId: "user-456", manualScore: 0.5 }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // handleGetRelationship
  // -------------------------------------------------------------------------

  describe("handleGetRelationship", () => {
    function getRequest(params: Record<string, string> = {}): Request {
      const url = new URL("https://api.example.com/api/relationships/single");
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return new Request(url.toString(), { method: "GET" });
    }

    it("returns 200 with the relationship when found", async () => {
      const rel = { id: "rel-1", tier: 2 };
      mockGraphService.getRelationship.mockResolvedValue(rel);

      const response = await handler.handleGetRelationship(
        getRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(rel);
      expect(mockGraphService.getRelationship).toHaveBeenCalledWith("user-123", "user", "user-456");
    });

    it("returns 200 for entity targetType", async () => {
      mockGraphService.getRelationship.mockResolvedValue({ id: "rel-2" });

      const response = await handler.handleGetRelationship(
        getRequest({ targetType: "entity", targetId: "ent-1" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      expect(mockGraphService.getRelationship).toHaveBeenCalledWith("user-123", "entity", "ent-1");
    });

    it("returns 404 when relationship is null", async () => {
      mockGraphService.getRelationship.mockResolvedValue(null);

      const response = await handler.handleGetRelationship(
        getRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("NOT_FOUND");
    });

    it("returns 400 when targetType is missing", async () => {
      const response = await handler.handleGetRelationship(
        getRequest({ targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when targetId is missing", async () => {
      const response = await handler.handleGetRelationship(
        getRequest({ targetType: "user" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when targetType is invalid", async () => {
      const response = await handler.handleGetRelationship(
        getRequest({ targetType: "org", targetId: "o-1" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.getRelationship.mockRejectedValue(new GraphConnectionError("down"));

      const response = await handler.handleGetRelationship(
        getRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(503);
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.getRelationship.mockRejectedValue(new Error("unknown"));

      const response = await handler.handleGetRelationship(
        getRequest({ targetType: "user", targetId: "user-456" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // handleGetRelationships
  // -------------------------------------------------------------------------

  describe("handleGetRelationships", () => {
    function getRequest(params: Record<string, string> = {}): Request {
      const url = new URL("https://api.example.com/api/relationships");
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return new Request(url.toString(), { method: "GET" });
    }

    it("returns 200 with all relationships (no filters)", async () => {
      const result = { items: [], nextCursor: null };
      mockGraphService.getRelationships.mockResolvedValue(result);

      const response = await handler.handleGetRelationships(
        getRequest(),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(result);
      expect(mockGraphService.getRelationships).toHaveBeenCalledWith("user-123", {
        tier: undefined,
        targetType: undefined,
        pagination: { limit: 20, cursor: undefined },
      });
    });

    it("applies tier and targetType filters", async () => {

      mockGraphService.getRelationships.mockResolvedValue({ items: [] });

      await handler.handleGetRelationships(
        getRequest({ tier: "1", targetType: "user" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(mockGraphService.getRelationships).toHaveBeenCalledWith("user-123", {
        tier: 1,
        targetType: "user",
        pagination: { limit: 20, cursor: undefined },
      });
    });

    it("applies limit and cursor from query params", async () => {
      mockGraphService.getRelationships.mockResolvedValue({ items: [] });

      await handler.handleGetRelationships(
        getRequest({ limit: "50", cursor: "tok-abc" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(mockGraphService.getRelationships).toHaveBeenCalledWith("user-123", {
        tier: undefined,
        targetType: undefined,
        pagination: { limit: 50, cursor: "tok-abc" },
      });
    });

    it("clamps limit to max 100", async () => {
      mockGraphService.getRelationships.mockResolvedValue({ items: [] });

      await handler.handleGetRelationships(
        getRequest({ limit: "999" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(mockGraphService.getRelationships).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({ pagination: { limit: 100, cursor: undefined } }),
      );
    });

    it("clamps limit to min 1", async () => {
      mockGraphService.getRelationships.mockResolvedValue({ items: [] });

      await handler.handleGetRelationships(
        getRequest({ limit: "-5" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(mockGraphService.getRelationships).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({ pagination: { limit: 1, cursor: undefined } }),
      );
    });

    it("returns 400 when tier is invalid (NaN)", async () => {
      const response = await handler.handleGetRelationships(
        getRequest({ tier: "abc" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/tier/i);
    });

    it("returns 400 when tier is out of range (> 3)", async () => {
      const response = await handler.handleGetRelationships(
        getRequest({ tier: "4" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when tier is negative", async () => {
      const response = await handler.handleGetRelationships(
        getRequest({ tier: "-1" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
    });

    it("accepts valid tier values 0, 1, 2, 3", async () => {
      mockGraphService.getRelationships.mockResolvedValue({ items: [] });

      for (const tier of ["0", "1", "2", "3"]) {
        vi.clearAllMocks();
        mockGraphService.getRelationships.mockResolvedValue({ items: [] });

        const response = await handler.handleGetRelationships(
          getRequest({ tier }),
          session,
          mockEnv,
          mockRequestContext,
        );
        expect(response.status).toBe(200);
      }
    });

    it("returns 400 when targetType is invalid", async () => {
      const response = await handler.handleGetRelationships(
        getRequest({ targetType: "org" }),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.getRelationships.mockRejectedValue(new GraphConnectionError("down"));

      const response = await handler.handleGetRelationships(
        getRequest(),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(503);
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.getRelationships.mockRejectedValue(new Error("boom"));

      const response = await handler.handleGetRelationships(
        getRequest(),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // handleGetGraph
  // -------------------------------------------------------------------------

  describe("handleGetGraph", () => {
    function getRequest(): Request {
      return new Request("https://api.example.com/api/relationships/graph", { method: "GET" });
    }

    it("returns 200 with graph data", async () => {
      const graphData = { nodes: [], edges: [] };
      mockGraphService.getRelationshipGraph.mockResolvedValue(graphData);

      const response = await handler.handleGetGraph(
        getRequest(),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(graphData);
      expect(mockGraphService.getRelationshipGraph).toHaveBeenCalledWith("user-123");
    });

    it("logs a warning about session-age check not being implemented", async () => {
      mockGraphService.getRelationshipGraph.mockResolvedValue({});

      await handler.handleGetGraph(getRequest(), session, mockEnv, mockRequestContext);

          });

    it("returns 404 on GraphNotFoundError", async () => {
      mockGraphService.getRelationshipGraph.mockRejectedValue(new GraphNotFoundError("nope"));

      const response = await handler.handleGetGraph(
        getRequest(),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
    });

    it("returns 409 on GraphConflictError", async () => {
      mockGraphService.getRelationshipGraph.mockRejectedValue(new GraphConflictError("conflict"));

      const response = await handler.handleGetGraph(
        getRequest(),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(409);
    });

    it("returns 503 on GraphConnectionError", async () => {
      mockGraphService.getRelationshipGraph.mockRejectedValue(new GraphConnectionError("down"));

      const response = await handler.handleGetGraph(
        getRequest(),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(503);
    });

    it("returns 500 on unexpected error", async () => {
      mockGraphService.getRelationshipGraph.mockRejectedValue(new Error("boom"));

      const response = await handler.handleGetGraph(
        getRequest(),
        session,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("INTERNAL_ERROR");
    });
  });
});
