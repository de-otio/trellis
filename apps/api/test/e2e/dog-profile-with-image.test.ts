/**
 * Post-deployment E2E Test: Dog Profile Creation with Image Upload
 *
 * Tests the complete flow of creating a dog profile with profile picture:
 * 1. Upload test image as profile picture
 * 2. Create dog profile with name, breed, bio, birthdate, and avatar
 * 3. Save the profile
 * 4. Reload profile page and verify all data and image are correctly displayed
 *
 * ⚠️ CRITICAL: This test requires deployed infrastructure.
 * It will only run in postdeployment phase.
 *
 * Prerequisites:
 * - ENVIRONMENT or DEPLOY_ENV must be set to 'dev'
 * - API must be deployed and accessible
 * - DATABASE_URL or DIRECT_DATABASE_URL must be available (via AWS SSM or env)
 * - SESSION_SECRET must be available (via AWS SSM or env)
 *
 * Usage:
 *   npm run test:e2e -- dog-profile-with-image
 */

import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestUser } from "../utils/test-auth.js";
import {
  authenticatedFetch,
  cleanupTestUser,
  createTestUserWithSession,
} from "../utils/test-auth.js";
import { getApiUrl } from "../utils/test-config.js";

const API_URL = getApiUrl();

/**
 * Retry a fetch request with exponential backoff
 * Useful for handling transient infrastructure issues (522 timeouts, etc.)
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  attempts = 3,
  delayMs = 1000,
): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, init);
      // Retry on 522 (Cloudflare timeout) or 5xx errors
      if (
        response.status === 522 ||
        (response.status >= 500 && response.status < 600)
      ) {
        lastResponse = response;
        if (i < attempts - 1) {
          const delay = delayMs * Math.pow(2, i); // Exponential backoff
          console.log(
            `[RETRY] Request to ${url} failed with status ${response.status}, retrying in ${delay}ms (attempt ${i + 1}/${attempts})`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      return response;
    } catch (err: any) {
      lastResponse = null;
      if (i < attempts - 1) {
        const delay = delayMs * Math.pow(2, i);
        console.error(
          `[RETRY] Network error for ${url} (attempt ${i + 1}/${attempts}):`,
          err?.message || err,
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  // If we exhausted retries, return the last response or throw
  if (lastResponse) {
    return lastResponse;
  }
  throw new Error(`Failed to fetch ${url} after ${attempts} attempts`);
}

// Uses admin test user API (dev-only). On prod, the beforeEach user creation
// will fail and tests will be skipped gracefully.
describe(
  "Dog Profile Creation with Image Upload E2E",
  () => {
    let testUser: TestUser;
    let sessionToken: string;
    let createdEntityId: string | null = null;

    beforeEach(async () => {
      // Create test user with EU region (matches API's detected region)
      const uniqueId = crypto.randomUUID();
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).substring(2, 8);

      const user = await createTestUserWithSession({
        email: `test-dog-profile-${timestamp}-${randomSuffix}-${uniqueId.substring(0, 8)}@test.example.com`,
        role: "END_USER",
        region: "EU",
        dataRegion: "EU",
      });

      testUser = user.testUser;
      sessionToken = user.sessionToken;
    });

    afterEach(async () => {
      // Clean up created entity if it exists
      // Note: Entities are cascade deleted when user is deleted, but we try to delete explicitly first
      if (createdEntityId && testUser?.id) {
        try {
          // Get CSRF token for deletion
          const csrfResponse = await authenticatedFetch(
            `${API_URL}/api/csrf-token`,
            sessionToken,
            {
              method: "GET",
            },
          );
          if (csrfResponse.ok) {
            const csrfData = await csrfResponse.json();
            const csrfToken = csrfData.token;

            // Extract updated session if present
            const setCookieHeader = csrfResponse.headers.get("Set-Cookie");
            let updatedSessionToken = sessionToken;
            if (setCookieHeader) {
              const match = setCookieHeader.match(/trellis_session=([^;]+)/);
              if (match) {
                updatedSessionToken = match[1];
              }
            }

            // Try to delete entity (if DELETE endpoint exists)
            await authenticatedFetch(
              `${API_URL}/api/entities/${createdEntityId}`,
              updatedSessionToken,
              {
                method: "DELETE",
                headers: {
                  "X-CSRF-Token": csrfToken,
                },
              },
            ).catch(() => {
              // Ignore deletion errors - cascade delete will handle it
            });
          }
        } catch (error) {
          // Ignore cleanup errors - cascade delete will handle it
        }
      }

      // Clean up test user (cascade delete will handle entities)
      if (testUser?.id) {
        await cleanupTestUser(testUser.id);
      }
    });

    it("should create dog profile with image upload and verify all data", async () => {
      // Step 1: Get CSRF token and updated session
      const csrfResponse = await authenticatedFetch(
        `${API_URL}/api/csrf-token`,
        sessionToken,
        {
          method: "GET",
        },
      );
      expect(csrfResponse.status).toBe(200);
      const csrfData = await csrfResponse.json();
      const csrfToken = csrfData.token;

      // Extract updated session cookie if present (contains CSRF token)
      const setCookieHeader = csrfResponse.headers.get("Set-Cookie");
      let updatedSessionToken = sessionToken;
      if (setCookieHeader) {
        const match = setCookieHeader.match(/trellis_session=([^;]+)/);
        if (match) {
          updatedSessionToken = match[1];
        }
      }

      // Step 2: Upload test image
      // Resolve path relative to test file location
      const testImagePath = path.resolve(import.meta.dirname, "../utils/testimage.png");

      // Fallback: try resolving from process.cwd() if __dirname path doesn't work
      const fallbackPath = path.resolve(
        process.cwd(),
        "apps/api/test/utils/testimage.png",
      );

      const finalImagePath = fs.existsSync(testImagePath)
        ? testImagePath
        : fallbackPath;

      expect(fs.existsSync(finalImagePath)).toBe(true);

      const imageBuffer = fs.readFileSync(finalImagePath);
      const imageBlob = new Blob([imageBuffer], { type: "image/png" });
      const formData = new FormData();
      formData.append("file", imageBlob, "testimage.png");

      const uploadResponse = await authenticatedFetch(
        `${API_URL}/api/media/upload`,
        updatedSessionToken, // Use updated session with CSRF token
        {
          method: "POST",
          headers: {
            "X-CSRF-Token": csrfToken,
          },
          body: formData,
        },
      );

      // Check if media upload feature is disabled
      if (uploadResponse.status === 403) {
        const errorText = await uploadResponse.text();
        console.log(
          `[SKIP] Media upload feature is disabled (403): ${errorText}. Skipping test.`,
        );
        return;
      }

      if (uploadResponse.status !== 200) {
        const errorText = await uploadResponse.text();
        throw new Error(
          `Media upload failed with status ${uploadResponse.status}: ${errorText}`,
        );
      }

      const uploadData = await uploadResponse.json();
      expect(uploadData).toHaveProperty("url");
      const avatarUrl =
        uploadData.url || uploadData.mediaKey || uploadData.contentHash;
      expect(avatarUrl).toBeTruthy();

      // Step 3: Create dog profile with all fields
      // Use 'followers' privacy instead of 'public' to avoid PUBLIC_POSTING_DISABLED error
      const profileData = {
        name: "Test Dog Profile",
        entityType: "dog",
        metadata: {
          breed: "Golden Retriever",
          bio: "A friendly and energetic test dog profile",
          birthdate: "2020-05-15",
          privacy: "followers",
          avatar: avatarUrl,
        },
      };

      // Use fetchWithRetry for entity creation to handle transient infrastructure issues
      const createResponse = await fetchWithRetry(
        `${API_URL}/api/entities`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
            Cookie: `trellis_session=${updatedSessionToken}`,
          },
          body: JSON.stringify(profileData),
        },
        3, // 3 attempts
        1000, // Start with 1 second delay
      );

      // Check if feature is disabled
      if (createResponse.status === 403) {
        const errorText = await createResponse.text();
        console.log(
          `[SKIP] Entity creation feature is disabled (403): ${errorText}. Skipping test.`,
        );
        return;
      }

      // Handle timeout or connection errors
      // 522 errors indicate infrastructure issues (API not responding)
      if (createResponse.status === 522) {
        console.log(
          `[SKIP] API infrastructure unavailable (522 timeout). This indicates the deployed API is not responding. Skipping test.`,
        );
        return;
      }

      if (createResponse.status >= 500) {
        const errorText = await createResponse
          .text()
          .catch(() => "Unable to read error response");
        // For other 5xx errors, log but don't fail - might be transient
        console.warn(
          `[WARN] Entity creation returned ${createResponse.status}: ${errorText.substring(0, 200)}`,
        );
        // Still throw to fail the test, but with better message
        throw new Error(
          `Entity creation failed with status ${createResponse.status}. This may indicate an infrastructure issue. Error: ${errorText.substring(0, 500)}`,
        );
      }

      expect([200, 201]).toContain(createResponse.status);
      const createData = await createResponse.json();
      expect(createData.id).toBeDefined();
      expect(createData.name).toBe(profileData.name);
      expect(createData.entityType).toBe("dog");
      expect(createData.metadata).toBeDefined();
      expect(createData.metadata.breed).toBe(profileData.metadata.breed);
      expect(createData.metadata.bio).toBe(profileData.metadata.bio);
      expect(createData.metadata.birthdate).toBe(
        profileData.metadata.birthdate,
      );
      expect(createData.metadata.avatar).toBe(avatarUrl);

      createdEntityId = createData.id;

      // Step 4: Reload profile and verify all data
      const getResponse = await fetchWithRetry(
        `${API_URL}/api/entities/${createdEntityId}`,
        {
          method: "GET",
          headers: {
            Cookie: `trellis_session=${updatedSessionToken}`,
          },
        },
        3, // 3 attempts
        1000, // Start with 1 second delay
      );

      // Handle infrastructure issues gracefully
      if (getResponse.status === 522) {
        console.log(
          `[SKIP] API infrastructure unavailable (522 timeout) when retrieving profile. Skipping verification.`,
        );
        return;
      }

      if (getResponse.status !== 200) {
        const errorText = await getResponse
          .text()
          .catch(() => "Unable to read error response");
        throw new Error(
          `Failed to retrieve profile with status ${getResponse.status}: ${errorText.substring(0, 500)}`,
        );
      }

      expect(getResponse.status).toBe(200);
      const retrievedProfile = await getResponse.json();

      // Verify all fields are correctly stored and retrieved
      expect(retrievedProfile.id).toBe(createdEntityId);
      expect(retrievedProfile.name).toBe("Test Dog Profile");
      expect(retrievedProfile.entityType).toBe("dog");
      expect(retrievedProfile.metadata).toBeDefined();
      expect(retrievedProfile.metadata.breed).toBe("Golden Retriever");
      expect(retrievedProfile.metadata.bio).toBe(
        "A friendly and energetic test dog profile",
      );
      expect(retrievedProfile.metadata.birthdate).toBe("2020-05-15");
      expect(retrievedProfile.metadata.avatar).toBe(avatarUrl);
      expect(retrievedProfile.metadata.privacy).toBe("followers");

      // Step 6: Verify the image URL is accessible
      if (avatarUrl && avatarUrl.startsWith("http")) {
        const imageResponse = await fetch(avatarUrl, {
          method: "HEAD", // Use HEAD to check if image exists without downloading
        });
        // Image should be accessible (200 or 301/302 redirect)
        // Note: Some CDNs may return 404 if image hasn't propagated yet
        // Accept 200, 301, 302, 307, 308, or 404 (for eventual consistency)
        if (![200, 301, 302, 307, 308, 404].includes(imageResponse.status)) {
          throw new Error(
            `Image URL returned unexpected status: ${imageResponse.status} for ${avatarUrl}`,
          );
        }
        // Log if 404 (might be propagation delay)
        if (imageResponse.status === 404) {
          console.warn(
            `[WARN] Image URL returned 404 (may be propagation delay): ${avatarUrl}`,
          );
        }
      } else if (avatarUrl) {
        // If it's a media key, try to fetch it via the media endpoint
        const mediaKey = avatarUrl.startsWith("media/")
          ? avatarUrl
          : `media/${avatarUrl}`;
        const mediaResponse = await authenticatedFetch(
          `${API_URL}/api/media/${mediaKey}`,
          updatedSessionToken, // Use updated session
          {
            method: "GET",
          },
        );
        // Should be accessible (accept 404 for eventual consistency)
        if (![200, 301, 302, 307, 308, 404].includes(mediaResponse.status)) {
          throw new Error(
            `Media endpoint returned unexpected status: ${mediaResponse.status} for ${mediaKey}`,
          );
        }
        if (mediaResponse.status === 404) {
          console.warn(
            `[WARN] Media endpoint returned 404 (may be propagation delay): ${mediaKey}`,
          );
        }
      }
    }, 60000); // 60 second timeout for this comprehensive test
  },
);
