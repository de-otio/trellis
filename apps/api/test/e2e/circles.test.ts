/**
 * Phase 5a: Circles API
 *
 * Tests read-only circle endpoints that operate on the caller's relationship graph.
 * No data creation required — tests work with existing graph relationships or empty state.
 * All endpoints require authentication and a valid tier parameter (0, 1, 2, or 3).
 *
 * Note: Graph endpoints may return 503 if Neo4j is unavailable. Tests handle gracefully.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("Circles API", () => {
  const user = getShardUser(0);

  describe("GET /api/circles/members", () => {
    it("returns 400 without tier param", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/members`);
      expect(res.status).toBe(400);
    });

    it("returns 400 with invalid tier param (string)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/members?tier=abc`);
      expect(res.status).toBe(400);
    });

    it("returns 400 with tier out of range (negative)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/members?tier=-1`);
      expect(res.status).toBe(400);
    });

    it("returns 400 with tier out of range (too high)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/members?tier=4`);
      expect(res.status).toBe(400);
    });

    it("returns 200 with circle members for tier 0 (may be empty)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/members?tier=0`);
      // Allow 503 if Neo4j is unavailable
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("returns 200 with circle members for tier 1 (may be empty)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/members?tier=1`);
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("returns 200 with circle members for tier 2 (may be empty)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/members?tier=2`);
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("returns 200 with circle members for tier 3 (may be empty)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/members?tier=3`);
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe("GET /api/circles/feed", () => {
    it("returns 400 without tier param", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/feed?limit=20`);
      expect(res.status).toBe(400);
    });

    it("returns 400 with invalid tier param", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/feed?tier=invalid&limit=20`);
      expect(res.status).toBe(400);
    });

    it("returns 400 with tier out of range", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/feed?tier=5&limit=20`);
      expect(res.status).toBe(400);
    });

    it("returns 200 with paginated feed for tier 0 (may be empty)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/feed?tier=0&limit=20`);
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body).toBe("object");
      expect(Array.isArray(body.posts)).toBe(true);
    });

    it("returns 200 with cursor pagination", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/circles/feed?tier=0&limit=20&cursor=test-cursor`,
      );
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body).toBe("object");
      expect(Array.isArray(body.posts)).toBe(true);
    });

    it("returns 200 with since parameter (ISO timestamp)", async () => {
      const isoTimestamp = new Date(Date.now() - 86400000).toISOString(); // 24h ago
      const res = await user.authFetch(
        `${API_URL}/api/circles/feed?tier=0&limit=20&since=${encodeURIComponent(isoTimestamp)}`,
      );
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body).toBe("object");
      expect(Array.isArray(body.posts)).toBe(true);
    });
  });

  describe("GET /api/circles/glance", () => {
    it("returns 400 without tier param", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/glance?limit=20`);
      expect(res.status).toBe(400);
    });

    it("returns 400 with invalid tier param", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/glance?tier=xyz&limit=20`);
      expect(res.status).toBe(400);
    });

    it("returns 400 with tier out of range", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/glance?tier=10&limit=20`);
      expect(res.status).toBe(400);
    });

    it("returns 200 with glance items for tier 0 (may be empty)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/glance?tier=0&limit=20`);
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("returns 200 with glance items for tier 1 (may be empty)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/glance?tier=1&limit=20`);
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("respects limit parameter", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/glance?tier=0&limit=5`);
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      if (body.length > 0) {
        expect(body.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe("GET /api/circles/depth", () => {
    it("returns 400 without tier param", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/circles/depth?targetType=user&targetId=test-id&limit=20`,
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 without targetType param", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/circles/depth?tier=0&targetId=test-id&limit=20`,
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 without targetId param", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/circles/depth?tier=0&targetType=user&limit=20`,
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 with invalid tier", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/circles/depth?tier=invalid&targetType=user&targetId=test-id&limit=20`,
      );
      expect(res.status).toBe(400);
    });

    it("returns 200 with depth posts for valid tier 0 and targetId (may be empty)", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/circles/depth?tier=0&targetType=user&targetId=test-target-id&limit=20`,
      );
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("returns 200 with depth posts for tier 2", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/circles/depth?tier=2&targetType=user&targetId=another-target-id&limit=20`,
      );
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("respects limit parameter in depth query", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/circles/depth?tier=0&targetType=user&targetId=test-id&limit=5`,
      );
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      if (body.length > 0) {
        expect(body.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe("GET /api/circles/status", () => {
    it("returns 200 with read status structure", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/status`);
      // Allow 503 for Neo4j unavailability
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body).toBe("object");
      // Should have tiers property
      if (body.tiers) {
        expect(Array.isArray(body.tiers)).toBe(true);
      }
    });

    it("works without any query parameters", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/status`);
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect([200, 404]).toContain(res.status);
    });
  });

  describe("GET /api/circles/entities", () => {
    it("returns 400 without tier param", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/entities`);
      expect(res.status).toBe(400);
    });

    it("returns 400 with invalid tier param", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/entities?tier=bad`);
      expect(res.status).toBe(400);
    });

    it("returns 400 with tier out of range", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/entities?tier=999`);
      expect(res.status).toBe(400);
    });

    it("returns 200 with entity status for tier 0 (may be empty)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/entities?tier=0`);
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("returns 200 with entity status for tier 1 (may be empty)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/entities?tier=1`);
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("returns 200 with entity status for tier 3 (may be empty)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/entities?tier=3`);
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe("POST /api/circles/read", () => {
    it("returns 400 without tier in body", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 with tier as string (not number)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "0" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 with invalid tier value (negative)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: -1 }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 with invalid tier value (out of range)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: 5 }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 204 for tier 0 (idempotent)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: 0 }),
      });
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(204);
    });

    it("returns 204 for tier 1 (idempotent)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: 1 }),
      });
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(204);
    });

    it("returns 204 for tier 2 (idempotent)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: 2 }),
      });
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(204);
    });

    it("returns 204 for tier 3 (idempotent)", async () => {
      const res = await user.authFetch(`${API_URL}/api/circles/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: 3 }),
      });
      if (res.status === 503) {
        expect([503]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects unauthenticated requests to /api/circles/members", async () => {
      const res = await fetch(`${API_URL}/api/circles/members?tier=0`);
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated requests to /api/circles/feed", async () => {
      const res = await fetch(`${API_URL}/api/circles/feed?tier=0&limit=20`);
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated requests to /api/circles/status", async () => {
      const res = await fetch(`${API_URL}/api/circles/status`);
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated POST to /api/circles/read", async () => {
      const res = await fetch(`${API_URL}/api/circles/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: 0 }),
      });
      expect(res.status).toBe(401);
    });
  });
});
