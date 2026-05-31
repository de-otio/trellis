/**
 * Integration Tests: Post Visibility Privacy
 *
 * CRITICAL PRIVACY TESTS - These tests verify that visibility changes
 * are properly enforced and cannot be bypassed.
 *
 * Tests the post visibility system with a real database and deployed API.
 * Validates: Privacy protection, visibility enforcement, access control
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

describe("Post Visibility Privacy Tests", () => {
  let user1: TestUser;
  let user2: TestUser;
  let sessionToken1: string;
  let sessionToken2: string;
  let createdPostIds: string[] = [];

  beforeAll(async () => {
    requireDevEnvironment();

    // Create test users
    const result1 = await createTestUserWithSession({
      email: `test-visibility-1-${Date.now()}@test.example.com`,
      role: "END_USER",
      region: "EU",
      dataRegion: "EU",
    });
    user1 = result1.testUser;
    sessionToken1 = result1.sessionToken;

    const result2 = await createTestUserWithSession({
      email: `test-visibility-2-${Date.now()}@test.example.com`,
      role: "END_USER",
      region: "EU",
      dataRegion: "EU",
    });
    user2 = result2.testUser;
    sessionToken2 = result2.sessionToken;
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
    if (user1?.id) {
      await cleanupTestUser(user1.id).catch(() => {});
    }
    if (user2?.id) {
      await cleanupTestUser(user2.id).catch(() => {});
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
  ): Promise<{ id: string; text: string; visibility: string }> {
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

  async function editPost(
    sessionToken: string,
    postId: string,
    text: string,
    visibility: string,
  ): Promise<{ id: string; text: string; visibility: string }> {
    const { token: csrfToken, updatedSessionToken } =
      await getCsrfToken(sessionToken);
    const currentSessionToken = updatedSessionToken || sessionToken;

    const response = await authenticatedFetch(
      `${API_URL}/api/posts/${postId}`,
      currentSessionToken,
      {
        method: "PATCH",
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
      throw new Error(`Failed to edit post: ${response.status} ${errorText}`);
    }

    return await response.json();
  }

  describe("Visibility Change Persistence", () => {
    it("should persist friends-only to private visibility change", async () => {
      const post = await createPost(
        sessionToken1,
        "Friends post",
        "friends-only",
      );
      expect(post.visibility).toBe("friends-only");

      const edited = await editPost(
        sessionToken1,
        post.id,
        "Now private",
        "private",
      );
      expect(edited.visibility).toBe("private");
      expect(edited.editedAt).not.toBeNull();
    });

    it("should persist private to friends-only visibility change", async () => {
      const post = await createPost(sessionToken1, "Private post", "private");
      expect(post.visibility).toBe("private");

      const edited = await editPost(
        sessionToken1,
        post.id,
        "Now friends-only",
        "friends-only",
      );
      expect(edited.visibility).toBe("friends");
      expect(edited.editedAt).not.toBeNull();
    });

    it("should persist friends-only to friends-only (no change)", async () => {
      const post = await createPost(
        sessionToken1,
        "Friends post",
        "friends-only",
      );
      expect(post.visibility).toBe("friends-only");

      const edited = await editPost(
        sessionToken1,
        post.id,
        "Still friends-only",
        "friends-only",
      );
      expect(edited.visibility).toBe("friends");
      expect(edited.editedAt).not.toBeNull();
    });

    it("should persist private to private (no change)", async () => {
      const post = await createPost(sessionToken1, "Private post", "private");
      expect(post.visibility).toBe("private");

      const edited = await editPost(
        sessionToken1,
        post.id,
        "Still private",
        "private",
      );
      expect(edited.visibility).toBe("private");
      expect(edited.editedAt).not.toBeNull();
    });
  });

  describe("Visibility Enforcement - CRITICAL PRIVACY", () => {
    it("should NOT allow other users to change post visibility", async () => {
      // User1 creates a friends-only post
      const post = await createPost(
        sessionToken1,
        "User1 friends post",
        "friends-only",
      );

      // User2 tries to change it to private
      const { token: csrfToken, updatedSessionToken } = await getCsrfToken(sessionToken2);
      const editResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${post.id}`,
        updatedSessionToken || sessionToken2,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "Unauthorized edit",
            visibility: "private",
          }),
        },
      );

      // Should be forbidden
      expect(editResponse.status).toBe(403);
      const error = await editResponse.json();
      expect(error.error).toBe("Forbidden");
    });

    it("should reject invalid visibility values", async () => {
      const post = await createPost(sessionToken1, "Test post", "friends-only");

      const { token: csrfToken } = await getCsrfToken(sessionToken1);
      const editResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${post.id}`,
        sessionToken1,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "Test",
            visibility: "invalid-visibility",
          }),
        },
      );

      // Should be rejected with 400 or 403 (depending on validation order)
      expect([400, 403]).toContain(editResponse.status);
    });
  });

  describe("Response Format Validation", () => {
    it("should return properly formatted response for private visibility", async () => {
      const post = await createPost(sessionToken1, "Test", "friends-only");
      const edited = await editPost(
        sessionToken1,
        post.id,
        "Private",
        "private",
      );

      // Verify all required fields are present
      expect(edited).toHaveProperty("id");
      expect(edited).toHaveProperty("uri");
      expect(edited).toHaveProperty("text");
      expect(edited).toHaveProperty("visibility");
      expect(edited).toHaveProperty("createdAt");
      expect(edited).toHaveProperty("editedAt");
      expect(edited).toHaveProperty("author");
      expect(edited).toHaveProperty("sentimentCounts");
      expect(edited).toHaveProperty("commentCount");
      expect(edited).toHaveProperty("contentWarnings");
      expect(edited).toHaveProperty("media");

      // Verify sentimentCounts structure
      expect(edited.sentimentCounts).toHaveProperty("joy");
      expect(edited.sentimentCounts).toHaveProperty("love");
      expect(edited.sentimentCounts).toHaveProperty("calm");
      expect(edited.sentimentCounts).toHaveProperty("sad");
      expect(edited.sentimentCounts).toHaveProperty("angry");
      expect(edited.sentimentCounts).toHaveProperty("fear");
      expect(edited.sentimentCounts).toHaveProperty("surprise");
      expect(edited.sentimentCounts).toHaveProperty("disgust");
      expect(edited.sentimentCounts).toHaveProperty("neutral");
      expect(edited.sentimentCounts).toHaveProperty("excited");
      expect(edited.sentimentCounts).toHaveProperty("grateful");

      // Verify author structure
      expect(edited.author).toHaveProperty("actorUri");
      expect(edited.author).toHaveProperty("handle");

      // Verify visibility is correct
      expect(edited.visibility).toBe("private");
    });

    it("should return properly formatted response for friends-only visibility", async () => {
      const post = await createPost(sessionToken1, "Test", "private");
      const edited = await editPost(
        sessionToken1,
        post.id,
        "Friends",
        "friends-only",
      );

      // Verify visibility conversion
      expect(edited.visibility).toBe("friends");

      // Verify all required fields
      expect(edited).toHaveProperty("sentimentCounts");
      expect(edited.sentimentCounts).toHaveProperty("joy");
    });
  });

  describe("Edge Cases", () => {
    it("should handle changing visibility without changing text", async () => {
      const post = await createPost(
        sessionToken1,
        "Original text",
        "friends-only",
      );

      const edited = await editPost(
        sessionToken1,
        post.id,
        "Original text",
        "private",
      );
      expect(edited.visibility).toBe("private");
      expect(edited.text).toBe("Original text");
      expect(edited.editedAt).not.toBeNull();
    });

    it("should handle multiple visibility changes on same post", async () => {
      const post = await createPost(sessionToken1, "Test", "friends-only");

      // Change to private
      let edited = await editPost(sessionToken1, post.id, "Test", "private");
      expect(edited.visibility).toBe("private");

      // Change back to friends-only
      edited = await editPost(sessionToken1, post.id, "Test", "friends-only");
      expect(edited.visibility).toBe("friends");

      // Change to private again
      edited = await editPost(sessionToken1, post.id, "Test", "private");
      expect(edited.visibility).toBe("private");
    });
  });
});
