/**
 * Theme Configuration
 *
 * Provides theme structure for white-label support.
 * For MVP, always returns default Trellis theme.
 * Future: Will support tenant-specific themes.
 */

export interface Theme {
  primaryColor: string;
  secondaryColor: string;
  logoUrl?: string;
  faviconUrl?: string;
  name?: string;
}

const DEFAULT_THEME: Theme = {
  primaryColor: "#3B82F6", // Trellis blue
  secondaryColor: "#10B981", // Trellis green
  logoUrl: "/logo.svg",
  faviconUrl: "/favicon.ico",
  name: "Trellis",
};

/**
 * Get theme for a tenant
 *
 * For MVP, always returns default Trellis theme.
 * Future: Will look up tenant-specific theme from database.
 *
 * @param tenantId - Optional tenant ID (not used in MVP)
 * @returns Theme object
 */
export function getTheme(tenantId?: string): Theme {
  // For MVP, always return default
  return DEFAULT_THEME;
}

/**
 * Get theme synchronously
 */
export function getThemeSync(tenantId?: string): Theme {
  return DEFAULT_THEME;
}
