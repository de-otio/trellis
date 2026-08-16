/**
 * Test Authentication Utilities
 *
 * Provides utilities for creating test users and authenticated sessions
 * for non-interactive integration tests.
 *
 * Usage:
 * ```typescript
 * import { createTestUser, createAuthenticatedSession, cleanupTestUser } from './utils/test-auth';
 * 
 * describe('My API Tests', () => {
 *   let testUser: TestUser;
 *   let sessionToken: string;
 * 
 *   beforeEach(async () => {
 *     testUser = await createTestUser();
 *     sessionToken = await createAuthenticatedSession(testUser.id, testUser.email);
 *   });
 * 
 *   afterEach(async () => {
 *     await cleanupTestUser(testUser.id);
 *   });
 * 
 *   it('should handle authenticated request', async () => {
 *     const response = await fetch(`${API_URL}/api/endpoint`, {
 *       headers: {
 *         Cookie: `trellis_session=${sessionToken}`,
 *       },
 *     });
 *     expect(response.status).toBe(200);
 *   });
 * });
 * ```
 */

import { SessionManager } from '../../src/lib/session-cookie.js';
import type { Session, UserRole } from '../../src/lib/session-cookie.js';

export interface TestUser {
  id: string;
  email: string;
  role: UserRole;
}

/**
 * @deprecated Direct database connections are no longer used in tests.
 * All tests should use API endpoints instead.
 * This function is kept for backward compatibility but should not be used.
 */
function isHyperdriveUrl(url: string): boolean {
  return (
    url.includes(".hyperdrive.workers.dev") ||
    url.includes("test-hyperdrive-id")
  );
}

/**
 * Get database connection for tests
 * Uses DIRECT_DATABASE_URL for direct connection (not Hyperdrive)
 * Fetches from AWS SSM Parameter Store if not in environment variables
 * Rejects Hyperdrive URLs as they only work in Cloudflare Workers runtime
 */
async function getDatabaseUrl(): Promise<string> {
  // Check if we're in a post-deployment test
  const isPostdeploymentTest =
    process.env.VITEST_CONFIG?.includes("postdeployment") ||
    process.argv.some((arg) => arg.includes("postdeployment"));

  // For post-deployment tests, always fetch from AWS SSM (ignore environment variables)
  if (isPostdeploymentTest) {
    const { getSsmParameter } = await import("./aws-ssm.js");

    // Try DIRECT_DATABASE_URL first (preferred for tests)
    const directUrl = await getSsmParameter("DIRECT_DATABASE_URL", {
      required: false,
    });
    if (directUrl && !isHyperdriveUrl(directUrl)) {
      return directUrl;
    }

    // Fall back to DATABASE_URL from SSM
    const dbUrl = await getSsmParameter("DATABASE_URL", { required: false });
    if (dbUrl && !isHyperdriveUrl(dbUrl)) {
      return dbUrl;
    }

    throw new Error(
      "DIRECT_DATABASE_URL or DATABASE_URL must be available in AWS SSM Parameter Store for post-deployment tests. " +
        "Hyperdrive URLs (.hyperdrive.workers.dev) cannot be used in Node.js tests - they only work in Cloudflare Workers runtime. " +
        "Ensure AWS credentials are configured and the parameters exist with direct database connection URLs.",
    );
  }

  // For non-post-deployment tests, use environment variables first
  // For post-deployment tests, explicitly clear test URLs from environment
  if (isPostdeploymentTest) {
    if (
      process.env.DIRECT_DATABASE_URL &&
      isHyperdriveUrl(process.env.DIRECT_DATABASE_URL)
    ) {
      delete process.env.DIRECT_DATABASE_URL;
    }
    if (process.env.DATABASE_URL && isHyperdriveUrl(process.env.DATABASE_URL)) {
      delete process.env.DATABASE_URL;
    }
  }

  // First try environment variable (for local development)
  if (
    process.env.DIRECT_DATABASE_URL &&
    !isHyperdriveUrl(process.env.DIRECT_DATABASE_URL)
  ) {
    return process.env.DIRECT_DATABASE_URL;
  }
  if (process.env.DATABASE_URL && !isHyperdriveUrl(process.env.DATABASE_URL)) {
    return process.env.DATABASE_URL;
  }

  // Try to fetch from AWS SSM Parameter Store
  const { getSsmParameter } = await import("./aws-ssm.js");
  const dbUrl = await getSsmParameter("DIRECT_DATABASE_URL", {
    required: false,
  });

  if (dbUrl && !isHyperdriveUrl(dbUrl)) {
    return dbUrl;
  }

  // Try DATABASE_URL from SSM as fallback
  const dbUrlAlt = await getSsmParameter("DATABASE_URL", { required: false });
  if (dbUrlAlt && !isHyperdriveUrl(dbUrlAlt)) {
    return dbUrlAlt;
  }

  throw new Error(
    "DATABASE_URL or DIRECT_DATABASE_URL must be set in environment variables " +
      "or available in AWS SSM Parameter Store. " +
      "Hyperdrive URLs (.hyperdrive.workers.dev) cannot be used in Node.js tests - they only work in Cloudflare Workers runtime. " +
      "For local development, set DIRECT_DATABASE_URL with a direct PostgreSQL connection string. " +
      "For CI/CD, ensure AWS credentials are configured and the parameters contain direct connection URLs.",
  );
}

/**
 * Ensure SSL is enabled for Supabase connections
 */
export function ensureSslConnection(dbUrl: string): string {
  if (dbUrl.includes("supabase.co") && !dbUrl.includes("sslmode")) {
    return `${dbUrl}${dbUrl.includes("?") ? "&" : "?"}sslmode=require`;
  }
  return dbUrl;
}

/**
 * Convert database URL from pooler port (6543) to direct port (5432)
 * Used as fallback in CI when IPv6 is not available
 */
function convertToDirectPort(dbUrl: string): string {
  // Replace port 6543 with 5432 for direct connection
  return dbUrl.replace(/:6543\//, ":5432/").replace(/:6543$/, ":5432");
}

/**
 * Resolve hostname to IPv4 address in CI environments
 * GitHub Actions runners may not support IPv6, so we need to force IPv4
 */
async function resolveToIPv4(hostname: string): Promise<string> {
  const isCI =
    process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

  if (!isCI) {
    // Not in CI, return original hostname
    return hostname;
  }

  try {
    // Resolve all addresses
    const addresses = await dnsPromises.resolve4(hostname);
    if (addresses && addresses.length > 0) {
      // Use first IPv4 address
      const ipv4 = addresses[0];
      console.log(
        `[resolveToIPv4] Resolved ${hostname} to IPv4: ${ipv4} (CI environment)`,
      );
      return ipv4;
    }
  } catch (error: any) {
    // If resolve4 fails, try regular lookup with IPv4 family
    try {
      const addresses = await new Promise<string[]>((resolve, reject) => {
        dns.lookup(hostname, { family: 4, all: true }, (err, addresses) => {
          if (err) {
            reject(err);
            return;
          }
          // When all: true, addresses is an array of {address, family} objects
          if (Array.isArray(addresses)) {
            resolve(
              addresses.map((a: any) =>
                typeof a === "string" ? a : a.address,
              ),
            );
          } else if (
            addresses &&
            typeof addresses === "object" &&
            "address" in addresses
          ) {
            // Single result (when all: false)
            resolve([addresses.address]);
          } else {
            resolve([]);
          }
        });
      });
      if (addresses && addresses.length > 0) {
        const ipv4 = addresses[0];
        console.log(
          `[resolveToIPv4] Resolved ${hostname} to IPv4: ${ipv4} (CI environment, fallback)`,
        );
        return ipv4;
      }
    } catch (fallbackError) {
      console.warn(
        `[resolveToIPv4] Failed to resolve ${hostname} to IPv4:`,
        fallbackError,
      );
    }
  }

  // If resolution fails, return original hostname (will try connection anyway)
  console.warn(
    `[resolveToIPv4] Could not resolve ${hostname} to IPv4, using hostname as-is`,
  );
  return hostname;
}

/**
 * Convert database URL to use IPv4 address in CI environments
 * GitHub Actions runners may not support IPv6 connections
 */
export async function convertToIPv4(dbUrl: string): Promise<string> {
  const isCI =
    process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

  if (!isCI) {
    // Not in CI, return original URL
    return dbUrl;
  }

  try {
    // Parse the database URL
    const url = new URL(dbUrl);
    const hostname = url.hostname;

    // Skip if already an IP address
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      return dbUrl;
    }

    // Resolve to IPv4
    const ipv4 = await resolveToIPv4(hostname);

    // Only replace hostname if we successfully resolved to an IPv4 address
    // If resolution failed, ipv4 will be the original hostname
    if (ipv4 !== hostname && /^\d+\.\d+\.\d+\.\d+$/.test(ipv4)) {
      // Successfully resolved to IPv4
      url.hostname = ipv4;
      const newUrl = url.toString();
      console.log(
        `[convertToIPv4] Converted database URL to use IPv4 address: ${ipv4} (CI environment)`,
      );
      return newUrl;
    } else {
      // DNS resolution failed or returned hostname - log warning but proceed
      // The connection will attempt with hostname, and DNS should prefer IPv4 due to setup.ts configuration
      console.warn(
        `[convertToIPv4] Could not resolve ${hostname} to IPv4, will use hostname (DNS should prefer IPv4)`,
      );
      return dbUrl;
    }
  } catch (error) {
    // If URL parsing fails, return original
    console.warn(
      `[convertToIPv4] Failed to parse URL for IPv4 conversion:`,
      error,
    );
    return dbUrl;
  }
}

/**
 * Convert database URL to use direct connection (port 5432) for tests
 * Tests must use direct connection because:
 * 1. PgBouncer transaction mode (port 6543) doesn't support prepared statements
 * 2. Prisma uses prepared statements internally
 * 3. Direct connection (port 5432) supports all Prisma features
 *
 * In CI, also handles IPv6 fallback by forcing IPv4 resolution
 */
export async function getDatabaseUrlWithFallback(
  originalUrl: string,
): Promise<string> {
  let url = originalUrl;

  // Always use direct connection (port 5432) for tests to avoid PgBouncer prepared statement issues
  if (url.includes(":6543")) {
    url = convertToDirectPort(url);
    console.log(
      "[getDatabaseUrlWithFallback] Converting pooler port (6543) to direct port (5432) for tests (PgBouncer doesn't support prepared statements)",
    );
  }

  // In CI, force IPv4 resolution (GitHub Actions may not support IPv6)
  url = await convertToIPv4(url);

  return url;
}

/**
 * Shared PrismaClient instance for all tests
 * Reusing a single client prevents connection pool exhaustion
 * Each PrismaClient creates its own connection pool, so creating many clients
 * can exhaust available database connections, especially with parallel tests.
 */
let sharedTestPrismaClient: any = null;
let sharedTestPrismaClientUrl: string | null = null;
let sharedTestPrismaClientPromise: Promise<any> | null = null;

/**
 * @deprecated Direct database connections are no longer used in tests.
 * All tests should use API endpoints instead.
 * This function is kept for backward compatibility but should not be used.
 *
 * Create or get the shared Prisma client for testing
 * Reuses a single client instance to minimize database connections
 * Uses retry logic with exponential backoff for connection resilience
 */
async function createTestPrismaClient(): Promise<any> {
  // Use dynamic import to avoid ESM module resolution issues
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  let dbUrl = await getDatabaseUrl();
  if (!dbUrl) {
    throw new Error(
      "DATABASE_URL or DIRECT_DATABASE_URL must be set for integration tests",
    );
  }

  // Debug logging for post-deployment tests
  const isPostdeploymentTest =
    process.env.VITEST_CONFIG?.includes("postdeployment") ||
    process.argv.some((arg) => arg.includes("postdeployment"));
  if (isPostdeploymentTest) {
    console.log("[createTestPrismaClient] Post-deployment test detected");
    console.log(
      "[createTestPrismaClient] Database URL (masked):",
      dbUrl.replace(/:[^:@]+@/, ":****@"),
    );
    if (isHyperdriveUrl(dbUrl)) {
      console.error("[createTestPrismaClient] ERROR: Hyperdrive URL detected!");
      console.error(
        "[createTestPrismaClient] Hyperdrive URLs (.hyperdrive.workers.dev) only work in Cloudflare Workers runtime, not in Node.js tests.",
      );
      console.error(
        "[createTestPrismaClient] Use DIRECT_DATABASE_URL with a direct PostgreSQL connection string instead.",
      );
      console.error("[createTestPrismaClient] Environment variables:", {
        DATABASE_URL: process.env.DATABASE_URL?.substring(0, 50) + "...",
        DIRECT_DATABASE_URL:
          process.env.DIRECT_DATABASE_URL?.substring(0, 50) + "...",
      });
      throw new Error(
        "Cannot use Hyperdrive URL in Node.js tests. Hyperdrive URLs (.hyperdrive.workers.dev) only work in Cloudflare Workers runtime. " +
          "Use DIRECT_DATABASE_URL with a direct PostgreSQL connection string instead.",
      );
    }
  }

  // In CI, try fallback to direct port if pooler connection fails
  dbUrl = await getDatabaseUrlWithFallback(dbUrl);
  const finalUrl = ensureSslConnection(dbUrl);

  // Reuse existing client if URL matches
  if (sharedTestPrismaClient && sharedTestPrismaClientUrl === finalUrl) {
    return sharedTestPrismaClient;
  }

  // If another initialization is in progress, wait for it
  if (sharedTestPrismaClientPromise) {
    return await sharedTestPrismaClientPromise;
  }

  // Create new shared client
  sharedTestPrismaClientPromise = (async () => {
    const adapter = new PrismaPg({ connectionString: finalUrl });
    const client = new PrismaClient({
      adapter,
      // Limit connection pool size to prevent exhaustion
      // Use smaller pool for tests since we're reusing a single client
      log: process.env.DEBUG ? ["error", "warn", "query"] : [],
    });

    // Connect to ensure the client is ready
    await client.$connect();

    sharedTestPrismaClient = client;
    sharedTestPrismaClientUrl = finalUrl;
    sharedTestPrismaClientPromise = null;

    return client;
  })();

  return await sharedTestPrismaClientPromise;
}

/**
 * @deprecated Direct database connections are no longer used in tests.
 * All tests should use API endpoints instead.
 * This function is kept for backward compatibility but should not be used.
 *
 * Ensure database migrations are applied
 * This is a safety check to ensure the test database has the required schema
 */
async function ensureMigrationsApplied(db: any): Promise<void> {
  try {
    // Check if follow_privacy column exists
    const followPrivacyCheck = await db.$queryRawUnsafe(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'follow_privacy'
    `);

    // Check if actor_id column exists (ActivityPub fields)
    const actorIdCheck = await db.$queryRawUnsafe(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'actor_id'
    `);

    if (!followPrivacyCheck || followPrivacyCheck.length === 0) {
      // Column doesn't exist, apply migration
      console.log(
        "[ensureMigrationsApplied] Applying follow_privacy migration...",
      );

      // Create enum type if it doesn't exist
      await db.$executeRawUnsafe(`
        DO $$ BEGIN
          CREATE TYPE "Privacy" AS ENUM ('PUBLIC', 'FOLLOWERS', 'PRIVATE');
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `);

      // Add column to users table
      await db.$executeRawUnsafe(`
        ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "follow_privacy" "Privacy" NOT NULL DEFAULT 'PUBLIC';
      `);

      // Add column to entities table
      await db.$executeRawUnsafe(`
        ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "follow_privacy" "Privacy" NOT NULL DEFAULT 'PUBLIC';
      `);

      console.log(
        "[ensureMigrationsApplied] follow_privacy migration applied successfully",
      );
    }

    if (!actorIdCheck || actorIdCheck.length === 0) {
      // ActivityPub columns don't exist, add them as nullable for backward compatibility
      console.log(
        "[ensureMigrationsApplied] Applying ActivityPub columns migration...",
      );

      await db.$executeRawUnsafe(`
        ALTER TABLE "users" 
        ADD COLUMN IF NOT EXISTS "actor_id" TEXT UNIQUE,
        ADD COLUMN IF NOT EXISTS "inbox_url" TEXT,
        ADD COLUMN IF NOT EXISTS "outbox_url" TEXT,
        ADD COLUMN IF NOT EXISTS "followers_url" TEXT,
        ADD COLUMN IF NOT EXISTS "following_url" TEXT,
        ADD COLUMN IF NOT EXISTS "friends_url" TEXT,
        ADD COLUMN IF NOT EXISTS "public_key" TEXT,
        ADD COLUMN IF NOT EXISTS "private_key" TEXT;
      `);

      // Add index for actor_id
      await db.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "users_actor_id_idx" ON "users"("actor_id");
      `);

      console.log(
        "[ensureMigrationsApplied] ActivityPub columns migration applied successfully",
      );
    }
  } catch (error) {
    // If migration fails, log but don't throw - tests might be using a different database setup
    console.warn(
      "[ensureMigrationsApplied] Could not apply migrations (this may be expected):",
      error,
    );
  }
}

/**
 * @deprecated Direct database connections are no longer used in tests.
 * All tests should use API endpoints instead.
 * This function is kept for backward compatibility but should not be used.
 *
 * Cleanup the shared test Prisma client
 * Should be called in test teardown to properly close connections
 */
export async function cleanupTestPrismaClient(): Promise<void> {
  if (sharedTestPrismaClient) {
    try {
      await sharedTestPrismaClient.$disconnect();
    } catch (error) {
      console.warn("[cleanupTestPrismaClient] Error disconnecting:", error);
    }
    sharedTestPrismaClient = null;
    sharedTestPrismaClientUrl = null;
    sharedTestPrismaClientPromise = null;
  }
}

// ---------------------------------------------------------------------------
// SEC L1 — SUPER_ADMIN bootstrap for the `/api/admin/test/*` seam.
// ---------------------------------------------------------------------------

/**
 * Credentials for calling the test-user admin endpoints.
 *
 * ## Why this exists
 *
 * `/api/admin/test/users` used to be callable with no credentials at all: the
 * route skipped authentication for any request whose body `email` contained
 * `test-` or `@test.example.com`, which is precisely the shape this harness
 * sends. That was an unauthenticated SUPER_ADMIN-creation endpoint (security
 * review finding L1), and it is now gated two ways:
 *
 *   1. an explicit environment opt-in (`STAGE=dev`, CI, or
 *      `ENABLE_TEST_ROUTES=true` — the standalone lane sets the last one), and
 *   2. a real authenticated SUPER_ADMIN session, checked before the body is
 *      even parsed, plus CSRF like any other cookie-authenticated write.
 *
 * So the harness now has to be a genuine super-admin instead of relying on the
 * hole. It does that honestly: seed one SUPER_ADMIN row directly in the test
 * database (the harness already owns a Prisma client for schema checks), seal a
 * session cookie for it with the same secret the server uses, then fetch a CSRF
 * token from `/api/csrf-token` exactly as a browser client would.
 *
 * Deliberately NOT done: adding a back door (a shared bootstrap header, a
 * "trusted" env var that skips the session check). Any such seam would be the
 * L1 hole again under a different name.
 */
export interface TestAdminAuth {
  userId: string;
  email: string;
  /** Raw `trellis_session` cookie value for the SUPER_ADMIN. */
  sessionToken: string;
  csrfToken: string;
  /** Ready-to-spread request headers (`Cookie` + `X-CSRF-Token`). */
  headers: Record<string, string>;
}

/**
 * Stable identity for the bootstrap admin, so repeated runs reuse one row
 * instead of littering the database. cuid-shaped (`c[a-z0-9]{24,40}`) so it
 * satisfies every id validator in the stack.
 */
const BOOTSTRAP_ADMIN_ID = "ce2ebootstrapsuperadmin0001";
const BOOTSTRAP_ADMIN_EMAIL = "e2e-bootstrap-admin@test.example.com";
const BOOTSTRAP_ADMIN_HANDLE = "e2e-bootstrap-admin";

let adminAuthPromise: Promise<TestAdminAuth> | null = null;

/**
 * Reset the memoized bootstrap admin. Only useful when a test deliberately
 * invalidates the admin session (e.g. a revocation test).
 */
export function __resetTestAdminAuth(): void {
  adminAuthPromise = null;
}

async function seedBootstrapAdmin(): Promise<void> {
  const db = await createTestPrismaClient();
  await db.user.upsert({
    where: { id: BOOTSTRAP_ADMIN_ID },
    // Re-assert the role on every run: a previous test may have demoted or
    // suspended the row, and a silently non-super-admin bootstrap would fail
    // every later call with an opaque 403.
    update: {
      role: "SUPER_ADMIN",
      suspended: false,
      suspendedAt: null,
      suspendedReason: null,
    },
    create: {
      id: BOOTSTRAP_ADMIN_ID,
      email: BOOTSTRAP_ADMIN_EMAIL,
      handle: BOOTSTRAP_ADMIN_HANDLE,
      role: "SUPER_ADMIN",
    },
  });
}

/**
 * Get (and memoize) the SUPER_ADMIN credentials the test-user endpoints now
 * require. Every caller of `/api/admin/test/*` must spread `.headers`.
 */
export async function getTestAdminAuth(): Promise<TestAdminAuth> {
  if (adminAuthPromise) return adminAuthPromise;

  adminAuthPromise = (async () => {
    const { getApiUrl } = await import("./test-config.js");
    const API_URL = getApiUrl();

    try {
      await seedBootstrapAdmin();
    } catch (error) {
      // Fail loudly and specifically. Without the row, the sealed cookie
      // authenticates to a user the server cannot find, and every subsequent
      // call returns a bare 403 that reads like a bug in the route.
      throw new Error(
        `[test-auth] Could not seed the bootstrap SUPER_ADMIN. The ` +
          `/api/admin/test/* endpoints require a real SUPER_ADMIN session ` +
          `(security fix L1), so the harness needs write access to the test ` +
          `database (DATABASE_URL / DIRECT_DATABASE_URL). Underlying error: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const sealed = await createAuthenticatedSession(
      BOOTSTRAP_ADMIN_ID,
      BOOTSTRAP_ADMIN_EMAIL,
      "SUPER_ADMIN",
    );

    // Ask the server for a CSRF token the same way a browser client does,
    // rather than hand-crafting one into the seal. This also re-issues the
    // session cookie (the server re-seals it with the token), so the updated
    // cookie is the one we keep.
    const { token, updatedSessionToken } = await getCsrfToken(API_URL, sealed);

    return {
      userId: BOOTSTRAP_ADMIN_ID,
      email: BOOTSTRAP_ADMIN_EMAIL,
      sessionToken: updatedSessionToken,
      csrfToken: token,
      headers: {
        Cookie: `trellis_session=${updatedSessionToken}`,
        "X-CSRF-Token": token,
      },
    };
  })();

  try {
    return await adminAuthPromise;
  } catch (error) {
    adminAuthPromise = null; // let a later caller retry
    throw error;
  }
}

/**
 * Create a test user via API (no direct database connection)
 *
 * @param options - Optional user configuration
 * @returns TestUser object with id, email, and role
 */
export async function createTestUser(
  options: {
    email?: string;
    role?: UserRole;
    region?: string;
    dataRegion?: string;
  } = {},
): Promise<TestUser> {
  const { getApiUrl } = await import("./test-config.js");
  const API_URL = getApiUrl();

  const userId = crypto.randomUUID();
  const email =
    options.email ||
    `test-${Date.now()}-${Math.random().toString(36).substring(7)}@test.example.com`;
  const role = options.role || "END_USER";
  const region = options.region || "US";
  const dataRegion = options.dataRegion || region;

  // Create user via API endpoint (no direct DB access)
  // User creation involves region detection, database writes, and session creation
  // New users without cached region require database queries for region detection
  // CRITICAL FIX: Increased timeout based on Cloudflare logs analysis
  // Logs showed queries timing out at 800ms, causing retries and compound delays
  // Increased to provide safety margin while query timeout fixes are deployed
  const isCI =
    process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  const REQUEST_TIMEOUT_MS = isCI ? 15000 : 12000; // 15s in CI, 12s locally (increased from 10s/8s to provide safety margin)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    // SEC L1: the seam now requires a real SUPER_ADMIN session + CSRF.
    const admin = await getTestAdminAuth();
    const response = await fetch(`${API_URL}/api/admin/test/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...admin.headers,
      },
      body: JSON.stringify({
        id: userId,
        email,
        role,
        region,
        dataRegion,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to create test user via API: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const result = await response.json();
    if (!result.success || !result.user) {
      throw new Error(
        `API returned unexpected response: ${JSON.stringify(result)}`,
      );
    }

    return {
      id: result.user.id,
      email: result.user.email,
      role: result.user.role,
    };
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new Error(
        `Test user creation timed out after ${REQUEST_TIMEOUT_MS}ms. ` +
          `This indicates a performance issue with user creation. ` +
          `Check API logs and database connectivity.`,
      );
    }
    throw error;
  }
}

/**
 * Create an authenticated session token for a test user
 *
 * @param userId - User ID (UUID)
 * @param email - User email
 * @param role - User role (defaults to END_USER)
 * @param sessionSecret - Session secret (defaults to test secret or SSM)
 * @returns Encrypted session token that can be used in Cookie header
 */
export async function createAuthenticatedSession(
  userId: string,
  email: string,
  role: UserRole = "END_USER",
  sessionSecret?: string,
): Promise<string> {
  // Get session secret from parameter, environment variable, or default
  // IMPORTANT: For postdeployment tests, we MUST use the same secret as the API
  // The API uses SSM, so we should prefer SSM over env var to match production behavior
  let secret = sessionSecret;

  // Check if this is a postdeployment test
  const isPostdeploymentTest =
    process.env.VITEST_ENV === "postdeployment" ||
    process.argv.some((arg) => arg.includes("postdeployment")) ||
    process.env.CI === "true" ||
    process.env.GITHUB_ACTIONS === "true";

  if (!secret) {
    // For postdeployment tests, try SSM first (same as API)
    // This ensures we use the same secret as the deployed API
    try {
      const { getSsmParameter } = await import("./aws-ssm.js");
      const ssmSecret = await getSsmParameter("SESSION_SECRET", {
        required: isPostdeploymentTest, // Require SSM for postdeployment tests
      });
      if (ssmSecret) {
        secret = ssmSecret;
        console.log(
          "[DEBUG] Using SESSION_SECRET from AWS SSM, length:",
          ssmSecret.length,
          "first 4 chars:",
          ssmSecret.substring(0, 4),
        );
      } else if (isPostdeploymentTest) {
        throw new Error(
          "SESSION_SECRET must be available from AWS SSM for postdeployment tests. " +
            "The test secret will not work with the deployed API. " +
            "Ensure AWS credentials are configured and the parameter exists in SSM.",
        );
      }
    } catch (error) {
      if (isPostdeploymentTest) {
        throw new Error(
          `Failed to fetch SESSION_SECRET from SSM for postdeployment test: ${error instanceof Error ? error.message : String(error)}. ` +
            "Ensure AWS credentials are configured and the parameter exists in SSM.",
        );
      }
      console.warn("[DEBUG] Failed to fetch SESSION_SECRET from SSM:", error);
    }

    // Fallback to environment variable if SSM not available (only for non-postdeployment tests)
    if (!secret && process.env.SESSION_SECRET) {
      const testSecret = "test-secret-key-32-characters-long!!";
      // Skip test secret for postdeployment tests
      if (isPostdeploymentTest && process.env.SESSION_SECRET === testSecret) {
        throw new Error(
          "SESSION_SECRET is set to test secret, but this is a postdeployment test. " +
            "The test secret will not work with the deployed API. " +
            "Ensure AWS credentials are configured to fetch the real secret from SSM.",
        );
      }
      secret = process.env.SESSION_SECRET;
      console.log("[DEBUG] Using SESSION_SECRET from environment variable");
    }

    // Last resort: default test secret (only for unit tests, not postdeployment)
    if (!secret) {
      if (isPostdeploymentTest) {
        throw new Error(
          "SESSION_SECRET is required for postdeployment tests. " +
            "Either set SESSION_SECRET environment variable or configure AWS credentials to fetch from SSM.",
        );
      }
      secret = "test-secret-key-32-characters-long!!";
      console.warn(
        "[DEBUG] Using default test SESSION_SECRET - this will NOT work with deployed API!",
      );
    }
  } else {
    console.log("[DEBUG] Using provided SESSION_SECRET parameter");
  }

  // Use dynamic import to avoid ESM module resolution issues
  const { SessionManager: SessionManagerClass } = await import(
    "../../src/lib/session-cookie.js"
  );
  const sessionManager = new SessionManagerClass();

  // Create session with 1 hour expiration
  const session: Session = {
    userId,
    email,
    role,
    expiresAt: Date.now() + 3600000, // 1 hour from now
    dataRegion: "EU", // Default to EU for test sessions
    sessionType: "user",
    lastActivityAt: Date.now(),
    profileContext: "primary", // Required field
  };

  // Encrypt the session — SESSION_SALT must match the deployed API's value
  let salt = process.env.SESSION_SALT;
  if (!salt) {
    try {
      const { getSsmParameter } = await import("./aws-ssm.js");
      salt = await getSsmParameter("SESSION_SALT", { required: false });
      if (salt) {
        console.log("[DEBUG] Fetched SESSION_SALT from SSM");
      }
    } catch {
      // SSM not available
    }
  }
  const sessionCreationStartTime = Date.now();
  const encrypted = await sessionManager.encryptSession(
    JSON.stringify(session),
    secret,
    salt,
  );
  const sessionCreationDuration = Date.now() - sessionCreationStartTime;
  console.log("[UserCreation] Session creation completed", {
    duration: sessionCreationDuration,
    userId,
  });

  return encrypted;
}

/**
 * Clean up a test user via API (no direct database connection)
 * Attempts deletion from all regions in parallel to handle cross-region test scenarios
 * Uses short timeouts since DB should be very fast (<1s per operation)
 *
 * @param userId - User ID to delete
 */
export async function cleanupTestUser(userId: string): Promise<void> {
  const { getApiUrl } = await import("./test-config.js");
  const API_URL = getApiUrl();

  // DB should be very fast - use short timeout (2 seconds max per request)
  // If it takes longer, something is wrong with the API/DB
  const REQUEST_TIMEOUT_MS = 2000; // 2 seconds - DB should be fast

  // SEC L1: DELETE now requires a real SUPER_ADMIN session + CSRF too — the
  // old route allowed unauthenticated deletion whenever CI was set, and
  // otherwise fell through a "no session in local dev, still allow" branch.
  // Resolved once, outside the per-region fan-out (it is memoized anyway).
  // Cleanup is best-effort by design, so a bootstrap failure degrades to
  // "cleanup skipped with a warning" rather than failing an otherwise green
  // test's teardown.
  let adminHeaders: Record<string, string> = {};
  try {
    adminHeaders = (await getTestAdminAuth()).headers;
  } catch (error) {
    console.warn(
      `[cleanupTestUser] Could not obtain SUPER_ADMIN credentials; skipping cleanup of ${userId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  // Try deleting from all regions in parallel for speed
  // Test users may exist in different regions, so we try all
  const regions = ["US", "EU", "CN"];

  // Create parallel deletion attempts
  const deletionPromises = regions.map(async (region) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      try {
        // Try deleting with region hint (if API supports it)
        const response = await fetch(
          `${API_URL}/api/admin/test/users/${userId}?region=${region}`,
          {
            method: "DELETE",
            headers: adminHeaders,
            signal: controller.signal,
          },
        );

        clearTimeout(timeoutId);

        // 200, 204, or 404 are all acceptable (user deleted or doesn't exist)
        if (response.ok || response.status === 404) {
          return { region, success: true };
        }

        // For other errors, log but don't fail
        if (response.status !== 404) {
          const errorText = await response.text().catch(() => "");
          console.warn(
            `Failed to cleanup test user ${userId} from ${region} via API: ${response.status} ${response.statusText} - ${errorText}`,
          );
        }
        return { region, success: false };
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === "AbortError") {
          // Timeout indicates API/DB performance issue - this should not happen
          throw new Error(
            `Test user cleanup timed out after ${REQUEST_TIMEOUT_MS}ms for user ${userId} in region ${region}. ` +
              `DB should be very fast - this indicates a serious API/DB performance issue.`,
          );
        }
        // For other errors, log but don't fail
        console.warn(
          `Error cleaning up test user ${userId} from ${region}:`,
          fetchError.message,
        );
        return { region, success: false };
      }
    } catch (error: any) {
      // Re-throw timeout errors, but log others
      if (error.message?.includes("timed out")) {
        throw error;
      }
      console.warn(
        `Failed to cleanup test user ${userId} from ${region}:`,
        error.message,
      );
      return { region, success: false };
    }
  });

  // Also try without region parameter in parallel
  const noRegionPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      try {
        const response = await fetch(
          `${API_URL}/api/admin/test/users/${userId}`,
          {
            method: "DELETE",
            headers: adminHeaders,
            signal: controller.signal,
          },
        );

        clearTimeout(timeoutId);

        // 200, 204, or 404 are acceptable
        if (response.ok || response.status === 404) {
          return { success: true };
        }
        return { success: false };
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === "AbortError") {
          throw new Error(
            `Test user cleanup timed out after ${REQUEST_TIMEOUT_MS}ms for user ${userId} (no region). ` +
              `DB should be very fast - this indicates a serious API/DB performance issue.`,
          );
        }
        console.warn(
          `Error cleaning up test user ${userId} (no region):`,
          fetchError.message,
        );
        return { success: false };
      }
    } catch (error: any) {
      if (error.message?.includes("timed out")) {
        throw error;
      }
      console.warn(`Failed to cleanup test user ${userId}:`, error.message);
      return { success: false };
    }
  })();

  // Wait for all deletions in parallel (should complete in <2s if DB is fast)
  try {
    await Promise.allSettled([...deletionPromises, noRegionPromise]);
  } catch (error: any) {
    // If any timeout error occurred, re-throw it
    if (error.message?.includes("timed out")) {
      throw error;
    }
    // Other errors are non-fatal for cleanup
  }
}

/**
 * Create a test user with an authenticated session in one call
 *
 * @param options - Optional user configuration
 * @returns Object with testUser and sessionToken
 */
export async function createTestUserWithSession(
  options: {
    email?: string;
    role?: UserRole;
    region?: string;
    dataRegion?: string;
    sessionSecret?: string;
  } = {},
): Promise<{ testUser: TestUser; sessionToken: string }> {
  // Ensure dataRegion matches region if both are provided
  const region = options.region || "US";
  const dataRegion = options.dataRegion || region;

  const { getApiUrl } = await import("./test-config.js");
  const API_URL = getApiUrl();

  const userId = crypto.randomUUID();
  const email =
    options.email ||
    `test-${Date.now()}-${Math.random().toString(36).substring(7)}@test.example.com`;
  const role = options.role || "END_USER";

  const isCI =
    process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  const REQUEST_TIMEOUT_MS = isCI ? 15000 : 12000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    // SEC L1: the seam now requires a real SUPER_ADMIN session + CSRF.
    const admin = await getTestAdminAuth();
    const response = await fetch(`${API_URL}/api/admin/test/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...admin.headers,
      },
      body: JSON.stringify({
        id: userId,
        email,
        role,
        region,
        dataRegion,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to create test user via API: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const result = await response.json();
    if (!result.success || !result.user) {
      throw new Error(
        `API returned unexpected response: ${JSON.stringify(result)}`,
      );
    }

    // Extract session token from Set-Cookie header (server-side session creation)
    const setCookieHeader = response.headers.get("Set-Cookie") || "";
    const sessionMatch = setCookieHeader.match(/trellis_session=([^;]+)/);

    let sessionToken: string;
    if (sessionMatch) {
      sessionToken = sessionMatch[1];
      console.log("[UserCreation] Session token from server cookie");
    } else {
      // Fallback: create session locally (for backward compatibility with older API versions)
      console.warn(
        "[UserCreation] No session cookie in response, falling back to local session creation",
      );
      sessionToken = await createAuthenticatedSession(
        result.user.id,
        result.user.email,
        result.user.role,
        options.sessionSecret,
      );
    }

    console.log("[UserCreation] Session creation completed", {
      duration: 0,
      userId: result.user.id,
    });

    return {
      testUser: {
        id: result.user.id,
        email: result.user.email,
        role: result.user.role,
      },
      sessionToken,
    };
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new Error(
        `Test user creation timed out after ${REQUEST_TIMEOUT_MS}ms. ` +
          `This indicates a performance issue with user creation. ` +
          `Check API logs and database connectivity.`,
      );
    }
    throw error;
  }
}

/**
 * Create an authenticated fetch request helper
 *
 * @param url - Request URL
 * @param sessionToken - Session token
 * @param options - Additional fetch options
 * @returns Fetch Response
 */
export async function authenticatedFetch(
  url: string,
  sessionToken: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `trellis_session=${sessionToken}`,
    },
  });
}

/**
 * Extract session token from a response's Set-Cookie header.
 * Returns the original session token if no cookie is present.
 */
export function extractSessionFromResponse(
  response: Response,
  fallbackSessionToken: string,
): string {
  const setCookieHeader = response.headers.get("Set-Cookie") || "";
  const match = setCookieHeader.match(/trellis_session=([^;]+)/);
  return match ? match[1] : fallbackSessionToken;
}

/**
 * Get a CSRF token for authenticated state-changing requests.
 *
 * CRITICAL: This function returns an updated session token from the Set-Cookie
 * header. You MUST use the returned updatedSessionToken for all subsequent
 * requests — the server re-encrypts the session when it generates the CSRF
 * token, so the old session cookie no longer contains the token.
 *
 * See doc/02-technical/development/misc/csrf-guide.md for details.
 */
export async function getCsrfToken(
  apiUrl: string,
  sessionToken: string,
): Promise<{ token: string; updatedSessionToken: string }> {
  const response = await authenticatedFetch(
    `${apiUrl}/api/csrf-token`,
    sessionToken,
    { method: "GET" },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to get CSRF token: ${response.status} ${errorText}`,
    );
  }

  const body = await response.json();
  const updatedSessionToken = extractSessionFromResponse(response, sessionToken);

  return { token: body.token, updatedSessionToken };
}
