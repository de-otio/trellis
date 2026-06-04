/**
 * Test Helper Utilities
 *
 * Common utilities for e2e tests to improve reliability and reduce flakiness.
 */

import { Page, Request, Response } from "@playwright/test";

/**
 * Wait for a specific request with better error handling
 *
 * @param page - Playwright page
 * @param predicate - Function to match the request
 * @param timeout - Timeout in milliseconds (default: 120000)
 * @returns The matching request
 */
export async function waitForRequest(
  page: Page,
  predicate: (request: Request) => boolean,
  timeout = 120000,
): Promise<Request> {
  return page.waitForRequest(predicate, { timeout });
}

/**
 * Wait for a specific response with better error handling
 *
 * @param page - Playwright page
 * @param predicate - Function to match the response
 * @param timeout - Timeout in milliseconds (default: 120000)
 * @returns The matching response
 */
export async function waitForResponse(
  page: Page,
  predicate: (response: Response) => boolean,
  timeout = 120000,
): Promise<Response> {
  return page.waitForResponse(predicate, { timeout });
}

/**
 * Wait for UI feedback (success message, navigation, etc.)
 *
 * @param page - Playwright page
 * @param options - Options for waiting
 * @returns True if feedback was detected
 */
export async function waitForUIFeedback(
  page: Page,
  options: {
    successText?: string | RegExp;
    navigateTo?: string | RegExp;
    selector?: string;
    timeout?: number;
  },
): Promise<boolean> {
  const timeout = options.timeout || 120000;

  // Wait for success message
  if (options.successText) {
    try {
      await page.waitForSelector(`text=${options.successText}`, { timeout });
      return true;
    } catch (error) {
      // Continue to other checks
    }
  }

  // Wait for navigation
  if (options.navigateTo) {
    try {
      await page.waitForURL(options.navigateTo, { timeout });
      return true;
    } catch (error) {
      // Continue to other checks
    }
  }

  // Wait for specific selector
  if (options.selector) {
    try {
      await page.waitForSelector(options.selector, { timeout });
      return true;
    } catch (error) {
      // Continue
    }
  }

  return false;
}

/**
 * Wait for state synchronization
 *
 * Waits for frontend state to match expected value
 *
 * @param page - Playwright page
 * @param checkFunction - Function that returns true when state is correct
 * @param timeout - Timeout in milliseconds (default: 120000)
 */
export async function waitForStateSync(
  page: Page,
  checkFunction: () => boolean | Promise<boolean>,
  timeout = 120000,
): Promise<void> {
  await page.waitForFunction(checkFunction, { timeout });
}

/**
 * Retry an operation with exponential backoff
 *
 * @param operation - Operation to retry
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param initialDelay - Initial delay in milliseconds (default: 1000)
 * @returns Result of the operation
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  initialDelay = 1000,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, attempt);
        console.log(
          `[Retry] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Operation failed after retries");
}

/**
 * Set up request/response listeners before navigation
 *
 * Ensures listeners are registered before any requests are made
 *
 * @param page - Playwright page
 * @param handlers - Handlers for request and response events
 */
export function setupRequestListeners(
  page: Page,
  handlers: {
    onRequest?: (request: Request) => void;
    onResponse?: (response: Response) => void;
    onRequestFailed?: (request: Request) => void;
  },
): void {
  if (handlers.onRequest) {
    page.on("request", handlers.onRequest);
  }

  if (handlers.onResponse) {
    page.on("response", handlers.onResponse);
  }

  if (handlers.onRequestFailed) {
    page.on("requestfailed", handlers.onRequestFailed);
  }
}

/**
 * Clear CSRF token from frontend storage
 *
 * Useful for testing CSRF retry logic
 *
 * @param page - Playwright page
 */
export async function clearCsrfToken(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Clear from localStorage
    localStorage.removeItem("csrf_token");
    // Clear from sessionStorage
    sessionStorage.removeItem("csrf_token");
    // Clear from any Flutter-specific storage
    // Note: Flutter may store tokens in ApiClient instance, which we can't directly access
    // This clears what we can from browser storage
  });
}

/**
 * Wait for network to be idle with better diagnostics
 *
 * Provides information about what's preventing network idle
 *
 * @param page - Playwright page
 * @param timeout - Timeout in milliseconds (default: 60000)
 * @param idleTime - Time network must be idle (default: 500ms)
 */
export async function waitForNetworkIdle(
  page: Page,
  timeout = 60000,
  idleTime = 500,
): Promise<{
  success: boolean;
  reason?: string;
  activeRequests?: number;
}> {
  const startTime = Date.now();
  let lastActivityTime = Date.now();
  const activeRequests = new Set<string>();

  page.on("request", (request) => {
    activeRequests.add(request.url());
    lastActivityTime = Date.now();
  });

  page.on("response", () => {
    lastActivityTime = Date.now();
  });

  // Poll for network idle
  while (Date.now() - startTime < timeout) {
    const timeSinceLastActivity = Date.now() - lastActivityTime;

    // Remove completed requests
    // Note: This is a simplified check - in reality, we'd need to track request lifecycle
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check if network is idle
    if (timeSinceLastActivity >= idleTime && activeRequests.size === 0) {
      return {
        success: true,
        activeRequests: 0,
      };
    }

    // Check timeout
    if (Date.now() - startTime >= timeout) {
      return {
        success: false,
        reason: `Timeout after ${timeout}ms`,
        activeRequests: activeRequests.size,
      };
    }
  }

  return {
    success: false,
    reason: "Timeout",
    activeRequests: activeRequests.size,
  };
}
