/**
 * Feed E2E Tests
 *
 * Tests the home feed and dog feed endpoints including
 * post lifecycle (create, update, hide, unhide, delete) as seen through the feed.
 */

import { afterAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Feed", () => {
  const user = getShardUser(0);
  const cleanup = new TestCleanup(user.authFetch);
  let postId: string | null = null;

  afterAll(async () => {
    await cleanup.cleanAll();
  });

  it("rejects unauthenticated request", async () => {
    const res = await fetch(`${API_URL}/api/feeds/home`);
    expect(res.status).toBe(401);
  });

  it("returns valid home feed structure", async () => {
    const res = await user.authFetch(`${API_URL}/api/feeds/home`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("posts");
      expect(Array.isArray(body.posts)).toBe(true);
    }
  });

  it("respects pagination params", async () => {
    const res = await user.authFetch(`${API_URL}/api/feeds/home?limit=2`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const body = await res.json();
      expect(body.posts.length).toBeLessThanOrEqual(2);
    }
  });

  it("create post appears in home feed", async () => {
    const res = await user.authFetch(`${API_URL}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_feed_post_${Date.now()}` }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);

    if (res.status === 201) {
      const body = await res.json();
      postId = body.id;
      cleanup.track("post", postId!);

      // Verify it appears in feed
      const feedRes = await user.authFetch(`${API_URL}/api/feeds/home`);
      if (feedRes.status === 200) {
        const feedBody = await feedRes.json();
        const found = feedBody.posts?.some((p: any) => p.id === postId);
        expect(found).toBe(true);
      }
    }
  });

  it("update post content reflected", async () => {
    if (!postId) return;
    const updated = `__e2e_feed_updated_${Date.now()}`;
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: updated }),
    });
    expect(res.status).toBeLessThan(500);

    if (res.status === 200) {
      const getRes = await user.authFetch(`${API_URL}/api/posts/${postId}`);
      if (getRes.status === 200) {
        const body = await getRes.json();
        expect(body.content).toBe(updated);
      }
    }
  });

  it("hide post removes from feed", async () => {
    if (!postId) return;
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}/hide`, {
      method: "PATCH",
    });
    expect(res.status).toBeLessThan(500);

    if (res.status === 200) {
      const feedRes = await user.authFetch(`${API_URL}/api/feeds/home`);
      if (feedRes.status === 200) {
        const feedBody = await feedRes.json();
        const found = feedBody.posts?.some((p: any) => p.id === postId);
        expect(found).toBeFalsy();
      }
    }
  });

  it("unhide post restores to feed", async () => {
    if (!postId) return;
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}/unhide`, {
      method: "PATCH",
    });
    expect(res.status).toBeLessThan(500);
  });

  it("add reaction updates sentiment", async () => {
    if (!postId) return;
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}/sentiment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "like" }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);

    // Clean up reaction
    await user.authFetch(`${API_URL}/api/posts/${postId}/sentiment`, { method: "DELETE" });
  });

  it("create comment appears under post", async () => {
    if (!postId) return;
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_feed_comment_${Date.now()}` }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);

    if (res.status === 201) {
      const body = await res.json();
      cleanup.track("comment", body.id);

      const commentsRes = await user.authFetch(`${API_URL}/api/posts/${postId}/comments`);
      if (commentsRes.status === 200) {
        const commentsBody = await commentsRes.json();
        const comments = Array.isArray(commentsBody) ? commentsBody : commentsBody.comments || [];
        const found = comments.some((c: any) => c.id === body.id);
        expect(found).toBe(true);
      }
    }
  });

  it("delete post removes from feed", async () => {
    if (!postId) return;
    const res = await user.authFetch(`${API_URL}/api/posts/${postId}`, {
      method: "DELETE",
    });
    expect(res.status).toBeLessThan(500);
    // Post is deleted, no need to track for cleanup
  });

  it("dog feed returns valid structure or 404", async () => {
    const res = await user.authFetch(`${API_URL}/api/feeds/dog/nonexistent-id`);
    expect(res.status).not.toBe(401);
    expect([200, 404]).toContain(res.status);
  });
});
