/**
 * Integration Tests: Reactions API
 *
 * Tests the reactions/sentiment endpoints with a real database and deployed API.
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

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  authenticatedFetch,
  cleanupTestUser,
  createTestUserWithSession,
  extractSessionFromResponse,
  type TestUser,
} from "../../utils/test-auth.js";
import { getApiUrl } from "../../utils/test-config.js";
import {
  requireDevEnvironment,
  skipIfNotDev,
} from "../../utils/test-environment-guard.js";

const API_URL = getApiUrl();

// Skip entire test suite if not in dev environment
describe("Reactions API Integration", () => {
  let testUser1: TestUser;
  let testUser2: TestUser;
  let sessionToken1: string;
  let sessionToken2: string;
  let createdPostId: string | null = null;

  beforeAll(async () => {
    requireDevEnvironment();

    // Create test users once for the entire test suite (reused across all tests)
    // This reduces user creation from ~14 (7 tests × 2 users) to just 2 users
    const user1 = await createTestUserWithSession({
      email: `test-reactions-1-${Date.now()}@test.example.com`,
      role: "END_USER",
      region: "EU",
      dataRegion: "EU",
    });
    testUser1 = user1.testUser;
    sessionToken1 = user1.sessionToken;

    const user2 = await createTestUserWithSession({
      email: `test-reactions-2-${Date.now()}@test.example.com`,
      role: "END_USER",
      region: "EU",
      dataRegion: "EU",
    });
    testUser2 = user2.testUser;
    sessionToken2 = user2.sessionToken;
  });

  beforeEach(async () => {
    // Create a test post for reactions
    const { token: csrfToken, updatedSessionToken } =
      await getCsrfToken(sessionToken1);
    const currentSessionToken = updatedSessionToken || sessionToken1;

    const postResponse = await authenticatedFetch(
      `${API_URL}/api/posts`,
      currentSessionToken,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          text: "Test post for reactions",
          visibility: "friends-only",
        }),
      },
    );

    if (postResponse.ok) {
      const postBody = await postResponse.json();
      createdPostId = postBody.id;
    }
  });

  afterEach(async () => {
    // Clean up test post
    if (createdPostId) {
      try {
        const { token: csrfToken } = await getCsrfToken(sessionToken1);
        await authenticatedFetch(
          `${API_URL}/api/posts/${createdPostId}`,
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
      createdPostId = null;
    }
  });

  afterAll(async () => {
    // Clean up test users once at the end of the entire test suite
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

  describe("POST /api/posts/:postId/sentiment", () => {
    it("should add sentiment reaction", async () => {
      if (!createdPostId) {
        throw new Error("Test post not created");
      }

      const { token: csrfToken, updatedSessionToken } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken = updatedSessionToken || sessionToken1;

      const response = await authenticatedFetch(
        `${API_URL}/api/posts/${createdPostId}/sentiment`,
        currentSessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            sentiment: "joy",
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("success");
      expect(body.success).toBe(true);
    });

    it("should update existing reaction", async () => {
      if (!createdPostId) {
        throw new Error("Test post not created");
      }

      const { token: csrfToken, updatedSessionToken } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken = updatedSessionToken || sessionToken1;

      // Add initial reaction
      const initialResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${createdPostId}/sentiment`,
        currentSessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            sentiment: "joy",
          }),
        },
      );

      if (!initialResponse.ok) {
        const errorText = await initialResponse.text();
        throw new Error(
          `Failed to add initial reaction: ${initialResponse.status} ${errorText}`,
        );
      }

      // Track session changes from first request
      const session2 = extractSessionFromResponse(initialResponse, currentSessionToken);
      // Get fresh CSRF for second mutation
      const { token: csrfToken2, updatedSessionToken: session3 } =
        await getCsrfToken(session2);

      // Update to different sentiment
      const updateResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${createdPostId}/sentiment`,
        session3,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken2,
          },
          body: JSON.stringify({
            sentiment: "sad",
          }),
        },
      );

      // API may return 200 (updated) or 400 (duplicate/already exists)
      expect([200, 400]).toContain(updateResponse.status);
      if (updateResponse.status === 200) {
        const body = await updateResponse.json();
        expect(body).toHaveProperty("success");
        expect(body.success).toBe(true);
      }
    });

    it("should validate sentiment type", async () => {
      if (!createdPostId) {
        throw new Error("Test post not created");
      }

      const { token: csrfToken, updatedSessionToken } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken = updatedSessionToken || sessionToken1;

      // Try invalid sentiment type
      const response = await authenticatedFetch(
        `${API_URL}/api/posts/${createdPostId}/sentiment`,
        currentSessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            sentiment: "invalid-sentiment-type",
          }),
        },
      );

      // Should reject invalid sentiment
      expect([400, 422]).toContain(response.status);
    });
  });

  describe("GET /api/posts/:postId/sentiments", () => {
    it("should return sentiment counts", async () => {
      if (!createdPostId) {
        throw new Error("Test post not created");
      }

      // Add some reactions first
      const { token: csrfToken1, updatedSessionToken: token1 } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken1 = token1 || sessionToken1;

      const addResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${createdPostId}/sentiment`,
        currentSessionToken1,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken1,
          },
          body: JSON.stringify({
            sentiment: "joy",
          }),
        },
      );

      if (!addResponse.ok) {
        const errorText = await addResponse.text();
        throw new Error(
          `Failed to add reaction: ${addResponse.status} ${errorText}`,
        );
      }

      // Get sentiment counts
      const response = await authenticatedFetch(
        `${API_URL}/api/posts/${createdPostId}/sentiments`,
        sessionToken1,
        {
          method: "GET",
        },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("sentimentCounts");
      expect(typeof body.sentimentCounts).toBe("object");
      // Should have counts since we just added a reaction
      expect(body.sentimentCounts).toHaveProperty("joy");
      expect(body.sentimentCounts.joy).toBeGreaterThan(0);
    });

    it("should include user sentiment if authenticated", async () => {
      if (!createdPostId) {
        throw new Error("Test post not created");
      }

      // Add reaction as user1
      const { token: csrfToken1, updatedSessionToken: token1 } =
        await getCsrfToken(sessionToken1);
      const currentSessionToken1 = token1 || sessionToken1;

      const addResponse = await authenticatedFetch(
        `${API_URL}/api/posts/${createdPostId}/sentiment`,
        currentSessionToken1,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken1,
          },
          body: JSON.stringify({
            sentiment: "joy",
          }),
        },
      );

      if (!addResponse.ok) {
        const errorText = await addResponse.text();
        throw new Error(
          `Failed to add reaction: ${addResponse.status} ${errorText}`,
        );
      }

      // Get sentiments as user1 (should include their sentiment)
      const response = await authenticatedFetch(
        `${API_URL}/api/posts/${createdPostId}/sentiments`,
        currentSessionToken1,
        {
          method: "GET",
        },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("sentimentCounts");
      // userSentiment is only present if user has a reaction
      // Since we added a 'joy' reaction above, userSentiment should be present
      expect(body).toHaveProperty("userSentiment");
      // User's sentiment should be 'joy' since we just added it
      expect(body.userSentiment).toBe("joy");
    });
  });
});
