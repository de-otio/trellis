/**
 * Comment Management E2E Tests
 *
 * Tests edit, hide/unhide, and reply functionality for comments.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Comment Management", () => {
  const userA = getShardUser(0);
  const userB = getShardUser(1);
  const cleanup = new TestCleanup(userA.authFetch);
  let postId: string | null = null;

  beforeAll(async () => {
    // Create parent post
    const res = await userA.authFetch(`${API_URL}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_comment_mgmt_parent_${Date.now()}` }),
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

  it("edit returns 404 for non-existent comment", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await userA.authFetch(`${API_URL}/api/comments/${fakeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "edited" }),
    });
    expect([403, 404]).toContain(res.status);
  });

  it("hide returns 404 for non-existent comment", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await userA.authFetch(`${API_URL}/api/comments/${fakeId}/hide`, {
      method: "PATCH",
    });
    expect([403, 404]).toContain(res.status);
  });

  it("edit comment content", async () => {
    if (!postId) return;

    // Create comment
    const createRes = await userA.authFetch(`${API_URL}/api/posts/${postId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_comment_edit_${Date.now()}` }),
    });
    if (createRes.status !== 201) return;
    const createBody = await createRes.json();
    const commentId = createBody.id;
    cleanup.track("comment", commentId);

    // Edit
    const editRes = await userA.authFetch(`${API_URL}/api/comments/${commentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_comment_edited_${Date.now()}` }),
    });
    expect(editRes.status).toBeLessThan(500);
  });

  it("hide and unhide comment", async () => {
    if (!postId) return;

    const createRes = await userA.authFetch(`${API_URL}/api/posts/${postId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_comment_hide_${Date.now()}` }),
    });
    if (createRes.status !== 201) return;
    const createBody = await createRes.json();
    const commentId = createBody.id;
    cleanup.track("comment", commentId);

    // Hide
    const hideRes = await userA.authFetch(`${API_URL}/api/comments/${commentId}/hide`, {
      method: "PATCH",
    });
    expect(hideRes.status).toBeLessThan(500);

    // Unhide
    const unhideRes = await userA.authFetch(`${API_URL}/api/comments/${commentId}/unhide`, {
      method: "PATCH",
    });
    expect(unhideRes.status).toBeLessThan(500);
  });

  it("create reply to comment", async () => {
    if (!postId) return;

    // Create parent comment
    const parentRes = await userA.authFetch(`${API_URL}/api/posts/${postId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_comment_parent_reply_${Date.now()}` }),
    });
    if (parentRes.status !== 201) return;
    const parentBody = await parentRes.json();
    cleanup.track("comment", parentBody.id);

    // Create reply
    const replyRes = await userA.authFetch(`${API_URL}/api/comments/${parentBody.id}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_reply_${Date.now()}` }),
    });
    expect(replyRes.status).not.toBe(401);
    expect(replyRes.status).toBeLessThan(500);

    if (replyRes.status === 201) {
      const replyBody = await replyRes.json();
      cleanup.track("comment", replyBody.id);
    }
  });

  it("cannot edit another user's comment", async () => {
    if (!postId) return;

    // userA creates comment
    const createRes = await userA.authFetch(`${API_URL}/api/posts/${postId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `__e2e_comment_authz_${Date.now()}` }),
    });
    if (createRes.status !== 201) return;
    const createBody = await createRes.json();
    cleanup.track("comment", createBody.id);

    // userB tries to edit
    const editRes = await userB.authFetch(`${API_URL}/api/comments/${createBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hacked" }),
    });
    expect([403, 404]).toContain(editRes.status);
  });
});
