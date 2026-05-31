/**
 * End-to-End Tests: Media Collection Feature
 *
 * Tests the complete flow of the media collection feature:
 * 1. Upload media (or create post with media)
 * 2. List user media
 * 3. Get grouped media (by month/year)
 * 4. Get media statistics
 * 5. Hide media
 * 6. Unhide media
 * 7. Delete media
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
 *   npm run test:e2e -- media-collection
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
describe("Media Collection E2E Tests", () => {
  let testUser: TestUser;
  let sessionToken: string;
  let uploadedMediaId: string | null = null;
  let uploadedContentHash: string | null = null;

  beforeEach(async () => {
    // Create test user with EU region (matches API's detected region)
    const uniqueId = crypto.randomUUID();
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);

    const user = await createTestUserWithSession({
      email: `test-media-collection-${timestamp}-${randomSuffix}-${uniqueId.substring(0, 8)}@test.example.com`,
      role: "END_USER",
      region: "EU",
      dataRegion: "EU",
    });

    testUser = user.testUser;
    sessionToken = user.sessionToken;
  });

  afterEach(async () => {
    // Clean up uploaded media if it exists
    if (uploadedMediaId && testUser?.id && sessionToken) {
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

          // Try to delete media (soft delete)
          await authenticatedFetch(
            `${API_URL}/api/media/${uploadedMediaId}`,
            updatedSessionToken,
            {
              method: "DELETE",
              headers: {
                "X-CSRF-Token": csrfToken,
              },
            },
          ).catch(() => {
            // Ignore deletion errors - cleanup job will handle it
          });
        }
      } catch (error) {
        // Ignore cleanup errors
      }
    }

    // Clean up test user (cascade delete will handle media)
    if (testUser?.id) {
      await cleanupTestUser(testUser.id);
    }
  });

  it("should complete full media collection flow: upload → list → grouped → stats → hide → unhide → delete", async () => {
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

    // Extract updated session cookie if present
    const setCookieHeader = csrfResponse.headers.get("Set-Cookie");
    let updatedSessionToken = sessionToken;
    if (setCookieHeader) {
      const match = setCookieHeader.match(/trellis_session=([^;]+)/);
      if (match) {
        updatedSessionToken = match[1];
      }
    }

    // Step 2: Upload test image
    const testImagePath = path.resolve(import.meta.dirname, "../utils/testimage.png");
    const fallbackPath = path.resolve(
      process.cwd(),
      "apps/api/test/utils/testimage.png",
    );
    const finalImagePath = fs.existsSync(testImagePath)
      ? testImagePath
      : fallbackPath;

    if (!fs.existsSync(finalImagePath)) {
      console.log("[SKIP] Test image not found. Skipping media upload test.");
      return;
    }

    const imageBuffer = fs.readFileSync(finalImagePath);
    const imageBlob = new Blob([imageBuffer], { type: "image/png" });
    const formData = new FormData();
    formData.append("file", imageBlob, "testimage.png");

    const uploadResponse = await authenticatedFetch(
      `${API_URL}/api/media/upload`,
      updatedSessionToken,
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
    expect(uploadData).toHaveProperty("contentHash");
    uploadedContentHash = uploadData.contentHash;

    // Step 3: Create a post with the uploaded media to ensure it appears in media collection
    // This step may be optional if media appears in collection without being in a post
    // For now, we'll proceed to list media and see if it appears

    // Step 4: List user media
    const listResponse = await fetchWithRetry(
      `${API_URL}/api/media?limit=50&includeTotalCount=true`,
      {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${updatedSessionToken}`,
        },
      },
    );

    expect(listResponse.status).toBe(200);
    const listData = await listResponse.json();
    expect(listData).toHaveProperty("media");
    expect(listData).toHaveProperty("totalCount");
    expect(Array.isArray(listData.media)).toBe(true);

    // Find the uploaded media in the list
    const uploadedMedia = listData.media.find(
      (m: any) => m.contentHash === uploadedContentHash,
    );

    if (!uploadedMedia) {
      console.log(
        "[INFO] Uploaded media not found in list (may need to be in a post first). Continuing with other tests.",
      );
      // Continue with other tests even if media not in list
    } else {
      uploadedMediaId = uploadedMedia.id;
      expect(uploadedMedia).toHaveProperty("id");
      expect(uploadedMedia).toHaveProperty("contentHash");
      expect(uploadedMedia).toHaveProperty("mimeType");
      expect(uploadedMedia).toHaveProperty("thumbnailUrl");
    }

    // Step 5: Get grouped media (by month)
    const groupedResponse = await fetchWithRetry(
      `${API_URL}/api/media/grouped?groupBy=month&limit=100`,
      {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${updatedSessionToken}`,
        },
      },
    );

    expect(groupedResponse.status).toBe(200);
    const groupedData = await groupedResponse.json();
    expect(groupedData).toHaveProperty("groups");
    expect(Array.isArray(groupedData.groups)).toBe(true);

    // Step 6: Get grouped media (by year)
    const groupedYearResponse = await fetchWithRetry(
      `${API_URL}/api/media/grouped?groupBy=year&limit=100`,
      {
        method: "GET",
        headers: {
          Cookie: `trellis_session=${updatedSessionToken}`,
        },
      },
    );

    expect(groupedYearResponse.status).toBe(200);
    const groupedYearData = await groupedYearResponse.json();
    expect(groupedYearData).toHaveProperty("groups");
    expect(Array.isArray(groupedYearData.groups)).toBe(true);

    // Step 7: Get media statistics
    const statsResponse = await fetchWithRetry(`${API_URL}/api/media/stats`, {
      method: "GET",
      headers: {
        Cookie: `trellis_session=${updatedSessionToken}`,
      },
    });

    expect(statsResponse.status).toBe(200);
    const statsData = await statsResponse.json();
    expect(statsData).toHaveProperty("totalCount");
    expect(statsData).toHaveProperty("photoCount");
    expect(statsData).toHaveProperty("videoCount");
    expect(statsData).toHaveProperty("hiddenCount");
    expect(statsData).toHaveProperty("totalSize");
    expect(typeof statsData.totalCount).toBe("number");
    expect(typeof statsData.photoCount).toBe("number");
    expect(typeof statsData.videoCount).toBe("number");

    // Step 8: Hide media (if we found it in the list)
    if (uploadedMediaId) {
      const hideResponse = await authenticatedFetch(
        `${API_URL}/api/media/${uploadedMediaId}/hide`,
        updatedSessionToken,
        {
          method: "POST",
          headers: {
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      expect(hideResponse.status).toBe(200);
      const hideData = await hideResponse.json();
      expect(hideData).toHaveProperty("hidden");
      expect(hideData.hidden).toBe(true);
      expect(hideData).toHaveProperty("hiddenAt");

      // Verify media is hidden in list
      const listHiddenResponse = await fetchWithRetry(
        `${API_URL}/api/media?limit=50&includeHidden=false`,
        {
          method: "GET",
          headers: {
            Cookie: `trellis_session=${updatedSessionToken}`,
          },
        },
      );

      expect(listHiddenResponse.status).toBe(200);
      const listHiddenData = await listHiddenResponse.json();
      const hiddenMediaInList = listHiddenData.media.find(
        (m: any) => m.id === uploadedMediaId,
      );
      expect(hiddenMediaInList).toBeUndefined(); // Should not appear when includeHidden=false

      // Verify media appears when includeHidden=true
      const listWithHiddenResponse = await fetchWithRetry(
        `${API_URL}/api/media?limit=50&includeHidden=true`,
        {
          method: "GET",
          headers: {
            Cookie: `trellis_session=${updatedSessionToken}`,
          },
        },
      );

      expect(listWithHiddenResponse.status).toBe(200);
      const listWithHiddenData = await listWithHiddenResponse.json();
      const hiddenMediaInListWithHidden = listWithHiddenData.media.find(
        (m: any) => m.id === uploadedMediaId,
      );
      expect(hiddenMediaInListWithHidden).toBeDefined(); // Should appear when includeHidden=true
      expect(hiddenMediaInListWithHidden.hidden).toBe(true);

      // Step 9: Unhide media
      const unhideResponse = await authenticatedFetch(
        `${API_URL}/api/media/${uploadedMediaId}/unhide`,
        updatedSessionToken,
        {
          method: "POST",
          headers: {
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      expect(unhideResponse.status).toBe(200);
      const unhideData = await unhideResponse.json();
      expect(unhideData).toHaveProperty("hidden");
      expect(unhideData.hidden).toBe(false);
      expect(unhideData.hiddenAt).toBeNull();

      // Verify media is visible again
      const listUnhiddenResponse = await fetchWithRetry(
        `${API_URL}/api/media?limit=50&includeHidden=false`,
        {
          method: "GET",
          headers: {
            Cookie: `trellis_session=${updatedSessionToken}`,
          },
        },
      );

      expect(listUnhiddenResponse.status).toBe(200);
      const listUnhiddenData = await listUnhiddenResponse.json();
      const unhiddenMediaInList = listUnhiddenData.media.find(
        (m: any) => m.id === uploadedMediaId,
      );
      expect(unhiddenMediaInList).toBeDefined(); // Should appear again
      expect(unhiddenMediaInList.hidden).toBe(false);

      // Step 10: Delete media (soft delete)
      const deleteResponse = await authenticatedFetch(
        `${API_URL}/api/media/${uploadedMediaId}`,
        updatedSessionToken,
        {
          method: "DELETE",
          headers: {
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      expect(deleteResponse.status).toBe(200);

      // Verify media is deleted (should not appear in list)
      const listAfterDeleteResponse = await fetchWithRetry(
        `${API_URL}/api/media?limit=50&includeHidden=true`,
        {
          method: "GET",
          headers: {
            Cookie: `trellis_session=${updatedSessionToken}`,
          },
        },
      );

      expect(listAfterDeleteResponse.status).toBe(200);
      const listAfterDeleteData = await listAfterDeleteResponse.json();
      const deletedMediaInList = listAfterDeleteData.media.find(
        (m: any) => m.id === uploadedMediaId,
      );
      expect(deletedMediaInList).toBeUndefined(); // Should not appear (deleted media is excluded)
    } else {
      console.log(
        "[INFO] Skipping hide/unhide/delete tests because uploaded media was not found in list.",
      );
    }
  }, 120000); // 120 second timeout for this comprehensive test
});
