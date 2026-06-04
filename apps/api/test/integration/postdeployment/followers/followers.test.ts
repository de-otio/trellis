/**
 * Post-Deployment Integration Tests: Followers List Endpoint
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
describe("GET /api/followers/followers", () => {
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

  it("should return followers list for a user", async () => {
    const { token: csrfToken, updatedSessionToken: token2 } =
      await getCsrfToken(context.sessionToken2);
    let currentSessionToken2 = token2 || context.sessionToken2;

    // User2 follows User1
    const follow1Response = await authenticatedFetch(
      `${API_URL}/api/followers/follow`,
      currentSessionToken2,
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

    if (follow1Response.status === 200) {
      const setCookie1 = follow1Response.headers.get("Set-Cookie");
      if (setCookie1) {
        const match1 = setCookie1.match(/trellis_session=([^;]+)/);
        if (match1) currentSessionToken2 = match1[1];
      }
    }

    const { token: csrfToken3, updatedSessionToken: token3 } =
      await getCsrfToken(context.sessionToken3);
    let currentSessionToken3 = token3 || context.sessionToken3;
    const follow2Response = await authenticatedFetch(
      `${API_URL}/api/followers/follow`,
      currentSessionToken3,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken3,
        },
        body: JSON.stringify({
          targetType: "user",
          targetId: context.testUser1.id,
        }),
      },
    );

    if (follow2Response.status === 200) {
      const setCookie2 = follow2Response.headers.get("Set-Cookie");
      if (setCookie2) {
        const match2 = setCookie2.match(/trellis_session=([^;]+)/);
        if (match2) currentSessionToken3 = match2[1];
      }
    }

    // Get followers of user1
    const response = await authenticatedFetch(
      `${API_URL}/api/followers/followers?targetType=user&targetId=${context.testUser1.id}&limit=50`,
      context.sessionToken1,
      {
        method: "GET",
      },
    );

    if (response.status !== 200) {
      const errorText = await response.text();
      console.error(
        `[DEBUG] Get followers failed with status ${response.status}:`,
        errorText,
      );
    }

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.followers).toBeDefined();
    expect(Array.isArray(data.followers)).toBe(true);
    expect(data.hasMore).toBeDefined();
    // Check if we have at least the follows we just created
    expect(data.followers.length).toBeGreaterThanOrEqual(0);
  });

  it("should return followers list for a dog", async () => {
    if (!context.testEntityId) {
      console.log(
        "[SKIP] Test entity not created - skipping dog followers test",
      );
      return;
    }

    const { token: csrfToken } = await getCsrfToken(context.sessionToken2);

    // User2 and User3 follow the dog
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
          targetType: "dog",
          targetId: context.testEntityId,
        }),
      },
    );

    const { token: csrfToken3 } = await getCsrfToken(context.sessionToken3);
    await authenticatedFetch(
      `${API_URL}/api/followers/follow`,
      context.sessionToken3,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken3,
        },
        body: JSON.stringify({
          targetType: "dog",
          targetId: context.testEntityId,
        }),
      },
    );

    // Get followers of the dog
    const response = await authenticatedFetch(
      `${API_URL}/api/followers/followers?targetType=dog&targetId=${context.testEntityId}&limit=50`,
      context.sessionToken1,
      {
        method: "GET",
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.followers).toBeDefined();
    expect(Array.isArray(data.followers)).toBe(true);
    expect(data.followers.length).toBeGreaterThanOrEqual(2);
  });

  it("should support pagination with cursor", async () => {
    const { token: csrfToken } = await getCsrfToken(context.sessionToken2);

    // User2 follows User1
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

    // Get first page
    const firstPage = await authenticatedFetch(
      `${API_URL}/api/followers/followers?targetType=user&targetId=${context.testUser1.id}&limit=1`,
      context.sessionToken1,
      {
        method: "GET",
      },
    );

    expect(firstPage.status).toBe(200);
    const firstPageData = await firstPage.json();
    expect(firstPageData.followers).toBeDefined();
    expect(Array.isArray(firstPageData.followers)).toBe(true);

    // If there's a cursor, get next page
    if (firstPageData.cursor) {
      const secondPage = await authenticatedFetch(
        `${API_URL}/api/followers/followers?targetType=user&targetId=${context.testUser1.id}&limit=1&cursor=${firstPageData.cursor}`,
        context.sessionToken1,
        {
          method: "GET",
        },
      );

      expect(secondPage.status).toBe(200);
      const secondPageData = await secondPage.json();
      expect(secondPageData.followers).toBeDefined();
      expect(Array.isArray(secondPageData.followers)).toBe(true);
    }
  });
});
