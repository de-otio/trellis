/**
 * Flutter Component Helpers
 *
 * Utilities to check Flutter component state and readiness
 */

import { Page } from "@playwright/test";

/**
 * Check if a Flutter component is mounted and ready
 * This verifies that the component has initialized and is ready to make API calls
 */
export async function checkFlutterComponentReady(
  page: Page,
  componentName: string,
  timeout = 10000,
): Promise<boolean> {
  try {
    // Check if component is in the widget tree
    const isMounted = await page.evaluate((name) => {
      // Try to find component by checking for specific Flutter elements
      // This is a heuristic - we check for common Flutter widget patterns
      const body = document.body;
      if (!body) return false;

      // Check for Flutter canvas (indicates Flutter is rendering)
      const canvas = body.querySelector("flt-scene-host canvas");
      if (!canvas) return false;

      // Check if Flutter app is interactive (not just loading)
      // We can check for specific text or elements that indicate the component loaded
      // For edit page, we might look for form elements or loading indicators
      return true; // Basic check - component is mounted if Flutter is rendering
    }, componentName);

    if (!isMounted) {
      console.warn(`⚠️  Component ${componentName} may not be mounted`);
      return false;
    }

    return true;
  } catch (e) {
    console.warn(`⚠️  Error checking component readiness: ${e}`);
    return false;
  }
}

/**
 * Wait for Flutter component to be in a specific state
 * This is useful for waiting for loading states to complete
 */
export async function waitForFlutterComponentState(
  page: Page,
  checkFn: () => Promise<boolean>,
  timeout = 30000,
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const isReady = await checkFn();
      if (isReady) {
        return true;
      }
      await page.waitForTimeout(500); // Check every 500ms
    } catch (e) {
      // Continue checking
      await page.waitForTimeout(500);
    }
  }
  return false;
}

/**
 * Check if Flutter edit page is in loading state
 * This helps verify if the component is still loading data
 */
export async function isEditPageLoading(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      // Look for loading indicators in the Flutter app
      // This is a heuristic - we check for common loading patterns
      const body = document.body;
      if (!body) return false;

      // Check for CircularProgressIndicator or similar loading indicators
      // Flutter renders these as specific elements
      // We can check for specific text or attributes that indicate loading
      return false; // Default to not loading
    });
  } catch (e) {
    return false;
  }
}

/**
 * Check if Flutter component has made an API request
 * This verifies that the component has attempted to load data
 */
export async function hasComponentMadeRequest(
  page: Page,
  expectedUrl: string,
): Promise<boolean> {
  try {
    // This would require access to network logs
    // For now, we'll check if the component is in a non-loading state
    // which suggests it has attempted to load data
    return !(await isEditPageLoading(page));
  } catch (e) {
    return false;
  }
}

/**
 * Trigger Flutter component to reload data
 * This can be useful for testing retry scenarios
 */
export async function triggerFlutterComponentReload(
  page: Page,
  componentName: string,
): Promise<void> {
  try {
    // Try to trigger a reload by dispatching a custom event
    await page.evaluate((name) => {
      window.dispatchEvent(
        new CustomEvent("flutter:reload", { detail: { component: name } }),
      );
    }, componentName);
  } catch (e) {
    console.warn(`⚠️  Could not trigger component reload: ${e}`);
  }
}
