/**
 * Unit Tests: Validation Schemas
 *
 * Tests for Zod validation schemas to ensure they work correctly.
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

describe("paginationSchema", () => {
  it("should validate valid pagination", () => {
    const valid = { limit: 20, cursor: "abc123" };
    const result = paginationSchema.parse(valid);
    expect(result.limit).toBe(20);
    expect(result.cursor).toBe("abc123");
  });

  it("should use default limit", () => {
    const valid = {};
    const result = paginationSchema.parse(valid);
    expect(result.limit).toBe(20);
  });

  it("should coerce string to number", () => {
    const valid = { limit: "50" };
    const result = paginationSchema.parse(valid);
    expect(typeof result.limit).toBe("number");
    expect(result.limit).toBe(50);
  });

  it("should reject limit < 1", () => {
    const invalid = { limit: 0 };
    expect(() => paginationSchema.parse(invalid)).toThrow();
  });

  it("should reject limit > 100", () => {
    const invalid = { limit: 101 };
    expect(() => paginationSchema.parse(invalid)).toThrow();
  });
});

describe("createPostSchema", () => {
  it("should validate minimal post", () => {
    const valid = { text: "Hello", visibility: "public" as const };
    const result = createPostSchema.parse(valid);
    expect(result.text).toBe("Hello");
    expect(result.visibility).toBe("public");
  });

  it("should trim text", () => {
    const valid = { text: "  Hello  ", visibility: "public" as const };
    const result = createPostSchema.parse(valid);
    expect(result.text).toBe("Hello");
  });

  it("should validate geoData", () => {
    const valid = {
      text: "Hello",
      visibility: "public" as const,
      geoData: { lat: 37.7749, lng: -122.4194 },
    };
    const result = createPostSchema.parse(valid);
    expect(result.geoData?.lat).toBe(37.7749);
  });

  it("should reject invalid latitude", () => {
    const invalid = {
      text: "Hello",
      visibility: "public" as const,
      geoData: { lat: 91, lng: -122.4194 },
    };
    expect(() => createPostSchema.parse(invalid)).toThrow();
  });

  it("should reject invalid longitude", () => {
    const invalid = {
      text: "Hello",
      visibility: "public" as const,
      geoData: { lat: 37.7749, lng: 181 },
    };
    expect(() => createPostSchema.parse(invalid)).toThrow();
  });

  it("should validate contentWarnings", () => {
    const valid = {
      text: "Hello",
      visibility: "public" as const,
      contentWarnings: ["spoiler", "nsfw"],
    };
    const result = createPostSchema.parse(valid);
    expect(result.contentWarnings).toEqual(["spoiler", "nsfw"]);
  });

  it("should reject too many contentWarnings", () => {
    const invalid = {
      text: "Hello",
      visibility: "public" as const,
      contentWarnings: Array(11).fill("warning"),
    };
    expect(() => createPostSchema.parse(invalid)).toThrow();
  });

  it("should validate entityRefs", () => {
    const valid = {
      text: "Hello",
      visibility: "public" as const,
      entityRefs: ["entity1", "entity2"],
    };
    const result = createPostSchema.parse(valid);
    expect(result.entityRefs).toEqual(["entity1", "entity2"]);
  });

  it("should default entityRefs to empty array", () => {
    const valid = {
      text: "Hello",
      visibility: "public" as const,
    };
    const result = createPostSchema.parse(valid);
    expect(result.entityRefs).toEqual([]);
  });

  it("should validate entityRefs with valid CUID format", () => {
    const valid = {
      text: "Hello",
      visibility: "public" as const,
      entityRefs: ["clx123abc456def789"],
    };
    const result = createPostSchema.parse(valid);
    expect(result.entityRefs).toEqual(["clx123abc456def789"]);
  });

  it("should reject entityRefs with invalid format", () => {
    const invalid = {
      text: "Hello",
      visibility: "public" as const,
      entityRefs: ["invalid-entity-id!"],
    };
    expect(() => createPostSchema.parse(invalid)).toThrow();
  });

  it("should reject too many entityRefs", () => {
    const invalid = {
      text: "Hello",
      visibility: "public" as const,
      entityRefs: Array(21).fill("entity"),
    };
    expect(() => createPostSchema.parse(invalid)).toThrow();
  });

  it("should trim entityRefs", () => {
    const valid = {
      text: "Hello",
      visibility: "public" as const,
      entityRefs: ["  clx123abc456def789  ", "clx987xyz654ghi321"],
    };
    const result = createPostSchema.parse(valid);
    expect(result.entityRefs).toEqual([
      "clx123abc456def789",
      "clx987xyz654ghi321",
    ]);
  });

  it("should reject empty entityRefs strings", () => {
    const invalid = {
      text: "Hello",
      visibility: "public" as const,
      entityRefs: ["", "entity1"],
    };
    expect(() => createPostSchema.parse(invalid)).toThrow();
  });
});

describe("createCommentSchema", () => {
  it("should validate comment", () => {
    const valid = { text: "Great post!" };
    const result = createCommentSchema.parse(valid);
    expect(result.text).toBe("Great post!");
  });

  it("should trim text", () => {
    const valid = { text: "  Comment  " };
    const result = createCommentSchema.parse(valid);
    expect(result.text).toBe("Comment");
  });

  it("should reject empty text", () => {
    const invalid = { text: "" };
    expect(() => createCommentSchema.parse(invalid)).toThrow();
  });
});

describe("sentimentSchema", () => {
  it("should validate joy sentiment", () => {
    const valid = { sentiment: "joy" as const };
    const result = sentimentSchema.parse(valid);
    expect(result.sentiment).toBe("joy");
  });

  it("should validate sad sentiment", () => {
    const valid = { sentiment: "sadness" as const };
    const result = sentimentSchema.parse(valid);
    expect(result.sentiment).toBe("sadness");
  });

  it("should validate love sentiment", () => {
    const valid = { sentiment: "love" as const };
    const result = sentimentSchema.parse(valid);
    expect(result.sentiment).toBe("love");
  });

  it("should reject invalid sentiment", () => {
    const invalid = { sentiment: "happy" as any };
    expect(() => sentimentSchema.parse(invalid)).toThrow();
  });
});

describe("badgeSchema", () => {
  it("should validate true", () => {
    const valid = { showVerifiedBadge: true };
    const result = badgeSchema.parse(valid);
    expect(result.showVerifiedBadge).toBe(true);
  });

  it("should validate false", () => {
    const valid = { showVerifiedBadge: false };
    const result = badgeSchema.parse(valid);
    expect(result.showVerifiedBadge).toBe(false);
  });

  it('should reject string "true"', () => {
    const invalid = { showVerifiedBadge: "true" as any };
    expect(() => badgeSchema.parse(invalid)).toThrow();
  });

  it("should reject number 1", () => {
    const invalid = { showVerifiedBadge: 1 as any };
    expect(() => badgeSchema.parse(invalid)).toThrow();
  });
});

describe("createInvitationSchema", () => {
  it("should validate with email", () => {
    const valid = { email: "user@example.com", expiresInDays: 30 };
    const result = createInvitationSchema.parse(valid);
    expect(result.email).toBe("user@example.com");
    expect(result.expiresInDays).toBe(30);
  });

  it("should validate without email", () => {
    const valid = { expiresInDays: 7 };
    const result = createInvitationSchema.parse(valid);
    expect(result.email).toBeUndefined();
    expect(result.expiresInDays).toBe(7);
  });

  it("should use default expiresInDays", () => {
    const valid = {};
    const result = createInvitationSchema.parse(valid);
    expect(result.expiresInDays).toBe(30);
  });

  it("should lowercase email", () => {
    const valid = { email: "USER@EXAMPLE.COM", expiresInDays: 30 };
    const result = createInvitationSchema.parse(valid);
    expect(result.email).toBe("user@example.com");
  });

  it("should coerce string to number", () => {
    const valid = { expiresInDays: "30" as any };
    const result = createInvitationSchema.parse(valid);
    expect(typeof result.expiresInDays).toBe("number");
    expect(result.expiresInDays).toBe(30);
  });

  it("should reject invalid email", () => {
    const invalid = { email: "not-an-email" };
    expect(() => createInvitationSchema.parse(invalid)).toThrow();
  });

  it("should reject expiresInDays > 365", () => {
    const invalid = { expiresInDays: 366 };
    expect(() => createInvitationSchema.parse(invalid)).toThrow();
  });

  it("should reject expiresInDays < 1", () => {
    const invalid = { expiresInDays: 0 };
    expect(() => createInvitationSchema.parse(invalid)).toThrow();
  });
});

describe("validateInvitationSchema", () => {
  it("should validate code", () => {
    const valid = { code: "ABC123" };
    const result = validateInvitationSchema.parse(valid);
    expect(result.code).toBe("ABC123");
  });

  it("should uppercase and trim code", () => {
    const valid = { code: "  abc123  " };
    const result = validateInvitationSchema.parse(valid);
    expect(result.code).toBe("ABC123");
  });

  it("should validate with email", () => {
    const valid = { code: "ABC123", email: "user@example.com" };
    const result = validateInvitationSchema.parse(valid);
    expect(result.code).toBe("ABC123");
    expect(result.email).toBe("user@example.com");
  });

  it("should lowercase email", () => {
    const valid = { code: "ABC123", email: "USER@EXAMPLE.COM" };
    const result = validateInvitationSchema.parse(valid);
    expect(result.email).toBe("user@example.com");
  });

  it("should reject empty code", () => {
    const invalid = { code: "" };
    expect(() => validateInvitationSchema.parse(invalid)).toThrow();
  });

  it("should reject code > 100 chars", () => {
    const invalid = { code: "A".repeat(101) };
    expect(() => validateInvitationSchema.parse(invalid)).toThrow();
  });
});

describe("deleteAccountConfirmationSchema", () => {
  it("should validate confirmation code", () => {
    const valid = { confirmationCode: "ABC123XYZ" };
    const result = deleteAccountConfirmationSchema.parse(valid);
    expect(result.confirmationCode).toBe("ABC123XYZ");
  });

  it("should trim code", () => {
    const valid = { confirmationCode: "  ABC123  " };
    const result = deleteAccountConfirmationSchema.parse(valid);
    expect(result.confirmationCode).toBe("ABC123");
  });

  it("should reject empty code", () => {
    const invalid = { confirmationCode: "" };
    expect(() => deleteAccountConfirmationSchema.parse(invalid)).toThrow();
  });
});

describe("feedQuerySchema", () => {
  it("should validate with entityRefs", () => {
    const valid = { limit: 20, entityRefs: ["entity1", "entity2"] };
    const result = feedQuerySchema.parse(valid);
    expect(result.limit).toBe(20);
    expect(result.entityRefs).toEqual(["entity1", "entity2"]);
  });

  it("should validate without entity filters", () => {
    const valid = { limit: 50 };
    const result = feedQuerySchema.parse(valid);
    expect(result.limit).toBe(50);
    expect(result.entityRefs).toBeUndefined();
  });

  it("should reject too many entityRefs", () => {
    const invalid = { limit: 20, entityRefs: Array(21).fill("entity") };
    expect(() => feedQuerySchema.parse(invalid)).toThrow();
  });

  it("should inherit pagination validation", () => {
    const invalid = { limit: 101 };
    expect(() => feedQuerySchema.parse(invalid)).toThrow();
  });
});
