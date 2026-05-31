/**
 * E2E test setup — runs once before all e2e test files.
 *
 * Validates that API_URL is set and reachable.
 * Logs the environment and safety classification.
 */

import { getApiUrl } from "../utils/test-config.js";
import { getEnvironment, isProduction } from "../utils/test-environment-guard.js";

const env = getEnvironment();
const apiUrl = getApiUrl();

console.log(`\n[e2e] Environment: ${env}`);
console.log(`[e2e] API URL: ${apiUrl}`);

if (isProduction()) {
  console.log(`[e2e] ⚠️  Running in PROD mode — only prod-safe (read-only) tests will execute`);
} else {
  console.log(`[e2e] Running in DEV mode — all tests will execute`);
}

// Quick health check to fail fast if API is unreachable
try {
  const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`Health check returned ${res.status}`);
  }
  console.log(`[e2e] Health check passed\n`);
} catch (err) {
  console.error(`[e2e] ❌ API at ${apiUrl} is not reachable. Aborting e2e tests.`);
  console.error(`[e2e] ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
