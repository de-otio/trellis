/**
 * Unit Tests: Validation Schemas and Validator Class
 *
 * Tests for Zod validation schemas and Validator class methods used throughout the API.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Validator } from "../../src/lib/validation.js";

// These schemas should be imported from src/lib/validation.ts once created
// For now, we'll define them here to test

const dogProfileSchema = z.object({
  name: z.string().min(1).max(64),
  breed: z.string().max(128).optional(),
  bio: z.string().max(500).optional(),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a valid date in YYYY-MM-DD format")
    .optional(),
  privacy: z.enum(["public", "followers", "private"]).default("public"),
});

const sessionSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  expiresAt: z.number(),
});

describe("Validation Schemas", () => {
  describe("dogProfileSchema", () => {
    it("should validate valid dog profile", () => {
      const validProfile = {
        name: "Rex",
        breed: "German Shepherd",
        bio: "A good boy",
        privacy: "public" as const,
      };

      const result = dogProfileSchema.parse(validProfile);
      expect(result.name).toBe("Rex");
      expect(result.breed).toBe("German Shepherd");
      expect(result.bio).toBe("A good boy");
      expect(result.privacy).toBe("public");
    });

    it("should validate profile with only required field", () => {
      const minimalProfile = {
        name: "Rex",
      };

      const result = dogProfileSchema.parse(minimalProfile);
      expect(result.name).toBe("Rex");
      expect(result.privacy).toBe("public"); // Default value
    });

    it("should reject empty name", () => {
      const invalidProfile = {
        name: "",
        privacy: "public" as const,
      };

      expect(() => dogProfileSchema.parse(invalidProfile)).toThrow();
    });

    it("should reject name longer than 64 characters", () => {
      const invalidProfile = {
        name: "A".repeat(65),
        privacy: "public" as const,
      };

      expect(() => dogProfileSchema.parse(invalidProfile)).toThrow();
    });

    it("should reject breed longer than 128 characters", () => {
      const invalidProfile = {
        name: "Rex",
        breed: "A".repeat(129),
        privacy: "public" as const,
      };

      expect(() => dogProfileSchema.parse(invalidProfile)).toThrow();
    });

    it("should reject bio longer than 500 characters", () => {
      const invalidProfile = {
        name: "Rex",
        bio: "A".repeat(501),
        privacy: "public" as const,
      };

      expect(() => dogProfileSchema.parse(invalidProfile)).toThrow();
    });

    it("should reject invalid privacy value", () => {
      const invalidProfile = {
        name: "Rex",
        privacy: "invalid" as any,
      };

      expect(() => dogProfileSchema.parse(invalidProfile)).toThrow();
    });

    it("should accept all valid privacy values", () => {
      const privacyValues = ["public", "followers", "private"] as const;

      privacyValues.forEach((privacy) => {
        const profile = {
          name: "Rex",
          privacy,
        };

        const result = dogProfileSchema.parse(profile);
        expect(result.privacy).toBe(privacy);
      });
    });

    it("should accept valid ISO date string", () => {
      const profile = {
        name: "Rex",
        birthdate: "2020-01-15",
        privacy: "public" as const,
      };

      const result = dogProfileSchema.parse(profile);
      expect(result.birthdate).toBe("2020-01-15");
    });

    it("should reject invalid date format", () => {
      const profile = {
        name: "Rex",
        birthdate: "not-a-date",
        privacy: "public" as const,
      };

      expect(() => dogProfileSchema.parse(profile)).toThrow();
    });
  });

  describe("sessionSchema", () => {
    it("should validate valid session", () => {
      const validSession = {
        userId: "123e4567-e89b-12d3-a456-426614174000",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      };

      const result = sessionSchema.parse(validSession);
      expect(result.userId).toBe("123e4567-e89b-12d3-a456-426614174000");
      expect(result.email).toBe("test@example.com");
    });

    it("should reject invalid UUID for userId", () => {
      const invalidSession = {
        userId: "not-a-uuid",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      };

      expect(() => sessionSchema.parse(invalidSession)).toThrow();
    });

    it("should reject missing required fields", () => {
      const incompleteSession = {
        userId: "123e4567-e89b-12d3-a456-426614174000",
        // Missing email, expiresAt
      };

      expect(() => sessionSchema.parse(incompleteSession)).toThrow();
    });

    it("should reject non-numeric expiresAt", () => {
      const invalidSession = {
        userId: "123e4567-e89b-12d3-a456-426614174000",
        email: "test@example.com",
        expiresAt: "not-a-number" as any,
      };

      expect(() => sessionSchema.parse(invalidSession)).toThrow();
    });

    it("should reject invalid email format", () => {
      const invalidSession = {
        userId: "123e4567-e89b-12d3-a456-426614174000",
        email: "not-an-email",
        expiresAt: Date.now() + 3600000,
      };

      expect(() => sessionSchema.parse(invalidSession)).toThrow();
    });
  });

  describe("Validator Class", () => {
    const validator = new Validator();

    describe("validateEntityProfile", () => {
      it("should validate valid entity profile", () => {
        const input = {
          name: "Rex",
          entityType: "pet",
          metadata: {
            breed: "German Shepherd",
            bio: "A good boy",
            birthdate: "2020-01-15",
            privacy: "public",
          },
        };

        const result = validator.validateEntityProfile(input);
        expect(result.valid).toBe(true);
        expect(result.data?.name).toBe("Rex");
        expect(result.data?.entityType).toBe("pet");
        expect(result.data?.metadata?.breed).toBe("German Shepherd");
      });

      it("should validate entity profile with minimal required fields", () => {
        const input = {
          name: "Rex",
        };

        const result = validator.validateEntityProfile(input);
        expect(result.valid).toBe(true);
        expect(result.data?.name).toBe("Rex");
        expect(result.data?.entityType).toBeUndefined(); // entityType must be provided by caller
      });

      it("should reject empty name", () => {
        const input = {
          name: "",
        };

        const result = validator.validateEntityProfile(input);
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Name is required and cannot be empty");
      });

      it("should reject name with only whitespace", () => {
        const input = {
          name: "   ",
        };

        const result = validator.validateEntityProfile(input);
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Name is required and cannot be empty");
      });

      it("should reject name longer than 64 characters", () => {
        const input = {
          name: "A".repeat(65),
        };

        const result = validator.validateEntityProfile(input);
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Name must be 64 characters or less");
      });

      // breed, bio, birthdate validation is now handled by extension metadataSchema

      it("should reject invalid privacy value", () => {
        const input = {
          name: "Rex",
          metadata: {
            privacy: "invalid",
          },
        };

        const result = validator.validateEntityProfile(input);
        expect(result.valid).toBe(false);
        expect(result.error).toBe(
          "Privacy must be one of: public, followers, private",
        );
      });

      it("should accept all valid privacy values", () => {
        const privacyValues = ["public", "followers", "private"] as const;

        privacyValues.forEach((privacy) => {
          const input = {
            name: "Rex",
            metadata: { privacy },
          };

          const result = validator.validateEntityProfile(input);
          expect(result.valid).toBe(true);
          expect(result.data?.metadata?.privacy).toBe(privacy);
        });
      });

      // birthdate, breed, bio, breedSize validation is now handled by
      // extension metadataSchema, not the core validator

      it("should reject non-string ID", () => {
        const input = {
          name: "Rex",
          id: 123,
        };

        const result = validator.validateEntityProfile(input);
        expect(result.valid).toBe(false);
        expect(result.error).toBe("ID must be a string");
      });

      it("should accept valid ID", () => {
        const input = {
          name: "Rex",
          id: "entity-123",
        };

        const result = validator.validateEntityProfile(input);
        expect(result.valid).toBe(true);
        expect(result.data?.id).toBe("entity-123");
      });
    });

    // validateDogProfile was removed — dog metadata validation is now
    // handled by the extension's metadataSchema via entity-handler

    describe("validateTaxonIds", () => {
      it("should validate valid taxon IDs", () => {
        const taxonIds = [
          "dimension:category:taxon",
          "food:dog-food:kibble",
          "health:medication:antibiotic",
        ];

        const result = validator.validateTaxonIds(taxonIds);
        expect(result).toEqual(taxonIds);
      });

      it("should reject non-array input", () => {
        expect(() => validator.validateTaxonIds("not-an-array" as any)).toThrow(
          "taxonIds must be an array",
        );
      });

      it("should reject empty array", () => {
        expect(() => validator.validateTaxonIds([])).toThrow(
          "taxonIds cannot be empty",
        );
      });

      it("should reject array with more than 20 items", () => {
        const taxonIds = Array.from({ length: 21 }, (_, i) => {
          const letter = String.fromCharCode(97 + (i % 26)); // a-z
          return `dimension-${letter}:category-${letter}:taxon-${letter}`;
        });

        expect(() => validator.validateTaxonIds(taxonIds)).toThrow(
          "Maximum 20 taxonomy tags allowed",
        );
      });

      it("should reject invalid taxon ID format", () => {
        const taxonIds = ["invalid-format", "dimension:category:taxon"];

        expect(() => validator.validateTaxonIds(taxonIds)).toThrow(
          "Invalid taxon ID format",
        );
      });

      it("should reject non-string taxon IDs", () => {
        const taxonIds = [123, "dimension:category:taxon"];

        expect(() => validator.validateTaxonIds(taxonIds as any)).toThrow(
          "Invalid taxon ID format",
        );
      });

      it("should accept exactly 20 taxon IDs", () => {
        const taxonIds = Array.from({ length: 20 }, (_, i) => {
          const letter = String.fromCharCode(97 + (i % 26)); // a-z
          return `dimension-${letter}:category-${letter}:taxon-${letter}`;
        });

        const result = validator.validateTaxonIds(taxonIds);
        expect(result).toHaveLength(20);
      });
    });

    describe("sanitizeError", () => {
      it("should return sanitized error message for normal errors", () => {
        const error = new Error("User not found");
        const result = validator.sanitizeError(error);
        expect(result).toBe("User not found");
      });

      it("should sanitize PostgreSQL connection strings", () => {
        const error = new Error(
          "Connection failed: postgresql://user:pass@host:5432/db",
        );
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should sanitize Prisma connection strings", () => {
        const error = new Error("Connection failed: prisma://host:5432/db");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should sanitize postgres connection strings", () => {
        const error = new Error(
          "Connection failed: postgres://user:pass@host/db",
        );
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should sanitize API keys", () => {
        const error = new Error("API key invalid: api_key=secret123");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should sanitize secrets", () => {
        const error = new Error("Secret invalid: secret=mysecret");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should sanitize tokens", () => {
        const error = new Error("Token invalid: token=abc123");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should sanitize file paths (macOS)", () => {
        const error = new Error("File not found: /Users/john/secret.txt");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should sanitize file paths (Linux)", () => {
        const error = new Error("File not found: /home/user/secret.txt");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should sanitize file paths (Windows)", () => {
        const error = new Error("File not found: C:\\Users\\john\\secret.txt");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should sanitize stack traces", () => {
        const error = new Error("Error at someFunction (file.js:123)");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should sanitize TypeError in message", () => {
        const error = new Error("TypeError: Something went wrong");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should sanitize ReferenceError in message", () => {
        const error = new Error("ReferenceError: Something went wrong");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should sanitize SyntaxError in message", () => {
        const error = new Error("SyntaxError: Something went wrong");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should handle non-Error objects", () => {
        const result = validator.sanitizeError("string error");
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should handle null", () => {
        const result = validator.sanitizeError(null);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should handle undefined", () => {
        const result = validator.sanitizeError(undefined);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should handle errors with stack property", () => {
        const error = new Error("Error with stack");
        error.stack = "Error: Error with stack\n    at function (file.js:123)";
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should handle hyperdrive references", () => {
        const error = new Error("Connection failed: hyperdrive://host/db");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });

      it("should handle connection strings with @host:port/db format", () => {
        const error = new Error("Connection failed: user@host:5432/database");
        const result = validator.sanitizeError(error);
        expect(result).toBe("An error occurred. Please try again later.");
      });
    });
  });
});
