/**
 * Test Data Cleanup Utilities
 *
 * Utilities for managing test data lifecycle:
 * - Track created resources
 * - Automatic cleanup
 * - Bulk cleanup by prefix
 */

import { Page } from "@playwright/test";
import { getApiUrl } from "../../utils/test-config.js";
import { authenticatedFetch } from "../../utils/test-auth.js";

export interface TestResource {
  type: "profile" | "user" | "post" | "other";
  id: string;
  cleanupUrl?: string;
}

/**
 * Test Data Manager
 * Tracks created resources and provides automatic cleanup
 */
export class TestDataManager {
  private resources: TestResource[] = [];
  private apiUrl: string;
  private sessionToken?: string;

  constructor(apiUrl?: string) {
    this.apiUrl = apiUrl || getApiUrl();
  }

  /**
   * Set session token for authenticated cleanup
   */
  setSessionToken(token: string): void {
    this.sessionToken = token;
  }

  /**
   * Register a resource for cleanup
   */
  registerResource(resource: TestResource): void {
    this.resources.push(resource);
    console.log(
      `[TestDataManager] Registered ${resource.type} ${resource.id} for cleanup`,
    );
  }

  /**
   * Register a profile for cleanup
   */
  registerProfile(profileId: string): void {
    this.registerResource({
      type: "profile",
      id: profileId,
      cleanupUrl: `${this.apiUrl}/api/entities/${profileId}`,
    });
  }

  /**
   * Register a user for cleanup
   */
  registerUser(userId: string): void {
    this.registerResource({
      type: "user",
      id: userId,
      cleanupUrl: `${this.apiUrl}/api/users/${userId}`, // Adjust endpoint as needed
    });
  }

  /**
   * Clean up a single resource
   */
  async cleanupResource(resource: TestResource): Promise<boolean> {
    if (!resource.cleanupUrl) {
      console.warn(
        `[TestDataManager] No cleanup URL for ${resource.type} ${resource.id}`,
      );
      return false;
    }

    try {
      if (this.sessionToken) {
        const response = await authenticatedFetch(
          resource.cleanupUrl,
          this.sessionToken,
          { method: "DELETE" },
        );

        if (response.ok || response.status === 404) {
          console.log(
            `[TestDataManager] ✅ Cleaned up ${resource.type} ${resource.id}`,
          );
          return true;
        } else {
          console.warn(
            `[TestDataManager] ⚠️ Failed to cleanup ${resource.type} ${resource.id}: ${response.status}`,
          );
          return false;
        }
      } else {
        // Try without auth (may work for some endpoints)
        const response = await fetch(resource.cleanupUrl, { method: "DELETE" });
        if (response.ok || response.status === 404) {
          console.log(
            `[TestDataManager] ✅ Cleaned up ${resource.type} ${resource.id}`,
          );
          return true;
        }
        return false;
      }
    } catch (error) {
      console.warn(
        `[TestDataManager] ⚠️ Error cleaning up ${resource.type} ${resource.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Clean up all registered resources
   */
  async cleanupAll(): Promise<void> {
    console.log(
      `[TestDataManager] Cleaning up ${this.resources.length} resources...`,
    );

    // Clean up in reverse order (LIFO)
    const resources = [...this.resources].reverse();
    const results = await Promise.allSettled(
      resources.map((resource) => this.cleanupResource(resource)),
    );

    const successCount = results.filter(
      (r) => r.status === "fulfilled" && r.value,
    ).length;
    const failureCount = results.length - successCount;

    console.log(
      `[TestDataManager] Cleanup complete: ${successCount} succeeded, ${failureCount} failed`,
    );

    this.resources = [];
  }

  /**
   * Get all registered resources
   */
  getResources(): TestResource[] {
    return [...this.resources];
  }

  /**
   * Clear resource list without cleanup
   */
  clear(): void {
    this.resources = [];
  }
}

/**
 * Clean up browser state (cookies, storage)
 */
export async function cleanupBrowserState(page: Page): Promise<void> {
  // Clear cookies
  await page.context().clearCookies();

  // Clear storage
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
    console.log("[Test Cleanup] Browser storage cleared");
  });

  console.log("[Test Cleanup] ✅ Browser state cleaned up");
}

/**
 * Generate test-specific prefix for easy identification
 */
export function generateTestPrefix(testName: string): string {
  const timestamp = Date.now();
  const sanitized = testName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return `e2e-${sanitized}-${timestamp}`;
}

/**
 * Cleanup helper for use in test.afterEach
 */
export async function cleanupTestData(
  page: Page,
  dataManager: TestDataManager,
): Promise<void> {
  // Clean up registered resources
  await dataManager.cleanupAll();

  // Clean up browser state
  await cleanupBrowserState(page);
}
