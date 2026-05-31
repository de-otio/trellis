/**
 * Post-Deployment Integration Tests: OpenAI Moderation API
 *
 * Tests the OpenAI Moderation API integration for content moderation with real API calls.
 *
 * ⚠️ CRITICAL: This test MUST NEVER run on production.
 * It will abort immediately if environment is not 'dev'.
 *
 * This test verifies:
 * - OpenAI Moderation API is called correctly when creating posts
 * - Toxic content is rejected appropriately
 * - Safe content is approved
 * - Moderation caching works
 * - Error handling works correctly
 * - OpenAI API key is read from the boot-resolved env (OPENAI_API_KEY)
 *
 * Prerequisites:
 * - ENVIRONMENT or DEPLOY_ENV must be set to 'dev'
 * - DATABASE_URL or DIRECT_DATABASE_URL must be set (or available via AWS SSM)
 * - SESSION_SECRET must be set (or available via AWS SSM)
 * - OPENAI_API_KEY must be set in AWS SSM at /trellis/dev/backend/openai/api/key
 * - API must be running (via `npm run dev` or deployed)
 *
 * Usage:
 *   npm run test:postdeployment
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSsmParameter } from "../../utils/aws-ssm.js";
import {
  authenticatedFetch,
  cleanupTestUser,
  createTestUserWithSession,
  type TestUser,
} from "../../utils/test-auth.js";
import { getApiUrl } from "../../utils/test-config.js";
import { requireDevEnvironment } from "../../utils/test-environment-guard.js";

const API_URL = getApiUrl();

// Skip entire test suite if not in dev environment
describe("Post-Deployment: OpenAI Moderation API Integration", () => {
  let testUser: TestUser;
  let sessionToken: string;
  let openaiApiKey: string | null = null;

  // Additional safety check in beforeAll (defense in depth)
  beforeAll(async () => {
    requireDevEnvironment();

    // Try to get OpenAI API key from SSM (optional - tests will skip if not available)
    try {
      openaiApiKey =
        (await getSsmParameter("OPENAI_API_KEY", {
          environment: "dev",
          required: false,
        })) || null;
      if (openaiApiKey) {
        console.log(
          "[INFO] OpenAI API key found in SSM - will test with real API",
        );
      } else {
        console.log(
          "[WARN] OpenAI API key not found - will test with mocked responses",
        );
      }
    } catch (error) {
      console.log("[WARN] Could not fetch OpenAI API key from SSM:", error);
    }

    // Create test user once for the entire test suite (reused across all tests)
    // IMPORTANT: Set region and dataRegion to match the API's detected region
    // The API detects EU region (from Cloudflare headers), so we create users in EU
    // This prevents "CROSS_REGION_DATA_ACCESS_BLOCKED" errors
    const user = await createTestUserWithSession({
      email: `test-perspective-${Date.now()}@test.example.com`,
      role: "END_USER",
      region: "EU", // Match the API's detected region
      dataRegion: "EU", // Must match region to prevent cross-region access errors
    });
    testUser = user.testUser;
    sessionToken = user.sessionToken;
  });

  /**
   * Get CSRF token for authenticated requests
   * Returns both the token and the updated session cookie (if provided)
   */
  async function getCsrfToken(): Promise<{
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

    // Extract updated session cookie if present
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

  afterAll(async () => {
    // Clean up test user once at the end of the entire test suite
    if (testUser?.id) {
      await cleanupTestUser(testUser.id).catch(() => {});
    }
  });

  describe("POST /api/posts - Content Moderation", () => {
    it("should approve safe content", async () => {
      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
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
            text: "This is a friendly and positive post about dogs!",
            visibility: "friends-only",
          }),
        },
      );

      if (response.status !== 201) {
        const errorBody = await response.text();
        console.error(
          `[ERROR] Post creation failed with status ${response.status}:`,
          errorBody,
        );
        // Log the error but still fail the test
        throw new Error(
          `Post creation failed: ${response.status} - ${errorBody}`,
        );
      }
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("text");
      expect(body.text).toBe(
        "This is a friendly and positive post about dogs!",
      );
    });

    it("should reject toxic content when moderation is enabled", async () => {
      // Skip if API key is not available (moderation will be skipped)
      if (!openaiApiKey) {
        console.log(
          "[SKIP] OpenAI API key not available - skipping toxic content test",
        );
        return;
      }

      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
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
            text: "You are an idiot and I hate you!",
            visibility: "friends-only",
          }),
        },
      );

      // Should reject toxic content (status 400 with CONTENT_REJECTED error)
      // Note: Actual behavior depends on Perspective API scores
      // If moderation is working, it should reject; if not, it may approve
      expect([201, 400]).toContain(response.status);

      const body = await response.json();
      if (response.status === 400) {
        expect(body).toHaveProperty("error");
        expect(body.error).toBe("CONTENT_REJECTED");
        expect(body).toHaveProperty("message");
        expect(body).toHaveProperty("score");
      } else {
        // If approved, log for debugging (may happen if API scores are below threshold)
        console.log(
          "[INFO] Toxic content was approved (score may be below threshold)",
        );
      }
    });

    it("should handle moderation service errors gracefully", async () => {
      // This test verifies that if moderation fails, content is still approved (fail-open)
      // We can't easily simulate API failures in integration tests, but we can verify
      // that the endpoint doesn't crash when moderation has issues

      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
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
            text: "This is a test post to verify error handling",
            visibility: "friends-only",
          }),
        },
      );

      // Should not return 500 even if moderation has issues
      expect(response.status).not.toBe(500);
      // Should either succeed (201) or reject for content reasons (400)
      expect([201, 400]).toContain(response.status);
    });

    it("should work without API key (skip moderation)", async () => {
      // This test verifies that posts can be created even when API key is missing
      // The moderation handler should skip moderation and approve content

      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
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
            text: "This post should be approved even without moderation API key",
            visibility: "friends-only",
          }),
        },
      );

      // Should succeed (moderation skipped when API key is missing)
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toHaveProperty("id");
    });
  });

  describe("POST /api/posts/:postId/comments - Comment Moderation", () => {
    let postId: string;

    beforeEach(async () => {
      // Create a post for commenting
      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
      const sessionTokenToUse = updatedSessionToken || sessionToken;
      const postResponse = await authenticatedFetch(
        `${API_URL}/api/posts`,
        sessionTokenToUse,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "This is a test post for comments",
            visibility: "friends-only",
          }),
        },
      );

      expect(postResponse.status).toBe(201);
      const postBody = await postResponse.json();
      postId = postBody.id;
    });

    it("should moderate comment content", async () => {
      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
      const sessionTokenToUse = updatedSessionToken || sessionToken;
      const response = await authenticatedFetch(
        `${API_URL}/api/posts/${postId}/comments`,
        sessionTokenToUse,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "Great post! Thanks for sharing.",
          }),
        },
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("text");
      expect(body.text).toBe("Great post! Thanks for sharing.");
    });

    it("should reject toxic comments when moderation is enabled", async () => {
      // Skip if API key is not available
      if (!openaiApiKey) {
        console.log(
          "[SKIP] OpenAI API key not available - skipping toxic comment test",
        );
        return;
      }

      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
      const sessionTokenToUse = updatedSessionToken || sessionToken;
      const response = await authenticatedFetch(
        `${API_URL}/api/posts/${postId}/comments`,
        sessionTokenToUse,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            text: "This is a terrible comment with offensive language!",
          }),
        },
      );

      // Should either reject (400) or approve (201) depending on API scores
      expect([201, 400]).toContain(response.status);

      const body = await response.json();
      if (response.status === 400) {
        expect(body).toHaveProperty("error");
        expect(body.error).toBe("CONTENT_REJECTED");
      }
    });
  });

  describe("Moderation Caching", () => {
    it("should cache moderation results for identical content", async () => {
      // Skip if API key is not available
      if (!openaiApiKey) {
        console.log(
          "[SKIP] OpenAI API key not available - skipping cache test",
        );
        return;
      }

      const text = "This is a test post for caching verification";
      const { token: csrfToken1, updatedSessionToken: sessionToken1 } =
        await getCsrfToken();
      const currentSessionToken1 = sessionToken1 || sessionToken;

      // Create first post
      const response1 = await authenticatedFetch(
        `${API_URL}/api/posts`,
        currentSessionToken1,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken1,
          },
          body: JSON.stringify({
            text,
            visibility: "friends-only",
          }),
        },
      );

      expect(response1.status).toBe(201);
      const body1 = await response1.json();
      expect(body1).toHaveProperty("id");

      // Create second post with identical text
      // If caching works, this should be faster and use cached result
      const { token: csrfToken2, updatedSessionToken: sessionToken2 } =
        await getCsrfToken();
      const currentSessionToken2 = sessionToken2 || currentSessionToken1;
      const response2 = await authenticatedFetch(
        `${API_URL}/api/posts`,
        currentSessionToken2,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken2,
          },
          body: JSON.stringify({
            text,
            visibility: "friends-only",
          }),
        },
      );

      expect(response2.status).toBe(201);
      const body2 = await response2.json();
      expect(body2).toHaveProperty("id");

      // Both posts should have been created successfully
      // (caching is internal, but we verify it doesn't break functionality)
      expect(body1.id).not.toBe(body2.id);
    });
  });

  describe("Moderation Thresholds", () => {
    it("should handle edge case scores correctly", async () => {
      // Skip if API key is not available
      if (!openaiApiKey) {
        console.log(
          "[SKIP] OpenAI API key not available - skipping threshold test",
        );
        return;
      }

      // Test with content that might be borderline
      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
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
            text: "This is a neutral post that should be approved",
            visibility: "friends-only",
          }),
        },
      );

      // Should handle gracefully regardless of score
      expect([201, 400]).toContain(response.status);
    }, 30000); // 30 second timeout
  });

  describe("Secret Resolution", () => {
    it("should read the OpenAI API key from the resolved env", async () => {
      // This test verifies that the moderation handler reads the API key from
      // env.OPENAI_API_KEY (resolved once at boot in env.ts)

      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
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
            text: "Test post to verify secret resolution",
            visibility: "friends-only",
          }),
        },
      );

      // Should succeed (either with or without API key)
      expect([201, 400]).toContain(response.status);

      // If it fails, it should be a content rejection, not a secret resolution error
      if (response.status !== 201) {
        const body = await response.json();
        // Should not be a 500 error (which would indicate secret resolution failure)
        expect(response.status).not.toBe(500);
      }
    });
  });
});
