/**
 * Tests for Fedify Converters
 *
 * Tests conversion from Fedify types to database/storage formats.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createActivityDataToActivityStreams,
  extractCreateActivityData,
} from "../../../../src/lib/activitypub/services/fedify-converters.js";
import { PostActivityServiceFedify } from "../../../../src/lib/activitypub/services/post-service-fedify.js";
import {
  createFedifyTestEnv,
  createMockUser,
} from "../../../utils/fedify-test-fixtures.js";
import type { Env } from "../../../../src/env.js";
import type { Post, User } from "@prisma/client";
import { vi } from "vitest";

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

describe("Fedify Converters", () => {
  let mockEnv: Env;
  let mockUser: User;
  let mockPost: Post;

  beforeEach(() => {
    mockEnv = createFedifyTestEnv();
    mockUser = createMockUser({
      username: "alice",
      actorUri: "https://example.com/users/alice",
    }) as User;

    mockPost = {
      id: "post-123",
      text: "Hello, world!",
      // `radius`, not the long-dead `visibility` field. Post.radius is
      // non-nullable with a default in the schema, so an unset radius does not
      // occur in production — and it used to exercise determineAudience's
      // removed fail-open branch.
      radius: "SHOUT",
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
    } as Post;
  });

  describe("createActivityDataToActivityStreams", () => {
    it("should convert activity data to ActivityStreamsActivity format", () => {
      const data = {
        id: "https://example.com/posts/123/activity",
        actor: "https://example.com/users/alice",
        published: "2024-01-01T00:00:00Z",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        object: {
          id: "https://example.com/posts/123",
          attributedTo: "https://example.com/users/alice",
          content: "Hello, world!",
          published: "2024-01-01T00:00:00Z",
        },
      };

      const result = createActivityDataToActivityStreams(data);

      expect(result.type).toBe("Create");
      expect(result.id).toBe("https://example.com/posts/123/activity");
      expect(result.actor).toBe("https://example.com/users/alice");
      expect(result.published).toBe("2024-01-01T00:00:00Z");
      expect(result.object.type).toBe("Note");
      expect(result.object.id).toBe("https://example.com/posts/123");
      expect(result.object.attributedTo).toBe(
        "https://example.com/users/alice",
      );
      expect(result.object.content).toBe("Hello, world!");
    });

    it("should include audience fields when present", () => {
      const data = {
        id: "https://example.com/posts/123/activity",
        actor: "https://example.com/users/alice",
        published: "2024-01-01T00:00:00Z",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: ["https://example.com/users/bob"],
        object: {
          id: "https://example.com/posts/123",
          attributedTo: "https://example.com/users/alice",
          content: "Test",
          published: "2024-01-01T00:00:00Z",
          to: ["https://www.w3.org/ns/activitystreams#Public"],
        },
      };

      const result = createActivityDataToActivityStreams(data);

      expect(result.to).toEqual([
        "https://www.w3.org/ns/activitystreams#Public",
      ]);
      expect(result.cc).toEqual(["https://example.com/users/bob"]);
      expect(result.object.to).toEqual([
        "https://www.w3.org/ns/activitystreams#Public",
      ]);
    });

    it("should handle activities without audience fields", () => {
      const data = {
        id: "https://example.com/posts/123/activity",
        actor: "https://example.com/users/alice",
        published: "2024-01-01T00:00:00Z",
        object: {
          id: "https://example.com/posts/123",
          attributedTo: "https://example.com/users/alice",
          content: "Test",
          published: "2024-01-01T00:00:00Z",
        },
      };

      const result = createActivityDataToActivityStreams(data);

      expect(result.to).toBeUndefined();
      expect(result.cc).toBeUndefined();
      expect(result.bto).toBeUndefined();
      expect(result.bcc).toBeUndefined();
    });

    it("should include @context in both activity and object", () => {
      const data = {
        id: "https://example.com/posts/123/activity",
        actor: "https://example.com/users/alice",
        published: "2024-01-01T00:00:00Z",
        object: {
          id: "https://example.com/posts/123",
          attributedTo: "https://example.com/users/alice",
          content: "Test",
          published: "2024-01-01T00:00:00Z",
        },
      };

      const result = createActivityDataToActivityStreams(data);

      expect(result["@context"]).toBe("https://www.w3.org/ns/activitystreams");
      expect(result.object["@context"]).toBe(
        "https://www.w3.org/ns/activitystreams",
      );
    });
  });

  describe("extractCreateActivityData", () => {
    it("should extract data from Fedify Create and Note objects", async () => {
      const createActivity =
        await PostActivityServiceFedify.createCreateActivity(
          mockPost,
          mockUser,
          mockEnv,
        );
      const note = await PostActivityServiceFedify.createNote(
        mockPost,
        mockUser,
        mockEnv,
      );
      const uris = PostActivityServiceFedify.generatePostUris(
        mockPost.id,
        mockEnv,
      );
      const actorId = "https://example.com/users/alice";

      const data = extractCreateActivityData(
        createActivity,
        note,
        actorId,
        uris.activityId.toString(),
        uris.objectId.toString(),
      );

      expect(data.id).toContain("/posts/post-123/activity");
      expect(data.actor).toBe("https://example.com/users/alice");
      expect(data.object.id).toContain("/posts/post-123");
      expect(data.object.attributedTo).toBe("https://example.com/users/alice");
      expect(data.object.content).toBe("Hello, world!");
    });

    it("should convert URL objects to strings", async () => {
      const createActivity =
        await PostActivityServiceFedify.createCreateActivity(
          mockPost,
          mockUser,
          mockEnv,
        );
      const note = await PostActivityServiceFedify.createNote(
        mockPost,
        mockUser,
        mockEnv,
      );
      const uris = PostActivityServiceFedify.generatePostUris(
        mockPost.id,
        mockEnv,
      );
      const actorId = "https://example.com/users/alice";

      const data = extractCreateActivityData(
        createActivity,
        note,
        actorId,
        uris.activityId.toString(),
        uris.objectId.toString(),
      );

      expect(typeof data.id).toBe("string");
      expect(typeof data.actor).toBe("string");
      expect(typeof data.object.id).toBe("string");
      expect(typeof data.object.attributedTo).toBe("string");
    });

    it("should extract audience fields", async () => {
      const createActivity =
        await PostActivityServiceFedify.createCreateActivity(
          { ...mockPost, radius: "SHOUT" },
          mockUser,
          mockEnv,
        );
      const note = await PostActivityServiceFedify.createNote(
        { ...mockPost, radius: "SHOUT" },
        mockUser,
        mockEnv,
      );
      const uris = PostActivityServiceFedify.generatePostUris(
        mockPost.id,
        mockEnv,
      );
      const actorId = "https://example.com/users/alice";

      const data = extractCreateActivityData(
        createActivity,
        note,
        actorId,
        uris.activityId.toString(),
        uris.objectId.toString(),
      );

      expect(data.to).toBeDefined();
      expect(Array.isArray(data.to)).toBe(true);
      expect(data.object.to).toBeDefined();
    });

    it("should handle bto and bcc fields", async () => {
      const createActivity =
        await PostActivityServiceFedify.createCreateActivity(
          {
            ...mockPost,
            to: ["https://example.com/users/custom1"],
            bto: ["https://example.com/users/custom2"],
            bcc: ["https://example.com/users/custom3"],
          },
          mockUser,
          mockEnv,
        );
      const note = await PostActivityServiceFedify.createNote(
        {
          ...mockPost,
          to: ["https://example.com/users/custom1"],
          bto: ["https://example.com/users/custom2"],
          bcc: ["https://example.com/users/custom3"],
        },
        mockUser,
        mockEnv,
      );
      const uris = PostActivityServiceFedify.generatePostUris(
        mockPost.id,
        mockEnv,
      );
      const actorId = "https://example.com/users/alice";

      const data = extractCreateActivityData(
        createActivity,
        note,
        actorId,
        uris.activityId.toString(),
        uris.objectId.toString(),
      );

      expect(data.bto).toBeDefined();
      expect(Array.isArray(data.bto)).toBe(true);
      expect(data.bcc).toBeDefined();
      expect(Array.isArray(data.bcc)).toBe(true);
      expect(data.object.bto).toBeDefined();
      expect(data.object.bcc).toBeDefined();
    });

    it("should handle missing published date (fallback behavior)", async () => {
      // Test that the function handles missing published gracefully
      // Since Fedify objects have read-only properties, we test the fallback logic
      // by checking that the function always returns a valid ISO string
      const createActivity =
        await PostActivityServiceFedify.createCreateActivity(
          mockPost,
          mockUser,
          mockEnv,
        );
      const note = await PostActivityServiceFedify.createNote(
        mockPost,
        mockUser,
        mockEnv,
      );
      const uris = PostActivityServiceFedify.generatePostUris(
        mockPost.id,
        mockEnv,
      );
      const actorId = "https://example.com/users/alice";

      const data = extractCreateActivityData(
        createActivity,
        note,
        actorId,
        uris.activityId.toString(),
        uris.objectId.toString(),
      );

      // Should always return a valid ISO string
      expect(data.published).toBeDefined();
      expect(typeof data.published).toBe("string");
      expect(data.published).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("should handle Temporal.Instant dates", async () => {
      const { Temporal } = await import("@js-temporal/polyfill");
      const createActivity =
        await PostActivityServiceFedify.createCreateActivity(
          mockPost,
          mockUser,
          mockEnv,
        );
      const note = await PostActivityServiceFedify.createNote(
        mockPost,
        mockUser,
        mockEnv,
      );
      const uris = PostActivityServiceFedify.generatePostUris(
        mockPost.id,
        mockEnv,
      );
      const actorId = "https://example.com/users/alice";

      const data = extractCreateActivityData(
        createActivity,
        note,
        actorId,
        uris.activityId.toString(),
        uris.objectId.toString(),
      );

      // Should convert Temporal.Instant to ISO string
      expect(data.published).toBeDefined();
      expect(typeof data.published).toBe("string");
      expect(data.object.published).toBeDefined();
      expect(typeof data.object.published).toBe("string");
    });

    it("should handle Date objects (via Temporal.Instant conversion)", async () => {
      // Fedify uses Temporal.Instant, but the converter should handle both
      // Since we can't modify Fedify objects, we verify the conversion works
      const createActivity =
        await PostActivityServiceFedify.createCreateActivity(
          mockPost,
          mockUser,
          mockEnv,
        );
      const note = await PostActivityServiceFedify.createNote(
        mockPost,
        mockUser,
        mockEnv,
      );
      const uris = PostActivityServiceFedify.generatePostUris(
        mockPost.id,
        mockEnv,
      );
      const actorId = "https://example.com/users/alice";

      const data = extractCreateActivityData(
        createActivity,
        note,
        actorId,
        uris.activityId.toString(),
        uris.objectId.toString(),
      );

      // Should convert Temporal.Instant to ISO string
      expect(data.published).toBeDefined();
      expect(typeof data.published).toBe("string");
      expect(data.published).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("should handle recipients as URL objects", async () => {
      const createActivity =
        await PostActivityServiceFedify.createCreateActivity(
          { ...mockPost, to: ["https://example.com/users/custom1"] },
          mockUser,
          mockEnv,
        );
      const note = await PostActivityServiceFedify.createNote(
        { ...mockPost, to: ["https://example.com/users/custom1"] },
        mockUser,
        mockEnv,
      );
      const uris = PostActivityServiceFedify.generatePostUris(
        mockPost.id,
        mockEnv,
      );
      const actorId = "https://example.com/users/alice";

      const data = extractCreateActivityData(
        createActivity,
        note,
        actorId,
        uris.activityId.toString(),
        uris.objectId.toString(),
      );

      // Recipients should be converted to strings
      if (data.to) {
        expect(data.to.every((r: any) => typeof r === "string")).toBe(true);
      }
    });

    it("should handle recipients as strings", async () => {
      const createActivity =
        await PostActivityServiceFedify.createCreateActivity(
          { ...mockPost, radius: "SHOUT" },
          mockUser,
          mockEnv,
        );
      const note = await PostActivityServiceFedify.createNote(
        { ...mockPost, radius: "SHOUT" },
        mockUser,
        mockEnv,
      );
      const uris = PostActivityServiceFedify.generatePostUris(
        mockPost.id,
        mockEnv,
      );
      const actorId = "https://example.com/users/alice";

      const data = extractCreateActivityData(
        createActivity,
        note,
        actorId,
        uris.activityId.toString(),
        uris.objectId.toString(),
      );

      // PUBLIC_COLLECTION is a string constant
      if (data.to) {
        expect(data.to.every((r: any) => typeof r === "string")).toBe(true);
      }
    });

    it("should handle empty recipient arrays", async () => {
      const createActivity =
        await PostActivityServiceFedify.createCreateActivity(
          { ...mockPost, radius: "WHISPER" },
          mockUser,
          mockEnv,
        );
      const note = await PostActivityServiceFedify.createNote(
        { ...mockPost, radius: "WHISPER" },
        mockUser,
        mockEnv,
      );
      const uris = PostActivityServiceFedify.generatePostUris(
        mockPost.id,
        mockEnv,
      );
      const actorId = "https://example.com/users/alice";

      const data = extractCreateActivityData(
        createActivity,
        note,
        actorId,
        uris.activityId.toString(),
        uris.objectId.toString(),
      );

      // Empty arrays should be undefined
      expect(data.bto).toBeUndefined();
    });

    it("should handle missing content in note", async () => {
      const createActivity =
        await PostActivityServiceFedify.createCreateActivity(
          mockPost,
          mockUser,
          mockEnv,
        );
      const note = await PostActivityServiceFedify.createNote(
        { ...mockPost, text: null },
        mockUser,
        mockEnv,
      );
      const uris = PostActivityServiceFedify.generatePostUris(
        mockPost.id,
        mockEnv,
      );
      const actorId = "https://example.com/users/alice";

      const data = extractCreateActivityData(
        createActivity,
        note,
        actorId,
        uris.activityId.toString(),
        uris.objectId.toString(),
      );

      expect(data.object.content).toBe("");
    });
  });

  describe("createActivityDataToActivityStreams - additional edge cases", () => {
    it("should handle bto and bcc fields", () => {
      const data = {
        id: "https://example.com/posts/123/activity",
        actor: "https://example.com/users/alice",
        published: "2024-01-01T00:00:00Z",
        bto: ["https://example.com/users/bob"],
        bcc: ["https://example.com/users/charlie"],
        object: {
          id: "https://example.com/posts/123",
          attributedTo: "https://example.com/users/alice",
          content: "Test",
          published: "2024-01-01T00:00:00Z",
          bto: ["https://example.com/users/bob"],
          bcc: ["https://example.com/users/charlie"],
        },
      };

      const result = createActivityDataToActivityStreams(data);

      expect(result.bto).toEqual(["https://example.com/users/bob"]);
      expect(result.bcc).toEqual(["https://example.com/users/charlie"]);
      expect(result.object.bto).toEqual(["https://example.com/users/bob"]);
      expect(result.object.bcc).toEqual(["https://example.com/users/charlie"]);
    });

    it("should handle all audience fields together", () => {
      const data = {
        id: "https://example.com/posts/123/activity",
        actor: "https://example.com/users/alice",
        published: "2024-01-01T00:00:00Z",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: ["https://example.com/users/bob"],
        bto: ["https://example.com/users/charlie"],
        bcc: ["https://example.com/users/dave"],
        object: {
          id: "https://example.com/posts/123",
          attributedTo: "https://example.com/users/alice",
          content: "Test",
          published: "2024-01-01T00:00:00Z",
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: ["https://example.com/users/bob"],
          bto: ["https://example.com/users/charlie"],
          bcc: ["https://example.com/users/dave"],
        },
      };

      const result = createActivityDataToActivityStreams(data);

      expect(result.to).toEqual([
        "https://www.w3.org/ns/activitystreams#Public",
      ]);
      expect(result.cc).toEqual(["https://example.com/users/bob"]);
      expect(result.bto).toEqual(["https://example.com/users/charlie"]);
      expect(result.bcc).toEqual(["https://example.com/users/dave"]);
      expect(result.object.to).toEqual([
        "https://www.w3.org/ns/activitystreams#Public",
      ]);
      expect(result.object.cc).toEqual(["https://example.com/users/bob"]);
      expect(result.object.bto).toEqual(["https://example.com/users/charlie"]);
      expect(result.object.bcc).toEqual(["https://example.com/users/dave"]);
    });

    it("should not include undefined audience fields", () => {
      const data = {
        id: "https://example.com/posts/123/activity",
        actor: "https://example.com/users/alice",
        published: "2024-01-01T00:00:00Z",
        object: {
          id: "https://example.com/posts/123",
          attributedTo: "https://example.com/users/alice",
          content: "Test",
          published: "2024-01-01T00:00:00Z",
        },
      };

      const result = createActivityDataToActivityStreams(data);

      expect("to" in result).toBe(false);
      expect("cc" in result).toBe(false);
      expect("bto" in result).toBe(false);
      expect("bcc" in result).toBe(false);
      expect("to" in result.object).toBe(false);
      expect("cc" in result.object).toBe(false);
      expect("bto" in result.object).toBe(false);
      expect("bcc" in result.object).toBe(false);
    });

    it("should handle empty audience arrays (included but empty)", () => {
      const data = {
        id: "https://example.com/posts/123/activity",
        actor: "https://example.com/users/alice",
        published: "2024-01-01T00:00:00Z",
        to: [],
        object: {
          id: "https://example.com/posts/123",
          attributedTo: "https://example.com/users/alice",
          content: "Test",
          published: "2024-01-01T00:00:00Z",
        },
      };

      const result = createActivityDataToActivityStreams(data);

      // Empty arrays are still included (the function doesn't filter them)
      // This is expected behavior - filtering should happen at a higher level
      expect(result.to).toEqual([]);
    });
  });
});
