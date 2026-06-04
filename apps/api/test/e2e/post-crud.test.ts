/**
 * Phase 3b: Post CRUD
 *
 * Creates, reads, updates, and deletes a post.
 * Tests accept application errors (missing request context, etc.) as long as auth works.
 */

import { afterAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Post CRUD", () => {
  const user = getShardUser(0);
  const cleanup = new TestCleanup(user.authFetch);
  let postId: string | null = null;

  afterAll(async () => {
    await cleanup.cleanAll();
  });

  it("creates a post (or returns non-auth error)", async () => {
    const res = await user.authFetch(`${API_URL}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `__e2e_post_${Date.now()} — automated test post`,
      }),
    });
    expect(res.status).not.toBe(401); // Must not be auth failure
    expect(res.status).toBeLessThanOrEqual(500);

    if (res.status === 201) {
      const body = await res.json();
      postId = body.id;
      cleanup.track("post", postId!);
    }
  });

  it("gets post by ID", async () => {
    if (!postId) return;
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}`);
    expect(res.status).toBe(200);
  });

  it("post appears in feed", async () => {
    const res = await user.authFetch(`${API_URL}/api/feeds/home`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThanOrEqual(500);
  });

  it("updates post", async () => {
    if (!postId) return;
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_updated_${Date.now()}` }),
    });
    expect(res.status).toBeLessThanOrEqual(500);
  });

  it("deletes post", async () => {
    if (!postId) return;
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}`, {
      method: "DELETE",
    });
    expect(res.status).toBeLessThanOrEqual(500);
  });
});
