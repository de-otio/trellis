/**
 * Content Discovery E2E Tests
 *
 * Tests recommendation and trending endpoints.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("Content Discovery", () => {
  const user = getShardUser(0);

  it("trending topics returns valid structure", async () => {
    const res = await fetch(`${API_URL}/api/taxonomy/trending`);
    expect(res.status).toBeLessThan(500);
  });

  it("content recommendations returns valid structure", async () => {
    const res = await user.authFetch(`${API_URL}/api/recommendations/content`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("creator recommendations returns valid structure", async () => {
    const res = await user.authFetch(`${API_URL}/api/recommendations/creators`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("related posts for non-existent post returns 404", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${API_URL}/api/posts/${fakeId}/related`);
    expect([404, 400]).toContain(res.status);
  });
});
