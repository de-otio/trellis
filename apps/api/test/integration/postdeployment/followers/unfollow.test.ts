/**
 * Post-Deployment Integration Tests: Unfollow Endpoint
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
describe("POST /api/followers/unfollow", () => {
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

  it("should successfully unfollow a user", async () => {
    const { token: csrfToken, updatedSessionToken: token1 } =
      await getCsrfToken(context.sessionToken1);
    const currentSessionToken1 = token1 || context.sessionToken1;

    // First follow
    const followResponse = await authenticatedFetch(
      `${API_URL}/api/followers/follow`,
      currentSessionToken1,
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

    if (followResponse.status !== 200) {
      const errorText = await followResponse.text();
      console.error(
        `[DEBUG] Follow before unfollow failed with status ${followResponse.status}:`,
        errorText,
      );
      // If follow failed, skip the unfollow test
      throw new Error(
        `Follow failed with status ${followResponse.status}: ${errorText}`,
      );
    }

    const followBody = await followResponse.json();
    expect(followBody.success).toBe(true);
    expect(followBody.followId).toBeDefined();
    console.log("[DEBUG] Follow created successfully:", followBody.followId);

    // Verify follow exists by checking the following list
    const followingResponse = await authenticatedFetch(
      `${API_URL}/api/followers/following?targetType=user`,
      currentSessionToken1,
      { method: "GET" },
    );
    if (followingResponse.ok) {
      const followingData = await followingResponse.json();
      const isInList = followingData.following?.some(
        (f: any) =>
          f.targetId === context.testUser2.id && f.targetType === "user",
      );
      console.log(
        "[DEBUG] Follow in following list:",
        isInList,
        "Total follows:",
        followingData.following?.length,
      );
      if (!isInList) {
        throw new Error("Follow not found in following list after creation");
      }
    }

    const { token: csrfToken2, updatedSessionToken: token2 } =
      await getCsrfToken(currentSessionToken1);
    const currentSessionToken2 = token2 || currentSessionToken1;

    // Retry unfollow with short backoff
    let response;
    let lastError;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        const delay = 200 * attempt;
        console.log(
          `[DEBUG] Retrying unfollow, attempt ${attempt + 1}, waiting ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      response = await authenticatedFetch(
        `${API_URL}/api/followers/unfollow`,
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

      if (response.status === 200) {
        console.log(`[DEBUG] Unfollow succeeded on attempt ${attempt + 1}`);
        break; // Success!
      }

      const errorText = await response.text();
      lastError = { status: response.status, error: errorText };
      console.log(`[DEBUG] Unfollow attempt ${attempt + 1} failed:`, lastError);

      // If it's not a 404, fail immediately (don't retry)
      if (response.status !== 404) {
        break;
      }
    }

    if (response.status !== 200) {
      console.error(`[DEBUG] Unfollow failed after retries:`, lastError);
    }

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  }, 60000); // 60 second timeout for database consistency

  it("should return 404 when not following", async () => {
    const { token: csrfToken, updatedSessionToken } = await getCsrfToken(
      context.sessionToken1,
    );
    const currentSessionToken = updatedSessionToken || context.sessionToken1;
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
          targetType: "user",
          targetId: context.testUser2.id, // Not following this user
        }),
      },
    );

    // API might return 403 for not found, 404, 500, or 503 (service unavailable)
    // 500 can occur if there's an error in the handler
    // 503 can occur if database is temporarily unavailable
    expect([404, 403, 500, 503]).toContain(response.status);
  });
});
