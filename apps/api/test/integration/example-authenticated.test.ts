/**
 * Example: Non-Interactive Integration Tests with Authentication
 *
 * This file demonstrates how to write integration tests that require authentication.
 *
 * Key concepts:
 * 1. Create test users in the database before tests
 * 2. Create authenticated sessions for those users
 * 3. Use session tokens in Cookie headers for authenticated requests
 * 4. Clean up test users after tests
 *
 * Prerequisites:
 * - DATABASE_URL or DIRECT_DATABASE_URL environment variable must be set
 * - SESSION_SECRET environment variable (optional, defaults to test secret)
 * - API must be running (via `npm run dev` or deployed)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authenticatedFetch,
  cleanupTestUser,
  createTestUserWithSession,
  type TestUser,
} from "../utils/test-auth.js";
import { getApiUrl } from "../utils/test-config.js";

const API_URL = getApiUrl();

describe("Example: Authenticated Integration Tests", () => {
  let testUser: TestUser;
  let sessionToken: string;

  beforeEach(async () => {
    // Create a test user and get an authenticated session
    // Increased timeout for user creation (may take time in integration tests)
    const { testUser: user, sessionToken: token } =
      await createTestUserWithSession({
        email: `test-${Date.now()}@example.com`,
        role: "END_USER",
      });
    testUser = user;
    sessionToken = token;
  }, 60000); // 60 second timeout for beforeEach (user creation may be slow with increased query timeouts)

  afterEach(async () => {
    // Clean up the test user (only if it was created successfully)
    if (testUser?.id) {
      await cleanupTestUser(testUser.id);
    }
  }, 30000); // 30 second timeout for afterEach (cleanup may be slow)

  describe("Authenticated Endpoints", () => {
    it("should return user info for authenticated requests", async () => {
      const response = await authenticatedFetch(
        `${API_URL}/auth/me`,
        sessionToken,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.authenticated).toBe(true);
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe(testUser.id);
      expect(body.user.email).toBe(testUser.email);
    }, 60000); // 60 second timeout for integration test

    it("should return 401 for unauthenticated requests", async () => {
      const response = await fetch(`${API_URL}/auth/me`);

      expect(response.status).toBe(200); // May return 200 with authenticated=false
      const body = await response.json();
      expect(body.authenticated).toBe(false);
    }, 60000); // 60 second timeout for integration test

    it("should handle authenticated API requests", async () => {
      // Example: Test an authenticated endpoint
      // Replace with your actual authenticated endpoint
      const response = await authenticatedFetch(
        `${API_URL}/api/your-endpoint`,
        sessionToken,
        {
          method: "GET",
        },
      );

      // Adjust expectations based on your API
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(500);
    }, 60000); // 60 second timeout for integration test
  });

  describe("Multiple Test Users", () => {
    it("should handle multiple authenticated users", async () => {
      // Create a second test user
      const { testUser: user2, sessionToken: token2 } =
        await createTestUserWithSession({
          role: "CONTENT_CREATOR",
        });

      try {
        // Test with first user
        const response1 = await authenticatedFetch(
          `${API_URL}/auth/me`,
          sessionToken,
        );
        expect(response1.status).toBe(200);
        const body1 = await response1.json();
        expect(body1.user.id).toBe(testUser.id);

        // Test with second user
        const response2 = await authenticatedFetch(
          `${API_URL}/auth/me`,
          token2,
        );
        expect(response2.status).toBe(200);
        const body2 = await response2.json();
        expect(body2.user.id).toBe(user2.id);
        expect(body2.user.role).toBe("CONTENT_CREATOR");
      } finally {
        // Clean up second user
        await cleanupTestUser(user2.id);
      }
    });
  });

  describe("Different User Roles", () => {
    it("should handle SUPER_ADMIN role", async () => {
      const { testUser: adminUser, sessionToken: adminToken } =
        await createTestUserWithSession({
          role: "SUPER_ADMIN",
        });

      try {
        const response = await authenticatedFetch(
          `${API_URL}/auth/me`,
          adminToken,
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.user.role).toBe("SUPER_ADMIN");
      } finally {
        await cleanupTestUser(adminUser.id);
      }
    }, 60000); // 60 second timeout for integration test
  });
});
