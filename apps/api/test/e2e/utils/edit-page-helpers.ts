/**
 * Edit Page Helpers
 *
 * Utilities specifically for testing the dog profile edit page
 */

import { Page } from "@playwright/test";

/**
 * Wait for edit page to finish loading
 * The edit page shows a CircularProgressIndicator while loading
 * We wait for it to disappear, indicating the component has finished loading
 */
export async function waitForEditPageToLoad(
  page: Page,
  timeout = 30000,
): Promise<boolean> {
  try {
    // Wait for loading indicator to disappear
    // Flutter renders CircularProgressIndicator as specific elements
    // We can check if the page has moved past the loading state
    await page.waitForFunction(
      () => {
        const body = document.body;
        if (!body) return false;

        // Check if Flutter is rendering (canvas exists)
        const canvas = body.querySelector("flt-scene-host canvas");
        if (!canvas) return false;

        // Check if we're past the initial loading state
        // The edit page shows a loading indicator while _isLoadingProfile is true
        // Once loading is done, the form should be visible
        // We check for form elements or text that indicates the page is loaded
        const bodyText = body.textContent || "";

        // If we see "Edit Profile" or form-related text, page is likely loaded
        // If we only see loading indicators, page is still loading
        const hasFormText =
          bodyText.includes("Edit") ||
          bodyText.includes("Name") ||
          bodyText.includes("Save");

        // Don't consider it loaded if we only see "Loading" or spinner
        const isStillLoading =
          bodyText.includes("Loading") && !bodyText.includes("Edit");

        return hasFormText && !isStillLoading;
      },
      { timeout },
    );

    return true;
  } catch (e) {
    console.warn(`⚠️  Edit page may not have finished loading: ${e}`);
    return false;
  }
}

/**
 * Check if edit page is in error state
 * The edit page shows an error message if profile loading fails
 */
export async function isEditPageInErrorState(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const body = document.body;
      if (!body) return false;

      const bodyText = body.textContent || "";
      // Check for error indicators
      return (
        bodyText.includes("Error loading profile") ||
        (bodyText.includes("Error") && bodyText.includes("Back to List"))
      );
    });
  } catch (e) {
    return false;
  }
}

/**
 * Get edit page state information
 * Returns information about the current state of the edit page
 */
export async function getEditPageState(page: Page): Promise<{
  isLoaded: boolean;
  isError: boolean;
  hasForm: boolean;
  bodyText: string;
}> {
  try {
    return await page.evaluate(() => {
      const body = document.body;
      if (!body) {
        return {
          isLoaded: false,
          isError: false,
          hasForm: false,
          bodyText: "",
        };
      }

      const bodyText = body.textContent || "";
      const hasForm = bodyText.includes("Edit") || bodyText.includes("Name");
      const isError = bodyText.includes("Error loading profile");
      const isLoaded = hasForm && !bodyText.includes("Loading");

      return {
        isLoaded,
        isError,
        hasForm,
        bodyText: bodyText.substring(0, 500), // First 500 chars
      };
    });
  } catch (e) {
    return {
      isLoaded: false,
      isError: false,
      hasForm: false,
      bodyText: `Error: ${e}`,
    };
  }
}

/**
 * Wait for edit page component to make API request
 * This waits for the component to finish loading and make the entity GET request
 */
export async function waitForEditPageApiRequest(
  page: Page,
  profileId: string,
  timeout = 30000,
): Promise<boolean> {
  try {
    // First wait for page to finish loading
    await waitForEditPageToLoad(page, timeout);

    // Then wait for the API request
    await page.waitForResponse(
      (r) =>
        r.url().includes(`/api/entities/${profileId}`) &&
        r.request().method() === "GET",
      { timeout },
    );

    return true;
  } catch (e) {
    // Check if page is in error state
    const isError = await isEditPageInErrorState(page);
    if (isError) {
      const state = await getEditPageState(page);
      throw new Error(
        `Edit page is in error state. Body text: ${state.bodyText}`,
      );
    }

    throw e;
  }
}

/**
 * Trigger edit page to reload profile
 * This can be useful if the initial load failed
 */
export async function triggerEditPageReload(page: Page): Promise<void> {
  try {
    // Try to trigger a reload by dispatching a custom event
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("flutter:reload-profile", { detail: {} }),
      );
    });
  } catch (e) {
    console.warn(`⚠️  Could not trigger edit page reload: ${e}`);
  }
}
