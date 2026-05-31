/**
 * Internal Documentation Navigation Utilities
 *
 * Generates allowedFiles whitelist from navigation.json
 * This eliminates the need for manual whitelist maintenance.
 */

export interface NavItem {
  title: string;
  path: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export interface NavigationData {
  sections: NavSection[];
}

/**
 * Build allowedFiles whitelist from navigation data
 *
 * Converts navigation paths to the format expected by the API handler:
 * - Input: "internal/OVERVIEW.md"
 * - Output: { "OVERVIEW.md": "internal/OVERVIEW.md" }
 *
 * For subdirectories:
 * - Input: "internal/bavaria-compliance/README.md"
 * - Output: { "bavaria-compliance/README.md": "internal/bavaria-compliance/README.md" }
 */
export function buildAllowedFilesFromNavigation(
  navigation: NavigationData,
): Record<string, string> {
  const allowedFiles: Record<string, string> = {};

  for (const section of navigation.sections) {
    for (const item of section.items) {
      // Extract the filename/key from the path
      // "internal/OVERVIEW.md" -> "OVERVIEW.md"
      // "internal/bavaria-compliance/README.md" -> "bavaria-compliance/README.md"
      const pathWithoutInternal = item.path.replace(/^internal\//, "");

      // Use the path without "internal/" prefix as the key
      // The value is the full path with "internal/" prefix
      allowedFiles[pathWithoutInternal] = item.path;
    }
  }

  return allowedFiles;
}

/**
 * Validate that all navigation items have valid paths
 *
 * Checks:
 * - Paths start with "internal/"
 * - Paths end with ".md"
 * - No path traversal attempts (no "..")
 */
export function validateNavigation(navigation: NavigationData): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  for (const section of navigation.sections) {
    for (const item of section.items) {
      const path = item.path;

      // Check path starts with "internal/"
      if (!path.startsWith("internal/")) {
        errors.push(
          `Navigation item "${item.title}" has invalid path: "${path}" (must start with "internal/")`,
        );
      }

      // Check path ends with ".md"
      if (!path.endsWith(".md")) {
        errors.push(
          `Navigation item "${item.title}" has invalid path: "${path}" (must end with ".md")`,
        );
      }

      // Check for path traversal attempts
      if (path.includes("..")) {
        errors.push(
          `Navigation item "${item.title}" has invalid path: "${path}" (path traversal not allowed)`,
        );
      }

      // Check for absolute paths
      if (path.startsWith("/")) {
        errors.push(
          `Navigation item "${item.title}" has invalid path: "${path}" (absolute paths not allowed)`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
