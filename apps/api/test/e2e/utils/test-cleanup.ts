/**
 * Test Cleanup Utilities
 *
 * Utilities for cleaning up test data from the database.
 */

import { getApiUrl } from "../utils/test-config";

/**
 * Delete a profile by ID
 */
export async function deleteProfile(
  profileId: string,
  sessionToken: string,
  csrfToken?: string,
): Promise<boolean> {
  const apiUrl = getApiUrl();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${sessionToken}`,
  };

  if (csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }

  try {
    const response = await fetch(`${apiUrl}/api/entities/${profileId}`, {
      method: "DELETE",
      headers,
    });

    if (response.ok || response.status === 404) {
      console.log(`[Cleanup] ✅ Deleted profile: ${profileId}`);
      return true;
    } else {
      const errorText = await response.text().catch(() => "Unknown error");
      console.warn(
        `[Cleanup] ⚠️  Failed to delete profile ${profileId}: ${response.status} - ${errorText}`,
      );
      return false;
    }
  } catch (error) {
    console.warn(`[Cleanup] ⚠️  Error deleting profile ${profileId}:`, error);
    return false;
  }
}

/**
 * Cleanup test data by prefix
 *
 * Note: This requires direct database access, which may not be available in e2e tests.
 * For e2e tests, use TestDataManager to track and cleanup resources.
 */
export async function cleanupTestDataByPrefix(
  prefix: string,
  sessionToken?: string,
): Promise<number> {
  console.log(`[Cleanup] Cleaning up test data with prefix: ${prefix}`);

  // This would require database access, which is typically not available in e2e tests
  // For now, this is a placeholder that can be implemented if needed
  console.warn(
    "[Cleanup] Direct database cleanup not available in e2e tests. Use TestDataManager instead.",
  );

  return 0;
}

/**
 * Cleanup old test data (older than specified age in milliseconds)
 */
export async function cleanupOldTestData(
  maxAgeMs: number = 24 * 60 * 60 * 1000, // 24 hours
): Promise<number> {
  console.log(`[Cleanup] Cleaning up test data older than ${maxAgeMs}ms`);

  // This would require database access, which is typically not available in e2e tests
  // For now, this is a placeholder that can be implemented if needed
  console.warn(
    "[Cleanup] Direct database cleanup not available in e2e tests. Use TestDataManager instead.",
  );

  return 0;
}
