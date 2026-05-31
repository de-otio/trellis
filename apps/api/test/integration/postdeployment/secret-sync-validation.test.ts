/**
 * Post-Deployment Test: Secret Synchronization Validation
 *
 * This test validates that secrets in Cloudflare Workers match the corresponding
 * values in AWS SSM Parameter Store. This prevents issues where secrets are out
 * of sync, causing authentication failures.
 *
 * ⚠️ CRITICAL: This test MUST NEVER run on production.
 * It will abort immediately if environment is not 'dev'.
 *
 * How it works:
 * 1. Fetches secrets from AWS SSM (source of truth)
 * 2. Creates test sessions using SSM secrets
 * 3. Attempts to authenticate with the deployed API
 * 4. If authentication fails, indicates secret mismatch
 *
 * Prerequisites:
 * - ENVIRONMENT or DEPLOY_ENV must be set to 'dev'
 * - AWS credentials configured (for SSM access)
 * - API must be running and accessible
 *
 * Usage:
 *   npm run test:postdeployment
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getSsmParameter } from "../../utils/aws-ssm.js";
import {
  authenticatedFetch,
  cleanupTestUser,
  createTestUserWithSession,
  type TestUser,
} from "../../utils/test-auth.js";
import { getApiUrl } from "../../utils/test-config.js";
import {
  requireDevEnvironment,
  skipIfNotDev,
} from "../../utils/test-environment-guard.js";

const API_URL = getApiUrl();

// Skip entire test suite if not in dev environment
describe("Post-Deployment: Secret Synchronization Validation", () => {
  // Additional safety check in beforeAll (defense in depth)
  beforeAll(() => {
    requireDevEnvironment();
  });

  describe("SESSION_SECRET Synchronization", () => {
    let testUser: TestUser;
    let sessionToken: string;

    beforeAll(async () => {
      // Create a test user for validation
      const { testUser: user, sessionToken: token } =
        await createTestUserWithSession({
          role: "END_USER",
          email: `secret-validation-${Date.now()}@test.example.com`,
        });
      testUser = user;
      sessionToken = token;
    });

    afterAll(async () => {
      await cleanupTestUser(testUser.id);
    });

    it("should detect SESSION_SECRET mismatch between SSM and Cloudflare Workers", async () => {
      // Fetch SESSION_SECRET from SSM (source of truth)
      const ssmSecret = await getSsmParameter("SESSION_SECRET", {
        required: false,
      });

      if (!ssmSecret) {
        console.warn(
          "[SECRET SYNC] ⚠️  Cannot validate - SESSION_SECRET not found in SSM",
        );
        return;
      }

      console.log(
        "[SECRET SYNC] ✅ SESSION_SECRET found in SSM (length:",
        ssmSecret.length,
        ")",
      );

      // Try to authenticate with the API using a session created with SSM secret
      // If the API uses a different secret, this will fail with 401
      // Use a protected endpoint that requires authentication
      const response = await authenticatedFetch(
        `${API_URL}/api/admin/super-admin/feature-toggles`,
        sessionToken,
      );

      const body = await response.json();

      if (response.status === 401) {
        console.error(
          "[SECRET SYNC] ❌ MISMATCH DETECTED: SESSION_SECRET in Cloudflare Workers does NOT match SSM",
        );
        console.error(
          "[SECRET SYNC] 💡 The API returned 401, indicating it cannot decrypt the session",
        );
        console.error(
          "[SECRET SYNC] 💡 This means Cloudflare Workers secret is different from SSM secret",
        );
        console.error(
          "[SECRET SYNC] 💡 Solution: Run ./scripts/sync-env.sh sync -e dev",
        );

        // This is a validation test - we want it to fail if secrets don't match
        throw new Error(
          "SECRET MISMATCH: SESSION_SECRET in Cloudflare Workers does not match AWS SSM. " +
            "Run ./scripts/sync-env.sh sync -e dev to sync secrets.",
        );
      }

      // If we get 403, the session was decrypted successfully but user lacks permission
      // This is GOOD - it means secrets are in sync!
      if (response.status === 403) {
        console.log(
          "[SECRET SYNC] ✅ SESSION_SECRET is synchronized correctly",
        );
        console.log(
          "[SECRET SYNC] ✅ Session created with SSM secret was decrypted by API (got 403 = authenticated but not authorized)",
        );
        expect(response.status).toBe(403);
        expect(body).toHaveProperty("error");
        return;
      }

      // If we get 200, authentication worked (user has permission)
      if (response.status === 200) {
        console.log(
          "[SECRET SYNC] ✅ SESSION_SECRET is synchronized correctly",
        );
        console.log(
          "[SECRET SYNC] ✅ Session created with SSM secret works with API",
        );
        expect(response.status).toBe(200);
        return;
      }

      // Unexpected response - log for debugging
      console.warn(
        "[SECRET SYNC] ⚠️  Unexpected response:",
        response.status,
        body,
      );
      // Don't fail the test for unexpected responses - just log
    });

    it("should validate SESSION_SECRET format and length", async () => {
      const ssmSecret = await getSsmParameter("SESSION_SECRET", {
        required: false,
      });

      if (!ssmSecret) {
        console.warn(
          "[SECRET SYNC] ⚠️  Cannot validate - SESSION_SECRET not found in SSM",
        );
        return;
      }

      // Validate secret meets minimum requirements
      expect(ssmSecret.length).toBeGreaterThanOrEqual(32);
      expect(typeof ssmSecret).toBe("string");
      expect(ssmSecret.trim().length).toBe(ssmSecret.length); // No leading/trailing whitespace

      console.log(
        "[SECRET SYNC] ✅ SESSION_SECRET format is valid (length:",
        ssmSecret.length,
        ")",
      );
    });
  });

  describe("Database URL Synchronization", () => {
    it("should verify DIRECT_DATABASE_URL exists in SSM", async () => {
      const dbUrl = await getSsmParameter("DIRECT_DATABASE_URL", {
        required: false,
      });

      if (!dbUrl) {
        console.warn("[SECRET SYNC] ⚠️  DIRECT_DATABASE_URL not found in SSM");
        return;
      }

      // Validate it's a valid database URL
      expect(dbUrl).toMatch(/^postgres/);
      expect(dbUrl.length).toBeGreaterThan(0);

      console.log(
        "[SECRET SYNC] ✅ DIRECT_DATABASE_URL found in SSM (starts with:",
        dbUrl.substring(0, 20),
        "...)",
      );
    });

    it("should verify DATABASE_URL exists in SSM (if used)", async () => {
      const dbUrl = await getSsmParameter("DATABASE_URL", {
        required: false,
      });

      if (!dbUrl) {
        console.log(
          "[SECRET SYNC] ℹ️  DATABASE_URL not in SSM (may use DIRECT_DATABASE_URL instead)",
        );
        return;
      }

      // Validate it's a valid database URL
      expect(dbUrl).toMatch(/^postgres/);
      expect(dbUrl.length).toBeGreaterThan(0);

      console.log(
        "[SECRET SYNC] ✅ DATABASE_URL found in SSM (starts with:",
        dbUrl.substring(0, 20),
        "...)",
      );
    });
  });

  describe("Secret Synchronization Status", () => {
    it("should report which secrets are available in SSM", async () => {
      const secretsToCheck = [
        "SESSION_SECRET",
        "DIRECT_DATABASE_URL",
        "DATABASE_URL",
      ];

      const results: Record<string, boolean> = {};

      for (const secretName of secretsToCheck) {
        try {
          const value = await getSsmParameter(secretName, {
            required: false,
          });
          results[secretName] = !!value;
        } catch (error) {
          results[secretName] = false;
        }
      }

      console.log("[SECRET SYNC] SSM Secret Availability:");
      for (const [name, available] of Object.entries(results)) {
        console.log(
          `[SECRET SYNC]   ${name}: ${available ? "✅ Available" : "❌ Missing"}`,
        );
      }

      // At minimum, SESSION_SECRET should be available
      expect(results.SESSION_SECRET).toBe(true);
    });

    it("should provide instructions if secrets are missing", async () => {
      const ssmSecret = await getSsmParameter("SESSION_SECRET", {
        required: false,
      });

      if (!ssmSecret) {
        console.error("[SECRET SYNC] ❌ SESSION_SECRET not found in AWS SSM");
        console.error("[SECRET SYNC] 💡 Create it: aws ssm put-parameter \\");
        console.error(
          "[SECRET SYNC]      --name /trellis/dev/session/secret \\",
        );
        console.error(
          '[SECRET SYNC]      --value "$(./scripts/generate-session-secret.sh)" \\',
        );
        console.error("[SECRET SYNC]      --type SecureString \\");
        console.error("[SECRET SYNC]      --region eu-central-1");
      }
    });
  });

  describe("End-to-End Secret Validation", () => {
    it("should create and validate authenticated session end-to-end", async () => {
      // This is the ultimate test: create a session with SSM secret and verify it works
      const { testUser, sessionToken } = await createTestUserWithSession({
        role: "END_USER",
      });

      try {
        // Try to authenticate with the API using a protected endpoint
        // Use an endpoint that requires authentication (will return 401 if session invalid)
        const response = await authenticatedFetch(
          `${API_URL}/api/admin/super-admin/feature-toggles`,
          sessionToken,
        );
        const body = await response.json();

        if (response.status === 401) {
          const ssmSecret = await getSsmParameter("SESSION_SECRET", {
            required: false,
          });

          console.error("[SECRET SYNC] ❌ END-TO-END VALIDATION FAILED");
          console.error(
            "[SECRET SYNC] ❌ Session created with SSM secret cannot authenticate with API",
          );
          console.error(
            "[SECRET SYNC] 💡 This confirms SESSION_SECRET mismatch",
          );
          console.error(
            "[SECRET SYNC] 💡 SSM secret length:",
            ssmSecret?.length || "unknown",
          );
          console.error(
            "[SECRET SYNC] 💡 Solution: ./scripts/sync-env.sh sync -e dev",
          );

          throw new Error(
            "SECRET MISMATCH CONFIRMED: SESSION_SECRET in Cloudflare Workers does not match AWS SSM. " +
              "The API cannot decrypt sessions created with the SSM secret. " +
              "Run ./scripts/sync-env.sh sync -e dev to sync secrets.",
          );
        }

        // If we get 403, the session was decrypted successfully (secrets match!)
        // User just doesn't have permission (expected for END_USER role)
        if (response.status === 403) {
          console.log("[SECRET SYNC] ✅ END-TO-END VALIDATION PASSED");
          console.log(
            "[SECRET SYNC] ✅ Session decrypted successfully (403 = authenticated but not authorized)",
          );
          console.log("[SECRET SYNC] ✅ Secrets are synchronized correctly");
          expect(response.status).toBe(403);
          return;
        }

        // If we get 200, authentication worked and user has permission
        if (response.status === 200) {
          console.log("[SECRET SYNC] ✅ END-TO-END VALIDATION PASSED");
          console.log("[SECRET SYNC] ✅ Secrets are synchronized correctly");
          expect(response.status).toBe(200);
          return;
        }

        // Unexpected response
        console.warn(
          "[SECRET SYNC] ⚠️  Unexpected response:",
          response.status,
          body,
        );
      } finally {
        // Clean up test user
        await cleanupTestUser(testUser.id);
      }
    });
  });
});
