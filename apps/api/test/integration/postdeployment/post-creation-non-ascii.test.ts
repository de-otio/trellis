/**
 * Post-Deployment Integration Tests: Post Creation with Non-ASCII Characters
 *
 * Tests post creation with special characters and non-ASCII text to ensure
 * proper serialization and database handling.
 *
 * ⚠️ CRITICAL: This test MUST NEVER run on production.
 * It will abort immediately if environment is not 'dev'.
 *
 * This test verifies:
 * - Posts with non-ASCII characters can be created successfully
 * - Special characters are properly serialized
 * - No Symbol serialization errors occur
 * - Unicode characters are preserved correctly
 *
 * Prerequisites:
 * - ENVIRONMENT or DEPLOY_ENV must be set to 'dev'
 * - DATABASE_URL or DIRECT_DATABASE_URL must be set (or available via AWS SSM)
 * - SESSION_SECRET must be set (or available via AWS SSM)
 * - API must be running (via `npm run dev` or deployed)
 *
 * Usage:
 *   npm run test:postdeployment -- post-creation-non-ascii.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authenticatedFetch,
  cleanupTestUser,
  createTestUserWithSession,
  type TestUser,
} from "../../utils/test-auth.js";
import { getApiUrl } from "../../utils/test-config.js";
import {
  requireDevEnvironment,
  skipIfNotDev,
} from "../../utils/test-environment-guard.js";

const API_URL = getApiUrl();

// Skip entire test suite if not in dev environment
describe("Post-Deployment: Post Creation with Non-ASCII Characters", () => {
  let testUser: TestUser;
  let sessionToken: string;

  // Additional safety check in beforeAll (defense in depth)
  beforeEach(async () => {
    requireDevEnvironment();

    // Create a test user for authenticated requests
    // IMPORTANT: Set region and dataRegion to match the API's detected region
    // The API detects EU region (from Cloudflare headers), so we create users in EU
    // This prevents "CROSS_REGION_DATA_ACCESS_BLOCKED" errors
    const user = await createTestUserWithSession({
      email: `test-nonascii-${Date.now()}@test.example.com`,
      role: "END_USER",
      region: "EU", // Match the API's detected region
      dataRegion: "EU", // Must match region to prevent cross-region access errors
    });
    testUser = user.testUser;
    sessionToken = user.sessionToken;
  });

  afterEach(async () => {
    // Clean up test user
    if (testUser?.id) {
      await cleanupTestUser(testUser.id);
    }
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
        `Failed to get CSRF token: ${response.status} - ${errorText}`,
      );
    }

    // Try to get token from response body first (some endpoints return it in body)
    let token: string | null = null;
    try {
      const body = await response.json();
      token = body.token || body.csrfToken || null;
    } catch {
      // If not JSON, try header
      token = response.headers.get("X-CSRF-Token");
    }

    // Fallback to header if not in body
    if (!token) {
      token = response.headers.get("X-CSRF-Token");
    }

    if (!token) {
      // Log all headers for debugging
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      console.error("[DEBUG] CSRF token response headers:", headers);
      throw new Error("CSRF token not found in response headers or body");
    }

    // Check if session cookie was updated
    const setCookieHeader = response.headers.get("Set-Cookie");
    let updatedSessionToken: string | undefined;
    if (setCookieHeader) {
      // Extract session token from Set-Cookie header
      const match = setCookieHeader.match(/trellis_session=([^;]+)/);
      if (match) {
        updatedSessionToken = match[1];
      }
    }

    return { token, updatedSessionToken };
  }

  describe("POST /api/posts - Non-ASCII Character Handling", () => {
    it("should create post with non-ASCII characters and special symbols", async () => {
      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
      const currentSessionToken = updatedSessionToken || sessionToken;

      // Test string with lots of non-ASCII characters and special symbols
      const testText = "test :%^3-=@ 🥹 üß";

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
            text: testText,
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

      // Verify post was created successfully
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("text");
      expect(body).toHaveProperty("visibility");

      // Verify text is preserved exactly (including non-ASCII characters)
      expect(body.text).toBe(testText.trim());
      expect(body.visibility).toBe("friends-only"); // API returns original input value
    });

    it("should create post with extended Unicode characters", async () => {
      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
      const currentSessionToken = updatedSessionToken || sessionToken;

      // Test with various Unicode characters
      const testText = "Hello 世界 🌍 مرحبا Здравствуй こんにちは 🎉";

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
            text: testText,
            visibility: "friends-only",
          }),
        },
      );

      expect(response.status).toBe(201);
      const body = await response.json();

      // Verify Unicode characters are preserved
      expect(body.text).toBe(testText.trim());
      expect(body.visibility).toBe("friends-only"); // API returns original input value
    });

    it("should create post with special characters and emojis", async () => {
      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
      const currentSessionToken = updatedSessionToken || sessionToken;

      // Test with various special characters
      const testText = "Special chars: !@#$%^&*()_+-=[]{}|;:,.<>?/~` 🐕 🐶 🎈";

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
            text: testText,
            visibility: "private",
          }),
        },
      );

      expect(response.status).toBe(201);
      const body = await response.json();

      // Verify special characters are preserved
      expect(body.text).toBe(testText.trim());
      expect(body.visibility).toBe("private"); // API returns original input value
    });

    it("should handle mixed ASCII and non-ASCII characters", async () => {
      const { token: csrfToken, updatedSessionToken } = await getCsrfToken();
      const currentSessionToken = updatedSessionToken || sessionToken;

      // Mix of ASCII and non-ASCII
      const testText =
        "ASCII text with non-ASCII: café résumé naïve 北京 Москва";

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
            text: testText,
            visibility: "friends-only",
          }),
        },
      );

      expect(response.status).toBe(201);
      const body = await response.json();

      // Verify mixed content is preserved
      expect(body.text).toBe(testText.trim());
      expect(body.visibility).toBe("friends-only"); // API returns original input value
    });
  });
});
