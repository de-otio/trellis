/**
 * Test Configuration Utilities
 *
 * Provides configuration values for tests, including API URL and Frontend URL.
 * Automatically loads from config.yaml based on TEST_ENV environment variable.
 *
 * Usage:
 * ```typescript
 * import { TestConfig } from './utils/test-config';
 *
 * // In test setup
 * await TestConfig.validate();
 * const apiUrl = TestConfig.getApiUrl();
 * const frontendUrl = TestConfig.getFrontendUrl();
 * ```
 */

import { createRequire } from "module";

// `apps/api` is ESM ("type": "module"), so Node's `require` is not available by default.
// Many of our test utilities read YAML via CommonJS-only packages; use `createRequire` for that.
const require = createRequire(import.meta.url);

/**
 * Test configuration helper class
 * Provides centralized access to test configuration with validation
 */
export class TestConfig {
  private static _apiUrl: string | null = null;
  private static _frontendUrl: string | null = null;

  /**
   * Get API URL for tests
   * Caches the result for subsequent calls
   */
  static getApiUrl(): string {
    if (this._apiUrl === null) {
      this._apiUrl = getApiUrl();
    }
    return this._apiUrl;
  }

  /**
   * Get Frontend URL for tests
   * Caches the result for subsequent calls
   */
  static getFrontendUrl(): string {
    if (this._frontendUrl === null) {
      this._frontendUrl = getFrontendUrl();
    }
    return this._frontendUrl;
  }

  /**
   * Validate that configured URLs are accessible
   * Should be called in test.beforeAll() or test setup
   *
   * @throws {Error} If URLs are not accessible or not configured properly
   */
  static async validate(): Promise<void> {
    const apiUrl = this.getApiUrl();
    const frontendUrl = this.getFrontendUrl();

    // Check if using defaults (which may not be appropriate for e2e tests)
    const isE2ETest =
      process.env.VITEST_ENV === "e2e" ||
      process.argv.some((arg) => arg.includes("e2e")) ||
      process.argv.some((arg) => arg.includes("playwright"));

    if (isE2ETest) {
      // For e2e tests, warn if using localhost defaults
      if (
        apiUrl === "http://localhost:8787" ||
        frontendUrl === "http://localhost:3000"
      ) {
        const errorMessage = `
❌ E2E Test Configuration Error:

E2E tests require deployed URLs, but localhost defaults were detected.

Current configuration:
  API: ${apiUrl}
  Frontend: ${frontendUrl}

To fix, set one of:
  - TEST_ENV=dev (auto-loads from environments/dev/config.yaml)
  - API_URL=https://api.rkm1.de FRONTEND_URL=https://www.rkm1.de
  - API_DOMAIN=api.rkm1.de WWW_DOMAIN=www.rkm1.de

Example:
  export TEST_ENV=dev
  npm run test:e2e
        `;
        throw new Error(errorMessage);
      }
    }

    // Validate URLs are accessible
    await validateTestUrls(apiUrl, frontendUrl);
  }

  /**
   * Reset cached URLs (useful for testing)
   */
  static reset(): void {
    this._apiUrl = null;
    this._frontendUrl = null;
  }
}

/**
 * Load configuration from config.yaml file
 *
 * @param environment - Environment name (dev, prod, etc.)
 * @returns Configuration object or null if not found
 */
function loadConfigFromYaml(environment: string): any | null {
  try {
    const fs = require("fs");
    const path = require("path");
    const yaml = require("js-yaml");

    // Try multiple possible paths (from apps/api or from root)
    const possiblePaths = [
      path.join(process.cwd(), "environments", environment, "config.yaml"),
      path.resolve(
        process.cwd(),
        "..",
        "..",
        "environments",
        environment,
        "config.yaml",
      ),
      path.resolve(process.cwd(), "environments", environment, "config.yaml"),
    ];

    for (const configPath of possiblePaths) {
      if (fs.existsSync(configPath)) {
        const config = yaml.load(fs.readFileSync(configPath, "utf8"));
        console.log(`[test-config] Loaded config from: ${configPath}`);
        return config;
      }
    }

    return null;
  } catch (error) {
    console.warn(
      `[test-config] Error reading config.yaml: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Get the API URL for tests
 *
 * Priority:
 * 1. API_URL environment variable (explicit override)
 * 2. DEPLOYED_API_URL environment variable
 * 3. Construct from API_DOMAIN environment variable
 * 4. Construct from APP_DOMAIN environment variable
 * 5. Load from config.yaml (based on TEST_ENV or ENVIRONMENT)
 * 6. For postdeployment tests: Read from config.yaml (legacy)
 * 7. Default: http://localhost:8787 (local development only)
 *
 * @throws {Error} For postdeployment tests, throws if API URL cannot be determined
 */
export function getApiUrl(): string {
  // Check for explicit API_URL first (highest priority)
  if (process.env.API_URL) {
    console.log(
      `[test-config] Using API_URL from environment: ${process.env.API_URL}`,
    );
    return process.env.API_URL;
  }

  // Check for DEPLOYED_API_URL
  if (process.env.DEPLOYED_API_URL) {
    console.log(
      `[test-config] Using DEPLOYED_API_URL from environment: ${process.env.DEPLOYED_API_URL}`,
    );
    return process.env.DEPLOYED_API_URL;
  }

  // Try to construct from API_DOMAIN
  if (process.env.API_DOMAIN) {
    const apiUrl = `https://${process.env.API_DOMAIN}`;
    console.log(`[test-config] Constructed API_URL from API_DOMAIN: ${apiUrl}`);
    return apiUrl;
  }

  // Try to construct from APP_DOMAIN (but skip test.example.com as it's not a real dev server)
  // For dev environment, prefer api.rkm1.de if APP_DOMAIN is test.example.com
  if (process.env.APP_DOMAIN) {
    if (process.env.APP_DOMAIN.includes("test.example.com")) {
      // test.example.com is not a real dev server, use api.rkm1.de instead
      const devApiUrl = "https://api.rkm1.de";
      console.log(
        `[test-config] APP_DOMAIN is test.example.com (not a real server), using dev API: ${devApiUrl}`,
      );
      return devApiUrl;
    }
    console.log(
      `[test-config] Using APP_DOMAIN from environment: ${process.env.APP_DOMAIN}`,
    );
    return process.env.APP_DOMAIN;
  }

  // Try to load from config.yaml (for all tests, not just postdeployment)
  // Use TEST_ENV, ENVIRONMENT, or DEPLOY_ENV to determine environment
  const environment =
    process.env.TEST_ENV ||
    process.env.ENVIRONMENT ||
    process.env.DEPLOY_ENV ||
    "dev";

  const config = loadConfigFromYaml(environment);
  if (config?.API_DOMAIN) {
    const apiUrl = `https://${config.API_DOMAIN}`;
    console.log(
      `[test-config] Found API_DOMAIN in config.yaml (env: ${environment}): ${config.API_DOMAIN}`,
    );
    console.log(`[test-config] Using API_URL: ${apiUrl}`);
    return apiUrl;
  }

  // For postdeployment tests, fail fast if API URL cannot be determined
  const isPostdeploymentTest =
    process.env.VITEST_ENV === "postdeployment" ||
    process.argv.some((arg) => arg.includes("postdeployment"));

  if (isPostdeploymentTest) {
    const errorMessage = `
❌ ERROR: Cannot determine API URL for postdeployment tests.

Postdeployment tests require a deployed API to test against. Please set one of:
  - API_URL environment variable (e.g., export API_URL="https://api.rkm1.de")
  - DEPLOYED_API_URL environment variable
  - API_DOMAIN environment variable (will be prefixed with https://)
  - APP_DOMAIN environment variable
  - TEST_ENV environment variable (e.g., export TEST_ENV="dev" to load from config.yaml)
  - Ensure config.yaml exists at: environments/${environment}/config.yaml

Current environment: ${environment}
Working directory: ${process.cwd()}

For local testing against deployed API:
  export TEST_ENV="dev"
  # or
  export API_URL="https://api.rkm1.de"
  npm run test:postdeployment

For CI/CD: Ensure the workflow sets TEST_ENV or API_URL after deployment.
`;

    console.error(errorMessage);
    throw new Error(
      "API URL cannot be determined for postdeployment tests. Set API_URL, DEPLOYED_API_URL, API_DOMAIN, APP_DOMAIN, or TEST_ENV environment variable.",
    );
  }

  // Default: local development (only for non-postdeployment tests)
  const defaultUrl = "http://localhost:8787";

  // Check if this is an e2e test (which should not use localhost)
  const isE2ETest =
    process.env.VITEST_ENV === "e2e" ||
    process.argv.some((arg) => arg.includes("e2e")) ||
    process.argv.some((arg) => arg.includes("playwright"));

  if (isE2ETest) {
    const errorMessage = `
❌ E2E Test Configuration Error:

Cannot determine API URL for e2e tests. E2E tests require deployed URLs.

Please set one of:
  - TEST_ENV=dev (loads from environments/dev/config.yaml) - RECOMMENDED
  - API_URL=https://api.rkm1.de
  - API_DOMAIN=api.rkm1.de
  - DEPLOYED_API_URL=https://api.rkm1.de

Current environment: ${environment}
Working directory: ${process.cwd()}

Quick fix:
  export TEST_ENV="dev"
  npm run test:e2e

For CI/CD: Ensure the workflow sets TEST_ENV or API_URL after deployment.
    `;
    console.error(errorMessage);
    throw new Error(
      "API URL cannot be determined for e2e tests. Set TEST_ENV, API_URL, API_DOMAIN, or DEPLOYED_API_URL environment variable.",
    );
  }

  console.warn(
    `[test-config] No API URL configured, using default: ${defaultUrl}`,
  );
  console.warn(
    `[test-config] To use deployed API, set one of:
  - TEST_ENV=dev (loads from environments/dev/config.yaml)
  - API_URL=https://api.rkm1.de
  - API_DOMAIN=api.rkm1.de`,
  );
  return defaultUrl;
}

/**
 * Get the Frontend URL for tests
 *
 * Priority:
 * 1. FRONTEND_URL environment variable (explicit override)
 * 2. WWW_URL environment variable
 * 3. Construct from WWW_DOMAIN environment variable
 * 4. Load from config.yaml (based on TEST_ENV or ENVIRONMENT)
 * 5. Derive from API URL (fallback)
 * 6. Default: http://localhost:3000 (local development only)
 */
export function getFrontendUrl(): string {
  // Check for explicit FRONTEND_URL first (highest priority)
  if (process.env.FRONTEND_URL) {
    console.log(
      `[test-config] Using FRONTEND_URL from environment: ${process.env.FRONTEND_URL}`,
    );
    return process.env.FRONTEND_URL;
  }

  // Check for WWW_URL
  if (process.env.WWW_URL) {
    console.log(
      `[test-config] Using WWW_URL from environment: ${process.env.WWW_URL}`,
    );
    return process.env.WWW_URL;
  }

  // Try to construct from WWW_DOMAIN
  if (process.env.WWW_DOMAIN) {
    const frontendUrl = `https://${process.env.WWW_DOMAIN}`;
    console.log(
      `[test-config] Constructed FRONTEND_URL from WWW_DOMAIN: ${frontendUrl}`,
    );
    return frontendUrl;
  }

  // Try to load from config.yaml
  const environment =
    process.env.TEST_ENV ||
    process.env.ENVIRONMENT ||
    process.env.DEPLOY_ENV ||
    "dev";

  const config = loadConfigFromYaml(environment);
  if (config?.WWW_DOMAIN) {
    const frontendUrl = `https://${config.WWW_DOMAIN}`;
    console.log(
      `[test-config] Found WWW_DOMAIN in config.yaml (env: ${environment}): ${config.WWW_DOMAIN}`,
    );
    console.log(`[test-config] Using FRONTEND_URL: ${frontendUrl}`);
    return frontendUrl;
  }

  // Fallback: Try to derive from API URL
  const apiUrl = getApiUrl();
  if (apiUrl && apiUrl !== "http://localhost:8787") {
    // Try common patterns
    if (apiUrl.includes("api.rkm1.de")) {
      return "https://www.rkm1.de";
    }
    if (apiUrl.includes("api.example.com")) {
      return "https://www.example.com";
    }
    // Generic fallback: strip api. subdomain (site is at apex, not www)
    const frontendUrl = apiUrl.replace(/\/api$/, "").replace(/api\./, "");
    if (frontendUrl !== apiUrl) {
      console.log(
        `[test-config] Derived FRONTEND_URL from API_URL: ${frontendUrl}`,
      );
      return frontendUrl;
    }
  }

  // Default: local development
  const defaultUrl = "http://localhost:3000";

  // Check if this is an e2e test (which should not use localhost)
  const isE2ETest =
    process.env.VITEST_ENV === "e2e" ||
    process.argv.some((arg) => arg.includes("e2e")) ||
    process.argv.some((arg) => arg.includes("playwright"));

  if (isE2ETest) {
    const errorMessage = `
❌ E2E Test Configuration Error:

Cannot determine Frontend URL for e2e tests. E2E tests require deployed URLs.

Please set one of:
  - TEST_ENV=dev (loads from environments/dev/config.yaml) - RECOMMENDED
  - FRONTEND_URL=https://www.rkm1.de
  - WWW_DOMAIN=www.rkm1.de
  - WWW_URL=https://www.rkm1.de

Current environment: ${environment}
Working directory: ${process.cwd()}

Quick fix:
  export TEST_ENV="dev"
  npm run test:e2e

For CI/CD: Ensure the workflow sets TEST_ENV or FRONTEND_URL after deployment.
    `;
    console.error(errorMessage);
    throw new Error(
      "Frontend URL cannot be determined for e2e tests. Set TEST_ENV, FRONTEND_URL, WWW_DOMAIN, or WWW_URL environment variable.",
    );
  }

  console.warn(
    `[test-config] No FRONTEND_URL configured, using default: ${defaultUrl}`,
  );
  console.warn(
    `[test-config] To use deployed frontend, set one of:
  - TEST_ENV=dev (loads from environments/dev/config.yaml)
  - FRONTEND_URL=https://www.rkm1.de
  - WWW_DOMAIN=www.rkm1.de`,
  );
  return defaultUrl;
}

/**
 * Validate that URLs are accessible
 *
 * @param apiUrl - API URL to validate
 * @param frontendUrl - Frontend URL to validate
 * @throws {Error} If URLs are not accessible
 */
export async function validateTestUrls(
  apiUrl?: string,
  frontendUrl?: string,
): Promise<void> {
  const api = apiUrl || getApiUrl();
  const frontend = frontendUrl || getFrontendUrl();

  const errors: string[] = [];

  // Validate API URL
  try {
    const apiResponse = await fetch(`${api}/api/health`, {
      method: "HEAD",
      signal: AbortSignal.timeout(10000),
    });
    if (!apiResponse.ok && apiResponse.status !== 404) {
      errors.push(`API health check failed: ${apiResponse.status}`);
    }
  } catch (error) {
    // Health endpoint may not exist, try root
    try {
      const rootResponse = await fetch(api, {
        method: "HEAD",
        signal: AbortSignal.timeout(10000),
      });
      if (!rootResponse.ok) {
        errors.push(
          `API not accessible: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } catch (rootError) {
      errors.push(
        `API not accessible: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Validate Frontend URL
  try {
    const frontendResponse = await fetch(frontend, {
      method: "HEAD",
      signal: AbortSignal.timeout(10000),
    });
    if (!frontendResponse.ok) {
      errors.push(`Frontend not accessible: ${frontendResponse.status}`);
    }
  } catch (error) {
    errors.push(
      `Frontend not accessible: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (errors.length > 0) {
    const errorMessage = `
❌ URL Validation Failed:

${errors.join("\n")}

Configured URLs:
  API: ${api}
  Frontend: ${frontend}

Please verify:
  1. URLs are correct
  2. Services are deployed and accessible
  3. Network connectivity is available
  4. Set TEST_ENV environment variable to load from config.yaml
    `;
    throw new Error(errorMessage);
  }

  console.log(`[test-config] ✅ URL validation passed`);
  console.log(`[test-config]   API: ${api}`);
  console.log(`[test-config]   Frontend: ${frontend}`);
}
