/**
 * Unit Tests: Request Validation Helpers
 *
 * Tests for validateRequest and validateQueryParams functions.
 */

import { describe, expect, it } from "vitest";
import {
  badgeSchema,
  createCommentSchema,
  createInvitationSchema,
  createPostSchema,
  deleteAccountConfirmationSchema,
  feedQuerySchema,
  paginationSchema,
  sentimentSchema,
  validateInvitationSchema,
} from "../../src/lib/schemas.js";
import {
  safeJsonParse,
  validateQueryParams,
  validateRequest,
} from "../../src/lib/validate-request.js";

describe("validateRequest", () => {
  describe("createPostSchema", () => {
    it("should validate valid post", async () => {
      const validPost = {
        text: "Hello, world!",
        visibility: "public" as const,
      };

      const request = new Request("https://example.com/posts", {
        method: "POST",
        body: JSON.stringify(validPost),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createPostSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.text).toBe("Hello, world!");
        expect(result.data.visibility).toBe("public");
      }
    });

    it("should validate post with all optional fields", async () => {
      const validPost = {
        text: "Check out this location!",
        visibility: "friends-only" as const,
        entityRefs: ["entity1", "entity2"],
        geoData: {
          lat: 37.7749,
          lng: -122.4194,
          place: "San Francisco",
        },
        contentWarnings: ["spoiler"],
      };

      const request = new Request("https://example.com/posts", {
        method: "POST",
        body: JSON.stringify(validPost),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createPostSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.geoData?.lat).toBe(37.7749);
        expect(result.data.contentWarnings).toEqual(["spoiler"]);
        expect(result.data.entityRefs).toEqual(["entity1", "entity2"]);
      }
    });

    it("should reject empty text", async () => {
      const invalidPost = {
        text: "",
        visibility: "public" as const,
      };

      const request = new Request("https://example.com/posts", {
        method: "POST",
        body: JSON.stringify(invalidPost),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createPostSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.status).toBe(400);
        const body = await result.error.json();
        expect(body.error).toBe("Validation failed");
      }
    });

    it("should reject text exceeding max length", async () => {
      const invalidPost = {
        text: "a".repeat(3001),
        visibility: "public" as const,
      };

      const request = new Request("https://example.com/posts", {
        method: "POST",
        body: JSON.stringify(invalidPost),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createPostSchema);
      expect(result.success).toBe(false);
    });

    it("should reject invalid visibility", async () => {
      const invalidPost = {
        text: "Hello",
        visibility: "invalid" as any,
      };

      const request = new Request("https://example.com/posts", {
        method: "POST",
        body: JSON.stringify(invalidPost),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createPostSchema);
      expect(result.success).toBe(false);
    });

    it("should reject invalid geoData coordinates", async () => {
      const invalidPost = {
        text: "Hello",
        visibility: "public" as const,
        geoData: {
          lat: 91, // Invalid: > 90
          lng: -122.4194,
        },
      };

      const request = new Request("https://example.com/posts", {
        method: "POST",
        body: JSON.stringify(invalidPost),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createPostSchema);
      expect(result.success).toBe(false);
    });

    it("should trim text automatically", async () => {
      const post = {
        text: "  Hello, world!  ",
        visibility: "public" as const,
      };

      const request = new Request("https://example.com/posts", {
        method: "POST",
        body: JSON.stringify(post),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createPostSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.text).toBe("Hello, world!");
      }
    });

    it("should reject too many content warnings", async () => {
      const invalidPost = {
        text: "Hello",
        visibility: "public" as const,
        contentWarnings: Array(11).fill("warning"), // 11 warnings, max is 10
      };

      const request = new Request("https://example.com/posts", {
        method: "POST",
        body: JSON.stringify(invalidPost),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createPostSchema);
      expect(result.success).toBe(false);
    });
  });

  describe("createCommentSchema", () => {
    it("should validate valid comment", async () => {
      const validComment = {
        text: "Great post!",
      };

      const request = new Request("https://example.com/comments", {
        method: "POST",
        body: JSON.stringify(validComment),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createCommentSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.text).toBe("Great post!");
      }
    });

    it("should reject empty comment", async () => {
      const invalidComment = {
        text: "",
      };

      const request = new Request("https://example.com/comments", {
        method: "POST",
        body: JSON.stringify(invalidComment),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createCommentSchema);
      expect(result.success).toBe(false);
    });
  });

  describe("sentimentSchema", () => {
    it("should validate valid sentiment", async () => {
      const validSentiment = {
        sentiment: "joy" as const,
      };

      const request = new Request("https://example.com/sentiment", {
        method: "POST",
        body: JSON.stringify(validSentiment),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, sentimentSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sentiment).toBe("joy");
      }
    });

    it("should reject invalid sentiment", async () => {
      const invalidSentiment = {
        sentiment: "happy" as any, // Not in enum
      };

      const request = new Request("https://example.com/sentiment", {
        method: "POST",
        body: JSON.stringify(invalidSentiment),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, sentimentSchema);
      expect(result.success).toBe(false);
    });
  });

  describe("badgeSchema", () => {
    it("should validate boolean true", async () => {
      const validBadge = {
        showVerifiedBadge: true,
      };

      const request = new Request("https://example.com/badge", {
        method: "PATCH",
        body: JSON.stringify(validBadge),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, badgeSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.showVerifiedBadge).toBe(true);
      }
    });

    it("should validate boolean false", async () => {
      const validBadge = {
        showVerifiedBadge: false,
      };

      const request = new Request("https://example.com/badge", {
        method: "PATCH",
        body: JSON.stringify(validBadge),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, badgeSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.showVerifiedBadge).toBe(false);
      }
    });

    it('should reject string "true"', async () => {
      const invalidBadge = {
        showVerifiedBadge: "true" as any,
      };

      const request = new Request("https://example.com/badge", {
        method: "PATCH",
        body: JSON.stringify(invalidBadge),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, badgeSchema);
      expect(result.success).toBe(false);
    });

    it("should reject number 1", async () => {
      const invalidBadge = {
        showVerifiedBadge: 1 as any,
      };

      const request = new Request("https://example.com/badge", {
        method: "PATCH",
        body: JSON.stringify(invalidBadge),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, badgeSchema);
      expect(result.success).toBe(false);
    });
  });

  describe("createInvitationSchema", () => {
    it("should validate invitation with email", async () => {
      const validInvitation = {
        email: "user@example.com",
        expiresInDays: 30,
      };

      const request = new Request("https://example.com/invitations", {
        method: "POST",
        body: JSON.stringify(validInvitation),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createInvitationSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe("user@example.com");
        expect(result.data.expiresInDays).toBe(30);
      }
    });

    it("should validate invitation without email", async () => {
      const validInvitation = {
        expiresInDays: 7,
      };

      const request = new Request("https://example.com/invitations", {
        method: "POST",
        body: JSON.stringify(validInvitation),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createInvitationSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBeUndefined();
        expect(result.data.expiresInDays).toBe(7);
      }
    });

    it("should use default expiresInDays", async () => {
      const validInvitation = {};

      const request = new Request("https://example.com/invitations", {
        method: "POST",
        body: JSON.stringify(validInvitation),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createInvitationSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.expiresInDays).toBe(30); // Default
      }
    });

    it("should reject invalid email", async () => {
      const invalidInvitation = {
        email: "not-an-email",
        expiresInDays: 30,
      };

      const request = new Request("https://example.com/invitations", {
        method: "POST",
        body: JSON.stringify(invalidInvitation),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createInvitationSchema);
      expect(result.success).toBe(false);
    });

    it("should reject expiresInDays > 365", async () => {
      const invalidInvitation = {
        expiresInDays: 366,
      };

      const request = new Request("https://example.com/invitations", {
        method: "POST",
        body: JSON.stringify(invalidInvitation),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createInvitationSchema);
      expect(result.success).toBe(false);
    });

    it("should reject expiresInDays < 1", async () => {
      const invalidInvitation = {
        expiresInDays: 0,
      };

      const request = new Request("https://example.com/invitations", {
        method: "POST",
        body: JSON.stringify(invalidInvitation),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createInvitationSchema);
      expect(result.success).toBe(false);
    });

    it("should coerce string to number for expiresInDays", async () => {
      const validInvitation = {
        expiresInDays: "30" as any, // String should be coerced to number
      };

      const request = new Request("https://example.com/invitations", {
        method: "POST",
        body: JSON.stringify(validInvitation),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createInvitationSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.expiresInDays).toBe("number");
        expect(result.data.expiresInDays).toBe(30);
      }
    });
  });

  describe("validateInvitationSchema", () => {
    it("should validate invitation code", async () => {
      const validCode = {
        code: "ABC123",
        email: "user@example.com",
      };

      const request = new Request("https://example.com/invitations/validate", {
        method: "POST",
        body: JSON.stringify(validCode),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, validateInvitationSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toBe("ABC123"); // Should be uppercase
        expect(result.data.email).toBe("user@example.com");
      }
    });

    it("should uppercase and trim code", async () => {
      const validCode = {
        code: "  abc123  ",
      };

      const request = new Request("https://example.com/invitations/validate", {
        method: "POST",
        body: JSON.stringify(validCode),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, validateInvitationSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toBe("ABC123");
      }
    });
  });

  describe("deleteAccountConfirmationSchema", () => {
    it("should validate confirmation code", async () => {
      const validCode = {
        confirmationCode: "ABC123XYZ",
      };

      const request = new Request(
        "https://example.com/delete-account/confirm",
        {
          method: "POST",
          body: JSON.stringify(validCode),
          headers: { "Content-Type": "application/json" },
        },
      );

      const result = await validateRequest(
        request,
        deleteAccountConfirmationSchema,
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.confirmationCode).toBe("ABC123XYZ");
      }
    });

    it("should reject empty code", async () => {
      const invalidCode = {
        confirmationCode: "",
      };

      const request = new Request(
        "https://example.com/delete-account/confirm",
        {
          method: "POST",
          body: JSON.stringify(invalidCode),
          headers: { "Content-Type": "application/json" },
        },
      );

      const result = await validateRequest(
        request,
        deleteAccountConfirmationSchema,
      );
      expect(result.success).toBe(false);
    });
  });

  describe("Error handling", () => {
    it("should handle invalid JSON", async () => {
      const request = new Request("https://example.com/posts", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createPostSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.status).toBe(400);
        const body = await result.error.json();
        expect(body.error).toBe("Invalid JSON");
      }
    });

    it("should return detailed validation errors", async () => {
      const invalidPost = {
        text: "",
        visibility: "invalid",
      };

      const request = new Request("https://example.com/posts", {
        method: "POST",
        body: JSON.stringify(invalidPost),
        headers: { "Content-Type": "application/json" },
      });

      const result = await validateRequest(request, createPostSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.status).toBe(400);
        const body = await result.error.json();
        expect(body.error).toBe("Validation failed");
        expect(body.details).toBeInstanceOf(Array);
        expect(body.details.length).toBeGreaterThan(0);
      }
    });
  });
});

describe("validateQueryParams", () => {
  describe("paginationSchema", () => {
    it("should validate valid pagination params", () => {
      const url = new URL("https://example.com/feeds?limit=20&cursor=abc123");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
        expect(result.data.cursor).toBe("abc123");
      }
    });

    it("should use default limit when not provided", () => {
      const url = new URL("https://example.com/feeds");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20); // Default
      }
    });

    it("should coerce string to number", () => {
      const url = new URL("https://example.com/feeds?limit=50");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.limit).toBe("number");
        expect(result.data.limit).toBe(50);
      }
    });

    it("should reject limit < 1", () => {
      const url = new URL("https://example.com/feeds?limit=0");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(false);
    });

    it("should reject limit > 100", () => {
      const url = new URL("https://example.com/feeds?limit=101");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(false);
    });

    it("should reject negative limit", () => {
      const url = new URL("https://example.com/feeds?limit=-1");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(false);
    });

    it("should reject non-numeric limit", () => {
      const url = new URL("https://example.com/feeds?limit=abc");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(false);
    });

    it("should validate offset", () => {
      const url = new URL("https://example.com/feeds?limit=20&offset=10");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.offset).toBe(10);
      }
    });

    it("should reject negative offset", () => {
      const url = new URL("https://example.com/feeds?offset=-1");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(false);
    });

    it("should reject offset > 10000", () => {
      const url = new URL("https://example.com/feeds?offset=10001");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(false);
    });
  });

  describe("feedQuerySchema", () => {
    it("should validate feed query without dogRef", () => {
      const url = new URL("https://example.com/feeds?limit=50");
      const result = validateQueryParams(url, feedQuerySchema);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
        expect(result.data.dogRef).toBeUndefined();
      }
    });
  });

  describe("Error handling", () => {
    it("should return detailed validation errors", () => {
      const url = new URL("https://example.com/feeds?limit=999");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.status).toBe(400);
      }
    });

    it("should handle empty query params", () => {
      const url = new URL("https://example.com/feeds");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20); // Default
      }
    });
  });

  describe("DoS protection", () => {
    it("should prevent excessive limit values", () => {
      const url = new URL("https://example.com/feeds?limit=999999999");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(false);
    });

    it("should prevent excessive offset values", () => {
      const url = new URL("https://example.com/feeds?offset=999999999");
      const result = validateQueryParams(url, paginationSchema);

      expect(result.success).toBe(false);
    });
  });
});

describe("safeJsonParse", () => {
  it("should parse valid JSON", async () => {
    const request = new Request("https://example.com/test", {
      method: "POST",
      body: JSON.stringify({ test: "value" }),
      headers: { "Content-Type": "application/json" },
    });

    const result = await safeJsonParse(request);
    expect(result).toEqual({ test: "value" });
  });

  it("should return null for invalid JSON", async () => {
    const request = new Request("https://example.com/test", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });

    const result = await safeJsonParse(request);
    expect(result).toBeNull();
  });

  it("should return null for empty body", async () => {
    const request = new Request("https://example.com/test", {
      method: "POST",
      body: "",
      headers: { "Content-Type": "application/json" },
    });

    const result = await safeJsonParse(request);
    expect(result).toBeNull();
  });

  it("should parse complex JSON objects", async () => {
    const complex = {
      nested: {
        array: [1, 2, 3],
        object: { key: "value" },
      },
      number: 42,
      boolean: true,
      nullValue: null,
    };

    const request = new Request("https://example.com/test", {
      method: "POST",
      body: JSON.stringify(complex),
      headers: { "Content-Type": "application/json" },
    });

    const result = await safeJsonParse(request);
    expect(result).toEqual(complex);
  });

  it("should handle JSON parsing errors gracefully", async () => {
    const request = new Request("https://example.com/test", {
      method: "POST",
      body: '{"incomplete":',
      headers: { "Content-Type": "application/json" },
    });

    const result = await safeJsonParse(request);
    expect(result).toBeNull();
  });
});
