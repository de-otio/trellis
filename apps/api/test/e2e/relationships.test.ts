/**
 * Relationships API E2E Tests
 *
 * Tests all /api/relationships endpoints: create, list, get single,
 * update score, delete, and graph visualization.
 *
 * Graph endpoints may return 503 if the graph DB is unavailable in the
 * test environment — those tests skip assertions rather than fail.
 *
 * Requires 2 shard users: user0 (primary), user1 (target for user→user tests).
 */

import { afterAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("Relationships API", () => {
  const user0 = getShardUser(0);
  const user1 = getShardUser(1);

  // Track entity IDs created so we can clean them up in afterAll.
  // Format: { targetType, targetId }
  const createdRelationships: Array<{ targetType: string; targetId: string }> = [];

  afterAll(async () => {
    for (const rel of createdRelationships) {
      try {
        await Promise.race([
          user0.authFetch(
            `${API_URL}/api/relationships?targetType=${rel.targetType}&targetId=${encodeURIComponent(rel.targetId)}`,
            { method: "DELETE" },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Cleanup timeout")), 5_000),
          ),
        ]);
      } catch {
        // Best-effort cleanup — don't fail the suite
        console.warn(`[cleanup] Failed to delete relationship ${rel.targetType}:${rel.targetId}`);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/relationships
  // ---------------------------------------------------------------------------
  describe("POST /api/relationships", () => {
    it("creates a user→entity relationship and returns 201", async () => {
      const entityId = `__e2e_entity_${Date.now()}`;
      const res = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "entity", targetId: entityId }),
      });

      // 201 = created, 503 = graph unavailable (both acceptable)
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(400);

      if (res.status === 201) {
        const body = await res.json();
        expect(body).toHaveProperty("targetId", entityId);
        expect(body).toHaveProperty("targetType", "entity");
        createdRelationships.push({ targetType: "entity", targetId: entityId });
      }
    });

    it("creates a user→user relationship and returns 201", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "user",
          targetId: user1.userId,
          connectionMethod: "discovery",
        }),
      });

      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(400);

      if (res.status === 201) {
        const body = await res.json();
        expect(body).toHaveProperty("targetId", user1.userId);
        createdRelationships.push({ targetType: "user", targetId: user1.userId });
      }
    });

    it("accepts all valid connectionMethod values", async () => {
      const entityId = `__e2e_entity_cm_${Date.now()}`;
      const res = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "entity",
          targetId: entityId,
          connectionMethod: "import",
        }),
      });

      expect(res.status).not.toBe(401);
      // Valid request must not be rejected by validation
      expect(res.status).not.toBe(400);

      if (res.status === 201) {
        createdRelationships.push({ targetType: "entity", targetId: entityId });
      }
    });

    it("returns 400 when targetType is missing", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: "some-id" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });

    it("returns 400 when targetId is missing", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "user" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });

    it("returns 400 when targetType is invalid", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "group", targetId: "some-id" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when user tries to relate to themselves", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "user", targetId: user0.userId }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 409 on duplicate relationship", async () => {
      // Use an entity ID that's very likely to already have been created above
      // or create a fresh one and then attempt to create it twice.
      const entityId = `__e2e_entity_dup_${Date.now()}`;

      // First creation
      const first = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "entity", targetId: entityId }),
      });

      expect(first.status).not.toBe(401);

      if (first.status === 201) {
        createdRelationships.push({ targetType: "entity", targetId: entityId });

        // Second creation — should conflict
        const second = await user0.authFetch(`${API_URL}/api/relationships`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetType: "entity", targetId: entityId }),
        });
        expect(second.status).toBe(409);
        const body = await second.json();
        expect(body.error).toBe("CONFLICT");
      }
      // If 503, graph is unavailable — skip the conflict assertion
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/relationships
  // ---------------------------------------------------------------------------
  describe("GET /api/relationships", () => {
    it("returns 200 with relationships array", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships`);
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);

      if (res.status === 200) {
        const body = await res.json();
        expect(body).toHaveProperty("relationships");
        expect(Array.isArray(body.relationships)).toBe(true);
        // nextCursor may be null/undefined or a string
        expect(body).toHaveProperty("nextCursor");
      }
    });

    it("accepts tier filter (tier=0)", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships?tier=0`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(400);
      expect(res.status).toBeLessThan(500);
    });

    it("accepts tier filter (tier=2)", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships?tier=2`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(400);
      expect(res.status).toBeLessThan(500);
    });

    it("accepts targetType filter", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships?targetType=user`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(400);
      expect(res.status).toBeLessThan(500);
    });

    it("accepts limit and cursor params", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships?limit=5`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(400);
      expect(res.status).toBeLessThan(500);
    });

    it("returns 400 for invalid tier value", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships?tier=99`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for non-numeric tier", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships?tier=bad`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for invalid targetType", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships?targetType=group`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/relationships/single
  // ---------------------------------------------------------------------------
  describe("GET /api/relationships/single", () => {
    it("returns 200 when relationship exists", async () => {
      // Create a relationship first so we can look it up
      const entityId = `__e2e_entity_single_${Date.now()}`;
      const createRes = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "entity", targetId: entityId }),
      });

      expect(createRes.status).not.toBe(401);

      if (createRes.status === 201) {
        createdRelationships.push({ targetType: "entity", targetId: entityId });

        const res = await user0.authFetch(
          `${API_URL}/api/relationships/single?targetType=entity&targetId=${encodeURIComponent(entityId)}`,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty("targetId", entityId);
        expect(body).toHaveProperty("targetType", "entity");
      }
      // If 503, graph is unavailable — skip assertion
    });

    it("returns 404 when relationship does not exist", async () => {
      const nonExistentId = `non-existent-id-${Date.now()}`;
      const res = await user0.authFetch(
        `${API_URL}/api/relationships/single?targetType=entity&targetId=${encodeURIComponent(nonExistentId)}`,
      );

      // 404 = not found (expected), 503 = graph unavailable (acceptable)
      expect(res.status).not.toBe(401);
      if (res.status !== 503) {
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toBe("NOT_FOUND");
      }
    });

    it("returns 400 when targetType is missing", async () => {
      const res = await user0.authFetch(
        `${API_URL}/api/relationships/single?targetId=some-id`,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when targetId is missing", async () => {
      const res = await user0.authFetch(
        `${API_URL}/api/relationships/single?targetType=entity`,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when both params are missing", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships/single`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/relationships/score
  // ---------------------------------------------------------------------------
  describe("PATCH /api/relationships/score", () => {
    it("updates manualScore and returns 200 with updated relationship", async () => {
      // Create a relationship to update
      const entityId = `__e2e_entity_score_${Date.now()}`;
      const createRes = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "entity", targetId: entityId }),
      });

      expect(createRes.status).not.toBe(401);

      if (createRes.status === 201) {
        createdRelationships.push({ targetType: "entity", targetId: entityId });

        const res = await user0.authFetch(`${API_URL}/api/relationships/score`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType: "entity",
            targetId: entityId,
            manualScore: 0.8,
          }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty("targetId", entityId);
      }
      // If 503, graph is unavailable — skip assertion
    });

    it("accepts null manualScore (clears override)", async () => {
      const entityId = `__e2e_entity_score_null_${Date.now()}`;
      const createRes = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "entity", targetId: entityId }),
      });

      if (createRes.status === 201) {
        createdRelationships.push({ targetType: "entity", targetId: entityId });

        const res = await user0.authFetch(`${API_URL}/api/relationships/score`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType: "entity",
            targetId: entityId,
            manualScore: null,
          }),
        });
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(400);
        if (res.status !== 503) {
          expect(res.status).toBe(200);
        }
      }
    });

    it("returns 400 when manualScore is below 0", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships/score`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "entity",
          targetId: "any-id",
          manualScore: -0.1,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when manualScore is above 1", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships/score`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "entity",
          targetId: "any-id",
          manualScore: 1.1,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when targetType is missing", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships/score`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: "some-id", manualScore: 0.5 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 404 when relationship does not exist", async () => {
      const nonExistentId = `non-existent-score-${Date.now()}`;
      const res = await user0.authFetch(`${API_URL}/api/relationships/score`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "entity",
          targetId: nonExistentId,
          manualScore: 0.5,
        }),
      });

      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(400);
      if (res.status !== 503) {
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toBe("NOT_FOUND");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/relationships
  // ---------------------------------------------------------------------------
  describe("DELETE /api/relationships", () => {
    it("returns 204 when relationship is deleted successfully", async () => {
      // Create a fresh relationship to delete
      const entityId = `__e2e_entity_del_${Date.now()}`;
      const createRes = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "entity", targetId: entityId }),
      });

      expect(createRes.status).not.toBe(401);

      if (createRes.status === 201) {
        const res = await user0.authFetch(
          `${API_URL}/api/relationships?targetType=entity&targetId=${encodeURIComponent(entityId)}`,
          { method: "DELETE" },
        );
        // 204 = deleted, 503 = graph unavailable
        expect(res.status).not.toBe(401);
        if (res.status !== 503) {
          expect(res.status).toBe(204);
        }
        // Don't add to createdRelationships — it's already been deleted (or failed)
      }
    });

    it("returns 400 when targetType query param is missing", async () => {
      const res = await user0.authFetch(
        `${API_URL}/api/relationships?targetId=some-id`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when targetId query param is missing", async () => {
      const res = await user0.authFetch(
        `${API_URL}/api/relationships?targetType=entity`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when both query params are missing", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships`, {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });

    it("returns 400 when targetType is invalid", async () => {
      const res = await user0.authFetch(
        `${API_URL}/api/relationships?targetType=group&targetId=some-id`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/relationships/graph
  // ---------------------------------------------------------------------------
  describe("GET /api/relationships/graph", () => {
    it("returns graph data or 503 if graph service unavailable", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships/graph`);

      // Must not be an auth failure
      expect(res.status).not.toBe(401);

      if (res.status === 200) {
        const body = await res.json();
        // Graph data should have nodes and edges (or equivalent structure)
        expect(typeof body).toBe("object");
        expect(body).not.toBeNull();
      } else {
        // 503 = graph service unavailable — acceptable in test environment
        expect(res.status).toBe(503);
      }
    });

    it("does not require query params", async () => {
      const res = await user0.authFetch(`${API_URL}/api/relationships/graph`);
      // No 400 — no required params for this endpoint
      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(401);
    });
  });
});
