/**
 * Phase 3b: Discovery API
 *
 * Tests read-only discovery endpoints:
 * - GET /api/discovery/graph (graph-based entity discovery)
 * - GET /api/discovery/nearby (geolocation-based discovery)
 * - GET /api/discovery/recommendations (personalized recommendations)
 *
 * All endpoints are rate-limited (5 req/min/user). Tests are kept minimal
 * to stay well under the limit. Read-only operations, no cleanup needed.
 *
 * Note: Graph endpoints may return 503 if Neo4j is unavailable.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("Discovery API", () => {
  const user = getShardUser(0);

  describe("GET /api/discovery/graph", () => {
    it("returns discovered entities (may be empty)", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/discovery/graph?hops=1&limit=10`
      );
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);

      // 503 (Neo4j unavailable) is acceptable for graph endpoints
      if (res.status === 503) {
        return;
      }

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("handles invalid hops parameter gracefully", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/discovery/graph?hops=999&limit=10`
      );
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);

      // 503 is acceptable for graph endpoints
      if (res.status === 503) {
        return;
      }

      // Should either accept and cap at 2, or return 400
      expect([200, 400]).toContain(res.status);
    });
  });

  describe("GET /api/discovery/nearby", () => {
    it("returns nearby entities for valid lat/lng", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/discovery/nearby?lat=52.520&lng=13.405&radius=5000&limit=10`
      );
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("returns 400 when lat is missing", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/discovery/nearby?lng=13.405&radius=5000&limit=10`
      );
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBe(400);
    });

    it("returns 400 when coordinates are out of range", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/discovery/nearby?lat=91&lng=13.405&radius=5000&limit=10`
      );
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/discovery/recommendations", () => {
    it("returns recommendations (may be empty)", async () => {
      const res = await user.authFetch(
        `${API_URL}/api/discovery/recommendations?limit=10`
      );
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });
});
