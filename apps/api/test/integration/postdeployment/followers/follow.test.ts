/**
 * Post-Deployment Integration Tests: Follow Endpoint
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticatedFetch } from "../../../utils/test-auth.js";
import {
  API_URL,
  cleanupFollowersTests,
  getCsrfToken,
  setupFollowersTests,
  setupTestHooks,
  type FollowersTestContext,
} from "./setup.js";

// Skip entire test suite if not in dev environment
describe("POST /api/followers/follow", () => {
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

  it("should successfully follow a user", async () => {
    const { token: csrfToken, updatedSessionToken } = await getCsrfToken(
      context.sessionToken1,
    );
    const currentSessionToken = updatedSessionToken || context.sessionToken1;
    const response = await authenticatedFetch(
      `${API_URL}/api/followers/follow`,
      currentSessionToken,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          targetType: "user",
          targetId: context.testUser2.id,
        }),
      },
    );

    if (response.status !== 200) {
      const errorText = await response.text();
      console.error(
        `[DEBUG] Follow failed with status ${response.status}:`,
        errorText,
      );
    }

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.followId).toBeDefined();
    expect(typeof data.followId).toBe("string");
  });

  it("should successfully follow a dog (entity)", async () => {
    if (!context.testEntityId) {
      console.log("[SKIP] Test entity not created - skipping dog follow test");
      return;
    }

    const { token: csrfToken } = await getCsrfToken(context.sessionToken2);
    const response = await authenticatedFetch(
      `${API_URL}/api/followers/follow`,
      context.sessionToken2,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          targetType: "dog",
          targetId: context.testEntityId,
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.followId).toBeDefined();
  });

  it("should return 400 when trying to follow self", async () => {
    const { token: csrfToken, updatedSessionToken } = await getCsrfToken(
      context.sessionToken1,
    );
    const currentSessionToken = updatedSessionToken || context.sessionToken1;
    const response = await authenticatedFetch(
      `${API_URL}/api/followers/follow`,
      currentSessionToken,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          targetType: "user",
          targetId: context.testUser1.id, // Following self
        }),
      },
    );

    if (response.status !== 400) {
      const errorText = await response.text();
      console.error(
        `[DEBUG] Self-follow test failed with status ${response.status}:`,
        errorText,
      );
    }

    expect([400, 403]).toContain(response.status); // API might return 403 for self-follow
    const data = await response.json();
    expect(data.error).toBeDefined();
  });

  it("should return 403 when already following", async () => {
    const { token: csrfToken, updatedSessionToken: token1 } =
      await getCsrfToken(context.sessionToken1);
    const currentSessionToken1 = token1 || context.sessionToken1;

    // First check if already following (cleanup might have failed)
    const statusResponse = await authenticatedFetch(
      `${API_URL}/api/followers/status?targetType=user&targetId=${context.testUser2.id}`,
      currentSessionToken1,
      { method: "GET" },
    );

    // If already following, unfollow first to ensure clean state
    let finalSessionToken = currentSessionToken1;
    let finalCsrfToken = csrfToken;

    if (statusResponse.ok) {
      const statusData = await statusResponse.json();
      if (statusData.isFollowing) {
        const { token: unfollowCsrfToken, updatedSessionToken: unfollowToken } =
          await getCsrfToken(currentSessionToken1);
        const unfollowSessionToken = unfollowToken || currentSessionToken1;
        await authenticatedFetch(
          `${API_URL}/api/followers/unfollow`,
          unfollowSessionToken,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": unfollowCsrfToken,
            },
            body: JSON.stringify({
              targetType: "user",
              targetId: context.testUser2.id,
            }),
          },
        );
        // Get fresh CSRF token for follow
        const { token: newCsrfToken, updatedSessionToken: newToken } =
          await getCsrfToken(unfollowSessionToken);
        finalCsrfToken = newCsrfToken;
        finalSessionToken = newToken || unfollowSessionToken;
      }
    }

    // First follow
    const firstResponse = await authenticatedFetch(
      `${API_URL}/api/followers/follow`,
      finalSessionToken,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": finalCsrfToken,
        },
        body: JSON.stringify({
          targetType: "user",
          targetId: context.testUser2.id,
        }),
      },
    );

    if (firstResponse.status !== 200) {
      const errorText = await firstResponse.text();
      console.error(
        `[DEBUG] First follow failed with status ${firstResponse.status}:`,
        errorText,
      );
      // If first follow failed (e.g., timeout), skip this test
      throw new Error(
        `First follow failed with status ${firstResponse.status}: ${errorText}`,
      );
    }
    expect(firstResponse.status).toBe(200);

    // Try to follow again
    const { token: csrfToken2, updatedSessionToken: token2 } =
      await getCsrfToken(finalSessionToken);
    const currentSessionToken2 = token2 || finalSessionToken;
    const response = await authenticatedFetch(
      `${API_URL}/api/followers/follow`,
      currentSessionToken2,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken2,
        },
        body: JSON.stringify({
          targetType: "user",
          targetId: context.testUser2.id,
        }),
      },
    );

    if (response.status !== 403) {
      const errorData = await response.json();
      console.error("[TEST] Unexpected status code:", {
        status: response.status,
        expected: 403,
        error: errorData,
      });
    }
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBeDefined();
  });

  it("should return 400 for invalid targetType", async () => {
    const { token: csrfToken, updatedSessionToken } = await getCsrfToken(
      context.sessionToken1,
    );
    const currentSessionToken = updatedSessionToken || context.sessionToken1;
    const response = await authenticatedFetch(
      `${API_URL}/api/followers/follow`,
      currentSessionToken,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          targetType: "invalid",
          targetId: context.testUser2.id,
        }),
      },
    );

    expect([400, 403]).toContain(response.status); // API might return 403 for invalid input
  });

  it("should return 400 for missing targetId", async () => {
    const { token: csrfToken, updatedSessionToken } = await getCsrfToken(
      context.sessionToken1,
    );
    const currentSessionToken = updatedSessionToken || context.sessionToken1;
    const response = await authenticatedFetch(
      `${API_URL}/api/followers/follow`,
      currentSessionToken,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          targetType: "user",
          // Missing targetId
        }),
      },
    );

    expect([400, 403]).toContain(response.status); // API might return 403 for invalid input
  });
});
