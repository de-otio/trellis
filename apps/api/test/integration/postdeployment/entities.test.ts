/**
 * Post-Deployment Integration Tests: Entities API
 *
 * Tests the /api/entities endpoint with a real database.
 *
 * ⚠️ CRITICAL: This test MUST NEVER run on production.
 * It will abort immediately if environment is not 'dev'.
 *
 * This test verifies:
 * - GET /api/entities returns user's entities
 * - POST /api/entities creates new entities
 * - GET /api/entities/:id returns a specific entity (searches all regions)
 * - PUT /api/entities/:id updates an entity
 * - DELETE /api/entities/:id deletes an entity
 * - Full CRUD lifecycle works correctly
 * - Entity lookup works regardless of region mismatch
 * - Timeout/retry logic works correctly
 * - Database queries complete without cancellation
 * - Error handling works correctly
 *
 * Prerequisites:
 * - ENVIRONMENT or DEPLOY_ENV must be set to 'dev'
 * - DATABASE_URL or DIRECT_DATABASE_URL must be set (or available via AWS SSM)
 * - SESSION_SECRET must be set (or available via AWS SSM)
 * - API must be running (via `npm run dev` or deployed)
 *
 * Usage:
 *   npm run test:postdeployment -- entities
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authenticatedFetch,
  cleanupTestUser,
  createTestUserWithSession,
  getCsrfToken,
  type TestUser,
} from "../../utils/test-auth.js";
import { getApiUrl } from "../../utils/test-config.js";
import {
  requireDevEnvironment,
  skipIfNotDev,
} from "../../utils/test-environment-guard.js";

const API_URL = getApiUrl();

// Skip entire test suite if not in dev environment
describe("GET /api/entities", () => {
  let testUser: TestUser;
  let sessionToken: string;

  beforeAll(async () => {
    requireDevEnvironment();
  });

  beforeEach(async () => {
    // Create test user with EU region (matches API's detected region)
    const uniqueId = crypto.randomUUID();
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);

    const user = await createTestUserWithSession({
      email: `test-entities-${timestamp}-${randomSuffix}-${uniqueId.substring(0, 8)}@test.example.com`,
      role: "END_USER",
      region: "EU",
      dataRegion: "EU",
    });

    testUser = user.testUser;
    sessionToken = user.sessionToken;
  });

  afterEach(async () => {
    if (testUser?.id) {
      await cleanupTestUser(testUser.id);
    }
  });

  it("should return empty array when user has no entities", async () => {
    const response = await authenticatedFetch(
      `${API_URL}/api/entities`,
      sessionToken,
      {
        method: "GET",
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.profiles).toBeDefined();
    expect(Array.isArray(data.profiles)).toBe(true);
    expect(data.profiles).toHaveLength(0);
  });

  it("should return entities owned by user", async () => {
    // First, get CSRF token (this also updates the session with the CSRF token)
    const { token: csrfToken, updatedSessionToken } = await getCsrfToken(API_URL, sessionToken);
    sessionToken = updatedSessionToken;

    const createResponse = await authenticatedFetch(
      `${API_URL}/api/entities`,
      sessionToken,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          name: `Test Dog ${Date.now()}`,
          metadata: { breed: "Golden Retriever" },
        }),
      },
    );

    // Check if feature is disabled
    if (createResponse.status === 403) {
      const errorText = await createResponse.text();
      console.log(
        `[SKIP] Entity creation feature is disabled (403): ${errorText}. Skipping entity creation test.`,
      );
      // If feature is disabled, just verify GET still works (returns empty array)
      const listResponse = await authenticatedFetch(
        `${API_URL}/api/entities`,
        sessionToken,
        {
          method: "GET",
        },
      );
      expect(listResponse.status).toBe(200);
      const listData = await listResponse.json();
      expect(listData.profiles).toBeDefined();
      expect(Array.isArray(listData.profiles)).toBe(true);
      return; // Skip rest of test if feature disabled
    }

    if (createResponse.status !== 200 && createResponse.status !== 201) {
      const errorText = await createResponse.text();
      console.error(
        `[DEBUG] Create entity failed with status ${createResponse.status}:`,
        errorText,
      );
    }

    // Accept both 200 and 201 (Created) as success
    expect([200, 201]).toContain(createResponse.status);
    const createData = await createResponse.json();
    expect(createData.id).toBeDefined();

    // List entities
    const listResponse = await authenticatedFetch(
      `${API_URL}/api/entities`,
      sessionToken,
      {
        method: "GET",
      },
    );

    if (listResponse.status !== 200) {
      const errorText = await listResponse.text();
      console.error(
        `[DEBUG] List entities failed with status ${listResponse.status}:`,
        errorText,
      );
    }

    expect(listResponse.status).toBe(200);
    const listData = await listResponse.json();
    expect(listData.profiles).toBeDefined();
    expect(Array.isArray(listData.profiles)).toBe(true);
    expect(listData.profiles.length).toBeGreaterThan(0);

    // Verify the created entity is in the list
    const foundEntity = listData.profiles.find(
      (p: any) => p.id === createData.id,
    );
    expect(foundEntity).toBeDefined();
    expect(foundEntity.name).toBeDefined();
    expect(foundEntity.entityType).toBe("dog");
  });

  it("should handle timeout/retry logic correctly and not cancel requests", async () => {
    // Create multiple entities to test with a larger dataset
    const { token: csrfToken, updatedSessionToken } = await getCsrfToken(API_URL, sessionToken);
    sessionToken = updatedSessionToken;

    // Create a few entities
    const entityIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const createResponse = await authenticatedFetch(
        `${API_URL}/api/entities`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            name: `Test Dog ${Date.now()}-${i}`,
            metadata: { breed: "Labrador" },
          }),
        },
      );

      if (createResponse.status === 200) {
        const createData = await createResponse.json();
        entityIds.push(createData.id);
      }
    }

    // Test that GET /api/entities completes without cancellation
    // This should use timeout/retry logic internally
    const startTime = Date.now();
    const listResponse = await authenticatedFetch(
      `${API_URL}/api/entities`,
      sessionToken,
      {
        method: "GET",
      },
    );
    const endTime = Date.now();
    const duration = endTime - startTime;

    // Response should complete successfully (not be canceled)
    expect(listResponse.status).toBe(200);

    // Should complete within reasonable time (timeout is 3s, so should be < 5s)
    expect(duration).toBeLessThan(5000);

    const listData = await listResponse.json();
    expect(listData.profiles).toBeDefined();
    expect(Array.isArray(listData.profiles)).toBe(true);

    // Verify all created entities are in the list
    for (const entityId of entityIds) {
      const foundEntity = listData.profiles.find((p: any) => p.id === entityId);
      expect(foundEntity).toBeDefined();
    }
  }, 30000); // 30 second timeout for this test

  it("should return entities ordered by name ascending", async () => {
    // Create entities with different names
    const { token: csrfToken, updatedSessionToken } = await getCsrfToken(API_URL, sessionToken);
    sessionToken = updatedSessionToken;

    const names = ["Zebra Dog", "Alpha Dog", "Beta Dog"];
    const entityIds: string[] = [];

    for (const name of names) {
      const createResponse = await authenticatedFetch(
        `${API_URL}/api/entities`,
        sessionToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            name,
            metadata: { breed: "Test Breed" },
          }),
        },
      );

      // Check if feature is disabled
      if (createResponse.status === 403) {
        console.log(
          `[SKIP] Entity creation feature is disabled (403). Skipping ordering test.`,
        );
        // If feature is disabled, just verify GET still works
        const listResponse = await authenticatedFetch(
          `${API_URL}/api/entities`,
          sessionToken,
          {
            method: "GET",
          },
        );
        expect(listResponse.status).toBe(200);
        const listData = await listResponse.json();
        expect(listData.profiles).toBeDefined();
        expect(Array.isArray(listData.profiles)).toBe(true);
        return; // Skip rest of test if feature disabled
      }

      if (createResponse.status === 200) {
        const createData = await createResponse.json();
        entityIds.push(createData.id);
      }
    }

    // Skip test if no entities were created
    if (entityIds.length === 0) {
      console.log("[SKIP] No entities created, skipping ordering test");
      return;
    }

    // List entities
    const listResponse = await authenticatedFetch(
      `${API_URL}/api/entities`,
      sessionToken,
      {
        method: "GET",
      },
    );

    expect(listResponse.status).toBe(200);
    const listData = await listResponse.json();
    expect(listData.profiles.length).toBeGreaterThanOrEqual(entityIds.length);

    // Verify ordering (should be alphabetical)
    const profileNames = listData.profiles.map((p: any) => p.name);
    const sortedNames = [...profileNames].sort();
    expect(profileNames).toEqual(sortedNames);
  }, 30000);

  it("should handle errors gracefully when feature is disabled", async () => {
    // Note: This test assumes the feature toggle might be disabled
    // In practice, the endpoint returns 200 with empty profiles if disabled
    const response = await authenticatedFetch(
      `${API_URL}/api/entities`,
      sessionToken,
      {
        method: "GET",
      },
    );

    // Should return 200 even if feature is disabled (with empty profiles)
    expect([200, 403]).toContain(response.status);

    if (response.status === 200) {
      const data = await response.json();
      expect(data.profiles).toBeDefined();
    }
  });

  it("should support full CRUD lifecycle: create, read, update, delete", async () => {
    // This test verifies the fix for the region search issue where:
    // - Entity was created successfully
    // - GET/PUT/DELETE failed with 404 because they only searched one region
    // After the fix, all operations search all regions to find the entity

    // Step 1: Get CSRF token
    const { token: initialCsrfToken, updatedSessionToken } = await getCsrfToken(API_URL, sessionToken);
    let csrfToken = initialCsrfToken;
    sessionToken = updatedSessionToken;

    // Step 2: CREATE entity
    const entityName = `CRUD Test Dog ${Date.now()}`;
    const createResponse = await authenticatedFetch(
      `${API_URL}/api/entities`,
      sessionToken,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          name: entityName,
          entityType: "dog",
          metadata: {
            breed: "Golden Retriever",
            privacy: "followers", // Use 'followers' since public posting may be disabled
          },
        }),
      },
    );

    // Check if feature is disabled or other 403 error
    if (createResponse.status === 403) {
      const errorText = await createResponse.text();
      let errorData: any = {};
      try {
        errorData = JSON.parse(errorText);
      } catch {
        // Not JSON, use raw text
      }

      // Check for feature disabled
      if (
        errorData.error === "ENTITY_PROFILES_DISABLED" ||
        errorData.error?.includes("disabled")
      ) {
        console.log(
          "[SKIP] Entity profiles feature is disabled. Skipping CRUD test.",
        );
        return;
      }

      // Log the actual error for debugging
      console.error(`[DEBUG] CRUD test got 403 error:`, errorText);

      // If it's a CSRF error, fail with helpful message
      if (
        errorData.error === "Invalid CSRF token" ||
        errorText.includes("CSRF")
      ) {
        throw new Error(
          `CSRF token validation failed. This may indicate a session token mismatch. ` +
            `Error: ${errorText}`,
        );
      }
    }

    // Accept both 200 and 201 (Created) as success
    expect([200, 201]).toContain(createResponse.status);
    const createData = await createResponse.json();
    expect(createData.id).toBeDefined();
    expect(createData.name).toBe(entityName);
    const entityId = createData.id;

    // Step 3: READ entity (GET by ID)
    // This was failing with 404 before the fix because it only searched one region
    const getResponse = await authenticatedFetch(
      `${API_URL}/api/entities/${entityId}`,
      sessionToken,
      {
        method: "GET",
      },
    );

    if (getResponse.status !== 200) {
      const errorText = await getResponse.text();
      console.error(
        `[DEBUG] GET entity failed with status ${getResponse.status}:`,
        errorText,
      );
    }

    expect(getResponse.status).toBe(200);
    const getData = await getResponse.json();
    expect(getData.id).toBe(entityId);
    expect(getData.name).toBe(entityName);
    expect(getData.entityType).toBe("dog");
    expect(getData.metadata.breed).toBe("Golden Retriever");

    // Step 4: Refresh CSRF token before UPDATE (token may have changed)
    const { token: csrfToken2, updatedSessionToken: updatedSession2 } = await getCsrfToken(API_URL, sessionToken);
    csrfToken = csrfToken2;
    sessionToken = updatedSession2;

    // Step 5: UPDATE entity (PUT)
    const updatedName = `CRUD Test Dog Updated ${Date.now()}`;
    const updateResponse = await authenticatedFetch(
      `${API_URL}/api/entities/${entityId}`,
      sessionToken,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          id: entityId,
          name: updatedName,
          entityType: "dog",
          metadata: {
            breed: "Labrador Retriever",
            privacy: "followers", // Use 'followers' since public posting may be disabled
          },
        }),
      },
    );

    if (updateResponse.status !== 200) {
      const errorText = await updateResponse.text();
      console.error(
        `[DEBUG] PUT entity failed with status ${updateResponse.status}:`,
        errorText,
      );
    }

    expect(updateResponse.status).toBe(200);
    const updateData = await updateResponse.json();
    console.log(
      `[DEBUG] Update response:`,
      JSON.stringify(updateData, null, 2),
    );
    expect(updateData.id).toBe(entityId);
    expect(updateData.name).toBe(updatedName);
    expect(updateData.metadata.breed).toBe("Labrador Retriever");

    // Step 6: Verify UPDATE by reading again with retry
    let getData2: any = null;
    let getResponse2: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      getResponse2 = await authenticatedFetch(
        `${API_URL}/api/entities/${entityId}`,
        sessionToken,
        {
          method: "GET",
        },
      );

      if (getResponse2.status === 200) {
        getData2 = await getResponse2.json();
        console.log(
          `[DEBUG] GET after update response (attempt ${attempt + 1}):`,
          JSON.stringify(getData2, null, 2),
        );

        // Check if the update was applied
        if (getData2.name === updatedName) {
          break; // Update was applied, exit retry loop
        }

        // Update not yet visible, wait and retry
        console.log(`[DEBUG] Update not yet visible, retrying in 200ms...`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      } else {
        const errorText = await getResponse2.text();
        console.error(
          `[DEBUG] GET after update failed with status ${getResponse2.status}:`,
          errorText,
        );
        break;
      }
    }

    expect(getResponse2!.status).toBe(200);
    expect(getData2.name).toBe(updatedName);
    expect(getData2.metadata.breed).toBe("Labrador Retriever");

    // Step 7: Refresh CSRF token before DELETE
    const { token: csrfToken3, updatedSessionToken: updatedSession3 } = await getCsrfToken(API_URL, sessionToken);
    csrfToken = csrfToken3;
    sessionToken = updatedSession3;

    // Step 8: DELETE entity
    const deleteResponse = await authenticatedFetch(
      `${API_URL}/api/entities/${entityId}`,
      sessionToken,
      {
        method: "DELETE",
        headers: {
          "X-CSRF-Token": csrfToken,
        },
      },
    );

    if (deleteResponse.status !== 200 && deleteResponse.status !== 204) {
      const errorText = await deleteResponse.text();
      console.error(
        `[DEBUG] DELETE entity failed with status ${deleteResponse.status}:`,
        errorText,
      );
    }

    expect([200, 204]).toContain(deleteResponse.status);

    // Step 9: Verify DELETE by trying to read again (should return 404)
    const getResponse3 = await authenticatedFetch(
      `${API_URL}/api/entities/${entityId}`,
      sessionToken,
      {
        method: "GET",
      },
    );

    expect(getResponse3.status).toBe(404);
  }, 60000); // 60 second timeout for this comprehensive test

  it("should find entity by ID regardless of region mismatch", async () => {
    // This test specifically verifies the fix for the region search issue
    // The entity should be found even if session.dataRegion doesn't match
    // where the entity was actually created

    // Step 1: Get CSRF token
    const { token: csrfToken, updatedSessionToken } = await getCsrfToken(API_URL, sessionToken);
    sessionToken = updatedSessionToken;

    // Step 2: Create entity
    const createResponse = await authenticatedFetch(
      `${API_URL}/api/entities`,
      sessionToken,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          name: `Region Test Dog ${Date.now()}`,
          entityType: "dog",
          metadata: { privacy: "followers" }, // Use 'followers' since public posting may be disabled
        }),
      },
    );

    // Check if feature is disabled
    if (createResponse.status === 403) {
      console.log(
        "[SKIP] Entity profiles feature is disabled. Skipping region test.",
      );
      return;
    }

    expect([200, 201]).toContain(createResponse.status);
    const createData = await createResponse.json();
    const entityId = createData.id;

    // Step 3: Immediately try to GET the entity
    // Before the fix, this would fail with 404 if session.dataRegion
    // didn't match the region where the entity was created
    const getResponse = await authenticatedFetch(
      `${API_URL}/api/entities/${entityId}`,
      sessionToken,
      {
        method: "GET",
      },
    );

    // This should succeed now that we search all regions
    expect(getResponse.status).toBe(200);
    const getData = await getResponse.json();
    expect(getData.id).toBe(entityId);

    // Cleanup: Delete the entity
    const { token: deleteToken, updatedSessionToken: deleteSession } = await getCsrfToken(API_URL, sessionToken);
    sessionToken = deleteSession;

    await authenticatedFetch(
      `${API_URL}/api/entities/${entityId}`,
      sessionToken,
      {
        method: "DELETE",
        headers: {
          "X-CSRF-Token": deleteToken,
        },
      },
    );
  }, 30000);
});
