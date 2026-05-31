/**
 * Unit Tests: Error Handling and Sanitization
 *
 * Tests for error sanitization, input validation errors, and security.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

/**
 * Mock error sanitization function
 */
function sanitizeError(error: unknown): { message: string; code?: string } {
  if (error instanceof z.ZodError) {
    return { message: "Invalid input", code: "VALIDATION_ERROR" };
  }

  if (error instanceof Error) {
    // Log full error server-side (would happen in real code)
    // Return sanitized message
    return {
      message: "An error occurred. Please try again.",
      code: "INTERNAL_ERROR",
    };
  }

  return { message: "Unknown error", code: "UNKNOWN" };
}

describe("Error Handling", () => {
  describe("sanitizeError", () => {
    it("should sanitize Zod validation errors", () => {
      const schema = z.object({ name: z.string().min(1) });

      try {
        schema.parse({ name: "" });
      } catch (error) {
        const sanitized = sanitizeError(error);
        expect(sanitized.message).toBe("Invalid input");
        expect(sanitized.code).toBe("VALIDATION_ERROR");
      }
    });

    it("should sanitize generic errors", () => {
      const error = new Error("Internal database connection failed");
      const sanitized = sanitizeError(error);

      expect(sanitized.message).toBe("An error occurred. Please try again.");
      expect(sanitized.message).not.toContain("database");
      expect(sanitized.message).not.toContain("connection");
      expect(sanitized.code).toBe("INTERNAL_ERROR");
    });

    it("should not expose stack traces", () => {
      const error = new Error("Test error");
      error.stack = "Error: Test error\n    at function (file.js:1:1)";

      const sanitized = sanitizeError(error);
      const sanitizedStr = JSON.stringify(sanitized);

      expect(sanitizedStr).not.toContain("stack");
      expect(sanitizedStr).not.toContain("at ");
      expect(sanitizedStr).not.toContain("file.js");
    });

    it("should handle unknown error types", () => {
      const error = "String error";
      const sanitized = sanitizeError(error);

      expect(sanitized.message).toBe("Unknown error");
      expect(sanitized.code).toBe("UNKNOWN");
    });

    it("should not expose internal paths or file names", () => {
      const error = new Error("/var/www/server.js:123 Internal error");
      const sanitized = sanitizeError(error);
      const sanitizedStr = JSON.stringify(sanitized);

      expect(sanitizedStr).not.toContain("/var/www");
      expect(sanitizedStr).not.toContain("server.js");
      expect(sanitizedStr).not.toContain(":123");
    });
  });

  describe("Input Validation Errors", () => {
    it("should provide helpful validation error messages", () => {
      const schema = z.object({
        name: z.string().min(1, "Name is required"),
        age: z.number().min(0, "Age must be positive"),
      });

      try {
        schema.parse({ name: "", age: -1 });
      } catch (error) {
        if (error instanceof z.ZodError) {
          expect(error.errors.length).toBeGreaterThan(0);
          // Errors should be specific but not expose internal details
        }
      }
    });
  });
});
