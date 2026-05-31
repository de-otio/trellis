/**
 * Database Configuration Manager
 *
 * Provides region-aware database connection configuration for multi-region support.
 * With self-hosted Supabase on AWS China, no database provider abstraction is needed -
 * just connection string changes for different regions.
 */

export interface Env {
  DATABASE_URL: string; // Hyperdrive connection string (US/EU) or direct connection (migrations)
  DATABASE_URL_CN?: string; // China database connection (self-hosted Supabase on AWS China)
}

/**
 * Get database connection string for a specific region
 *
 * @param region - Region code ('US', 'CN', etc.)
 * @param env - Environment variables
 * @returns Database connection string for the region
 */
export function getDatabaseConnection(region: string, env: Env): string {
  // Validate region
  if (!isValidRegion(region)) {
    throw new Error(`Invalid region: ${region}. Must be one of: US, CN`);
  }

  if (region === "CN") {
    // China region: Use self-hosted Supabase on AWS China
    if (!env.DATABASE_URL_CN) {
      throw new Error(
        "China region requires DATABASE_URL_CN environment variable",
      );
    }
    return env.DATABASE_URL_CN;
  }

  // Global region (US, EU, etc.): Use hosted Supabase
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return env.DATABASE_URL;
}

/**
 * Validate region code
 *
 * @param region - Region code to validate
 * @returns True if region is valid
 */
function isValidRegion(region: string): boolean {
  const validRegions = ["US", "CN", "EU"];
  return validRegions.includes(region);
}
