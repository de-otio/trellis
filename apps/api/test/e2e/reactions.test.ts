/**
 * Phase 3d: Reactions
 *
 * Adds and removes a reaction on a post.
 * Tests accept application errors as long as auth works.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Reactions", () => {
  const user = getShardUser(0);
  const cleanup = new TestCleanup(user.authFetch);
  let postId: string | null = null;

  beforeAll(async () => {
    const res = await user.authFetch(`${API_URL}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_reaction_parent_${Date.now()}` }),
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

  it("adds a reaction (or returns non-auth error)", async () => {
    if (!postId) return;
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}/sentiment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "like" }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("removes a reaction (or returns non-auth error)", async () => {
    if (!postId) return;
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}/sentiment`, {
      method: "DELETE",
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });
});
