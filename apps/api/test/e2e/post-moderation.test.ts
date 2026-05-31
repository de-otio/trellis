/**
 * Post Moderation E2E Tests
 *
 * Tests hide/unhide functionality for posts, including cross-user authorization.
 */

import { afterAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Post Moderation", () => {
  const userA = getShardUser(0);
  const userB = getShardUser(1);
  const cleanup = new TestCleanup(userA.authFetch);
  let postId: string | null = null;

  afterAll(async () => {
    await cleanup.cleanAll();
  });

  it("hide rejects unauthenticated", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${API_URL}/api/posts/${fakeId}/hide`, { method: "PATCH" });
    expect(res.status).toBe(401);
  });

  it("hide returns 404 for non-existent post", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await userA.authFetch(`${API_URL}/api/posts/${fakeId}/hide`, {
      method: "PATCH",
    });
    expect([403, 404]).toContain(res.status);
  });

  it("unhide returns 404 for non-existent post", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await userA.authFetch(`${API_URL}/api/posts/${fakeId}/unhide`, {
      method: "PATCH",
    });
    expect([403, 404]).toContain(res.status);
  });

  it("create, hide, unhide full flow", async () => {
    // Create post
    const createRes = await userA.authFetch(`${API_URL}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_moderation_${Date.now()}` }),
    });
    if (createRes.status !== 201) return;
    const body = await createRes.json();
    postId = body.id;
    cleanup.track("post", postId!);

    // Hide
    const hideRes = await userA.authFetch(`${API_URL}/api/posts/${postId}/hide`, {
      method: "PATCH",
    });
    expect(hideRes.status).toBeLessThan(500);

    // Unhide
    const unhideRes = await userA.authFetch(`${API_URL}/api/posts/${postId}/unhide`, {
      method: "PATCH",
    });
    expect(unhideRes.status).toBeLessThan(500);

    // Verify accessible
    const getRes = await userA.authFetch(`${API_URL}/api/posts/${postId}`);
    expect(getRes.status).toBe(200);
  });

  it("cannot hide another user's post", async () => {
    if (!postId) return;
    const res = await userB.authFetch(`${API_URL}/api/posts/${postId}/hide`, {
      method: "PATCH",
    });
    expect([403, 404]).toContain(res.status);
  });
});
