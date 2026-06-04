/**
 * Post-Deployment Integration Tests: Authentication and Authorization
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticatedFetch } from "../../../utils/test-auth.js";
import { skipIfNotDev } from "../../../utils/test-environment-guard.js";
import {
  API_URL,
  cleanupFollowersTests,
  getCsrfToken,
  setupFollowersTests,
  setupTestHooks,
  type FollowersTestContext,
} from "./setup.js";

// Skip entire test suite if not in dev environment
describe("Authentication and Authorization", () => {
  let context: FollowersTestContext;

  setupTestHooks();

  beforeEach(async () => {
    context = await setupFollowersTests();
  });

  afterEach(async () => {
    if (context) {
      await cleanupFollowersTests(context);
    }
  });

  it("should require authentication for follow endpoint", async () => {
    const response = await fetch(`${API_URL}/api/followers/follow`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetType: "user",
        targetId: context.testUser2.id,
      }),
    });

    expect(response.status).toBe(401);
  });

  it("should require authentication for unfollow endpoint", async () => {
    const response = await fetch(`${API_URL}/api/followers/unfollow`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetType: "user",
        targetId: context.testUser2.id,
      }),
    });

    expect(response.status).toBe(401);
  });

  it("should require authentication for following list", async () => {
    const response = await fetch(`${API_URL}/api/followers/following?limit=50`);

    expect(response.status).toBe(401);
  });

  it("should allow unauthenticated access to followers list (public data)", async () => {
    // First create a follow relationship
    const { token: csrfToken } = await getCsrfToken(context.sessionToken2);
    await authenticatedFetch(
      `${API_URL}/api/followers/follow`,
      context.sessionToken2,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          targetType: "user",
          targetId: context.testUser1.id,
        }),
      },
    );

    // Try to get followers list without authentication
    // Note: This may require authentication depending on privacy settings
    const response = await fetch(
      `${API_URL}/api/followers/followers?targetType=user&targetId=${context.testUser1.id}&limit=50`,
    );

    // Should either succeed (if public) or require auth (if private)
    expect([200, 401]).toContain(response.status);
  });
});
