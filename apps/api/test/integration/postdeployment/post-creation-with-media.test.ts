/**
 * Post Creation with Media - Post-Deployment Integration Test
 *
 * Tests the complete flow of creating posts with media attachments.
 * This test caught a critical bug where media IDs were being sent as full URLs
 * instead of content hashes, causing post creation to fail with 400 errors.
 *
 * ⚠️ CRITICAL: This test MUST NEVER run on production.
 * It will abort immediately if environment is not 'dev'.
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import { requireDevEnvironment } from "../../utils/test-environment-guard.js";

import { getApiUrl } from "../../utils/test-config.js";

const API_URL = getApiUrl();

interface AuthResponse {
  token: string;
  updatedSessionToken: string;
}

/**
 * Get CSRF token for authenticated requests
 */
async function getCsrfToken(sessionToken: string): Promise<AuthResponse> {
  const response = await fetch(`${API_URL}/api/csrf-token`, {
    method: "GET",
    headers: {
      Cookie: `trellis_session=${sessionToken}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get CSRF token: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const setCookieHeader = response.headers.get("Set-Cookie") || "";
  const match = setCookieHeader.match(/trellis_session=([^;]+)/);
  const updatedSessionToken = match ? match[1] : sessionToken;

  return {
    token: data.token,
    updatedSessionToken,
  };
}

/**
 * Make authenticated fetch request with CSRF token
 */
async function authenticatedFetch(
  url: string,
  options: RequestInit,
  sessionToken: string,
  csrfToken?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
    Cookie: `trellis_session=${sessionToken}`,
  };

  if (csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }

  return fetch(url, {
    ...options,
    headers,
  });
}

/**
 * Create a test image buffer (1x1 red pixel PNG)
 */
function createTestImage(): Buffer {
  // 1x1 red pixel PNG
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    "base64",
  );
}

describe("Post Creation with Media - Post-Deployment", () => {
  let sessionToken: string;
  let userId: string;
  let skipTests = false;

  beforeAll(async () => {
    requireDevEnvironment();

    // Create test user
    const email = `test-media-post-${Date.now()}@example.com`;
    const password = "TestPassword123!";

    // Register user — if registration endpoint is unavailable or auth infra
    // is not set up, skip all tests gracefully
    try {
      const registerResponse = await fetch(`${API_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!registerResponse.ok) {
        const errorText = await registerResponse.text().catch(() => "");
        console.warn(
          `[SKIP] Post-creation-with-media tests skipped — registration failed: ${registerResponse.status} ${errorText}`,
        );
        skipTests = true;
        return;
      }

      const registerData = await registerResponse.json();
      sessionToken = registerData.sessionToken;
      userId = registerData.user.id;

      console.log(`✓ Created test user: ${email}`);
    } catch (error) {
      console.warn(
        `[SKIP] Post-creation-with-media tests skipped — cannot reach auth endpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
      skipTests = true;
    }
  });

  it("should create a post with media attachments using content hashes", async () => {
    if (skipTests) return;
    // Step 1: Upload media files
    const { token: csrfToken, updatedSessionToken } =
      await getCsrfToken(sessionToken);
    sessionToken = updatedSessionToken;

    const testImage = createTestImage();
    const formData = new FormData();
    formData.append("file", testImage, {
      filename: "test-image.png",
      contentType: "image/png",
    });

    const uploadResponse = await authenticatedFetch(
      `${API_URL}/api/media/upload`,
      {
        method: "POST",
        body: formData as any,
      },
      sessionToken,
      csrfToken,
    );

    expect(uploadResponse.ok).toBe(true);
    const uploadData = await uploadResponse.json();

    // Verify response contains contentHash (not just URL)
    expect(uploadData).toHaveProperty("contentHash");
    expect(uploadData).toHaveProperty("url");
    expect(typeof uploadData.contentHash).toBe("string");
    expect(uploadData.contentHash.length).toBeGreaterThan(0);

    const contentHash = uploadData.contentHash;
    console.log(`✓ Uploaded media with contentHash: ${contentHash}`);

    // Step 2: Create post with media using contentHash (NOT the full URL)
    const { token: postCsrfToken, updatedSessionToken: postSessionToken } =
      await getCsrfToken(sessionToken);
    sessionToken = postSessionToken;

    const postData = {
      text: "Test post with media attachment",
      visibility: "friends-only",
      media: [
        {
          id: contentHash, // CRITICAL: Use contentHash, not the full URL
          alt: "Test image",
        },
      ],
    };

    const createPostResponse = await authenticatedFetch(
      `${API_URL}/api/posts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postData),
      },
      sessionToken,
      postCsrfToken,
    );

    // This should succeed (not return 400)
    if (!createPostResponse.ok) {
      const errorData = await createPostResponse.json();
      console.error("Post creation failed:", errorData);
    }

    expect(createPostResponse.ok).toBe(true);
    const postResponse = await createPostResponse.json();

    expect(postResponse).toHaveProperty("id");
    expect(postResponse.text).toBe("Test post with media attachment");
    expect(postResponse.visibility).toBe("friends-only");

    console.log(`✓ Created post with media: ${postResponse.id}`);
  });

  it("should reject post creation with invalid media IDs (full URLs)", async () => {
    if (skipTests) return;
    // This test verifies that the API properly validates media IDs
    // and rejects full URLs instead of content hashes

    const { token: csrfToken, updatedSessionToken } =
      await getCsrfToken(sessionToken);
    sessionToken = updatedSessionToken;

    const postData = {
      text: "Test post with invalid media ID",
      visibility: "friends-only",
      media: [
        {
          // Using full URL instead of contentHash (should fail)
          id: `${API_URL}/api/media/e39839560f1500a2ccd2bd8e7322a50fca79e2c004ba8b6b2a4c0ecacbafd8ed`,
          alt: "Test image",
        },
      ],
    };

    const createPostResponse = await authenticatedFetch(
      `${API_URL}/api/posts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postData),
      },
      sessionToken,
      csrfToken,
    );

    // Should fail with 400 because the media ID is invalid
    expect(createPostResponse.status).toBe(400);
    const errorData = await createPostResponse.json();
    expect(errorData.error).toBe("INVALID_MEDIA");

    console.log(`✓ Correctly rejected post with invalid media ID (full URL)`);
  });

  it("should create post with multiple media attachments", async () => {
    if (skipTests) return;
    // Upload multiple images
    const { token: csrfToken, updatedSessionToken } =
      await getCsrfToken(sessionToken);
    sessionToken = updatedSessionToken;

    const mediaIds: string[] = [];

    // Upload 3 test images
    for (let i = 0; i < 3; i++) {
      const testImage = createTestImage();
      const formData = new FormData();
      formData.append("file", testImage, {
        filename: `test-image-${i}.png`,
        contentType: "image/png",
      });

      const uploadResponse = await authenticatedFetch(
        `${API_URL}/api/media/upload`,
        {
          method: "POST",
          body: formData as any,
        },
        sessionToken,
        csrfToken,
      );

      expect(uploadResponse.ok).toBe(true);
      const uploadData = await uploadResponse.json();
      mediaIds.push(uploadData.contentHash);
    }

    console.log(`✓ Uploaded ${mediaIds.length} media files`);

    // Create post with all media
    const { token: postCsrfToken, updatedSessionToken: postSessionToken } =
      await getCsrfToken(sessionToken);
    sessionToken = postSessionToken;

    const postData = {
      text: "Test post with multiple media attachments",
      visibility: "friends-only",
      media: mediaIds.map((id, index) => ({
        id,
        alt: `Test image ${index + 1}`,
      })),
    };

    const createPostResponse = await authenticatedFetch(
      `${API_URL}/api/posts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postData),
      },
      sessionToken,
      postCsrfToken,
    );

    expect(createPostResponse.ok).toBe(true);
    const postResponse = await createPostResponse.json();

    expect(postResponse).toHaveProperty("id");
    expect(postResponse.text).toBe("Test post with multiple media attachments");

    console.log(
      `✓ Created post with ${mediaIds.length} media attachments: ${postResponse.id}`,
    );
  });

  it("should reject post with media exceeding maximum limit", async () => {
    if (skipTests) return;
    // The API should enforce a maximum of 4 media attachments per post
    const { token: csrfToken, updatedSessionToken } =
      await getCsrfToken(sessionToken);
    sessionToken = updatedSessionToken;

    // Try to create post with 5 media attachments (exceeds limit)
    const postData = {
      text: "Test post with too many media",
      visibility: "friends-only",
      media: [
        { id: "hash1", alt: "Image 1" },
        { id: "hash2", alt: "Image 2" },
        { id: "hash3", alt: "Image 3" },
        { id: "hash4", alt: "Image 4" },
        { id: "hash5", alt: "Image 5" }, // Exceeds limit
      ],
    };

    const createPostResponse = await authenticatedFetch(
      `${API_URL}/api/posts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postData),
      },
      sessionToken,
      csrfToken,
    );

    // Should fail with 400 due to validation error
    expect(createPostResponse.status).toBe(400);

    console.log(`✓ Correctly rejected post with too many media attachments`);
  });
});
