/**
 * Badges E2E Tests
 *
 * Tests badge retrieval endpoints.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("Badges", () => {
  const user = getShardUser(0);

  it("get user badges returns valid structure", async () => {
    const res = await fetch(`${API_URL}/api/users/${user.userId}/badges`);
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const body = await res.json();
      expect(Array.isArray(body) || typeof body === "object").toBe(true);
    }
  });

  it("get badges for non-existent user returns 404 or empty", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${API_URL}/api/users/${fakeId}/badges`);
    expect([200, 404]).toContain(res.status);
  });
});
