/**
 * Shared setup and utilities for followers integration tests
 */

import { afterAll, beforeAll } from "vitest";
import {
  authenticatedFetch,
  cleanupTestUser,
  createTestUserWithSession,
  type TestUser,
} from "../../../utils/test-auth.js";
import { getApiUrl } from "../../../utils/test-config.js";
import { requireDevEnvironment } from "../../../utils/test-environment-guard.js";

export const API_URL = getApiUrl();

export interface FollowersTestContext {
  testUser1: TestUser;
  testUser2: TestUser;
  testUser3: TestUser;
  sessionToken1: string;
  sessionToken2: string;
  sessionToken3: string;
  testEntityId: string;
}

/**
 * Cached test users - created once per test suite and reused across tests
 * This reduces user creation overhead significantly
 */
let cachedTestUsers: {
  user1?: { testUser: TestUser; sessionToken: string };
  user2?: { testUser: TestUser; sessionToken: string };
  user3?: { testUser: TestUser; sessionToken: string };
  testEntityId?: string;
} | null = null;

/**
 * Get CSRF token for authenticated requests
 */
export async function getCsrfToken(sessionToken: string): Promise<{
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

/**
 * Setup function for followers tests
 * Creates test users and entity once per test suite (cached), returns context
 *
 * OPTIMIZATION: Test users are cached and reused across tests in the same suite
 * This significantly reduces user creation overhead (from ~3-5s per test to ~0s after first creation)
 */
export async function setupFollowersTests(): Promise<FollowersTestContext> {
  // Return cached users if they already exist
  if (cachedTestUsers) {
    return {
      testUser1: cachedTestUsers.user1!.testUser,
      testUser2: cachedTestUsers.user2!.testUser,
      testUser3: cachedTestUsers.user3!.testUser,
      sessionToken1: cachedTestUsers.user1!.sessionToken,
      sessionToken2: cachedTestUsers.user2!.sessionToken,
      sessionToken3: cachedTestUsers.user3!.sessionToken,
      testEntityId: cachedTestUsers.testEntityId || "",
    };
  }

  // Create test users for authenticated requests (only once per test suite)
  // IMPORTANT: Set region and dataRegion to match the API's detected region
  // The API detects EU region (from Cloudflare headers), so we create users in EU
  // This prevents "CROSS_REGION_DATA_ACCESS_BLOCKED" errors
  // Use crypto.randomUUID() for better uniqueness in parallel test runs
  const uniqueId = crypto.randomUUID();
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);

  // Create users sequentially with small delays to avoid overwhelming database connection pool
  // With maxThreads: 3 (reduced from 5), fewer parallel test files reduce connection pool pressure
  // Sequential creation prevents connection pool exhaustion and timeouts
  // OPTIMIZATION: With test user caching, this only runs once per test suite
  // Add retry logic for user creation in case of transient failures
  let user1, user2, user3;
  let retries = 0;
  const maxRetries = 3;

  while (retries < maxRetries) {
    try {
      user1 = await createTestUserWithSession({
        email: `test-followers-1-${timestamp}-${randomSuffix}-${uniqueId.substring(0, 8)}@test.example.com`,
        role: "END_USER",
        region: "EU",
        dataRegion: "EU",
      });
      break;
    } catch (error: any) {
      retries++;
      if (retries >= maxRetries) throw error;
      console.warn(
        `[Setup] User1 creation failed, retrying (${retries}/${maxRetries}):`,
        error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000 * retries)); // Exponential backoff
    }
  }

  retries = 0;
  while (retries < maxRetries) {
    try {
      user2 = await createTestUserWithSession({
        email: `test-followers-2-${timestamp}-${randomSuffix}-${uniqueId.substring(8, 16)}@test.example.com`,
        role: "END_USER",
        region: "EU",
        dataRegion: "EU",
      });
      break;
    } catch (error: any) {
      retries++;
      if (retries >= maxRetries) throw error;
      console.warn(
        `[Setup] User2 creation failed, retrying (${retries}/${maxRetries}):`,
        error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
    }
  }

  retries = 0;
  while (retries < maxRetries) {
    try {
      user3 = await createTestUserWithSession({
        email: `test-followers-3-${timestamp}-${randomSuffix}-${uniqueId.substring(16, 24)}@test.example.com`,
        role: "END_USER",
        region: "EU",
        dataRegion: "EU",
      });
      break;
    } catch (error: any) {
      retries++;
      if (retries >= maxRetries) throw error;
      console.warn(
        `[Setup] User3 creation failed, retrying (${retries}/${maxRetries}):`,
        error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
    }
  }

  // Create a test entity (dog) for user1
  const { token: csrfToken } = await getCsrfToken(user1.sessionToken);
  const entityResponse = await authenticatedFetch(
    `${API_URL}/api/entities`,
    user1.sessionToken,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({
        name: `Test Dog ${Date.now()}`,
        metadata: { breed: "Test Breed" },
      }),
    },
  );

  let testEntityId = "";
  if (entityResponse.ok) {
    const entityBody = await entityResponse.json();
    testEntityId = entityBody.id;
  }

  // Cache the test users for reuse across tests
  cachedTestUsers = {
    user1,
    user2,
    user3,
    testEntityId,
  };

  return {
    testUser1: user1.testUser,
    testUser2: user2.testUser,
    testUser3: user3.testUser,
    sessionToken1: user1.sessionToken,
    sessionToken2: user2.sessionToken,
    sessionToken3: user3.sessionToken,
    testEntityId,
  };
}

/**
 * Cleanup test user with timeout to prevent hanging
 * Defined before cleanupFollowersTests to ensure it's available
 *
 * Note: cleanupTestUser already has a 10-second timeout, so we use 12 seconds
 * to allow the API call to complete or timeout gracefully
 */
async function cleanupTestUserWithTimeout(
  userId: string,
  timeoutMs: number,
): Promise<void> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Cleanup timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([cleanupTestUser(userId), timeoutPromise]);
  } catch (error) {
    // Log but don't throw - cleanup failures shouldn't fail tests
    // The error is already logged by cleanupTestUser if it's a timeout
    if (!(error instanceof Error && error.message.includes("timed out"))) {
      console.error(`[Cleanup] Error cleaning up user ${userId}:`, error);
    }
  }
}

/**
 * Cleanup function for followers tests
 * OPTIMIZATION: With cached test users, we only clean up follow relationships between tests
 * Test users are cleaned up once in cleanupCachedTestUsers() after all tests complete
 *
 * This function now only cleans up follow relationships to ensure test isolation
 * without the overhead of deleting/recreating users for each test
 */
export async function cleanupFollowersTests(
  context: FollowersTestContext | undefined,
): Promise<void> {
  // Guard against undefined context (can happen if setup fails)
  if (!context) {
    console.warn("[Cleanup] Context is undefined, skipping cleanup");
    return;
  }

  // OPTIMIZATION: With cached users, we don't delete users between tests
  // Instead, we clean up follow relationships to ensure test isolation
  // This is much faster than deleting/recreating users (saves ~3-5s per test)

  // Clean up all follows for test users to ensure test isolation
  // This prevents test interference while keeping cached users
  const cleanupPromises: Promise<void>[] = [];

  // Clean up follows for user1
  if (context.sessionToken1) {
    cleanupPromises.push(
      cleanupUserFollows(
        context.sessionToken1,
        "user",
        context.testUser2.id,
      ).catch(
        () => {}, // Ignore errors - follows might not exist
      ),
    );
    cleanupPromises.push(
      cleanupUserFollows(
        context.sessionToken1,
        "user",
        context.testUser3.id,
      ).catch(() => {}),
    );
  }

  // Clean up follows for user2
  if (context.sessionToken2) {
    cleanupPromises.push(
      cleanupUserFollows(
        context.sessionToken2,
        "user",
        context.testUser1.id,
      ).catch(() => {}),
    );
    cleanupPromises.push(
      cleanupUserFollows(
        context.sessionToken2,
        "user",
        context.testUser3.id,
      ).catch(() => {}),
    );
  }

  // Clean up follows for user3
  if (context.sessionToken3) {
    cleanupPromises.push(
      cleanupUserFollows(
        context.sessionToken3,
        "user",
        context.testUser1.id,
      ).catch(() => {}),
    );
    cleanupPromises.push(
      cleanupUserFollows(
        context.sessionToken3,
        "user",
        context.testUser2.id,
      ).catch(() => {}),
    );
  }

  // Wait for all cleanup operations to complete (don't fail if some fail)
  await Promise.allSettled(cleanupPromises);
}

/**
 * Clean up a specific follow relationship
 * Used to ensure test isolation without deleting cached test users
 */
async function cleanupUserFollows(
  sessionToken: string,
  targetType: "user" | "dog",
  targetId: string,
): Promise<void> {
  try {
    // Get CSRF token and use updated session token if provided
    const { token: csrfToken, updatedSessionToken } =
      await getCsrfToken(sessionToken);
    const currentSessionToken = updatedSessionToken || sessionToken;

    const response = await authenticatedFetch(
      `${API_URL}/api/followers/unfollow`,
      currentSessionToken,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          targetType,
          targetId,
        }),
      },
    );
    // Don't throw on 404 - follow might not exist
    // Also don't throw on 403 - might be CSRF token issue or already unfollowed
    if (!response.ok && response.status !== 404 && response.status !== 403) {
      const errorText = await response.text();
      console.warn(
        `[Cleanup] Failed to unfollow ${targetType} ${targetId}: ${response.status} ${errorText}`,
      );
    }
  } catch (error) {
    // Ignore errors - this is cleanup, not critical
    // Log at debug level to avoid cluttering test output
    if (process.env.DEBUG) {
      console.warn(`[Cleanup] Error cleaning up follow:`, error);
    }
  }
}

/**
 * Clean up cached test users (called once after all tests complete)
 * This should be called in afterAll hook in test files
 */
export async function cleanupCachedTestUsers(): Promise<void> {
  if (!cachedTestUsers) {
    return;
  }

  // Clean up test users and follows in parallel with timeouts
  // Note: Follows will be cascade deleted when users are deleted
  // Use 12 seconds to allow cleanupTestUser's 10-second API timeout to complete
  const CLEANUP_TIMEOUT_MS = 12000;
  const cleanupPromises: Promise<void>[] = [];

  if (cachedTestUsers.user1?.testUser.id) {
    cleanupPromises.push(
      cleanupTestUserWithTimeout(
        cachedTestUsers.user1.testUser.id,
        CLEANUP_TIMEOUT_MS,
      ),
    );
  }
  if (cachedTestUsers.user2?.testUser.id) {
    cleanupPromises.push(
      cleanupTestUserWithTimeout(
        cachedTestUsers.user2.testUser.id,
        CLEANUP_TIMEOUT_MS,
      ),
    );
  }
  if (cachedTestUsers.user3?.testUser.id) {
    cleanupPromises.push(
      cleanupTestUserWithTimeout(
        cachedTestUsers.user3.testUser.id,
        CLEANUP_TIMEOUT_MS,
      ),
    );
  }

  if (cleanupPromises.length === 0) {
    cachedTestUsers = null;
    return;
  }

  // Use allSettled to ensure all cleanup attempts complete, even if some fail
  const results = await Promise.allSettled(cleanupPromises);

  // Log any failures but don't throw (cleanup failures shouldn't fail tests)
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const userIds = [
        cachedTestUsers?.user1?.testUser.id,
        cachedTestUsers?.user2?.testUser.id,
        cachedTestUsers?.user3?.testUser.id,
      ].filter(Boolean);
      const userId = userIds[index];
      console.error(
        `[Cleanup] Failed to cleanup cached test user ${userId}:`,
        result.reason,
      );
    }
  });

  // Clear cache after cleanup
  cachedTestUsers = null;
}

/**
 * Wait for follow relationship to be visible (handles eventual consistency)
 * Retries checking the status endpoint until the follow is visible or timeout
 */
export async function waitForFollowStatus(
  sessionToken: string,
  targetType: "user" | "dog",
  targetId: string,
  expectedStatus: boolean = true,
  maxRetries: number = 5,
  delayMs: number = 200,
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    const response = await authenticatedFetch(
      `${API_URL}/api/followers/status?targetType=${targetType}&targetId=${targetId}`,
      sessionToken,
      {
        method: "GET",
      },
    );

    if (response.status === 200) {
      const data = await response.json();
      if (data.isFollowing === expectedStatus) {
        return true;
      }
    }

    // Wait before retrying (exponential backoff)
    if (i < maxRetries - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
    }
  }

  return false;
}

/**
 * Shared test setup hooks
 * OPTIMIZATION: Sets up cached test users and ensures cleanup after all tests
 */
export function setupTestHooks() {
  // Additional safety check in beforeAll (defense in depth)
  beforeAll(async () => {
    requireDevEnvironment();
  });

  // Clean up cached test users after all tests complete
  // This ensures cached users are cleaned up once per test suite
  afterAll(async () => {
    await cleanupCachedTestUsers();
  });
}
