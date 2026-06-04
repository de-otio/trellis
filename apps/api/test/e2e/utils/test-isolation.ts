/**
 * Test Isolation Utilities
 *
 * Ensures each test starts with a clean, isolated state.
 * Prevents test interference and improves reliability.
 */

import { BrowserContext, Page } from "@playwright/test";

/**
 * Clear all browser state for test isolation
 *
 * This ensures each test starts with a clean slate:
 * - No cookies from previous tests
 * - No localStorage/sessionStorage data
 * - No cached permissions
 * - No cached resources (optional)
 */
export async function clearBrowserState(
  context: BrowserContext,
  page?: Page,
): Promise<void> {
  console.log("[Test Isolation] Clearing browser state...");

  // Clear cookies
  await context.clearCookies();
  console.log("[Test Isolation] ✅ Cookies cleared");

  // Clear permissions
  await context.clearPermissions();
  console.log("[Test Isolation] ✅ Permissions cleared");

  // Clear cache (if page is provided)
  if (page) {
    // Avoid storage APIs on about:blank / non-origin documents (can throw SecurityError).
    // We'll still clear cookies/permissions via the context above.
    const currentUrl = page.url();
    if (
      currentUrl === "about:blank" ||
      currentUrl.startsWith("chrome-error://")
    ) {
      console.log(
        `[Test Isolation] Skipping storage clear on non-origin page (${currentUrl})`,
      );
    } else {
      try {
        // ✅ CRITICAL: Do NOT clear localStorage if auth token is present
        // Token is set by authenticateForTest() and must persist
        const hasAuthToken = await page.evaluate(() => {
          return localStorage.getItem("trellis_session_token") !== null;
        });

        if (!hasAuthToken) {
          // Only clear if no auth token is present
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
            // Clear IndexedDB (if accessible)
            if ("indexedDB" in window && indexedDB.databases) {
              indexedDB.databases().then((databases) => {
                databases.forEach((db) => {
                  if (db.name) {
                    indexedDB.deleteDatabase(db.name);
                  }
                });
              });
            }
          });
          console.log(
            "[Test Isolation] ✅ Storage cleared (no auth token present)",
          );
        } else {
          console.log("[Test Isolation] Preserving authentication token");
          // Still clear sessionStorage and other items if needed, but preserve auth token
          await page.evaluate(() => {
            const authToken = localStorage.getItem("trellis_session_token");
            const csrfToken = localStorage.getItem("trellis_csrf_token");
            localStorage.clear();
            if (authToken) {
              localStorage.setItem("trellis_session_token", authToken);
            }
            if (csrfToken) {
              localStorage.setItem("trellis_csrf_token", csrfToken);
            }
            sessionStorage.clear();
          });
          console.log(
            "[Test Isolation] ✅ Storage cleared (auth token preserved)",
          );
        }
      } catch (error) {
        console.warn("[Test Isolation] ⚠️  Could not clear storage:", error);
      }
    }

    // Clear cache via CDP (Chrome DevTools Protocol) if available
    try {
      const client = await context.newCDPSession(page);
      await client.send("Network.clearBrowserCache");
      await client.send("Network.clearBrowserCookies");
      console.log("[Test Isolation] ✅ Browser cache cleared via CDP");
    } catch (error) {
      // CDP may not be available in all browsers
      console.log(
        "[Test Isolation] CDP cache clearing not available (this is OK)",
      );
    }
  }

  console.log("[Test Isolation] Browser state cleared successfully");
}

/**
 * Set up test isolation for a test suite
 *
 * Use this in test.describe.beforeEach to ensure each test is isolated
 */
export async function setupTestIsolation(
  context: BrowserContext,
  page?: Page,
): Promise<void> {
  await clearBrowserState(context, page);
}

/**
 * Create a fresh page with isolated state
 *
 * Useful when you need a completely fresh page within a test
 */
export async function createIsolatedPage(
  context: BrowserContext,
): Promise<Page> {
  const page = await context.newPage();

  // Clear storage immediately after page creation
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  return page;
}

/**
 * Reset page state without creating a new page
 *
 * Clears storage and cookies for the current page
 */
export async function resetPageState(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  // Clear cookies via context
  const context = page.context();
  await context.clearCookies();
}

/**
 * Verify test isolation (for debugging)
 *
 * Checks that browser state is clean
 */
export async function verifyTestIsolation(
  context: BrowserContext,
  page: Page,
): Promise<{
  isolated: boolean;
  issues: string[];
}> {
  const issues: string[] = [];

  // Check cookies
  const cookies = await context.cookies();
  if (cookies.length > 0) {
    issues.push(
      `Found ${cookies.length} cookies: ${cookies.map((c) => c.name).join(", ")}`,
    );
  }

  // Check localStorage
  const localStorageItems = await page.evaluate(() => {
    const items: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        items.push(key);
      }
    }
    return items;
  });
  if (localStorageItems.length > 0) {
    issues.push(
      `Found ${localStorageItems.length} localStorage items: ${localStorageItems.join(", ")}`,
    );
  }

  // Check sessionStorage
  const sessionStorageItems = await page.evaluate(() => {
    const items: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key) {
        items.push(key);
      }
    }
    return items;
  });
  if (sessionStorageItems.length > 0) {
    issues.push(
      `Found ${sessionStorageItems.length} sessionStorage items: ${sessionStorageItems.join(", ")}`,
    );
  }

  return {
    isolated: issues.length === 0,
    issues,
  };
}
