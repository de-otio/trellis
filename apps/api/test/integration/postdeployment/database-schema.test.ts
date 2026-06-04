/**
 * Post-Deployment Test: Database Schema Validation
 *
 * ⚠️ SKIPPED: This test requires direct database connections which are not available
 * in GitHub Actions due to IPv6-only Supabase hostnames.
 *
 * Schema validation should be done via:
 * - Prisma migrations (run during deployment)
 * - API endpoint tests (validate functionality, not schema directly)
 * - Manual verification in Supabase dashboard
 *
 * Original purpose:
 * This test verified that the database schema matches the Prisma schema.
 * It caught issues where migrations hadn't been run or schema changes
 * hadn't been applied to the database.
 *
 * Alternative validation:
 * - Run `prisma migrate status` during deployment
 * - Test API endpoints that require specific schema (users, posts, etc.)
 * - Verify feature toggles API works (validates feature_toggles table exists)
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { beforeAll, describe, expect, it } from "vitest";
import { getSsmParameter } from "../../utils/aws-ssm.js";

// ⚠️ WARNING: This test requires direct database connections which violate test architecture.
// Schema validation should be done via API endpoints or during deployment.
describe.skip("Post-Deployment: Database Schema Validation", () => {
  let dbUrl: string | null = null;
  let skipTests = true; // Skip by default — direct DB connections require SSM paths that no longer exist (Supabase/Hyperdrive removed)

  // Initialize database URL before tests
  beforeAll(async () => {
    // For post-deployment tests, prioritize SSM over environment variables
    // This ensures we use real database URLs, not test URLs

    // First, try SSM (most reliable for post-deployment tests)
    try {
      const directUrl = await getSsmParameter("DIRECT_DATABASE_URL", {
        required: false,
      });
      if (
        directUrl &&
        !directUrl.includes("test-hyperdrive-id") &&
        !directUrl.includes("test-hyperdrive")
      ) {
        dbUrl = directUrl;
        skipTests = false;
        console.log(
          "[database-schema.test] Using DIRECT_DATABASE_URL from SSM",
        );
        return;
      }
      const url = await getSsmParameter("DATABASE_URL", { required: false });
      if (
        url &&
        !url.includes("test-hyperdrive-id") &&
        !url.includes("test-hyperdrive")
      ) {
        dbUrl = url;
        skipTests = false;
        console.log("[database-schema.test] Using DATABASE_URL from SSM");
        return;
      }
    } catch (error) {
      console.warn(
        "[database-schema.test] Failed to get database URL from SSM:",
        error,
      );
    }

    // Then check environment variables (but skip test URLs)
    if (
      process.env.DIRECT_DATABASE_URL &&
      !process.env.DIRECT_DATABASE_URL.includes("test-hyperdrive-id") &&
      !process.env.DIRECT_DATABASE_URL.includes("test-hyperdrive")
    ) {
      dbUrl = process.env.DIRECT_DATABASE_URL;
      skipTests = false;
      console.log(
        "[database-schema.test] Using DIRECT_DATABASE_URL from environment",
      );
      return;
    }
    if (
      process.env.DATABASE_URL &&
      !process.env.DATABASE_URL.includes("test-hyperdrive-id") &&
      !process.env.DATABASE_URL.includes("test-hyperdrive")
    ) {
      dbUrl = process.env.DATABASE_URL;
      skipTests = false;
      console.log("[database-schema.test] Using DATABASE_URL from environment");
      return;
    }

    if (!dbUrl) {
      console.warn(
        "[database-schema.test] DATABASE_URL or DIRECT_DATABASE_URL not set or contains test URL, skipping all database schema tests",
      );
      skipTests = true;
    }
  });

  // Ensure SSL is enabled for Supabase connections (required for external connections)
  const ensureSslConnection = (dbUrl: string): string => {
    if (dbUrl.includes("supabase.co") && !dbUrl.includes("sslmode")) {
      return `${dbUrl}${dbUrl.includes("?") ? "&" : "?"}sslmode=require`;
    }
    return dbUrl;
  };

  // Helper to convert pooler port (6543) to direct port (5432)
  // Tests must use direct connection because PgBouncer transaction mode doesn't support prepared statements
  const convertToDirectPort = (url: string): string => {
    return url.replace(/:6543\//, ":5432/").replace(/:6543$/, ":5432");
  };

  // Helper to convert database URL to use direct connection for tests
  const getDatabaseUrlWithFallback = async (
    originalUrl: string,
  ): Promise<string> => {
    // Always use direct connection (port 5432) for tests to avoid PgBouncer prepared statement issues
    if (originalUrl.includes(":6543")) {
      const directUrl = convertToDirectPort(originalUrl);
      console.log(
        "[database-schema.test] Converting pooler port (6543) to direct port (5432) for tests (PgBouncer doesn't support prepared statements)",
      );
      return directUrl;
    }

    // Port is already 5432 or not a Supabase URL, return original
    return originalUrl;
  };

  // Helper to create Prisma client with error handling
  const createPrismaClient = async (
    dbUrl: string | null,
  ): Promise<PrismaClient | null> => {
    if (!dbUrl) {
      return null;
    }

    // Validate URL is not a test URL
    if (
      dbUrl.includes("test-hyperdrive-id") ||
      dbUrl.includes("test-hyperdrive")
    ) {
      console.error(
        "[createPrismaClient] ERROR: Test database URL detected!",
        dbUrl.substring(0, 50) + "...",
      );
      throw new Error(
        "Test database URL detected. Use DIRECT_DATABASE_URL from SSM or environment.",
      );
    }

    // In CI, try fallback to direct port if pooler connection fails
    dbUrl = await getDatabaseUrlWithFallback(dbUrl);

    const sslUrl = ensureSslConnection(dbUrl);
    const db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: sslUrl }),
      log: process.env.DEBUG ? ["error", "warn"] : [],
    });

    // Test connection with retry
    let retries = 3;
    while (retries > 0) {
      try {
        await db.$connect();
        return db;
      } catch (error: any) {
        retries--;
        if (retries === 0) {
          console.error(
            "Failed to connect to database after 3 retries:",
            error,
          );
          await db.$disconnect().catch(() => {});
          return null;
        }
        // Wait before retry (exponential backoff)
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (4 - retries)),
        );
      }
    }
    return null;
  };

  it("should have region column in users table", async () => {
    if (skipTests || !dbUrl) {
      return; // Skip test
    }

    const db = await createPrismaClient(dbUrl);

    if (!db) {
      throw new Error("Failed to create database connection");
    }

    try {
      // Try to query the region field - if it doesn't exist, this will fail
      const result = await db.user.findFirst({
        select: {
          id: true,
          email: true,
          region: true,
          dataRegion: true,
        },
        take: 1,
      });

      // If we get here, the column exists
      expect(result).toBeDefined();
      // The result might be null if no users exist, but that's okay
      // The important thing is that the query didn't fail
    } catch (error: any) {
      if (
        error.message?.includes("does not exist") ||
        error.message?.includes("Unknown column")
      ) {
        throw new Error(
          `Database schema mismatch: 'region' column does not exist in users table. ` +
            `Run migration: npx prisma migrate deploy`,
        );
      }
      throw error;
    } finally {
      await db.$disconnect().catch(() => {});
    }
  });

  it.skipIf(skipTests)(
    "should have dataRegion column in users table",
    async () => {
      const db = await createPrismaClient(dbUrl);

      if (!db) {
        throw new Error("Failed to create database connection");
      }

      try {
        const result = await db.user.findFirst({
          select: {
            id: true,
            email: true,
            dataRegion: true,
          },
          take: 1,
        });

        expect(result).toBeDefined();
      } catch (error: any) {
        if (
          error.message?.includes("does not exist") ||
          error.message?.includes("Unknown column")
        ) {
          throw new Error(
            `Database schema mismatch: 'dataRegion' column does not exist in users table. ` +
              `Run migration: npx prisma migrate deploy`,
          );
        }
        throw error;
      } finally {
        await db.$disconnect().catch(() => {});
      }
    },
  );

  it.skipIf(skipTests)(
    "should have dataRegion column in posts table",
    async () => {
      const db = await createPrismaClient(dbUrl);

      if (!db) {
        throw new Error("Failed to create database connection");
      }

      try {
        const result = await db.post.findFirst({
          select: {
            id: true,
            dataRegion: true,
          },
          take: 1,
        });

        expect(result).toBeDefined();
      } catch (error: any) {
        if (
          error.message?.includes("does not exist") ||
          error.message?.includes("Unknown column")
        ) {
          throw new Error(
            `Database schema mismatch: 'dataRegion' column does not exist in posts table. ` +
              `Run migration: npx prisma migrate deploy`,
          );
        }
        throw error;
      } finally {
        await db.$disconnect().catch(() => {});
      }
    },
  );

  it.skipIf(skipTests)("should have feature_toggles table", async () => {
    const db = await createPrismaClient(dbUrl);

    if (!db) {
      throw new Error("Failed to create database connection");
    }

    try {
      const result = await db.featureToggle.findFirst({
        take: 1,
      });

      // If we get here, the table exists
      expect(result).toBeDefined();
    } catch (error: any) {
      if (
        error.message?.includes("does not exist") ||
        error.message?.includes("Unknown table") ||
        error.message?.includes("relation") ||
        error.code === "P2021" // Prisma error code for table not found
      ) {
        throw new Error(
          `Database schema mismatch: 'feature_toggles' table does not exist. ` +
            `Run migration: npx prisma migrate deploy --name add_feature_toggles`,
        );
      }
      throw error;
    } finally {
      await db.$disconnect().catch(() => {});
    }
  });

  it.skipIf(skipTests)(
    "should be able to create a user with region field",
    async () => {
      const db = await createPrismaClient(dbUrl);

      if (!db) {
        throw new Error("Failed to create database connection");
      }

      const testUserId = `test-schema-${Date.now()}`;
      const testEmail = `test-schema-${Date.now()}@example.com`;

      try {
        // Try to create a user with region field
        const user = await db.user.create({
          data: {
            id: testUserId,
            email: testEmail,
            role: "END_USER",
            region: "US",
            dataRegion: "US",
          },
        });

        expect(user).toBeDefined();
        expect(user.region).toBe("US");
        expect(user.dataRegion).toBe("US");

        // Clean up
        await db.user.delete({
          where: { id: testUserId },
        });
      } catch (error: any) {
        if (
          error.message?.includes("does not exist") ||
          error.message?.includes("Unknown column")
        ) {
          throw new Error(
            `Database schema mismatch: Cannot create user with region field. ` +
              `The 'region' column does not exist. Run migration: npx prisma migrate deploy`,
          );
        }
        throw error;
      } finally {
        await db.$disconnect().catch(() => {});
      }
    },
  );
});
