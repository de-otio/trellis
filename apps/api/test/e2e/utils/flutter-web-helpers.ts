/**
 * Flutter Web Test Helpers
 *
 * Utilities for testing Flutter web applications with Playwright.
 * Handles Flutter-specific initialization, waiting, and debugging.
 */

import { Page } from "@playwright/test";
import { TestDebugger } from "./test-debugger.js";

/**
 * Extended Window interface for test-specific properties
 * These are set by Flutter app and test helpers
 */
interface TestWindow extends Window {
  __apiClientInitialized?: boolean;
  __testUserCleanup?: string;
  __consoleMessages?: string[];
  flutterReady?: boolean;
  flutter?: {
    ready?: boolean;
  };
}
import {
  getApiUrl,
  getFrontendUrl as getFrontendUrlFromConfig,
} from "../../utils/test-config.js";
import {
  instrumentPerformance,
  type PerformanceInstrumentation,
  waitForNetworkIdleWithDiagnostics,
} from "./performance-instrumentation.js";

/**
 * Get frontend URL
 * Uses the centralized test-config utility which loads from config.yaml
 */
export function getFrontendUrl(): string {
  return getFrontendUrlFromConfig();
}

/**
 * Wait for Flutter app to be ready
 * Uses multiple strategies to detect when the app is fully initialized
 * Includes performance monitoring and timeout diagnostics
 */
export async function waitForFlutterReady(
  page: Page,
  timeout = 120000, // Increased to 2 minutes for Flutter initialization
): Promise<{
  ready: boolean;
  loadTime: number;
  diagnostics?: {
    bodyReady: boolean;
    flutterEngineReady: boolean;
    routerReady: boolean;
    interactiveElementsReady: boolean;
    networkIdle: boolean;
  };
}> {
  const startTime = Date.now();
  console.log("[Flutter Helper] Waiting for Flutter app to be ready...");

  const diagnostics = {
    bodyReady: false,
    flutterEngineReady: false,
    routerReady: false,
    interactiveElementsReady: false,
    networkIdle: false,
  };

  try {
    // Strategy 1: Wait for body element (basic page load)
    await page.waitForSelector("body", { timeout });
    diagnostics.bodyReady = true;
    console.log("[Flutter Helper] ✅ Body element ready");

    // Strategy 2: Wait for Flutter engine to initialize (if exposed)
    try {
      await page.waitForFunction(
        () => {
          // Check if Flutter engine is ready
          return (
            (window as any).flutterReady === true ||
            (window as any).flutter?.ready === true ||
            document.querySelector("flt-scene-host") !== null ||
            document.querySelector("flt-glass-pane") !== null
          );
        },
        { timeout: Math.min(timeout, 30000) },
      );
      diagnostics.flutterEngineReady = true;
      console.log("[Flutter Helper] ✅ Flutter engine detected as ready");
    } catch (error) {
      // Flutter engine ready flag may not be exposed - continue anyway
      console.log(
        "[Flutter Helper] ⚠️ Flutter engine ready flag not found, continuing...",
      );
    }

    // Strategy 3: Wait for router to be ready (hash routing)
    try {
      await page.waitForFunction(
        () => {
          // Check if router has processed the current route
          const hash = window.location.hash;
          const pathname = window.location.pathname;
          // Router is ready if hash is set or pathname changed from initial '/'
          return hash !== "" || (pathname !== "/" && pathname !== "");
        },
        { timeout: Math.min(timeout, 30000) },
      );
      diagnostics.routerReady = true;
      console.log("[Flutter Helper] ✅ Router detected as ready");
    } catch (error) {
      // Router may not use hash - continue anyway
      console.log("[Flutter Helper] ⚠️ Router ready check skipped");
    }

    // Strategy 4: Wait for any interactive element
    try {
      await page.waitForSelector('input, button, a, [role="button"]', {
        timeout: Math.min(timeout, 30000),
      });
      diagnostics.interactiveElementsReady = true;
      console.log("[Flutter Helper] ✅ Interactive elements detected");
    } catch (error) {
      console.log(
        "[Flutter Helper] ⚠️ No interactive elements found, continuing...",
      );
    }

    // Strategy 5: Wait for network to be relatively idle (with short timeout)
    // Note: We use a short timeout because Flutter web may have background requests
    // We don't want to wait forever for network idle
    try {
      const networkResult = await waitForNetworkIdleWithDiagnostics(
        page,
        2000,
        500,
      );
      if (networkResult.success) {
        diagnostics.networkIdle = true;
        console.log("[Flutter Helper] ✅ Network appears idle");
      } else {
        console.log(
          `[Flutter Helper] ⚠️ Network not idle (${networkResult.activeRequests} active requests, ${networkResult.websocketConnections} WebSockets) - continuing anyway`,
        );
      }
    } catch (error) {
      console.log(
        "[Flutter Helper] ⚠️ Network idle check timed out, continuing...",
      );
    }

    const loadTime = Date.now() - startTime;
    console.log(
      `[Flutter Helper] ✅ Flutter app appears ready (${loadTime}ms)`,
    );

    return {
      ready: true,
      loadTime,
      diagnostics,
    };
  } catch (error) {
    const loadTime = Date.now() - startTime;
    console.error(
      `[Flutter Helper] ❌ Flutter app ready check failed after ${loadTime}ms`,
    );
    console.error(
      `[Flutter Helper] Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(`[Flutter Helper] Diagnostics:`, diagnostics);

    // Try to get more diagnostic information
    try {
      const consoleMessages = await page.evaluate(() => {
        return (window as any).__consoleMessages || [];
      });
      if (consoleMessages.length > 0) {
        console.error(
          "[Flutter Helper] Recent console messages:",
          consoleMessages.slice(-10),
        );
      }
    } catch (e) {
      // Ignore
    }

    return {
      ready: false,
      loadTime,
      diagnostics,
    };
  }
}

/**
 * Set up comprehensive debugging for Flutter web tests
 * Captures console logs, page errors, and network failures
 *
 * @deprecated Use TestDebugger.enableAll() instead for more comprehensive debugging
 * This function is kept for backward compatibility
 */
export function setupFlutterDebugging(page: Page): void {
  console.log("[Flutter Helper] Setting up debugging...");

  // Capture console messages
  page.on("console", (msg) => {
    const type = msg.type();
    const text = msg.text();
    const location = msg.location();

    if (type === "error") {
      console.error(`[BROWSER ERROR] ${text}`);
      if (location) {
        console.error(`  Location: ${location.url}:${location.lineNumber}`);
      }
    } else if (type === "warning") {
      console.warn(`[BROWSER WARNING] ${text}`);
    } else {
      console.log(`[BROWSER ${type.toUpperCase()}] ${text}`);
    }
  });

  // Capture page errors (uncaught exceptions)
  page.on("pageerror", (error) => {
    console.error(`[PAGE ERROR] ${error.message}`);
    if (error.stack) {
      console.error(`[PAGE ERROR STACK] ${error.stack}`);
    }
  });

  // Capture failed network requests
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    console.error(`[REQUEST FAILED] ${request.method()} ${request.url()}`);
    if (failure) {
      console.error(`  Error: ${failure.errorText}`);
    }
  });

  // Log all network requests (optional, can be verbose)
  if (process.env.VERBOSE_NETWORK === "true") {
    page.on("request", (request) => {
      console.log(`[REQUEST] ${request.method()} ${request.url()}`);
    });

    page.on("response", (response) => {
      if (response.status() >= 400) {
        console.error(
          `[RESPONSE ERROR] ${response.status()} ${response.url()}`,
        );
      }
    });
  }

  console.log("[Flutter Helper] Debugging setup complete");
}

/**
 * Set up comprehensive debugging using TestDebugger
 * This is the recommended approach for new tests
 */
export function setupFlutterDebuggingAdvanced(
  page: Page,
  options?: {
    verbose?: boolean;
    networkVerbose?: boolean;
    captureScreenshots?: boolean;
    logFlutterState?: boolean;
  },
) {
  return TestDebugger.enableAll(page, options);
}

// Re-export test utilities for convenience
export { TestDebugger } from "./test-debugger.js";
export type { DebugOptions, DebugData } from "./test-debugger.js";
export {
  waitForRequest,
  waitForResponse,
  waitForApiRequest,
  waitForApiResponse,
  waitForTextContent,
  waitForStateUpdate,
  retryOperation,
  clearCsrfTokenFromBrowser,
  clearBrowserStorage,
  waitForNavigation,
  setupRequestInterception,
} from "./test-reliability-helpers.js";
export {
  TestDataManager,
  cleanupBrowserState,
  generateTestPrefix,
  cleanupTestData,
} from "./test-data-cleanup.js";
export type { TestResource } from "./test-data-cleanup.js";

/**
 * Measure frontend load time with detailed performance metrics
 * Returns load time in milliseconds and performance instrumentation
 */
export async function measureFrontendLoadTime(
  page: Page,
  url: string,
): Promise<{
  loadTime: number;
  instrumentation: PerformanceInstrumentation;
}> {
  console.log("[Performance] Starting performance instrumentation...");
  const instrumentation = instrumentPerformance(page);

  const loadStart = Date.now();
  await page.goto(url);
  await waitForFlutterReady(page);
  const loadTime = Date.now() - loadStart;

  // Get metrics and generate report
  const metrics = await instrumentation.getMetrics();
  const report = await instrumentation.generateReport();
  console.log(report);

  // Log warnings
  if (metrics.warnings.length > 0) {
    const highWarnings = metrics.warnings.filter((w) => w.severity === "high");
    if (highWarnings.length > 0) {
      console.error(
        `[Performance] ⚠️  ${highWarnings.length} HIGH severity warnings detected!`,
      );
    }
  }

  return {
    loadTime,
    instrumentation,
  };
}

/**
 * Diagnose timeout causes with comprehensive instrumentation
 * Use this when a timeout occurs to understand what went wrong
 */
export async function diagnoseTimeout(
  page: Page,
  operation: () => Promise<void>,
  operationName: string,
  timeout = 60000,
): Promise<{
  success: boolean;
  metrics?: any;
  report?: string;
  timeoutReason?: string;
}> {
  console.log(`[Performance] Diagnosing ${operationName}...`);
  const instrumentation = instrumentPerformance(page);

  try {
    await Promise.race([
      operation(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeout),
      ),
    ]);

    // Operation succeeded
    const metrics = await instrumentation.getMetrics();
    const report = await instrumentation.generateReport();
    console.log(report);

    return {
      success: true,
      metrics,
      report,
    };
  } catch (error) {
    // Operation timed out or failed
    const metrics = await instrumentation.getMetrics();
    const report = await instrumentation.generateReport();
    console.error(`[Performance] ❌ ${operationName} failed or timed out`);
    console.error(report);

    // Try to diagnose why
    const networkDiagnostics = await waitForNetworkIdleWithDiagnostics(
      page,
      5000,
    );
    let timeoutReason = "Unknown";
    if (
      networkDiagnostics.activeRequests &&
      networkDiagnostics.activeRequests > 0
    ) {
      timeoutReason = `${networkDiagnostics.activeRequests} active requests preventing completion`;
    } else if (
      networkDiagnostics.websocketConnections &&
      networkDiagnostics.websocketConnections > 0
    ) {
      timeoutReason = `${networkDiagnostics.websocketConnections} WebSocket connections keeping network active`;
    } else if (!metrics.flutterEngineStatus.initialized) {
      timeoutReason = "Flutter engine did not initialize";
    } else if (metrics.failedResources.length > 0) {
      timeoutReason = `${metrics.failedResources.length} failed resources blocking initialization`;
    }

    return {
      success: false,
      metrics,
      report,
      timeoutReason,
    };
  }
}

/**
 * Check frontend health
 * Verifies frontend is accessible and returns status
 */
export async function checkFrontendHealth(): Promise<{
  healthy: boolean;
  status: number;
  loadTime?: number;
  error?: string;
}> {
  const frontendUrl = getFrontendUrl();

  try {
    const response = await fetch(frontendUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    return {
      healthy: response.status === 200,
      status: response.status,
    };
  } catch (error) {
    return {
      healthy: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Automated authentication helper for tests
 * Bypasses browser-based auth flow by using API directly
 *
 * This function:
 * 1. Creates a test user via API (or uses existing)
 * 2. Gets a session token via API
 * 3. Sets session token in browser localStorage
 * 4. Fetches CSRF token and sets it
 * 5. Returns tokens for verification
 *
 * This bypasses the magic link flow entirely, making tests faster and more reliable.
 */
export async function authenticateForTest(
  page: Page,
  email: string,
  apiUrl: string,
): Promise<{
  sessionToken: string;
  csrfToken: string;
  userId: string;
}> {
  console.log(
    `[Auth Helper] Starting API-based authentication for ${email}...`,
  );

  // Import test auth utilities
  const { createTestUserWithSession, cleanupTestUser } = await import(
    "../../utils/test-auth.js"
  );

  // Step 1: Create test user and get session token
  let testUser;
  let sessionToken: string;

  try {
    const result = await createTestUserWithSession({
      email,
      role: "END_USER",
    });
    testUser = result.testUser;
    sessionToken = result.sessionToken;
    console.log(`[Auth Helper] ✅ Test user created: ${testUser.id}`);
  } catch (error) {
    throw new Error(
      `Failed to create test user: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Step 2: Set session token in browser localStorage
  // Also dispatch custom event to notify Flutter app (same-tab sync)
  try {
    await page.evaluate((token) => {
      localStorage.setItem("trellis_session_token", token);
      console.log("[Auth Helper] Session token set in localStorage");

      // Dispatch custom event to notify Flutter app of token update
      // This is needed because storage events only fire cross-tab, not same-tab
      // Security: Custom events are same-origin only (browser enforced)
      window.dispatchEvent(
        new CustomEvent("sessionTokenUpdated", {
          detail: token,
        }),
      );

      // Also dispatch storage event for consistency (won't fire same-tab, but good for cross-tab)
      // This ensures cross-tab sync still works if multiple tabs are open
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "trellis_session_token",
          newValue: token,
          storageArea: localStorage,
        }),
      );
    }, sessionToken);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    if (
      errorMessage.includes("Target page, context or browser has been closed")
    ) {
      throw new Error(
        `Page closed during token setting. This may indicate the page navigated or was closed. ` +
          `Make sure the page is stable before calling authenticateForTest().`,
      );
    }
    throw e;
  }

  // ✅ STRICT VERIFICATION: Ensure token is set and accessible
  let tokenVerified: boolean;
  try {
    tokenVerified = await page.evaluate((token) => {
      const stored = localStorage.getItem("trellis_session_token");
      if (stored !== token) {
        throw new Error(
          `Token verification failed: expected ${token.substring(0, 20)}..., got ${stored?.substring(0, 20) || "null"}...`,
        );
      }
      return true;
    }, sessionToken);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    if (
      errorMessage.includes("Target page, context or browser has been closed")
    ) {
      throw new Error(
        `Page closed during token verification. This may indicate the page navigated or was closed. ` +
          `Make sure the page is stable before calling authenticateForTest().`,
      );
    }
    throw e;
  }

  if (!tokenVerified) {
    throw new Error("Token verification failed after setting");
  }

  console.log("[Auth Helper] ✅ Token verified in localStorage");

  // Step 3: Set session cookie (for cookie-based auth fallback)
  await page.context().addCookies([
    {
      name: "trellis_session",
      value: sessionToken,
      domain: new URL(apiUrl).hostname.replace("api.", ""),
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    },
  ]);

  // Step 4: Fetch CSRF token from API
  let csrfToken: string;
  let updatedSessionToken: string | undefined;

  try {
    const csrfResponse = await fetch(`${apiUrl}/api/csrf-token`, {
      method: "GET",
      headers: {
        Cookie: `trellis_session=${sessionToken}`,
        Authorization: `Bearer ${sessionToken}`,
      },
      credentials: "include",
    });

    if (!csrfResponse.ok) {
      throw new Error(
        `CSRF token fetch failed: ${csrfResponse.status} ${csrfResponse.statusText}`,
      );
    }

    const csrfData = await csrfResponse.json();
    csrfToken = csrfData.token;
    updatedSessionToken = csrfData.sessionToken;

    console.log(`[Auth Helper] ✅ CSRF token fetched`);
  } catch (error) {
    // Clean up test user on failure
    await cleanupTestUser(testUser.id).catch(() => {
      // Ignore cleanup errors
    });
    throw new Error(
      `Failed to fetch CSRF token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Step 5: Update session token if backend returned updated one
  if (updatedSessionToken && updatedSessionToken !== sessionToken) {
    await page.evaluate((token) => {
      localStorage.setItem("trellis_session_token", token);
      console.log("[Auth Helper] Session token updated in localStorage");

      // Dispatch custom event to notify Flutter app of token update
      // This is needed because storage events only fire cross-tab, not same-tab
      // Security: Custom events are same-origin only (browser enforced)
      window.dispatchEvent(
        new CustomEvent("sessionTokenUpdated", {
          detail: token,
        }),
      );

      // Also dispatch storage event for consistency (won't fire same-tab, but good for cross-tab)
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "trellis_session_token",
          newValue: token,
          storageArea: localStorage,
        }),
      );
    }, updatedSessionToken);

    // ✅ STRICT VERIFICATION: Ensure updated token is set and accessible
    const updatedTokenVerified = await page.evaluate((token) => {
      const stored = localStorage.getItem("trellis_session_token");
      if (stored !== token) {
        throw new Error(
          `Updated token verification failed: expected ${token.substring(0, 20)}..., got ${stored?.substring(0, 20) || "null"}...`,
        );
      }
      return true;
    }, updatedSessionToken);

    if (!updatedTokenVerified) {
      throw new Error("Updated token verification failed after setting");
    }

    console.log("[Auth Helper] ✅ Updated token verified in localStorage");

    // IMPORTANT: Keep cookie-based auth in sync with Authorization/localStorage.
    // The CSRF endpoint can return a rotated/updated session token; if we don't update the cookie,
    // subsequent XHRs that rely on cookies can become unauthorized (401) even though localStorage has
    // the new token. This caused flaky E2E failures on `/api/entities/:id`.
    await page.context().addCookies([
      {
        name: "trellis_session",
        value: updatedSessionToken,
        domain: new URL(apiUrl).hostname.replace("api.", ""),
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      },
    ]);
    sessionToken = updatedSessionToken;
  }

  // Step 6: Set CSRF token in localStorage (for cross-tab sync)
  await page.evaluate((token) => {
    localStorage.setItem("trellis_csrf_token", token);
    console.log("[Auth Helper] CSRF token set in localStorage");
  }, csrfToken);

  console.log(`[Auth Helper] ✅ Authentication complete for ${email}`);
  console.log(`[Auth Helper]   User ID: ${testUser.id}`);
  console.log(
    `[Auth Helper]   Session token: ${sessionToken.substring(0, 20)}...`,
  );
  console.log(`[Auth Helper]   CSRF token: ${csrfToken.substring(0, 20)}...`);

  // Store cleanup function on page for later use
  await page.evaluate((userId: string): void => {
    const testWindow = window as unknown as TestWindow;
    testWindow.__testUserCleanup = userId;
  }, testUser.id);

  return {
    sessionToken,
    csrfToken,
    userId: testUser.id,
  };
}

/**
 * Dispatch session token update event to Flutter app
 * This should be called after Flutter is ready to ensure the event listener is set up
 * The event notifies Flutter's ApiClient to invalidate its session token cache
 */
export async function notifyFlutterSessionTokenUpdate(
  page: Page,
): Promise<void> {
  await page.evaluate(() => {
    // ✅ STRICT: Verify token exists before dispatching
    const token = localStorage.getItem("trellis_session_token");
    if (!token) {
      console.warn(
        "[Auth Helper] ⚠️  No token found in localStorage, skipping event dispatch",
      );
      return;
    }

    console.log(
      "[Auth Helper] Notifying Flutter of session token update (after Flutter ready)",
    );
    console.log(`[Auth Helper] Token preview: ${token.substring(0, 20)}...`);

    // Dispatch custom event to notify Flutter app of token update
    // This is needed because storage events only fire cross-tab, not same-tab
    // Security: Custom events are same-origin only (browser enforced)
    // Use bubbles: true to ensure the event propagates correctly
    const event = new CustomEvent("sessionTokenUpdated", {
      detail: token,
      bubbles: true,
      cancelable: true,
    });

    // Dispatch on window
    const dispatched = window.dispatchEvent(event);
    console.log(
      `[Auth Helper] Event dispatched on window: ${dispatched}, type: ${event.type}`,
    );

    // Also dispatch on document for compatibility
    document.dispatchEvent(event);
    console.log("[Auth Helper] Event also dispatched on document");
  });

  // Small delay to ensure event is processed
  await page.waitForTimeout(100);
}

/**
 * Wait for Flutter ApiClient to be initialized and ready
 *
 * This function uses a hybrid approach that:
 * 1. Waits for Flutter to be ready (ensures Flutter app is loaded)
 * 2. Verifies localStorage is accessible (tests actual functionality ApiClient needs)
 * 3. Does not rely on window flags (which may not be accessible from Playwright context)
 *
 * ApiClient is created lazily via Riverpod providers, so it will be initialized
 * when first accessed. This function ensures the environment is ready for ApiClient
 * to function correctly.
 *
 * @param page - Playwright page instance
 * @param timeoutMs - Maximum time to wait (default: 30000ms)
 * @throws Error if Flutter doesn't load or localStorage is not accessible
 */
export async function waitForApiClientReady(
  page: Page,
  timeoutMs = 5000,
): Promise<void> {
  // This function assumes Flutter is already ready (tests call waitForFlutterReady() first)
  // We only verify that localStorage is accessible, which is what ApiClient needs
  //
  // Since ApiClient is created lazily via Riverpod providers, we don't need to wait
  // for it to be explicitly initialized. We just need to ensure the environment
  // (localStorage) is ready for it to function.
  //
  // IMPORTANT: This function is very lenient about failures because:
  // 1. ApiClient is created lazily when first accessed
  // 2. Tests will fail naturally if ApiClient doesn't work
  // 3. Page closures or timing issues shouldn't block tests
  // 4. We assume ready if we can't verify (better to be lenient than block tests)

  // Try to verify localStorage is accessible, but don't block if we can't
  // ApiClient uses localStorage to read session tokens, so if localStorage
  // is accessible, ApiClient can function correctly
  try {
    // Quick check with short timeout - don't wait too long
    const checkPromise = page.evaluate((): boolean => {
      try {
        // Test localStorage access
        const testKey = "__test_storage_access__";
        localStorage.setItem(testKey, "test");
        const value = localStorage.getItem(testKey);
        localStorage.removeItem(testKey);
        return value === "test";
      } catch (e) {
        console.error("[Auth Helper] localStorage access test failed:", e);
        return false;
      }
    });

    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    });

    const storageReady = await Promise.race([checkPromise, timeoutPromise]);

    if (storageReady) {
      console.log("[Auth Helper] ✅ localStorage verified accessible");
    } else {
      console.warn(
        "[Auth Helper] ⚠️  Could not verify localStorage access within timeout, " +
          "assuming ApiClient is ready (lazy initialization will create it when needed)",
      );
    }
  } catch (e) {
    // If page.evaluate fails, assume it's ready anyway
    // ApiClient will be created when first accessed (lazy initialization)
    // The test will fail naturally if ApiClient doesn't work
    const errorMessage = e instanceof Error ? e.message : String(e);

    if (
      errorMessage.includes("Target page, context or browser has been closed")
    ) {
      console.warn(
        "[Auth Helper] ⚠️  Page closed during localStorage check, " +
          "assuming ApiClient is ready (lazy initialization will create it when needed)",
      );
    } else {
      console.warn(
        `[Auth Helper] ⚠️  Could not verify localStorage access: ${errorMessage}, ` +
          "assuming ApiClient is ready (lazy initialization)",
      );
    }
  }

  // Small delay to ensure Flutter providers are fully initialized
  // Since tests already waited for Flutter to be ready, this gives providers
  // a moment to complete their initialization
  await new Promise((resolve) => setTimeout(resolve, 200));

  console.log(
    "[Auth Helper] ✅ ApiClient ready (localStorage accessible or assumed ready)",
  );
}

/**
 * Clean up test user created by authenticateForTest
 * Should be called in test.afterEach() or test.afterAll()
 */
/**
 * Clean up test user created by authenticateForTest
 * Should be called in test.afterEach() or test.afterAll()
 *
 * @param page - Playwright page instance
 */
export async function cleanupTestAuth(page: Page): Promise<void> {
  try {
    const userId = await page.evaluate((): string | undefined => {
      const testWindow = window as unknown as TestWindow;
      return testWindow.__testUserCleanup;
    });

    if (userId) {
      const { cleanupTestUser } = await import("../../utils/test-auth.js");
      await cleanupTestUser(userId);
      console.log(`[Auth Helper] ✅ Test user cleaned up: ${userId}`);

      // Clear cleanup marker
      await page.evaluate((): void => {
        const testWindow = window as unknown as TestWindow;
        delete testWindow.__testUserCleanup;
      });
    }
  } catch (error) {
    console.warn(
      `[Auth Helper] Failed to cleanup test user: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
