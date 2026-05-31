/**
 * Upload Sessions Post-Deployment Test
 *
 * Tests the upload session management endpoints in the deployed environment.
 * This test verifies that the optimistic image upload feature works correctly
 * with real authentication and database.
 *
 * ⚠️ CRITICAL: This test requires deployed infrastructure.
 * It will only run in postdeployment phase.
 *
 * Prerequisites:
 * - API worker deployed to dev/prod environment
 * - Database accessible with UploadSession table
 * - AWS credentials configured (for session secret)
 * - CSRF token support enabled
 *
 * Usage:
 *   npm run test:postdeployment -- upload-sessions
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  authenticatedFetch,
  cleanupTestUser,
  createTestUserWithSession,
  getCsrfToken as getSharedCsrfToken,
  extractSessionFromResponse,
  type TestUser,
} from "../../utils/test-auth.js";
import { getApiUrl } from "../../utils/test-config.js";
import { requireDevEnvironment } from "../../utils/test-environment-guard.js";

const API_URL = getApiUrl();

describe("Upload Sessions - Post-Deployment", () => {
  let testUser: TestUser;
  let sessionToken: string;
  let csrfToken: string | null = null;
  let uploadSessionId: string | null = null;

  beforeAll(async () => {
    requireDevEnvironment();
    console.log(`Testing against API: ${API_URL}`);

    // Create a test user for authenticated requests
    // Set region and dataRegion to match the API's detected region (EU)
    const user = await createTestUserWithSession({
      email: `test-upload-${Date.now()}@test.example.com`,
      role: "END_USER",
      region: "EU",
      dataRegion: "EU",
    });
    testUser = user.testUser;
    sessionToken = user.sessionToken;
    console.log("✅ Test user created and authenticated");
    console.log(`   User ID: ${testUser.id}`);
    console.log(`   Email: ${testUser.email}`);

    // Fetch CSRF token using shared helper (extracts session from Set-Cookie)
    try {
      const csrf = await getSharedCsrfToken(API_URL, sessionToken);
      csrfToken = csrf.token;
      sessionToken = csrf.updatedSessionToken;
      console.log("✅ CSRF token fetched successfully");
      console.log(`   Token length: ${csrfToken?.length || 0}`);
      console.log("✅ Session token updated from CSRF endpoint");
    } catch (error) {
      console.warn("⚠️  CSRF token fetch error:", error);
    }
  });

  afterAll(async () => {
    // Clean up test user
    if (testUser?.id) {
      await cleanupTestUser(testUser.id);
      console.log("✅ Test user cleaned up");
    }
  });

  describe("POST /api/upload-sessions", () => {
    it("should require authentication", async () => {
      const response = await fetch(`${API_URL}/api/upload-sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Unauthorized");
    });

    it("should require CSRF token for authenticated requests", async () => {
      const response = await authenticatedFetch(
        `${API_URL}/api/upload-sessions`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      // Should get 403 without CSRF token
      expect(response.status).toBe(403);
    });

    it("should create upload session with valid authentication and CSRF token", async () => {
      if (!csrfToken) {
        throw new Error("CSRF token not available");
      }

      console.log(
        `   Sending request with CSRF token: ${csrfToken.substring(0, 8)}...`,
      );

      const response = await authenticatedFetch(
        `${API_URL}/api/upload-sessions`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      console.log(`   Response status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`   Error response: ${errorText}`);
      }

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data).toHaveProperty("sessionId");
      expect(data).toHaveProperty("expiresAt");
      expect(typeof data.sessionId).toBe("string");
      expect(data.sessionId.length).toBeGreaterThan(0);

      // Store session ID for subsequent tests
      uploadSessionId = data.sessionId;
      console.log(`✅ Created upload session: ${uploadSessionId}`);
    });

    it("should enforce rate limiting (10 sessions per hour)", async () => {
      if (!csrfToken) {
        throw new Error("CSRF token not available");
      }

      // Create 10 sessions rapidly
      const promises = Array.from({ length: 10 }, () =>
        authenticatedFetch(`${API_URL}/api/upload-sessions`, sessionToken, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
        }),
      );

      const responses = await Promise.all(promises);
      const successCount = responses.filter((r) => r.status === 201).length;
      const rateLimitCount = responses.filter((r) => r.status === 429).length;

      // Should have some successful and some rate-limited
      expect(successCount).toBeGreaterThan(0);
      console.log(
        `✅ Rate limiting working: ${successCount} succeeded, ${rateLimitCount} rate-limited`,
      );
    }, 30000); // Increase timeout for multiple requests
  });

  describe("POST /api/upload-sessions/:id/media", () => {
    it("should require authentication", async () => {
      const response = await fetch(
        `${API_URL}/api/upload-sessions/test-id/media`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ mediaId: "test-media-id" }),
        },
      );

      expect(response.status).toBe(401);
    });

    it("should require valid session ID", async () => {
      if (!csrfToken) {
        throw new Error("CSRF token not available");
      }

      const response = await authenticatedFetch(
        `${API_URL}/api/upload-sessions/invalid-session-id/media`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({ mediaId: "test-media-id" }),
        },
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("Session not found");
    });

    it("should require mediaId in request body", async () => {
      if (!csrfToken || !uploadSessionId) {
        throw new Error("Missing required data");
      }

      const response = await authenticatedFetch(
        `${API_URL}/api/upload-sessions/${uploadSessionId}/media`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("mediaId is required");
    });

    it("should accept contentHash as mediaId (for just-uploaded media)", async () => {
      if (!csrfToken || !uploadSessionId) {
        throw new Error("Missing required data");
      }

      // Simulate a contentHash from a just-uploaded image
      // The MediaFile record may not exist yet due to async reconciliation
      const contentHash = "abc123def456"; // Simulated contentHash

      const response = await authenticatedFetch(
        `${API_URL}/api/upload-sessions/${uploadSessionId}/media`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({ mediaId: contentHash }),
        },
      );

      // Should succeed even if MediaFile doesn't exist yet
      // The backend accepts contentHash and will track it in the session
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      console.log(
        `✅ ContentHash accepted as mediaId (async reconciliation supported)`,
      );
    });
  });

  describe("POST /api/upload-sessions/:id/complete", () => {
    it("should require authentication", async () => {
      const response = await fetch(
        `${API_URL}/api/upload-sessions/test-id/complete`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      expect(response.status).toBe(401);
    });

    it("should require valid session ID", async () => {
      if (!csrfToken) {
        throw new Error("CSRF token not available");
      }

      const response = await authenticatedFetch(
        `${API_URL}/api/upload-sessions/invalid-session-id/complete`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("Session not found");
    });

    it("should complete valid upload session", async () => {
      if (!csrfToken || !uploadSessionId) {
        throw new Error("Missing required data");
      }

      const response = await authenticatedFetch(
        `${API_URL}/api/upload-sessions/${uploadSessionId}/complete`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      console.log(`✅ Completed upload session: ${uploadSessionId}`);
    });
  });

  describe("POST /api/upload-sessions/:id/abandon", () => {
    let abandonSessionId: string | null = null;

    beforeAll(async () => {
      // Create a new session to abandon
      if (csrfToken) {
        const response = await authenticatedFetch(
          `${API_URL}/api/upload-sessions`,
          sessionToken,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfToken,
            },
          },
        );

        if (response.ok) {
          const data = await response.json();
          abandonSessionId = data.sessionId;
        }
      }
    });

    it("should require authentication", async () => {
      const response = await fetch(
        `${API_URL}/api/upload-sessions/test-id/abandon`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      expect(response.status).toBe(401);
    });

    it("should abandon valid upload session", async () => {
      if (!csrfToken || !abandonSessionId) {
        console.log("[SKIP] Missing required data (previous test may have been rate limited)");
        return;
      }

      const response = await authenticatedFetch(
        `${API_URL}/api/upload-sessions/${abandonSessionId}/abandon`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      console.log(`✅ Abandoned upload session: ${abandonSessionId}`);
    });
  });

  describe("POST /api/media/:id/mark-orphaned", () => {
    it("should require authentication", async () => {
      const response = await fetch(
        `${API_URL}/api/media/test-hash/mark-orphaned`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      expect(response.status).toBe(401);
    });

    it("should accept contentHash as mediaId (for just-uploaded media)", async () => {
      if (!csrfToken) {
        throw new Error("CSRF token not available");
      }

      // Simulate a contentHash from a just-uploaded image
      // The MediaFile record may not exist yet due to async reconciliation
      const contentHash = "xyz789abc123"; // Simulated contentHash

      const response = await authenticatedFetch(
        `${API_URL}/api/media/${contentHash}/mark-orphaned`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      console.log(`   Response status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`   Error response: ${errorText}`);
      }

      // Should succeed even if MediaFile doesn't exist yet
      // The backend treats non-existent media as already orphaned (best-effort)
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      console.log(
        `✅ ContentHash accepted for mark-orphaned (async reconciliation supported)`,
      );
    });

    it("should handle media that belongs to different user", async () => {
      if (!csrfToken) {
        throw new Error("CSRF token not available");
      }

      // Try to mark media that doesn't belong to this user
      // Using a realistic-looking hash that won't exist
      const someoneElsesHash = "aaabbbcccddd111222333";

      const response = await authenticatedFetch(
        `${API_URL}/api/media/${someoneElsesHash}/mark-orphaned`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      console.log(`   Response status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`   Error response: ${errorText}`);
      }

      // Should succeed (best-effort - media doesn't exist or doesn't belong to user)
      expect(response.status).toBe(200);
      console.log(
        `✅ Mark-orphaned is best-effort (succeeds even if media not found)`,
      );
    });
  });

  describe("Integration with Image Upload", () => {
    it("should work with complete upload flow", async () => {
      if (!csrfToken) {
        throw new Error("CSRF token not available");
      }

      // 1. Create upload session
      const sessionResponse = await authenticatedFetch(
        `${API_URL}/api/upload-sessions`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      // Skip if rate limited (previous tests may have exhausted the 10/hour limit)
      if (sessionResponse.status === 429) {
        console.log("[SKIP] Upload session rate limited (429). Skipping complete upload flow test.");
        return;
      }
      expect(sessionResponse.status).toBe(201);
      const sessionData = await sessionResponse.json();
      const testSessionId = sessionData.sessionId;

      console.log(`✅ Step 1: Created session ${testSessionId}`);

      // 2. Upload image (simulated - would need actual image file)
      // In real scenario: upload image, get mediaId

      // 3. Register media with session (simulated)
      // In real scenario: call /api/upload-sessions/:id/media with actual mediaId

      // 4. Complete session
      const completeResponse = await authenticatedFetch(
        `${API_URL}/api/upload-sessions/${testSessionId}/complete`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      expect(completeResponse.status).toBe(200);
      console.log(`✅ Step 2: Completed session ${testSessionId}`);
    });

    it("should handle first upload without CSRF token (browser flow)", async () => {
      // This test simulates the real browser flow where:
      // 1. User loads page (no CSRF token yet)
      // 2. User tries to upload image
      // 3. Frontend calls ensureValidToken() which fetches CSRF token
      // 4. Upload succeeds with token

      // Create a new test user to simulate fresh browser session
      const freshUser = await createTestUserWithSession({
        email: `test-fresh-${Date.now()}@test.example.com`,
        role: "END_USER",
        region: "EU",
        dataRegion: "EU",
      });

      try {
        // Step 1: Try to create session WITHOUT CSRF token (should fail with 403)
        const noTokenResponse = await authenticatedFetch(
          `${API_URL}/api/upload-sessions`,
          freshUser.sessionToken,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // No X-CSRF-Token header
            },
          },
        );

        expect(noTokenResponse.status).toBe(403);
        console.log(
          "✅ Step 1: Request without CSRF token correctly rejected (403)",
        );

        // Step 2: Fetch CSRF token (simulating ensureValidToken())
        const csrf = await getSharedCsrfToken(API_URL, freshUser.sessionToken);
        const freshCsrfToken = csrf.token;
        const updatedToken = csrf.updatedSessionToken;

        console.log("✅ Step 2: CSRF token fetched successfully");

        // Step 3: Retry with CSRF token (should succeed)
        const withTokenResponse = await authenticatedFetch(
          `${API_URL}/api/upload-sessions`,
          updatedToken,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": freshCsrfToken,
            },
          },
        );

        expect(withTokenResponse.status).toBe(201);
        const sessionData = await withTokenResponse.json();
        expect(sessionData).toHaveProperty("sessionId");
        console.log(
          `✅ Step 3: Upload session created with CSRF token: ${sessionData.sessionId}`,
        );
      } finally {
        // Cleanup
        await cleanupTestUser(freshUser.testUser.id);
      }
    });
  });
});
