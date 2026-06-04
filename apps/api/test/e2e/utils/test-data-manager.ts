/**
 * Test Data Manager
 *
 * Manages test data creation and cleanup for e2e tests.
 * Tracks created resources and provides automatic cleanup.
 */

import { getApiUrl } from "../../utils/test-config.js";

/**
 * Test data resource types
 */
export interface TestResource {
  type: "profile" | "user" | "image" | "other";
  id: string;
  name?: string;
  email?: string;
  createdAt: number;
}

/**
 * Test Data Manager
 *
 * Tracks and manages test data created during test execution.
 * Provides automatic cleanup of all created resources.
 */
export class TestDataManager {
  private resources: TestResource[] = [];
  private testPrefix: string;
  private apiUrl: string;
  private sessionToken?: string;
  private csrfToken?: string;

  constructor(testName: string) {
    const timestamp = Date.now();
    const sanitizedTestName = testName
      .replace(/[^a-zA-Z0-9]/g, "-")
      .toLowerCase();
    this.testPrefix = `e2e-test-${sanitizedTestName}-${timestamp}`;
    this.apiUrl = getApiUrl();
  }

  /**
   * Set authentication tokens for cleanup operations
   */
  setAuthTokens(sessionToken: string, csrfToken?: string): void {
    this.sessionToken = sessionToken;
    this.csrfToken = csrfToken;
  }

  /**
   * Get test-specific prefix for identifying test data
   */
  getTestPrefix(): string {
    return this.testPrefix;
  }

  /**
   * Generate test email with prefix
   */
  generateTestEmail(domain: string): string {
    return `${this.testPrefix}@${domain}`;
  }

  /**
   * Generate test profile name with prefix
   */
  generateTestProfileName(baseName: string = "Dog"): string {
    return `${this.testPrefix}-${baseName}`;
  }

  /**
   * Track a created profile
   */
  trackProfile(profileId: string, name?: string): void {
    this.resources.push({
      type: "profile",
      id: profileId,
      name,
      createdAt: Date.now(),
    });
    console.log(
      `[TestDataManager] Tracked profile: ${profileId} (${name || "unnamed"})`,
    );
  }

  /**
   * Track a created user
   */
  trackUser(userId: string, email?: string): void {
    this.resources.push({
      type: "user",
      id: userId,
      email,
      createdAt: Date.now(),
    });
    console.log(
      `[TestDataManager] Tracked user: ${userId} (${email || "no email"})`,
    );
  }

  /**
   * Track an uploaded image
   */
  trackImage(imageId: string, name?: string): void {
    this.resources.push({
      type: "image",
      id: imageId,
      name,
      createdAt: Date.now(),
    });
    console.log(
      `[TestDataManager] Tracked image: ${imageId} (${name || "unnamed"})`,
    );
  }

  /**
   * Track any other resource
   */
  trackResource(type: "other", id: string, name?: string): void {
    this.resources.push({
      type,
      id,
      name,
      createdAt: Date.now(),
    });
    console.log(
      `[TestDataManager] Tracked ${type}: ${id} (${name || "unnamed"})`,
    );
  }

  /**
   * Delete a profile via API
   */
  private async deleteProfile(profileId: string): Promise<boolean> {
    if (!this.sessionToken) {
      console.warn(
        `[TestDataManager] Cannot delete profile ${profileId}: No session token`,
      );
      return false;
    }

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.sessionToken}`,
      };

      if (this.csrfToken) {
        headers["X-CSRF-Token"] = this.csrfToken;
      }

      const response = await fetch(`${this.apiUrl}/api/entities/${profileId}`, {
        method: "DELETE",
        headers,
      });

      if (response.ok || response.status === 404) {
        console.log(`[TestDataManager] ✅ Deleted profile: ${profileId}`);
        return true;
      } else {
        const errorText = await response.text().catch(() => "Unknown error");
        console.warn(
          `[TestDataManager] ⚠️  Failed to delete profile ${profileId}: ${response.status} - ${errorText}`,
        );
        return false;
      }
    } catch (error) {
      console.warn(
        `[TestDataManager] ⚠️  Error deleting profile ${profileId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Cleanup all tracked resources
   */
  async cleanup(): Promise<void> {
    if (this.resources.length === 0) {
      console.log("[TestDataManager] No resources to cleanup");
      return;
    }

    console.log(
      `[TestDataManager] Cleaning up ${this.resources.length} resource(s)...`,
    );

    // Clean up in reverse order (most recent first)
    const sortedResources = [...this.resources].sort(
      (a, b) => b.createdAt - a.createdAt,
    );

    for (const resource of sortedResources) {
      try {
        switch (resource.type) {
          case "profile":
            await this.deleteProfile(resource.id);
            break;
          case "user":
            // Users are typically cascade-deleted when profiles are deleted
            // Or they can be cleaned up via a separate user cleanup endpoint
            console.log(
              `[TestDataManager] User cleanup not implemented: ${resource.id}`,
            );
            break;
          case "image":
            // Images are typically stored in S3/R2 and may need separate cleanup
            console.log(
              `[TestDataManager] Image cleanup not implemented: ${resource.id}`,
            );
            break;
          default:
            console.log(
              `[TestDataManager] Unknown resource type: ${resource.type}`,
            );
        }
      } catch (error) {
        console.warn(
          `[TestDataManager] ⚠️  Error cleaning up ${resource.type} ${resource.id}:`,
          error,
        );
      }
    }

    this.resources = [];
    console.log("[TestDataManager] ✅ Cleanup complete");
  }

  /**
   * Get all tracked resources
   */
  getResources(): TestResource[] {
    return [...this.resources];
  }

  /**
   * Get count of tracked resources by type
   */
  getResourceCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const resource of this.resources) {
      counts[resource.type] = (counts[resource.type] || 0) + 1;
    }
    return counts;
  }
}
