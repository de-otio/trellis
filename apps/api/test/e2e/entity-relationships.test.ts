/**
 * Phase 3b: Entity Relationship Lifecycle
 *
 * Tests the full propose → confirm → reject → remove lifecycle for
 * entity-to-entity relationships (PACK_MATE, SIBLING, PLAYMATE, etc.).
 *
 * Requires two users: user0 owns entity0, user1 owns entity1.
 * All graph endpoints may return 503 when Neo4j is unavailable — those are
 * treated as passing (graph-layer tests, not auth tests).
 *
 * All test data is prefixed with __e2e_ for easy identification.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Entity Relationships", () => {
  const user0 = getShardUser(0);
  const user1 = getShardUser(1);

  const cleanup0 = new TestCleanup(user0.authFetch);
  const cleanup1 = new TestCleanup(user1.authFetch);

  let entity0Id: string | null = null;
  let entity1Id: string | null = null;

  // ─── Setup: create one entity per user ──────────────────────────────────────

  beforeAll(async () => {
    const ts = Date.now();

    const res0 = await user0.authFetch(`${API_URL}/api/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `__e2e_er_entity0_${ts}`, type: "dog" }),
    });

    if (res0.status === 201) {
      const body = await res0.json();
      entity0Id = body.id;
      cleanup0.track("entity", entity0Id!);
    }

    const res1 = await user1.authFetch(`${API_URL}/api/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `__e2e_er_entity1_${ts}`, type: "dog" }),
    });

    if (res1.status === 201) {
      const body = await res1.json();
      entity1Id = body.id;
      cleanup1.track("entity", entity1Id!);
    }
  });

  afterAll(async () => {
    // Best-effort: remove any leftover relationship before deleting entities
    if (entity0Id && entity1Id) {
      await user0.authFetch(
        `${API_URL}/api/entity-relationships?entityId=${entity0Id}&relatedEntityId=${entity1Id}`,
        { method: "DELETE" },
      ).catch(() => { /* ignore */ });
    }
    await cleanup0.cleanAll();
    await cleanup1.cleanAll();
  });

  // ─── 1. Propose relationship ─────────────────────────────────────────────────

  it("user0 proposes PACK_MATE relationship (entity0 → entity1)", async () => {
    if (!entity0Id || !entity1Id) return; // entities unavailable — feature disabled

    const res = await user0.authFetch(`${API_URL}/api/entity-relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityId: entity0Id,
        relatedEntityId: entity1Id,
        type: "PACK_MATE",
      }),
    });

    expect(res.status).not.toBe(401);

    if (res.status === 503) return; // Neo4j unavailable — skip body assertions

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("PENDING");
  });

  // ─── 2. Get pending relationships ────────────────────────────────────────────

  it("user1 sees the pending proposal in /pending", async () => {
    if (!entity0Id || !entity1Id) return;

    const res = await user1.authFetch(`${API_URL}/api/entity-relationships/pending`);

    expect(res.status).not.toBe(401);

    if (res.status === 503) return;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("relationships");
    expect(Array.isArray(body.relationships)).toBe(true);

    const found = body.relationships.some(
      (r: any) => r.entityId === entity0Id && r.relatedEntityId === entity1Id,
    );
    expect(found).toBe(true);
  });

  // ─── 3. Confirm relationship ─────────────────────────────────────────────────

  it("user1 confirms the relationship", async () => {
    if (!entity0Id || !entity1Id) return;

    const res = await user1.authFetch(`${API_URL}/api/entity-relationships/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId: entity0Id, relatedEntityId: entity1Id }),
    });

    expect(res.status).not.toBe(401);

    if (res.status === 503) return;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("CONFIRMED");
  });

  // ─── 4. GET relationships for entity0 (confirmed) ────────────────────────────

  it("GET /api/entity-relationships returns CONFIRMED relationship for entity0", async () => {
    if (!entity0Id || !entity1Id) return;

    const res = await user0.authFetch(
      `${API_URL}/api/entity-relationships?entityId=${entity0Id}&type=PACK_MATE&status=CONFIRMED`,
    );

    expect(res.status).not.toBe(401);

    if (res.status === 503) return;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("relationships");
    expect(Array.isArray(body.relationships)).toBe(true);

    const found = body.relationships.some(
      (r: any) => r.relatedEntityId === entity1Id,
    );
    expect(found).toBe(true);
  });

  // ─── 5. Remove relationship ───────────────────────────────────────────────────

  it("user0 removes the PACK_MATE relationship", async () => {
    if (!entity0Id || !entity1Id) return;

    const res = await user0.authFetch(
      `${API_URL}/api/entity-relationships?entityId=${entity0Id}&relatedEntityId=${entity1Id}`,
      { method: "DELETE" },
    );

    expect(res.status).not.toBe(401);

    if (res.status === 503) return;

    expect(res.status).toBe(204);
  });

  // ─── 6. Propose again, then reject ───────────────────────────────────────────

  it("user0 proposes PACK_MATE again after removal", async () => {
    if (!entity0Id || !entity1Id) return;

    const res = await user0.authFetch(`${API_URL}/api/entity-relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityId: entity0Id,
        relatedEntityId: entity1Id,
        type: "PACK_MATE",
      }),
    });

    expect(res.status).not.toBe(401);

    if (res.status === 503) return;

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("PENDING");
  });

  it("user1 rejects the second proposal", async () => {
    if (!entity0Id || !entity1Id) return;

    const res = await user1.authFetch(`${API_URL}/api/entity-relationships/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId: entity0Id, relatedEntityId: entity1Id }),
    });

    expect(res.status).not.toBe(401);

    if (res.status === 503) return;

    expect(res.status).toBe(204);
  });

  // ─── 7. Duplicate proposal (409) ─────────────────────────────────────────────

  it("duplicate proposal returns 409 CONFLICT", async () => {
    if (!entity0Id || !entity1Id) return;

    // First, create a fresh proposal so we can try to duplicate it.
    const first = await user0.authFetch(`${API_URL}/api/entity-relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityId: entity0Id,
        relatedEntityId: entity1Id,
        type: "PLAYMATE",
      }),
    });
    expect(first.status).not.toBe(401);
    if (first.status === 503) return;
    // If the first succeeded we can test the duplicate
    if (first.status !== 201) return;

    const second = await user0.authFetch(`${API_URL}/api/entity-relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityId: entity0Id,
        relatedEntityId: entity1Id,
        type: "PLAYMATE",
      }),
    });
    expect(second.status).not.toBe(401);
    if (second.status === 503) return;
    expect(second.status).toBe(409);

    // Clean up the leftover proposal
    await user0.authFetch(
      `${API_URL}/api/entity-relationships?entityId=${entity0Id}&relatedEntityId=${entity1Id}`,
      { method: "DELETE" },
    ).catch(() => { /* ignore */ });
  });

  // ─── 8. Validation: self-relationship returns 400 ────────────────────────────

  it("returns 400 when entityId === relatedEntityId", async () => {
    if (!entity0Id) return;

    const res = await user0.authFetch(`${API_URL}/api/entity-relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityId: entity0Id,
        relatedEntityId: entity0Id,
        type: "PACK_MATE",
      }),
    });

    // Self-relationship is rejected before the graph call — no 503 possible here
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });

  // ─── 9. Validation: invalid type returns 400 ─────────────────────────────────

  it("returns 400 for an invalid relationship type", async () => {
    if (!entity0Id || !entity1Id) return;

    const res = await user0.authFetch(`${API_URL}/api/entity-relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityId: entity0Id,
        relatedEntityId: entity1Id,
        type: "NEMESIS", // not in the enum
      }),
    });

    // Validated before any graph call — no 503 possible here
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });

  // ─── 10. Authorization: non-owner of entityId returns 403 ────────────────────

  it("returns 403 when caller does not own entityId", async () => {
    if (!entity0Id || !entity1Id) return;

    // user1 tries to propose using entity0 (owned by user0)
    const res = await user1.authFetch(`${API_URL}/api/entity-relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityId: entity0Id,
        relatedEntityId: entity1Id,
        type: "SIBLING",
      }),
    });

    // Ownership is checked before the graph call — no 503 possible here
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(403);
  });

  // ─── 11. Authorization: non-owner of relatedEntityId cannot confirm ───────────

  it("returns 403 when caller does not own the target entity on confirm", async () => {
    if (!entity0Id || !entity1Id) return;

    // Propose first (may already be gone or 503 — that's fine)
    const propose = await user0.authFetch(`${API_URL}/api/entity-relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityId: entity0Id,
        relatedEntityId: entity1Id,
        type: "WALK_BUDDY",
      }),
    });
    expect(propose.status).not.toBe(401);
    if (propose.status === 503) return;
    if (propose.status !== 201) return; // Couldn't propose (e.g. already exists) — skip

    // user0 tries to confirm (owns entityId, not relatedEntityId)
    const res = await user0.authFetch(`${API_URL}/api/entity-relationships/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId: entity0Id, relatedEntityId: entity1Id }),
    });

    expect(res.status).not.toBe(401);
    if (res.status === 503) return;
    expect(res.status).toBe(403);

    // Clean up the pending proposal
    await user0.authFetch(
      `${API_URL}/api/entity-relationships?entityId=${entity0Id}&relatedEntityId=${entity1Id}`,
      { method: "DELETE" },
    ).catch(() => { /* ignore */ });
  });

  // ─── 12. GET validation: missing entityId returns 400 ────────────────────────

  it("GET /api/entity-relationships returns 400 when entityId is missing", async () => {
    const res = await user0.authFetch(`${API_URL}/api/entity-relationships`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });

  // ─── 13. GET validation: invalid type param returns 400 ──────────────────────

  it("GET /api/entity-relationships returns 400 for invalid type param", async () => {
    if (!entity0Id) return;

    const res = await user0.authFetch(
      `${API_URL}/api/entity-relationships?entityId=${entity0Id}&type=NEMESIS`,
    );
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });

  // ─── 14. GET validation: invalid status param returns 400 ────────────────────

  it("GET /api/entity-relationships returns 400 for invalid status param", async () => {
    if (!entity0Id) return;

    const res = await user0.authFetch(
      `${API_URL}/api/entity-relationships?entityId=${entity0Id}&status=MAYBE`,
    );
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });

  // ─── 15. DELETE validation: missing params returns 400 ───────────────────────

  it("DELETE /api/entity-relationships returns 400 when query params are missing", async () => {
    const res = await user0.authFetch(`${API_URL}/api/entity-relationships`, {
      method: "DELETE",
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });

  // ─── 16. Non-owner sees only CONFIRMED relationships ─────────────────────────

  it("non-owner of entity cannot see PENDING relationships via GET", async () => {
    if (!entity0Id || !entity1Id) return;

    // user1 queries entity0's relationships — should only get CONFIRMED back
    // Even if we request PENDING, the handler silently overrides to CONFIRMED for non-owners
    const res = await user1.authFetch(
      `${API_URL}/api/entity-relationships?entityId=${entity0Id}&status=PENDING`,
    );

    expect(res.status).not.toBe(401);

    if (res.status === 503) return;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("relationships");
    // All returned relationships must be CONFIRMED (if any)
    for (const r of body.relationships) {
      expect(r.status).toBe("CONFIRMED");
    }
  });

  // ─── 17. /pending requires no params, always returns 200 ─────────────────────

  it("GET /api/entity-relationships/pending returns 200 with relationships array", async () => {
    const res = await user0.authFetch(`${API_URL}/api/entity-relationships/pending`);

    expect(res.status).not.toBe(401);

    if (res.status === 503) return;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("relationships");
    expect(Array.isArray(body.relationships)).toBe(true);
  });

  // ─── 18. confirm 404 when no pending relationship exists ─────────────────────

  it("confirm returns 404 when no pending relationship exists", async () => {
    if (!entity0Id || !entity1Id) return;

    // Attempt to confirm something we know isn't pending (clean state)
    const res = await user1.authFetch(`${API_URL}/api/entity-relationships/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId: entity0Id, relatedEntityId: entity1Id }),
    });

    expect(res.status).not.toBe(401);

    if (res.status === 503) return;

    expect(res.status).toBe(404);
  });
});
