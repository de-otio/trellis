/**
 * Test Reliability Helpers
 *
 * Utilities to improve test reliability and reduce flakiness:
 * - Request/response waiting with proper timing
 * - State synchronization helpers
 * - Retry logic for flaky operations
 * - Request interception helpers
 */

import { Page, Request, Response } from "@playwright/test";

/**
 * Wait for a specific request matching the predicate
 * Registers listener before navigation to avoid race conditions
 */
export async function waitForRequest(
  page: Page,
  predicate: (request: Request) => boolean,
  options: {
    timeout?: number;
    beforeNavigation?: () => Promise<void>;
  } = {},
): Promise<Request> {
  const { timeout = 120000, beforeNavigation } = options;

  // Register listener BEFORE any navigation
  const requestPromise = page.waitForRequest(predicate, { timeout });

  // Execute any pre-navigation setup
  if (beforeNavigation) {
    await beforeNavigation();
  }

  return requestPromise;
}

/**
 * Wait for a specific response matching the predicate
 * Registers listener before navigation to avoid race conditions
 */
export async function waitForResponse(
  page: Page,
  predicate: (response: Response) => boolean,
  options: {
    timeout?: number;
    beforeNavigation?: () => Promise<void>;
  } = {},
): Promise<Response> {
  const { timeout = 120000, beforeNavigation } = options;

  // Register listener BEFORE any navigation
  const responsePromise = page.waitForResponse(predicate, { timeout });

  // Execute any pre-navigation setup
  if (beforeNavigation) {
    await beforeNavigation();
  }

  return responsePromise;
}

/**
 * Wait for API request with specific method and URL pattern
 */
export async function waitForApiRequest(
  page: Page,
  method: string,
  urlPattern: string | RegExp,
  options: { timeout?: number } = {},
): Promise<Request> {
  return waitForRequest(
    page,
    (request) => {
      const url = request.url();
      const matchesUrl =
        typeof urlPattern === "string"
          ? url.includes(urlPattern)
          : urlPattern.test(url);
      return request.method() === method && matchesUrl;
    },
    options,
  );
}

/**
 * Wait for API response with specific method, URL pattern, and status
 */
export async function waitForApiResponse(
  page: Page,
  method: string,
  urlPattern: string | RegExp,
  options: {
    timeout?: number;
    status?: number;
    beforeNavigation?: () => Promise<void>;
  } = {},
): Promise<Response> {
  const { status, ...restOptions } = options;

  return waitForResponse(
    page,
    (response) => {
      const url = response.url();
      const matchesUrl =
        typeof urlPattern === "string"
          ? url.includes(urlPattern)
          : urlPattern.test(url);
      const matchesMethod = response.request().method() === method;
      const matchesStatus =
        status === undefined || response.status() === status;
      return matchesUrl && matchesMethod && matchesStatus;
    },
    restOptions,
  );
}

/**
 * Wait for UI element to appear with text content
 */
export async function waitForTextContent(
  page: Page,
  selector: string,
  expectedText: string,
  options: { timeout?: number } = {},
): Promise<void> {
  const { timeout = 120000 } = options;

  await page.waitForFunction(
    ({ selector, expectedText }) => {
      const element = document.querySelector(selector);
      return element?.textContent?.includes(expectedText);
    },
    { selector, expectedText },
    { timeout },
  );
}

/**
 * Wait for state to update in the UI
 */
export async function waitForStateUpdate(
  page: Page,
  checkFunction: () => boolean | Promise<boolean>,
  options: { timeout?: number; description?: string } = {},
): Promise<void> {
  const { timeout = 120000, description = "state update" } = options;

  try {
    await page.waitForFunction(checkFunction, { timeout });
  } catch (error) {
    throw new Error(
      `Timeout waiting for ${description} after ${timeout}ms: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Retry an operation with exponential backoff
 */
export async function retryOperation<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelay?: number;
    maxDelay?: number;
    description?: string;
  } = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    description = "operation",
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxAttempts - 1) {
        const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
        console.log(
          `[Retry] Attempt ${attempt + 1}/${maxAttempts} failed for ${description}, retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(
    `Failed ${description} after ${maxAttempts} attempts: ${lastError?.message}`,
  );
}

/**
 * Clear CSRF token from browser storage
 * Useful for testing token invalidation scenarios
 */
export async function clearCsrfTokenFromBrowser(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem("trellis_csrf_token");
    localStorage.removeItem("csrf_token");
    console.log("[Test Helper] CSRF token cleared from localStorage");
  });
}

/**
 * Clear all browser storage
 */
export async function clearBrowserStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
    console.log("[Test Helper] Browser storage cleared");
  });
}

/**
 * Wait for navigation to complete
 * Handles both hash-based and pathname-based navigation
 */
export async function waitForNavigation(
  page: Page,
  urlPattern: string | RegExp,
  options: { timeout?: number } = {},
): Promise<void> {
  const { timeout = 120000 } = options;

  await page.waitForFunction(
    ({ pattern }) => {
      const url = window.location.href;
      const hash = window.location.hash;
      const pathname = window.location.pathname;

      if (typeof pattern === "string") {
        return (
          url.includes(pattern) ||
          hash.includes(pattern) ||
          pathname.includes(pattern)
        );
      } else {
        return (
          pattern.test(url) || pattern.test(hash) || pattern.test(pathname)
        );
      }
    },
    { pattern: urlPattern },
    { timeout },
  );
}

/**
 * Setup request interception with proper timing
 * Registers listeners before navigation to avoid race conditions
 */
export function setupRequestInterception(
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
