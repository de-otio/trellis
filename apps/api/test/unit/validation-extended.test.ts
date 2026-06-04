/**
 * Extended Unit Tests: Validation
 *
 * Tests edge cases for validation functions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Validator } from "../../src/lib/validation.js";

describe("Validation Extended", () => {
  let validator: Validator;

  beforeEach(() => {
    validator = new Validator();
  });

  describe("sanitizeError", () => {
    it("should sanitize error messages", () => {
      const error = new Error("Database connection failed");
      const sanitized = validator.sanitizeError(error);
      expect(sanitized).toBe("Database connection failed");
    });

    it("should handle string errors", () => {
      const sanitized = validator.sanitizeError("Test error");
      // Strings are not Error instances, so they return default message
      expect(sanitized).toBe("An error occurred. Please try again later.");
    });

    it("should handle unknown error types", () => {
      const sanitized = validator.sanitizeError({ message: "Custom error" });
      expect(sanitized).toBe("An error occurred. Please try again later.");
    });

    it("should handle null/undefined errors", () => {
      expect(validator.sanitizeError(null)).toBe(
        "An error occurred. Please try again later.",
      );
      expect(validator.sanitizeError(undefined)).toBe(
        "An error occurred. Please try again later.",
      );
    });

    it("should hide stack traces in error messages", () => {
      const error = new Error("Error at line 1");
      error.stack = "Error: Error at line 1\n    at test.js:1:1";
      const sanitized = validator.sanitizeError(error);
      expect(sanitized).toBe("An error occurred. Please try again later.");
    });

    it("should filter PostgreSQL connection strings", () => {
      const error = new Error(
        "Connection failed: postgresql://user:pass@host:5432/db",
      );
      const sanitized = validator.sanitizeError(error);
      expect(sanitized).toBe("An error occurred. Please try again later.");
    });

    it("should filter Prisma connection strings", () => {
      const error = new Error(
        "Connection failed: prisma://accelerate.prisma-data.net/?api_key=secret",
      );
      const sanitized = validator.sanitizeError(error);
      expect(sanitized).toBe("An error occurred. Please try again later.");
    });

    it("should filter Hyperdrive connection strings", () => {
      const error = new Error(
        "Connection failed: postgresql://hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      );
      const sanitized = validator.sanitizeError(error);
      expect(sanitized).toBe("An error occurred. Please try again later.");
    });

    it("should filter connection strings with passwords", () => {
      const error = new Error("Connection failed: password=secret123");
      const sanitized = validator.sanitizeError(error);
      expect(sanitized).toBe("An error occurred. Please try again later.");
    });

    it("should filter API keys", () => {
      const error = new Error("API key=secret123");
      const sanitized = validator.sanitizeError(error);
      expect(sanitized).toBe("An error occurred. Please try again later.");
    });

    it("should filter file paths", () => {
      const error = new Error("File not found: /Users/test/file.ts");
      const sanitized = validator.sanitizeError(error);
      expect(sanitized).toBe("An error occurred. Please try again later.");
    });

    it("should allow safe error messages", () => {
      const error = new Error("User not found");
      const sanitized = validator.sanitizeError(error);
      expect(sanitized).toBe("User not found");
    });
  });

  // validateDogProfile was removed — dog metadata is now validated
  // by the extension's metadataSchema via entity-handler
});
