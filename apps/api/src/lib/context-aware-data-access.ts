/**
 * Context-Aware Data Access
 *
 * PREPARATORY: Border Safety Mode - Context-aware query filters
 *
 * Manages data access filters based on user's profile context (primary vs decoy).
 * Currently dormant - always returns full access filters. This abstraction layer
 * prepares for future implementation where different contexts have different data visibility.
 *
 * FUTURE USE: When Border Safety Mode is implemented, this class will:
 * - Filter data based on profile context (primary vs decoy)
 * - Exclude sensitive data when in decoy context
 * - Apply context-specific visibility rules
 * - Support selective data wiping based on context
 *
 * @see doc/01-business/features/b2c-features/border-safety-mode/preparatory-design-changes/03-api-design.md
 */

import type { Session } from "./session-cookie.js";

/**
 * Data access context for filtering queries
 *
 * Defines what data a user can access based on their profile context.
 * Currently always allows full access (dormant until Border Safety Mode is implemented).
 */
export interface DataAccessContext {
  /** User ID for the access context */
  userId: string;

  /** Profile context type: 'primary' (real profile) or 'decoy' (fake profile) */
  profileContext: "primary" | "decoy";

  /** Whether to include decoy data in results */
  includeDecoy: boolean;

  /** Whether to include sensitive data in results */
  includeSensitive: boolean;
}

/**
 * Context-Aware Data Access Manager
 *
 * Provides data access filters based on user's session context.
 * Currently returns full access filters for all users (dormant).
 */
export class ContextAwareDataAccess {
  /**
   * Get data access filter for current session context
   *
   * PREPARATORY: Currently always returns full access (backward compatible).
   * This method prepares for future implementation where different contexts
   * have different data visibility rules.
   *
   * FUTURE USE: When Border Safety Mode is implemented, this will:
   * - Check session.profileContext
   * - Return filtered access for decoy contexts (exclude sensitive data)
   * - Return full access for primary contexts
   * - Respect user's travel mode settings
   *
   * @param session - User session with profileContext field
   * @returns Data access context with filtering rules
   * @throws Error if session is invalid or missing required fields
   */
  getAccessFilter(session: Session): DataAccessContext {
    if (!session || !session.userId) {
      throw new Error("Invalid session: userId is required");
    }

    // PREPARATORY: Always return full access for now
    // FUTURE: Filter based on session.profileContext when Border Safety Mode is implemented
    const profileContext = session.profileContext || "primary";

    return {
      userId: session.userId,
      profileContext: profileContext,
      includeDecoy: true, // Always true until feature is enabled
      includeSensitive: true, // Always true until feature is enabled
    };
  }

  /**
   * Apply data access filter to a Prisma query
   *
   * PREPARATORY: Currently a no-op (returns query unchanged).
   * This method prepares for future implementation where queries are filtered
   * based on context and sensitivity level.
   *
   * FUTURE USE: When Border Safety Mode is implemented, this will:
   * - Add WHERE clauses to filter by sensitivityLevel
   * - Filter by ownerContext based on profileContext
   * - Exclude decoy data when includeDecoy is false
   * - Exclude sensitive data when includeSensitive is false
   *
   * Example future implementation:
   * ```typescript
   * if (!filter.includeSensitive) {
   *   query.where.sensitivityLevel = { not: 'sensitive' };
   * }
   * if (!filter.includeDecoy) {
   *   query.where.ownerContext = filter.profileContext;
   * }
   * ```
   *
   * @param query - Prisma query object (any type for flexibility)
   * @param filter - Data access context filter
   * @returns Query with filters applied (currently unchanged)
   */
  applyFilter<T>(query: T, filter: DataAccessContext): T {
    // PREPARATORY: No-op for now - returns query unchanged
    // TODO: Add filtering logic when Border Safety Mode is implemented (Phase 3)
    // This will add WHERE clauses based on:
    // - filter.includeSensitive (exclude sensitive data if false)
    // - filter.includeDecoy (exclude decoy data if false)
    // - filter.profileContext (filter by ownerContext)

    return query;
  }
}
