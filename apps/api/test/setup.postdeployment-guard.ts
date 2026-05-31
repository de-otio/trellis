/**
 * Postdeployment Test Safety Guard
 *
 * This file MUST be the first entry in setupFiles for vitest.postdeployment.config.ts.
 * It runs before setup.ts (which overrides ENVIRONMENT to "dev"), so it can reliably
 * read DEPLOY_ENV from the CI workflow environment.
 *
 * CRITICAL: Postdeployment tests create and modify data (test users, posts, follows, etc.).
 * They must NEVER run against production.
 */

const deployEnv = (
  process.env.DEPLOY_ENV ||
  process.env.TEST_ENV ||
  process.env.ENVIRONMENT ||
  "dev"
).toLowerCase();

if (deployEnv === "prod" || deployEnv === "production") {
  throw new Error(
    `\n\n` +
      `╔══════════════════════════════════════════════════════════════════╗\n` +
      `║          ❌  POSTDEPLOYMENT TEST SAFETY GUARD TRIGGERED          ║\n` +
      `╠══════════════════════════════════════════════════════════════════╣\n` +
      `║                                                                  ║\n` +
      `║  Postdeployment integration tests MUST NEVER run on production.  ║\n` +
      `║  These tests create test users, posts, follows, and other data   ║\n` +
      `║  that would pollute or corrupt a production database.            ║\n` +
      `║                                                                  ║\n` +
      `║  Detected environment: "${deployEnv}"                            ║\n` +
      `║  (from DEPLOY_ENV / TEST_ENV / ENVIRONMENT)                     ║\n` +
      `║                                                                  ║\n` +
      `║  To run these tests, set DEPLOY_ENV=dev (or omit it entirely).  ║\n` +
      `╚══════════════════════════════════════════════════════════════════╝\n`,
  );
}

console.log(
  `[setup.postdeployment-guard] ✅ Environment check passed: "${deployEnv}"`,
);
