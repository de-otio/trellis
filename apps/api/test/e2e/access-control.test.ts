/**
 * Phase 5: Access Control & Privacy
 *
 * Tests check both unauthenticated and authenticated behavior.
 * Authenticated tests use the shard user pool (all environments).
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("Access Control", () => {
  // --- Prod-safe: unauthenticated, read-only ---

  describe("Unauthenticated access", () => {
    it("protected endpoints reject unauthenticated requests", async () => {
      const res = await fetch(`${API_URL}/api/entities`);
      expect(res.status).toBe(401);
    });

    it("health endpoint is publicly accessible", async () => {
      const res = await fetch(`${API_URL}/health`);
      expect(res.status).toBe(200);
    });
  });

  // --- Authenticated: access control checks using shard user pool ---

  describe("Authorized access", () => {
    const { authFetch } = getShardUser(0);

    it("feature flags endpoint returns valid structure", async () => {
      const res = await authFetch(`${API_URL}/api/feature-flags`);
      // 200 with data or 404 if not implemented
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        const body = await res.json();
        expect(typeof body).toBe("object");
      }
    });

    it("cannot modify a non-existent resource", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await authFetch(`${API_URL}/api/entities/${fakeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "__e2e_should_fail" }),
      });
      expect([403, 404]).toContain(res.status);
    });

    it("cannot delete a non-existent resource", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await authFetch(`${API_URL}/api/entities/${fakeId}`, {
        method: "DELETE",
      });
      expect([403, 404]).toContain(res.status);
    });
  });
});
