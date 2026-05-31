/**
 * Unit Tests: Email Privacy Utilities
 *
 * Comprehensive tests for email hashing including:
 * - Consistent hashing (same email = same hash)
 * - Email normalization (lowercase, trim)
 * - Edge cases (empty, whitespace, invalid)
 * - Hash format validation
 */

import { describe, expect, it } from "vitest";
import { hashEmail } from "../../src/lib/email-privacy.js";

describe("email-privacy", () => {
  describe("hashEmail", () => {
    it("should produce consistent hashes for same email", async () => {
      const email = "test@example.com";
      const hash1 = await hashEmail(email);
      const hash2 = await hashEmail(email);

      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe("string");
      expect(hash1.length).toBe(64); // SHA-256 produces 64 hex characters
    });

    it("should normalize email to lowercase", async () => {
      const email1 = "Test@Example.com";
      const email2 = "test@example.com";
      const email3 = "TEST@EXAMPLE.COM";

      const hash1 = await hashEmail(email1);
      const hash2 = await hashEmail(email2);
      const hash3 = await hashEmail(email3);

      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
    });

    it("should trim whitespace from email", async () => {
      const email1 = "  test@example.com  ";
      const email2 = "test@example.com";
      const email3 = "\t\ntest@example.com\n\t";

      const hash1 = await hashEmail(email1);
      const hash2 = await hashEmail(email2);
      const hash3 = await hashEmail(email3);

      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
    });

    it("should handle email with mixed case and whitespace", async () => {
      const email1 = "  User@Example.com  ";
      const email2 = "user@example.com";

      const hash1 = await hashEmail(email1);
      const hash2 = await hashEmail(email2);

      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different emails", async () => {
      const email1 = "test1@example.com";
      const email2 = "test2@example.com";

      const hash1 = await hashEmail(email1);
      const hash2 = await hashEmail(email2);

      expect(hash1).not.toBe(hash2);
    });

    it("should produce valid SHA-256 hex string", async () => {
      const email = "test@example.com";
      const hash = await hashEmail(email);

      // SHA-256 produces 64 hex characters
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should throw error for empty string", async () => {
      await expect(hashEmail("")).rejects.toThrow(
        "Email must be a non-empty string",
      );
    });

    it("should throw error for whitespace-only string", async () => {
      await expect(hashEmail("   ")).rejects.toThrow(
        "Email cannot be empty after normalization",
      );
    });

    it("should throw error for null", async () => {
      await expect(hashEmail(null as any)).rejects.toThrow(
        "Email must be a non-empty string",
      );
    });

    it("should throw error for undefined", async () => {
      await expect(hashEmail(undefined as any)).rejects.toThrow(
        "Email must be a non-empty string",
      );
    });

    it("should throw error for non-string input", async () => {
      await expect(hashEmail(123 as any)).rejects.toThrow(
        "Email must be a non-empty string",
      );
    });

    it("should handle email with special characters", async () => {
      const email = "test+tag@example.com";
      const hash = await hashEmail(email);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should handle email with subdomain", async () => {
      const email = "test@mail.example.com";
      const hash = await hashEmail(email);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(64);
    });

    it("should produce deterministic hashes", async () => {
      // Test that hashing is deterministic across multiple calls
      const email = "deterministic@test.com";
      const hashes = await Promise.all([
        hashEmail(email),
        hashEmail(email),
        hashEmail(email),
        hashEmail(email),
        hashEmail(email),
      ]);

      // All hashes should be identical
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(1);
    });

    it("should handle unicode characters in email", async () => {
      const email = "tëst@éxample.com";
      const hash = await hashEmail(email);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should normalize email before hashing", async () => {
      // Test that normalization happens before hashing
      const email1 = "  Test@Example.com  ";
      const email2 = "test@example.com";

      const hash1 = await hashEmail(email1);
      const hash2 = await hashEmail(email2);

      // Should be identical after normalization
      expect(hash1).toBe(hash2);
    });
  });
});
