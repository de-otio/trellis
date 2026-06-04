/**
 * Unit Tests: Context-Aware Data Access
 *
 * Comprehensive tests for ContextAwareDataAccess including:
 * - Getting access filters from sessions
 * - Applying filters to queries (currently no-op)
 * - Error handling for invalid sessions
 * - Profile context handling
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  ContextAwareDataAccess,
  type DataAccessContext,
} from "../../src/lib/context-aware-data-access.js";
import type { Session } from "../../src/lib/session-cookie.js";

describe("ContextAwareDataAccess", () => {
  let contextAwareDataAccess: ContextAwareDataAccess;

  beforeEach(() => {
    contextAwareDataAccess = new ContextAwareDataAccess();
  });

  describe("getAccessFilter", () => {
    it("should return full access filter for valid session with primary context", () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const filter = contextAwareDataAccess.getAccessFilter(session);

      expect(filter).toBeDefined();
      expect(filter.userId).toBe("test-user-123");
      expect(filter.profileContext).toBe("primary");
      expect(filter.includeDecoy).toBe(true);
      expect(filter.includeSensitive).toBe(true);
    });

    it("should return full access filter for session with decoy context", () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "decoy",
      };

      const filter = contextAwareDataAccess.getAccessFilter(session);

      expect(filter).toBeDefined();
      expect(filter.userId).toBe("test-user-123");
      expect(filter.profileContext).toBe("decoy");
      expect(filter.includeDecoy).toBe(true);
      expect(filter.includeSensitive).toBe(true);
    });

    it("should default to primary context if profileContext is missing", () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        // profileContext missing - should default to 'primary'
      } as Session;

      const filter = contextAwareDataAccess.getAccessFilter(session);

      expect(filter.profileContext).toBe("primary");
      expect(filter.includeDecoy).toBe(true);
      expect(filter.includeSensitive).toBe(true);
    });

    it("should return filter with correct structure", () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const filter: DataAccessContext =
        contextAwareDataAccess.getAccessFilter(session);

      expect(filter).toHaveProperty("userId");
      expect(filter).toHaveProperty("profileContext");
      expect(filter).toHaveProperty("includeDecoy");
      expect(filter).toHaveProperty("includeSensitive");
    });

    it("should throw error for null session", () => {
      expect(() => {
        contextAwareDataAccess.getAccessFilter(null as any);
      }).toThrow("Invalid session: userId is required");
    });

    it("should throw error for undefined session", () => {
      expect(() => {
        contextAwareDataAccess.getAccessFilter(undefined as any);
      }).toThrow("Invalid session: userId is required");
    });

    it("should throw error for session without userId", () => {
      const session = {
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      } as any;

      expect(() => {
        contextAwareDataAccess.getAccessFilter(session);
      }).toThrow("Invalid session: userId is required");
    });

    it("should throw error for session with empty userId", () => {
      const session: Session = {
        userId: "",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      expect(() => {
        contextAwareDataAccess.getAccessFilter(session);
      }).toThrow("Invalid session: userId is required");
    });

    it("should always return includeDecoy: true (dormant feature)", () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const filter = contextAwareDataAccess.getAccessFilter(session);
      expect(filter.includeDecoy).toBe(true);
    });

    it("should always return includeSensitive: true (dormant feature)", () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const filter = contextAwareDataAccess.getAccessFilter(session);
      expect(filter.includeSensitive).toBe(true);
    });
  });

  describe("applyFilter", () => {
    it("should return query unchanged (no-op)", () => {
      const query = { where: { userId: "test-user-123" } };
      const filter: DataAccessContext = {
        userId: "test-user-123",
        profileContext: "primary",
        includeDecoy: true,
        includeSensitive: true,
      };

      const result = contextAwareDataAccess.applyFilter(query, filter);

      expect(result).toBe(query);
      expect(result).toEqual(query);
    });

    it("should return query unchanged for different filter values", () => {
      const query = { where: { userId: "test-user-123" } };
      const filter: DataAccessContext = {
        userId: "test-user-123",
        profileContext: "decoy",
        includeDecoy: false,
        includeSensitive: false,
      };

      const result = contextAwareDataAccess.applyFilter(query, filter);

      expect(result).toBe(query);
      expect(result).toEqual(query);
    });

    it("should handle null query", () => {
      const filter: DataAccessContext = {
        userId: "test-user-123",
        profileContext: "primary",
        includeDecoy: true,
        includeSensitive: true,
      };

      const result = contextAwareDataAccess.applyFilter(null, filter);

      expect(result).toBeNull();
    });

    it("should handle undefined query", () => {
      const filter: DataAccessContext = {
        userId: "test-user-123",
        profileContext: "primary",
        includeDecoy: true,
        includeSensitive: true,
      };

      const result = contextAwareDataAccess.applyFilter(undefined, filter);

      expect(result).toBeUndefined();
    });

    it("should handle complex query objects", () => {
      const query = {
        where: {
          userId: "test-user-123",
          sensitivityLevel: "sensitive",
          ownerContext: "primary",
        },
        include: {
          author: true,
          comments: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      };

      const filter: DataAccessContext = {
        userId: "test-user-123",
        profileContext: "primary",
        includeDecoy: true,
        includeSensitive: true,
      };

      const result = contextAwareDataAccess.applyFilter(query, filter);

      expect(result).toBe(query);
      expect(result).toEqual(query);
    });

    it("should preserve query type", () => {
      const query = { id: "123", name: "test" };
      const filter: DataAccessContext = {
        userId: "test-user-123",
        profileContext: "primary",
        includeDecoy: true,
        includeSensitive: true,
      };

      const result = contextAwareDataAccess.applyFilter(query, filter);

      expect(result).toBe(query);
      expect(typeof result).toBe("object");
    });
  });

  describe("Integration: getAccessFilter + applyFilter", () => {
    it("should work together for full workflow", () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const filter = contextAwareDataAccess.getAccessFilter(session);
      const query = { where: { userId: session.userId } };
      const result = contextAwareDataAccess.applyFilter(query, filter);

      expect(result).toBe(query);
      expect(filter.includeDecoy).toBe(true);
      expect(filter.includeSensitive).toBe(true);
    });
  });
});
