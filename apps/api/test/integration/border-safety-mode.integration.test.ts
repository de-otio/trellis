/**
 * Integration Tests: Border Safety Mode Preparatory Classes
 *
 * Tests that all new Border Safety Mode classes work together correctly.
 * Verifies integration between:
 * - SessionManager with profileContext
 * - AuthContextManager
 * - ContextAwareDataAccess
 * - Email Privacy utilities
 *
 * These tests verify the actual code paths work correctly together without
 * mocking critical dependencies.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { AuthContextManager } from "../../src/lib/auth-context-manager.js";
import { ContextAwareDataAccess } from "../../src/lib/context-aware-data-access.js";
import { hashEmail } from "../../src/lib/email-privacy.js";
import { SessionManager, type Session } from "../../src/lib/session-cookie.js";

describe("Border Safety Mode Integration Tests", () => {
  let sessionManager: SessionManager;
  let authContextManager: AuthContextManager;
  let contextAwareDataAccess: ContextAwareDataAccess;

  beforeEach(() => {
    sessionManager = new SessionManager();
    authContextManager = new AuthContextManager();
    contextAwareDataAccess = new ContextAwareDataAccess();
  });

  describe("Session + AuthContextManager Integration", () => {
    it("should work together: Session with profileContext -> AuthContextManager", async () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      // Get contexts for user
      const contexts = await authContextManager.getContexts(session.userId);
      expect(contexts).toBeDefined();
      expect(contexts.length).toBe(1);
      expect(contexts[0].contextId).toBe("primary");

      // Get default context
      const defaultContext = await authContextManager.getDefaultContext(
        session.userId,
      );
      expect(defaultContext).toBe("primary");
      expect(defaultContext).toBe(session.profileContext);
    });

    it("should handle decoy context in session", async () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "decoy",
      };

      // AuthContextManager still returns primary (dormant)
      const contexts = await authContextManager.getContexts(session.userId);
      expect(contexts[0].contextType).toBe("primary");

      // But session has decoy context
      expect(session.profileContext).toBe("decoy");
    });
  });

  describe("Session + ContextAwareDataAccess Integration", () => {
    it("should work together: Session -> ContextAwareDataAccess", () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      // Get access filter from session
      const filter = contextAwareDataAccess.getAccessFilter(session);

      expect(filter.userId).toBe(session.userId);
      expect(filter.profileContext).toBe(session.profileContext);
      expect(filter.includeDecoy).toBe(true);
      expect(filter.includeSensitive).toBe(true);
    });

    it("should apply filter to query (no-op for now)", () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      const filter = contextAwareDataAccess.getAccessFilter(session);
      const query = { where: { userId: session.userId } };

      // Apply filter (currently no-op)
      const result = contextAwareDataAccess.applyFilter(query, filter);

      expect(result).toBe(query);
      expect(result).toEqual(query);
    });
  });

  describe("Email Privacy Integration", () => {
    it("should hash email consistently for user lookup", async () => {
      const email = "test@example.com";
      const hash1 = await hashEmail(email);
      const hash2 = await hashEmail(email);

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // SHA-256 hex string
    });

    it("should normalize email before hashing", async () => {
      const email1 = "  Test@Example.com  ";
      const email2 = "test@example.com";

      const hash1 = await hashEmail(email1);
      const hash2 = await hashEmail(email2);

      expect(hash1).toBe(hash2);
    });
  });

  describe("Full Workflow Integration", () => {
    it("should support full workflow: Session -> AuthContext -> DataAccess", async () => {
      // 1. Create session with profileContext
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      // 2. Get auth contexts
      const contexts = await authContextManager.getContexts(session.userId);
      expect(contexts.length).toBeGreaterThan(0);

      // 3. Get default context
      const defaultContext = await authContextManager.getDefaultContext(
        session.userId,
      );
      expect(defaultContext).toBe("primary");

      // 4. Get data access filter
      const filter = contextAwareDataAccess.getAccessFilter(session);
      expect(filter.profileContext).toBe(session.profileContext);

      // 5. Apply filter to query
      const query = { where: { userId: session.userId } };
      const filteredQuery = contextAwareDataAccess.applyFilter(query, filter);
      expect(filteredQuery).toBe(query);
    });

    it("should handle email hashing in user workflow", async () => {
      const session: Session = {
        userId: "test-user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
        profileContext: "primary",
      };

      // Hash email for privacy-preserving lookup
      const emailHash = await hashEmail(session.email);
      expect(emailHash).toBeDefined();
      expect(emailHash.length).toBe(64);

      // Verify hash is consistent
      const hash2 = await hashEmail(session.email);
      expect(emailHash).toBe(hash2);
    });
  });

  describe("Error Handling Integration", () => {
    it("should handle invalid session gracefully", () => {
      expect(() => {
        contextAwareDataAccess.getAccessFilter(null as any);
      }).toThrow("Invalid session: userId is required");
    });

    it("should handle invalid userId in AuthContextManager", async () => {
      await expect(authContextManager.getContexts("")).rejects.toThrow(
        "Invalid userId: must be a non-empty string",
      );
    });
  });
});
