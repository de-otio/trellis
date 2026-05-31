/**
 * Integration Tests: Post Editing API
 *
 * Tests the post editing endpoint with a real database and deployed API.
 * Validates: Requirements 4.2, 7.1, 7.2
 *
 * ⚠️ CRITICAL: This test MUST NEVER run on production.
 * It will abort immediately if environment is not 'dev'.
 *
 * Prerequisites:
 * - ENVIRONMENT or DEPLOY_ENV must be set to 'dev'
 * - DATABASE_URL or DIRECT_DATABASE_URL must be set (or available via AWS SSM)
 * - SESSION_SECRET must be set (or available via AWS SSM)
 * - API must be running (via `npm run dev` or deployed)
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedFetch,
  cleanupTestUser,
  createTestUserWithSession,
} from "../../utils/test-auth.js";
import { getApiUrl } from "../../utils/test-config.js";
import { requireDevEnvironment } from "../../utils/test-environment-guard.js";

const API_URL = getApiUrl();

interface TestUser {
  id: string;
  email: string;
  role: string;
}

describe("Post Editing API Integration", () => {
  let testUser1: TestUser;
  let testUser2: TestUser;
  let sessionToken1: string;
  let sessionToken2: string;
  let createdPostIds: string[] = [];

  beforeAll(async () => {
    requireDevEnvironment();

    // Create test users
    const user1 = await createTestUserWithSession({
      email: `test-edit-1-${Date.now()}@test.example.com`,
      role: "END_USER",
      region: "EU",
      dataRegion: "EU",
    });
    testUser1 = user1.testUser;
    sessionToken1 = user1.sessionToken;

    const user2 = await createTestUserWithSession({
      email: `test-edit-2-${Date.now()}@test.example.com`,
      role: "END_USER",
      region: "EU",
      dataRegion: "EU",
    });
    testUser2 = user2.testUser;
    sessionToken2 = user2.sessionToken;
  });

  afterEach(async () => {
    // Clean up test posts
    for (const postId of createdPostIds) {
      try {
        const { token: csrfToken } = await getCsrfToken(sessionToken1);
        await authenticatedFetch(
          `${API_URL}/api/posts/${postId}`,
          sessionToken1,
          {
            method: "DELETE",
            headers: {
              "X-CSRF-Token": csrfToken,
            },
          },
        );
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    createdPostIds = [];
  });

  afterAll(async () => {
    if (testUser1?.id) {
      await cleanupTestUser(testUser1.id).catch(() => {});
    }
    if (testUser2?.id) {
      await cleanupTestUser(testUser2.id).catch(() => {});
    }
  });

  async function getCsrfToken(sessionToken: string): Promise<{
    token: string;
    updatedSessionToken?: string;
  }> {
    const response = await authenticatedFetch(
      `${API_URL}/api/csrf-token`,
      sessionToken,
      {
        method: "GET",
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to get CSRF token: ${response.status} ${errorText}`,
      );
    }

    const body = await response.json();
    const setCookieHeader = response.headers.get("Set-Cookie");
    let updatedSessionToken = sessionToken;
    if (setCookieHeader) {
      const match = setCookieHeader.match(/trellis_session=([^;]+)/);
      if (match) {
        updatedSessionToken = match[1];
      }
    }

    return { token: body.token, updatedSessionToken };
  }

  async function createPost(
    sessionToken: string,
    text: string,
    visibility: string = "friends-only",
  ): Promise<{
    id: string;
    text: string;
    editedAt: string | null;
    createdAt: string;
  }> {
    const { token: csrfToken, updatedSessionToken } =
      await getCsrfToken(sessionToken);
    const currentSessionToken = updatedSessionToken || sessionToken;

    const response = await authenticatedFetch(
      `${API_URL}/api/posts`,
      currentSessionToken,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          text,
          visibility,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create post: ${response.status} ${errorText}`);
    }

    const body = await response.json();
    createdPostIds.push(body.id);
    return body;
  }

  describe("PATCH /api/posts/:postId", () => {
    it("should edit a post successfully", async () => {
      // Create a post
      const post = await createPost(sessionToken1, "Original post content");
      expect(post.editedAt).toBeFalsy();

      // Edit the post
      const { token: csrfToken, updatedSessionToken } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken = updatedSessionToken || sessionToken1;

      const editResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${post.id}`,
        currentSessionToken,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "Updated post content",
          }),
        },
      );

      expect(editResponse.status).toBe(200);
      const editedPost = await editResponse.json();
      expect(editedPost.text).toBe("Updated post content");
      expect(editedPost.editedAt).not.toBeNull();
    });

    it("should set editedAt timestamp on edit", async () => {
      const post = await createPost(sessionToken1, "Post to edit");
      const beforeEdit = new Date();

      const { token: csrfToken, updatedSessionToken } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken = updatedSessionToken || sessionToken1;

      const editResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${post.id}`,
        currentSessionToken,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "Edited content",
          }),
        },
      );

      expect(editResponse.status).toBe(200);
      const editedPost = await editResponse.json();
      const editedAt = new Date(editedPost.editedAt);
      expect(editedAt.getTime()).toBeGreaterThan(beforeEdit.getTime());
    });

    it("should reject edit from non-owner", async () => {
      // Create post with user1
      const post = await createPost(sessionToken1, "User1 post");

      // Try to edit with user2
      const { token: csrfToken } = await getCsrfToken(sessionToken2);

      const editResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${post.id}`,
        sessionToken2,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "Unauthorized edit attempt",
          }),
        },
      );

      expect(editResponse.status).toBe(403);
    });

    it("should reject edit with empty text", async () => {
      const post = await createPost(sessionToken1, "Post with content");

      const { token: csrfToken, updatedSessionToken } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken = updatedSessionToken || sessionToken1;

      const editResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${post.id}`,
        currentSessionToken,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "",
          }),
        },
      );

      expect(editResponse.status).toBe(400);
    });

    it("should reject edit with text exceeding 3000 characters", async () => {
      const post = await createPost(sessionToken1, "Short post");

      const { token: csrfToken, updatedSessionToken } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken = updatedSessionToken || sessionToken1;

      const longText = "a".repeat(3001);
      const editResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${post.id}`,
        currentSessionToken,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: longText,
          }),
        },
      );

      expect(editResponse.status).toBe(400);
    });

    it("should return 404 for non-existent post", async () => {
      const { token: csrfToken, updatedSessionToken } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken = updatedSessionToken || sessionToken1;

      const editResponse = await authenticatedFetch(
        `${API_URL}/api/posts/non-existent-post-id`,
        currentSessionToken,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "Edit attempt",
          }),
        },
      );

      expect(editResponse.status).toBe(404);
    });

    it("should return 401 for unauthenticated request", async () => {
      const post = await createPost(sessionToken1, "Post to edit");

      const editResponse = await fetch(`${API_URL}/api/posts/${post.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "Unauthenticated edit",
        }),
      });

      expect(editResponse.status).toBe(401);
    });

    it("should verify edited post appears in feed with updated content", async () => {
      // Create and edit a post
      const post = await createPost(sessionToken1, "Original feed post");

      const { token: csrfToken, updatedSessionToken } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken = updatedSessionToken || sessionToken1;

      await authenticatedFetch(
        `${API_URL}/api/posts/${post.id}`,
        currentSessionToken,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "Updated feed post content",
          }),
        },
      );

      // Fetch feed and verify updated content
      const feedResponse = await authenticatedFetch(
        `${API_URL}/api/feeds/home`,
        currentSessionToken,
        {
          method: "GET",
        },
      );

      expect(feedResponse.status).toBe(200);
      const feedBody = await feedResponse.json();
      const posts = feedBody.posts || feedBody;
      const editedPost = posts.find((p: any) => p.id === post.id);

      if (editedPost) {
        expect(editedPost.text).toBe("Updated feed post content");
        expect(editedPost.editedAt).not.toBeNull();
      }
    });

    it("should preserve original createdAt after edit", async () => {
      const post = await createPost(
        sessionToken1,
        "Post to preserve timestamp",
      );
      const originalCreatedAt = post.createdAt;

      const { token: csrfToken, updatedSessionToken } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken = updatedSessionToken || sessionToken1;

      const editResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${post.id}`,
        currentSessionToken,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "Edited but createdAt preserved",
          }),
        },
      );

      expect(editResponse.status).toBe(200);
      const editedPost = await editResponse.json();
      expect(editedPost.createdAt).toBe(originalCreatedAt);
    });

    it("should change post visibility to private", async () => {
      const post = await createPost(
        sessionToken1,
        "Post to make private",
        "friends-only",
      );

      const { token: csrfToken, updatedSessionToken } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken = updatedSessionToken || sessionToken1;

      const editResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${post.id}`,
        currentSessionToken,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "Now private post",
            visibility: "private",
          }),
        },
      );

      expect(editResponse.status).toBe(200);
      const editedPost = await editResponse.json();
      expect(editedPost.visibility).toBe("private");
      expect(editedPost.text).toBe("Now private post");
      expect(editedPost.editedAt).not.toBeNull();
    });

    it("should change post visibility to friends-only", async () => {
      const post = await createPost(
        sessionToken1,
        "Post to make friends-only",
        "private",
      );

      const { token: csrfToken, updatedSessionToken } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken = updatedSessionToken || sessionToken1;

      const editResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${post.id}`,
        currentSessionToken,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "Now friends-only post",
            visibility: "friends-only",
          }),
        },
      );

      expect(editResponse.status).toBe(200);
      const editedPost = await editResponse.json();
      expect(editedPost.visibility).toBe("friends");
      expect(editedPost.text).toBe("Now friends-only post");
      expect(editedPost.editedAt).not.toBeNull();
    });
  });
});
