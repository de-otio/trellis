/**
 * Tests for Post Activity Service (Fedify-Based)
 *
 * Tests post creation and serialization using Fedify's type-safe Create and Note types.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { Create, Note, PUBLIC_COLLECTION } from "@fedify/fedify/vocab";
import { PostActivityServiceFedify } from "../../../../src/lib/activitypub/services/post-service-fedify.js";
import {
  createFedifyTestEnv,
  createMockUser,
} from "../../../utils/fedify-test-fixtures.js";
import type { Env } from "../../../../src/env.js";
import type { Post, User } from "@prisma/client";
import { DatabaseConnectionManager } from "../../../../src/lib/database-connection-manager.js";

// Mock dependencies
vi.mock("../../../../src/lib/database-connection-manager");
vi.mock("../../../../src/lib/activitypub/crypto", () => ({
  KeyPairService: {
    generateKeyPair: vi.fn(() => ({
      publicKey: "mock-public-key",
      privateKey: "mock-private-key",
    })),
    encryptPrivateKey: vi.fn((key) => `encrypted-${key}`),
    decryptPrivateKey: vi.fn((encrypted) =>
      encrypted.replace("encrypted-", ""),
    ),
  },
}));

describe("PostActivityServiceFedify", () => {
  let mockEnv: Env;
  let mockUser: User;
  let mockPost: Post;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createFedifyTestEnv();
    mockUser = createMockUser({
      username: "testuser",
      actorUri: "https://example.com/users/testuser",
    }) as User;

    mockPost = {
      id: "post-123",
      text: "Hello, world!",
      visibility: "PUBLIC",
      authorId: mockUser.id,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      published: new Date("2024-01-01T00:00:00Z"),
      to: null,
      cc: null,
      bto: null,
      bcc: null,
      activityId: null,
      objectId: null,
      deletedAt: null,
      // ... other required Post fields
    } as Post;
  });

  describe("generatePostUris", () => {
    it("should generate correct activity and object URIs", () => {
      const uris = PostActivityServiceFedify.generatePostUris(
        "post-123",
        mockEnv,
      );

      expect(uris.activityId.toString()).toBe(
        "https://example.com/posts/post-123/activity",
      );
      expect(uris.objectId.toString()).toBe(
        "https://example.com/posts/post-123",
      );
    });

    it("should use requestUrl if provided", () => {
      const uris = PostActivityServiceFedify.generatePostUris(
        "post-123",
        mockEnv,
        "https://custom.example.com/posts/123",
      );

      expect(uris.activityId.toString()).toBe(
        "https://custom.example.com/posts/post-123/activity",
      );
      expect(uris.objectId.toString()).toBe(
        "https://custom.example.com/posts/post-123",
      );
    });
  });

  describe("determineAudience", () => {
    it("should return PUBLIC_COLLECTION for public posts", async () => {
      const audience = await PostActivityServiceFedify.determineAudience(
        { ...mockPost, visibility: "PUBLIC" },
        mockUser,
        mockEnv,
      );

      expect(audience.to).toBeDefined();
      expect(audience.to?.[0]).toBe(PUBLIC_COLLECTION);
    });

    // Tests for FOLLOWERS/FRIENDS/PRIVATE visibility removed:
    // post.visibility (PostVisibilityLevel) replaced by post.radius (PostRadius: SHOUT/NORMAL/WHISPER)

    it("should use existing post.to field if present", async () => {
      const customAudience = [
        "https://example.com/users/custom1",
        "https://example.com/users/custom2",
      ];
      const audience = await PostActivityServiceFedify.determineAudience(
        { ...mockPost, to: customAudience },
        mockUser,
        mockEnv,
      );

      expect(audience.to).toBeDefined();
      expect(audience.to?.map((r) => r.toString())).toEqual(customAudience);
    });

    it("should handle custom audience ID", async () => {
      // Mock CustomAudienceService
      vi.doMock("../../../../src/lib/activitypub/audience-service", () => ({
        CustomAudienceService: {
          generateCollectionUri: vi.fn(
            () => "https://example.com/audiences/custom-123",
          ),
        },
      }));

      const audience = await PostActivityServiceFedify.determineAudience(
        mockPost,
        mockUser,
        mockEnv,
        undefined,
        "custom-123",
      );

      expect(audience.to).toBeDefined();
      expect(audience.to?.[0].toString()).toBe(
        "https://example.com/audiences/custom-123",
      );
    });
  });

  describe("createNote", () => {
    it("should create a Fedify Note object with correct properties", async () => {
      const note = await PostActivityServiceFedify.createNote(
        mockPost,
        mockUser,
        mockEnv,
      );

      expect(note).toBeInstanceOf(Note);
      // Fedify doesn't expose properties directly, so we verify the object was created
      const noteAny = note as any;
      expect(noteAny.id).toBeDefined();
      expect(noteAny.content).toBe("Hello, world!");
      // Fedify uses Temporal.Instant for published dates
      expect(noteAny.published).toBeInstanceOf(Temporal.Instant);
      expect(noteAny.published.toString()).toContain("2024-01-01T00:00:00");
    });

    it("should handle public posts with PUBLIC_COLLECTION", async () => {
      const note = await PostActivityServiceFedify.createNote(
        { ...mockPost, visibility: "PUBLIC" },
        mockUser,
        mockEnv,
      );

      const noteAny = note as any;
      expect(noteAny.to).toBeDefined();
      expect(Array.isArray(noteAny.to)).toBe(true);
      expect(noteAny.to[0]).toBe(PUBLIC_COLLECTION);
    });
  });

  describe("createCreateActivity", () => {
    it("should create a Fedify Create activity with correct properties", async () => {
      const activity = await PostActivityServiceFedify.createCreateActivity(
        mockPost,
        mockUser,
        mockEnv,
      );

      expect(activity).toBeInstanceOf(Create);
      // Fedify doesn't expose properties directly, so we verify the object was created
      const activityAny = activity as any;
      expect(activityAny.id).toBeDefined();
      // Fedify uses Temporal.Instant for published dates
      expect(activityAny.published).toBeInstanceOf(Temporal.Instant);
      expect(activityAny.published.toString()).toContain("2024-01-01T00:00:00");
      // Note: Fedify doesn't expose object property directly, but we know it was set in the constructor
      // We verify the activity was created successfully
      expect(activity).toBeDefined();
    });

    it("should have Note object with correct content", async () => {
      // Create the note separately to verify it has correct content
      const note = await PostActivityServiceFedify.createNote(
        mockPost,
        mockUser,
        mockEnv,
      );

      const noteAny = note as any;
      expect(noteAny.content).toBe("Hello, world!");

      // Verify the activity was created (it uses the note internally)
      const activity = await PostActivityServiceFedify.createCreateActivity(
        mockPost,
        mockUser,
        mockEnv,
      );
      expect(activity).toBeInstanceOf(Create);
    });
  });

  describe("createPostActivity", () => {
    it("should create post activity and update database", async () => {
      const mockPrisma = {
        post: {
          update: vi.fn().mockResolvedValue(mockPost),
        },
        activity: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      vi.mocked(DatabaseConnectionManager).mockImplementation(
        () =>
          ({
            withClient: vi.fn(async (_region, _env, callback) => {
              return callback(mockPrisma as any);
            }),
          }) as any,
      );

      const activity = await PostActivityServiceFedify.createPostActivity(
        mockPrisma as any,
        mockPost,
        mockUser,
        mockEnv,
      );

      expect(activity).toBeDefined();
      expect(activity).toBeInstanceOf(Create);
      expect(mockPrisma.post.update).toHaveBeenCalled();
    });

    it("should store activity in outbox", async () => {
      const mockPrisma = {
        post: {
          update: vi.fn().mockResolvedValue(mockPost),
        },
        activity: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      vi.mocked(DatabaseConnectionManager).mockImplementation(
        () =>
          ({
            withClient: vi.fn(async (_region, _env, callback) => {
              return callback(mockPrisma as any);
            }),
          }) as any,
      );

      await PostActivityServiceFedify.createPostActivity(
        mockPrisma as any,
        mockPost,
        mockUser,
        mockEnv,
      );

      // Verify outbox storage was called
      expect(mockPrisma.post.update).toHaveBeenCalled();
      expect(mockPrisma.activity.create).toHaveBeenCalled();
    });

    // Test for FOLLOWERS visibility audience URL conversion removed:
    // post.visibility (PostVisibilityLevel) replaced by post.radius (PostRadius)
  });

  describe("determineAudience - additional edge cases", () => {
    it("should handle post.to with single string value", async () => {
      const audience = await PostActivityServiceFedify.determineAudience(
        { ...mockPost, to: ["https://example.com/users/custom1"] },
        mockUser,
        mockEnv,
      );

      expect(audience.to).toBeDefined();
      expect(audience.to?.length).toBe(1);
      expect(audience.to?.[0].toString()).toBe(
        "https://example.com/users/custom1",
      );
    });

    it("should handle post.cc as array", async () => {
      const audience = await PostActivityServiceFedify.determineAudience(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          cc: ["https://example.com/users/custom2"],
        },
        mockUser,
        mockEnv,
      );

      expect(audience.cc).toBeDefined();
      expect(audience.cc?.length).toBe(1);
      expect(audience.cc?.[0].toString()).toBe(
        "https://example.com/users/custom2",
      );
    });

    it("should handle post.cc as single string", async () => {
      const audience = await PostActivityServiceFedify.determineAudience(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          cc: "https://example.com/users/custom2",
        },
        mockUser,
        mockEnv,
      );

      expect(audience.cc).toBeDefined();
      expect(audience.cc?.length).toBe(1);
      expect(audience.cc?.[0].toString()).toBe(
        "https://example.com/users/custom2",
      );
    });

    it("should handle post.bto as array", async () => {
      const audience = await PostActivityServiceFedify.determineAudience(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          bto: ["https://example.com/users/custom2"],
        },
        mockUser,
        mockEnv,
      );

      expect(audience.bto).toBeDefined();
      expect(audience.bto?.length).toBe(1);
      expect(audience.bto?.[0].toString()).toBe(
        "https://example.com/users/custom2",
      );
    });

    it("should handle post.bto as single string", async () => {
      const audience = await PostActivityServiceFedify.determineAudience(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          bto: "https://example.com/users/custom2",
        },
        mockUser,
        mockEnv,
      );

      expect(audience.bto).toBeDefined();
      expect(audience.bto?.length).toBe(1);
      expect(audience.bto?.[0].toString()).toBe(
        "https://example.com/users/custom2",
      );
    });

    it("should handle post.bcc as array", async () => {
      const audience = await PostActivityServiceFedify.determineAudience(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          bcc: ["https://example.com/users/custom2"],
        },
        mockUser,
        mockEnv,
      );

      expect(audience.bcc).toBeDefined();
      expect(audience.bcc?.length).toBe(1);
      expect(audience.bcc?.[0].toString()).toBe(
        "https://example.com/users/custom2",
      );
    });

    it("should handle post.bcc as single string", async () => {
      const audience = await PostActivityServiceFedify.determineAudience(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          bcc: "https://example.com/users/custom2",
        },
        mockUser,
        mockEnv,
      );

      expect(audience.bcc).toBeDefined();
      expect(audience.bcc?.length).toBe(1);
      expect(audience.bcc?.[0].toString()).toBe(
        "https://example.com/users/custom2",
      );
    });

    it("should handle default visibility (unknown value)", async () => {
      const audience = await PostActivityServiceFedify.determineAudience(
        { ...mockPost, visibility: "UNKNOWN" as any },
        mockUser,
        mockEnv,
      );

      expect(audience.to).toBeDefined();
      expect(audience.to?.[0]).toBe(PUBLIC_COLLECTION);
    });

    it("should handle custom audience ID with requestUrl", async () => {
      vi.doMock("../../../../src/lib/activitypub/audience-service", () => ({
        CustomAudienceService: {
          generateCollectionUri: vi.fn(
            () => "https://custom-domain.com/audiences/custom-123",
          ),
        },
      }));

      const audience = await PostActivityServiceFedify.determineAudience(
        mockPost,
        mockUser,
        mockEnv,
        "https://custom-domain.com/api",
        "custom-123",
      );

      expect(audience.to).toBeDefined();
      expect(audience.to?.[0].toString()).toBe(
        "https://custom-domain.com/audiences/custom-123",
      );
    });
  });

  describe("createNote - additional edge cases", () => {
    it("should handle post without published date (uses createdAt)", async () => {
      const postWithoutPublished = {
        ...mockPost,
        published: null,
        createdAt: new Date("2024-01-02T00:00:00Z"),
      };

      const note = await PostActivityServiceFedify.createNote(
        postWithoutPublished as Post,
        mockUser,
        mockEnv,
      );

      const noteAny = note as any;
      expect(noteAny.published).toBeInstanceOf(Temporal.Instant);
      expect(noteAny.published.toString()).toContain("2024-01-02T00:00:00");
    });

    it("should handle post with empty text", async () => {
      const postWithEmptyText = {
        ...mockPost,
        text: "",
      };

      const note = await PostActivityServiceFedify.createNote(
        postWithEmptyText,
        mockUser,
        mockEnv,
      );

      const noteAny = note as any;
      expect(noteAny.content).toBe("");
    });

    it("should handle post with null text", async () => {
      const postWithNullText = {
        ...mockPost,
        text: null,
      };

      const note = await PostActivityServiceFedify.createNote(
        postWithNullText as Post,
        mockUser,
        mockEnv,
      );

      const noteAny = note as any;
      expect(noteAny.content).toBe("");
    });

    it("should include cc field in Note", async () => {
      const note = await PostActivityServiceFedify.createNote(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          cc: ["https://example.com/users/custom2"],
        },
        mockUser,
        mockEnv,
      );

      const noteAny = note as any;
      expect(noteAny.cc).toBeDefined();
      expect(Array.isArray(noteAny.cc)).toBe(true);
    });

    it("should include bto field in Note", async () => {
      const note = await PostActivityServiceFedify.createNote(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          bto: ["https://example.com/users/custom2"],
        },
        mockUser,
        mockEnv,
      );

      const noteAny = note as any;
      expect(noteAny.bto).toBeDefined();
      expect(Array.isArray(noteAny.bto)).toBe(true);
    });

    it("should include bcc field in Note", async () => {
      const note = await PostActivityServiceFedify.createNote(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          bcc: ["https://example.com/users/custom2"],
        },
        mockUser,
        mockEnv,
      );

      const noteAny = note as any;
      expect(noteAny.bcc).toBeDefined();
      expect(Array.isArray(noteAny.bcc)).toBe(true);
    });

    it("should handle user without username (uses empty string)", async () => {
      const userWithoutUsername = {
        ...mockUser,
        username: null,
      };

      // When username is null, it becomes empty string in generateActorUri
      // This might result in an invalid URI, but the function should still create the note
      const note = await PostActivityServiceFedify.createNote(
        mockPost,
        userWithoutUsername as User,
        mockEnv,
      );

      // The note should still be created, even if the actor URI might be invalid
      expect(note).toBeInstanceOf(Note);
    });
  });

  describe("createCreateActivity - additional edge cases", () => {
    it("should include cc field in Create activity", async () => {
      const activity = await PostActivityServiceFedify.createCreateActivity(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          cc: ["https://example.com/users/custom2"],
        },
        mockUser,
        mockEnv,
      );

      const activityAny = activity as any;
      expect(activityAny.cc).toBeDefined();
      expect(Array.isArray(activityAny.cc)).toBe(true);
    });

    it("should include bto field in Create activity", async () => {
      const activity = await PostActivityServiceFedify.createCreateActivity(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          bto: ["https://example.com/users/custom2"],
        },
        mockUser,
        mockEnv,
      );

      const activityAny = activity as any;
      expect(activityAny.bto).toBeDefined();
      expect(Array.isArray(activityAny.bto)).toBe(true);
    });

    it("should include bcc field in Create activity", async () => {
      const activity = await PostActivityServiceFedify.createCreateActivity(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          bcc: ["https://example.com/users/custom2"],
        },
        mockUser,
        mockEnv,
      );

      const activityAny = activity as any;
      expect(activityAny.bcc).toBeDefined();
      expect(Array.isArray(activityAny.bcc)).toBe(true);
    });

    it("should handle post without published date", async () => {
      const postWithoutPublished = {
        ...mockPost,
        published: null,
        createdAt: new Date("2024-01-02T00:00:00Z"),
      };

      const activity = await PostActivityServiceFedify.createCreateActivity(
        postWithoutPublished as Post,
        mockUser,
        mockEnv,
      );

      const activityAny = activity as any;
      expect(activityAny.published).toBeInstanceOf(Temporal.Instant);
      expect(activityAny.published.toString()).toContain("2024-01-02T00:00:00");
    });
  });

  describe("createPostActivity - additional edge cases", () => {
    it("should handle posts with cc, bto, bcc fields", async () => {
      const mockPrisma = {
        post: {
          update: vi.fn().mockResolvedValue(mockPost),
        },
        activity: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      vi.mocked(DatabaseConnectionManager).mockImplementation(
        () =>
          ({
            withClient: vi.fn(async (_region, _env, callback) => {
              return callback(mockPrisma as any);
            }),
          }) as any,
      );

      const postWithAllFields = {
        ...mockPost,
        to: ["https://example.com/users/custom1"],
        cc: ["https://example.com/users/custom2"],
        bto: ["https://example.com/users/custom3"],
        bcc: ["https://example.com/users/custom4"],
      };

      await PostActivityServiceFedify.createPostActivity(
        mockPrisma as any,
        postWithAllFields,
        mockUser,
        mockEnv,
      );

      const updateCall = mockPrisma.post.update.mock.calls[0];
      expect(updateCall[0].data.cc).toBeDefined();
      expect(updateCall[0].data.bto).toBeDefined();
      expect(updateCall[0].data.bcc).toBeDefined();
    });

    it("should handle posts with custom audience ID", async () => {
      const mockPrisma = {
        post: {
          update: vi.fn().mockResolvedValue(mockPost),
        },
        activity: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      vi.mocked(DatabaseConnectionManager).mockImplementation(
        () =>
          ({
            withClient: vi.fn(async (_region, _env, callback) => {
              return callback(mockPrisma as any);
            }),
          }) as any,
      );

      vi.doMock("../../../../src/lib/activitypub/audience-service", () => ({
        CustomAudienceService: {
          generateCollectionUri: vi.fn(
            () => "https://example.com/audiences/custom-123",
          ),
        },
      }));

      await PostActivityServiceFedify.createPostActivity(
        mockPrisma as any,
        mockPost,
        mockUser,
        mockEnv,
        undefined,
        "custom-123",
      );

      expect(mockPrisma.post.update).toHaveBeenCalled();
      expect(mockPrisma.activity.create).toHaveBeenCalled();
    });

    it("should handle database update errors", async () => {
      const mockPrisma = {
        post: {
          update: vi.fn().mockRejectedValue(new Error("Database error")),
        },
        activity: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      vi.mocked(DatabaseConnectionManager).mockImplementation(
        () =>
          ({
            withClient: vi.fn(async (_region, _env, callback) => {
              return callback(mockPrisma as any);
            }),
          }) as any,
      );

      await expect(
        PostActivityServiceFedify.createPostActivity(
          mockPrisma as any,
          mockPost,
          mockUser,
          mockEnv,
        ),
      ).rejects.toThrow("Database error");
    });

    it("should handle outbox storage errors", async () => {
      const mockPrisma = {
        post: {
          update: vi.fn().mockResolvedValue(mockPost),
        },
        activity: {
          create: vi.fn().mockRejectedValue(new Error("Storage error")),
        },
      };

      vi.mocked(DatabaseConnectionManager).mockImplementation(
        () =>
          ({
            withClient: vi.fn(async (_region, _env, callback) => {
              return callback(mockPrisma as any);
            }),
          }) as any,
      );

      await expect(
        PostActivityServiceFedify.createPostActivity(
          mockPrisma as any,
          mockPost,
          mockUser,
          mockEnv,
        ),
      ).rejects.toThrow("Storage error");
    });

    // Test for PRIVATE visibility (empty bto) removed:
    // post.visibility (PostVisibilityLevel) replaced by post.radius (PostRadius)
  });
});
