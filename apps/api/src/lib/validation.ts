/**
 * Input Validation
 *
 * Validation schemas and utilities for API endpoints.
 */

/**
 * Entity profile input interface (replaces Dog profile)
 */
export interface EntityProfileInput {
  name: string;
  entityType?: string;
  metadata?: {
    breed?: string;
    bio?: string;
    birthdate?: string;
    privacy?: "public" | "followers" | "private";
    [key: string]: any; // Flexible for different entity types
  };
  id?: string; // Optional ID for updating existing profiles
  /** Caller-supplied life-stage override (unvalidated pass-through). */
  lifeStageManualOverride?: boolean;
  /** Caller-supplied explicit life stage (unvalidated pass-through). */
  lifeStage?: string;
}


/**
 * Validator class for input validation
 */
export class Validator {
  /**
   * Validate entity profile input
   */
  validateEntityProfile(input: any): {
    valid: boolean;
    data?: EntityProfileInput;
    error?: string;
  } {
    // Name is required, max 64 characters, must not be empty after trimming
    if (
      !input.name ||
      typeof input.name !== "string" ||
      input.name.trim().length === 0
    ) {
      return { valid: false, error: "Name is required and cannot be empty" };
    }

    if (input.name.length > 64) {
      return { valid: false, error: "Name must be 64 characters or less" };
    }

    const entityType = input.entityType;

    // Metadata validation (optional)
    let metadata: any = {};
    if (input.metadata && typeof input.metadata === "object") {
      metadata = { ...input.metadata };
    }

    // Privacy validation (if in metadata)
    if (
      metadata.privacy &&
      !["public", "followers", "private"].includes(metadata.privacy)
    ) {
      return {
        valid: false,
        error: "Privacy must be one of: public, followers, private",
      };
    }

    // ID validation (optional, for updating existing profiles)
    if (input.id && typeof input.id !== "string") {
      return { valid: false, error: "ID must be a string" };
    }

    return {
      valid: true,
      data: {
        name: input.name,
        entityType,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        id: input.id,
        lifeStageManualOverride: input.lifeStageManualOverride,
        lifeStage: input.lifeStage,
      },
    };
  }



  /**
   * Validate taxonomy taxon IDs
   * Ensures taxon IDs are in the correct format: dimension:category:taxon
   */
  validateTaxonIds(taxonIds: any): string[] {
    if (!Array.isArray(taxonIds)) {
      throw new Error("taxonIds must be an array");
    }

    if (taxonIds.length === 0) {
      throw new Error("taxonIds cannot be empty");
    }

    if (taxonIds.length > 20) {
      throw new Error("Maximum 20 taxonomy tags allowed");
    }

    const taxonIdRegex = /^[a-z-]+:[a-z-]+:[a-z-]+$/;
    const invalidIds = taxonIds.filter(
      (id) => typeof id !== "string" || !taxonIdRegex.test(id),
    );

    if (invalidIds.length > 0) {
      throw new Error(
        `Invalid taxon ID format. Expected format: dimension:category:taxon. Invalid IDs: ${invalidIds.join(", ")}`,
      );
    }

    return taxonIds;
  }

  /**
   * Sanitize error for response (don't leak internal details)
   *
   * SECURITY: Prevents exposure of:
   * - Database connection strings (postgresql://, prisma://, etc.)
   * - Stack traces
   * - Internal file paths
   * - Sensitive environment variable names
   * - Internal error types
   */
  sanitizeError(error: unknown): string {
    if (error instanceof Error) {
      const message = error.message;

      // SECURITY: Filter out sensitive patterns
      const sensitivePatterns = [
        /postgresql:\/\/[^\s]+/gi, // PostgreSQL connection strings
        /prisma:\/\/[^\s]+/gi, // Prisma connection strings
        /postgres:\/\/[^\s]+/gi, // Postgres connection strings
        /hyperdrive[^\s]*/gi, // Hyperdrive references
        /@[^\s]+:[0-9]+\/[^\s]+/gi, // Connection strings with @host:port/db
        /password[=:][^\s]+/gi, // Password in connection strings
        /api[_\s-]?key[=:][^\s]+/gi, // API keys (case-insensitive, allows space/underscore/dash)
        /secret[=:][^\s]+/gi, // Secrets
        /token[=:][^\s]+/gi, // Tokens
        /\/Users\/[^\s]+/gi, // File paths (macOS)
        /\/home\/[^\s]+/gi, // File paths (Linux)
        /C:\\[^\s]+/gi, // File paths (Windows)
        /at\s+[^\s]+\s+\(/gi, // Stack trace patterns
        /TypeError|ReferenceError|SyntaxError/gi, // Internal error types
      ];

      // Check if message contains sensitive information
      for (const pattern of sensitivePatterns) {
        if (pattern.test(message)) {
          return "An error occurred. Please try again later.";
        }
      }

      // Check if it's an internal error we should hide
      if (message.includes("stack") || message.includes("at ")) {
        return "An error occurred. Please try again later.";
      }

      // Return sanitized message (safe to expose)
      return message;
    }

    return "An error occurred. Please try again later.";
  }
}
