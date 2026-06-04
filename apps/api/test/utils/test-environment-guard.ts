/**
 * Test Environment Guard Utilities
 *
 * Provides utilities to prevent tests from running in production.
 * Use these utilities to ensure tests that modify data or create test users
 * never run against production databases.
 *
 * Best Practices:
 * 1. Use `describe.skipIf(isProduction())` at the suite level
 * 2. Use `requireDevEnvironment()` in beforeAll hooks for extra safety
 * 3. Add environment checks in CI/CD pipelines
 * 4. Use separate test configs for different environments
 */

/**
 * Get the current environment
 */
export function getEnvironment(): string {
  return process.env.ENVIRONMENT || process.env.DEPLOY_ENV || "dev";
}

/**
 * Check if running in production
 */
export function isProduction(): boolean {
  return getEnvironment().toLowerCase() === "prod";
}

/**
 * Check if running in development
 */
export function isDevelopment(): boolean {
  return getEnvironment().toLowerCase() === "dev";
}

/**
 * Require development environment - throws error if not in dev
 * Use this in beforeAll hooks for extra safety
 */
export function requireDevEnvironment(): void {
  const env = getEnvironment();
  if (env.toLowerCase() !== "dev") {
    throw new Error(
      `❌ SAFETY CHECK FAILED: This test must NEVER run on production. ` +
        `Current environment: "${env}". ` +
        `Set ENVIRONMENT=dev or DEPLOY_ENV=dev to run this test. ` +
        `Aborting to prevent accidental production data modification.`,
    );
  }
}

/**
 * Require specific environment - throws error if not in specified environment
 */
export function requireEnvironment(allowedEnvironments: string[]): void {
  const env = getEnvironment().toLowerCase();
  const allowed = allowedEnvironments.map((e) => e.toLowerCase());

  if (!allowed.includes(env)) {
    throw new Error(
      `❌ SAFETY CHECK FAILED: This test can only run in: ${allowedEnvironments.join(", ")}. ` +
        `Current environment: "${env}". ` +
        `Aborting to prevent running in unsupported environment.`,
    );
  }
}

/**
 * Skip test if in production (for use with describe.skipIf or it.skipIf)
 */
export function skipInProduction(): boolean {
  return isProduction();
}

/**
 * Skip test if not in development (for use with describe.skipIf or it.skipIf)
 */
export function skipIfNotDev(): boolean {
  return !isDevelopment();
}

/**
 * True only for operations that are genuinely unsafe on production:
 * - Irreversible actions (account deletion confirmation)
 * - Admin state mutations (role changes, feature flags)
 * - Rate-limit exhaustion (flood tests)
 *
 * All other tests (including CRUD with test users) run on all envs.
 * Use with describe.skipIf(isProdExcluded()) for the small set of tests
 * that must never run on production.
 */
export function isProdExcluded(): boolean {
  return isProduction();
}
