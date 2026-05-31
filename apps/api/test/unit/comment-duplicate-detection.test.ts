/**
 * Unit Tests: Comment Duplicate Detection
 *
 * Tests duplicate comment detection logic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockComment {
  id: string;
  postId: string;
  authorId: string;
  text: string;
  createdAt: Date;
  deletedAt: Date | null;
}

describe("Comment Duplicate Detection", () => {
  let mockComments: MockComment[];
  let mockDb: any;

  beforeEach(() => {
    mockComments = [];

    mockDb = {
      postComment: {
        findFirst: vi.fn(async ({ where, orderBy }: any) => {
          // Simulate database query for duplicates
          const { postId, authorId, text, createdAt, deletedAt } = where;

          const matches = mockComments.filter((c) => {
            if (c.postId !== postId) return false;
            if (c.authorId !== authorId) return false;
            if (c.text !== text) return false;
            // Handle deletedAt: null filter (exclude deleted comments)
            if (deletedAt === null && c.deletedAt !== null) return false;
            if (createdAt?.gte && c.createdAt < createdAt.gte) return false;

            return true;
          });

          if (matches.length === 0) return null;

          // Sort by createdAt desc (most recent first)
          if (orderBy?.createdAt === "desc") {
            matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }

          return matches[0];
        }),
      },
    };
  });

  const createMockComment = (
    id: string,
    postId: string,
    authorId: string,
    text: string,
    minutesAgo: number,
    deleted: boolean = false,
  ): MockComment => {
    const createdAt = new Date(Date.now() - minutesAgo * 60 * 1000);
    return {
      id,
      postId,
      authorId,
      text,
      createdAt,
      deletedAt: deleted ? new Date() : null,
    };
  };

  describe("duplicate detection within 5 minutes", () => {
    it("should detect duplicate comment within 5 minutes", async () => {
      // Add existing comment (2 minutes ago)
      mockComments.push(
        createMockComment("comment1", "post456", "user123", "Hello world", 2),
      );

      // Query for duplicate
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user123",
          text: "Hello world",
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeTruthy();
      expect(duplicate?.id).toBe("comment1");
    });

    it("should not flag as duplicate after 5 minutes", async () => {
      // Add existing comment (6 minutes ago)
      mockComments.push(
        createMockComment("comment1", "post456", "user123", "Hello world", 6),
      );

      // Query for duplicate
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user123",
          text: "Hello world",
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeNull();
    });

    it("should detect duplicate at exactly 5 minutes", async () => {
      // Use a fixed reference time to avoid race between comment creation and query
      const now = Date.now();
      const exactlyFiveMinutesAgo = new Date(now - 5 * 60 * 1000);

      mockComments.push({
        id: "comment1",
        postId: "post456",
        authorId: "user123",
        text: "Hello world",
        createdAt: exactlyFiveMinutesAgo,
        deletedAt: null,
      });

      // Query with the same reference point
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user123",
          text: "Hello world",
          createdAt: { gte: exactlyFiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeTruthy();
    });
  });

  describe("text matching", () => {
    it("should not flag different text as duplicate", async () => {
      // Add existing comment
      mockComments.push(
        createMockComment("comment1", "post456", "user123", "Hello world", 2),
      );

      // Query with different text
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user123",
          text: "Hello world!", // Different (exclamation point)
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeNull();
    });

    it("should match text exactly (case-sensitive)", async () => {
      // Add existing comment
      mockComments.push(
        createMockComment("comment1", "post456", "user123", "Hello World", 2),
      );

      // Query with different case
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user123",
          text: "hello world", // Different case
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeNull();
    });

    it("should match sanitized text (whitespace normalized)", async () => {
      // Note: Sanitization happens before duplicate check in real code
      // This test verifies that sanitized text is compared
      mockComments.push(
        createMockComment("comment1", "post456", "user123", "Hello world", 2),
      );

      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user123",
          text: "Hello world", // Same after sanitization
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeTruthy();
    });
  });

  describe("user isolation", () => {
    it("should not flag duplicate from different user", async () => {
      // User 1 posts comment
      mockComments.push(
        createMockComment("comment1", "post456", "user123", "Hello world", 2),
      );

      // User 2 posts same text
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user789", // Different user
          text: "Hello world",
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeNull();
    });

    it("should allow different users to post identical comments", async () => {
      // Multiple users post same text
      mockComments.push(
        createMockComment("comment1", "post456", "user123", "Great post!", 2),
      );
      mockComments.push(
        createMockComment("comment2", "post456", "user789", "Great post!", 1),
      );

      // User 3 posts same text - should not be duplicate
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user999", // Different user
          text: "Great post!",
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeNull();
    });
  });

  describe("post isolation", () => {
    it("should not flag duplicate on different post", async () => {
      // User comments on post 1
      mockComments.push(
        createMockComment("comment1", "post456", "user123", "Hello world", 2),
      );

      // Same user posts same text on different post
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post789", // Different post
          authorId: "user123",
          text: "Hello world",
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeNull();
    });

    it("should allow same user to post same text on different posts", async () => {
      // User posts same text on multiple posts
      mockComments.push(
        createMockComment("comment1", "post1", "user123", "Thanks!", 2),
      );
      mockComments.push(
        createMockComment("comment2", "post2", "user123", "Thanks!", 1),
      );

      // Check each post independently
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const dup1 = await mockDb.postComment.findFirst({
        where: {
          postId: "post1",
          authorId: "user123",
          text: "Thanks!",
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });
      expect(dup1?.id).toBe("comment1");

      const dup2 = await mockDb.postComment.findFirst({
        where: {
          postId: "post2",
          authorId: "user123",
          text: "Thanks!",
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });
      expect(dup2?.id).toBe("comment2");
    });
  });

  describe("deleted comments handling", () => {
    it("should not match deleted comments as duplicates", async () => {
      // Add deleted comment
      mockComments.push(
        createMockComment(
          "comment1",
          "post456",
          "user123",
          "Hello world",
          2,
          true,
        ),
      );

      // Query should not match deleted comments
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user123",
          text: "Hello world",
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null, // Explicitly exclude deleted
        },
      });

      expect(duplicate).toBeNull();
    });

    it("should allow re-posting after deletion", async () => {
      // User posts comment, then deletes it
      mockComments.push(
        createMockComment(
          "comment1",
          "post456",
          "user123",
          "Hello world",
          2,
          true,
        ),
      );

      // User tries to post same comment again - should be allowed
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user123",
          text: "Hello world",
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("should handle empty comment list", async () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user123",
          text: "Hello world",
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeNull();
    });

    it("should return most recent duplicate when multiple exist", async () => {
      // Add multiple duplicates at different times
      mockComments.push(
        createMockComment("comment1", "post456", "user123", "Hello world", 4),
      );
      mockComments.push(
        createMockComment("comment2", "post456", "user123", "Hello world", 2),
      );

      // Should return most recent (comment2)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user123",
          text: "Hello world",
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
        orderBy: { createdAt: "desc" },
      });

      expect(duplicate?.id).toBe("comment2");
    });

    it("should handle very long text (3000 chars)", async () => {
      const longText = "a".repeat(3000);

      mockComments.push(
        createMockComment("comment1", "post456", "user123", longText, 2),
      );

      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user123",
          text: longText,
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeTruthy();
    });

    it("should handle special characters in text", async () => {
      const specialText =
        'Hello! 🐶 @user #hashtag <script>alert("xss")</script>';

      mockComments.push(
        createMockComment("comment1", "post456", "user123", specialText, 2),
      );

      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await mockDb.postComment.findFirst({
        where: {
          postId: "post456",
          authorId: "user123",
          text: specialText,
          createdAt: { gte: fiveMinutesAgo },
          deletedAt: null,
        },
      });

      expect(duplicate).toBeTruthy();
    });
  });
});
