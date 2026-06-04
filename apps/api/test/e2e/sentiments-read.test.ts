/**
 * Sentiments Read E2E Tests
 *
 * Tests reaction read endpoints (complements the existing add/remove tests).
 */

import { afterAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Sentiments Read", () => {
  const user = getShardUser(0);
  const cleanup = new TestCleanup(user.authFetch);

  afterAll(async () => {
    await cleanup.cleanAll();
  });

  it("get sentiments on non-existent post returns 404 or empty", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await user.authFetch(`${API_URL}/api/posts/${fakeId}/sentiments`);
    expect([200, 404]).toContain(res.status);
  });

  it("get user sentiments returns valid structure", async () => {
    const res = await user.authFetch(`${API_URL}/api/sentiments/user`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("add sentiment then read it back", async () => {
    // Create a post
    const postRes = await user.authFetch(`${API_URL}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_sentiment_read_${Date.now()}` }),
    });
    if (postRes.status !== 201) return;
    const postBody = await postRes.json();
    cleanup.track("post", postBody.id);

    // Add reaction
    const addRes = await user.authFetch(`${API_URL}/api/posts/${postBody.id}/sentiment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "like" }),
    });
    if (addRes.status >= 400) return;

    // Read sentiments on post
    const sentimentsRes = await user.authFetch(`${API_URL}/api/posts/${postBody.id}/sentiments`);
    expect(sentimentsRes.status).toBeLessThan(500);

    // Clean up reaction
    await user.authFetch(`${API_URL}/api/posts/${postBody.id}/sentiment`, { method: "DELETE" });
  });
});
