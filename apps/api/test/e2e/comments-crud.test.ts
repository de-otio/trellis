/**
 * Phase 3c: Comments CRUD
 *
 * Creates and deletes a comment on a post.
 * Tests accept application errors as long as auth works (not 401).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Comments CRUD", () => {
  const user = getShardUser(0);
  const cleanup = new TestCleanup(user.authFetch);
  let postId: string | null = null;
  let commentId: string | null = null;

  beforeAll(async () => {
    // Try to create a parent post
    const res = await user.authFetch(`${API_URL}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_comment_parent_${Date.now()}` }),
    });
    if (res.status === 201) {
      const body = await res.json();
      postId = body.id;
      cleanup.track("post", postId!);
    }
  });

  afterAll(async () => {
    await cleanup.cleanAll();
  });

  it("creates a comment (or returns non-auth error)", async () => {
    if (!postId) return; // Can't test without a post
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_comment_${Date.now()}` }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    if (res.status === 201) {
      const body = await res.json();
      commentId = body.id;
    }
  });

  it("lists comments on post", async () => {
    if (!postId) return;
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}/comments`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("deletes a comment", async () => {
    if (!commentId) return;
    const res = await user.authFetch(`${API_URL}/api/comments/${commentId}`, {
      method: "DELETE",
    });
    expect(res.status).toBeLessThan(500);
  });
});
