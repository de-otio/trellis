/**
 * ApiClient Helpers
 *
 * Utilities to test and verify ApiClient behavior directly
 */

import { Page } from "@playwright/test";

/**
 * Check if ApiClient is initialized in Flutter
 */
export async function isApiClientInitialized(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      return (window as any).__apiClientInitialized === true;
    });
  } catch (e) {
    return false;
  }
}

/**
 * Check if ApiClient can read token from localStorage
 */
export async function canApiClientReadToken(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const token = localStorage.getItem("trellis_session_token");
      return token !== null && token.length > 0;
    });
  } catch (e) {
    return false;
  }
}

/**
 * Get the current token that ApiClient would use
 */
export async function getApiClientToken(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      return localStorage.getItem("trellis_session_token");
    });
  } catch (e) {
    return null;
  }
}

/**
 * Manually trigger ApiClient to make a test request
 * This can help verify if ApiClient is working correctly
 */
export async function triggerApiClientTestRequest(
  page: Page,
  url: string,
): Promise<boolean> {
  try {
    return await page.evaluate(async (testUrl) => {
      try {
        // Try to trigger a request via Flutter's ApiClient
        // This is a workaround - we can't directly call Flutter code from Playwright
        // But we can check if the request would be made

        // Check if token is available
        const token = localStorage.getItem("trellis_session_token");
        if (!token) {
          console.error("[ApiClient Helper] No token available");
          return false;
        }

        // Try to make a direct fetch request to verify connectivity
        // This doesn't test ApiClient directly, but verifies the endpoint is reachable
        const response = await fetch(testUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        return response.ok;
      } catch (e) {
        console.error("[ApiClient Helper] Test request failed:", e);
        return false;
      }
    }, url);
  } catch (e) {
    console.warn(`⚠️  Could not trigger test request: ${e}`);
    return false;
  }
}

/**
 * Check if ApiClient interceptor is working
 * This verifies that the interceptor can read tokens
 */
export async function isApiClientInterceptorWorking(
  page: Page,
): Promise<boolean> {
  try {
    // Check if token is accessible
    const token = await getApiClientToken(page);
    if (!token) {
      return false;
    }

    // Check if ApiClient is initialized
    const initialized = await isApiClientInitialized(page);
    if (!initialized) {
      return false;
    }

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Wait for ApiClient to be fully ready
 * This includes initialization and token availability
 */
export async function waitForApiClientReady(
  page: Page,
  timeout = 30000,
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const initialized = await isApiClientInitialized(page);
    const canReadToken = await canApiClientReadToken(page);

    if (initialized && canReadToken) {
      return true;
    }

    await page.waitForTimeout(500); // Check every 500ms
  }

  return false;
}

/**
 * Force ApiClient to invalidate cache and re-read token
 * This can help when token is updated after ApiClient initialization
 */
export async function forceApiClientTokenRefresh(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      // Dispatch event to notify ApiClient of token update
      const token = localStorage.getItem("trellis_session_token");
      if (token) {
        window.dispatchEvent(
          new CustomEvent("sessionTokenUpdated", { detail: token }),
        );
      }
    });
  } catch (e) {
    console.warn(`⚠️  Could not force token refresh: ${e}`);
  }
}
