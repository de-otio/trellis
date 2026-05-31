/**
 * Unit Tests: Sentiment Digest Generator
 *
 * Tests digest generation with KV caching.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

// Hoist mocks
const { mockPrisma, mockKV } = vi.hoisted(() => ({
  mockPrisma: {
    post: { findMany: vi.fn() },
    release: vi.fn(),
  },
  mockKV: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

describe("generateSentimentDigest", () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
      FEED_CACHE_KV: mockKV,
    } as unknown as Env;
    mockPrisma.release.mockResolvedValue(undefined);
  });

  it("should return digest with multiple sentiments on a post", async () => {
    const { generateSentimentDigest } = await import(
      "../../src/lib/sentiment-digest.js"
    );

    mockKV.get.mockResolvedValue(null);
    mockKV.put.mockResolvedValue(undefined);

    mockPrisma.post.findMany.mockResolvedValue([
      {
        id: "post-1",
        text: "My cute dog photo",
        sentiments: [
          { sentiment: "joy" },
          { sentiment: "love" },
          { sentiment: "joy" },
        ],
      },
    ]);

    const since = new Date("2025-01-01");
    const result = await generateSentimentDigest("user-1", since, mockEnv);

    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].postId).toBe("post-1");
    expect(result.posts[0].postPreview).toBe("My cute dog photo");
    expect(result.posts[0].sentiments).toEqual(
      expect.arrayContaining(["joy", "love"]),
    );
    expect(result.posts[0].sentiments).toHaveLength(2); // unique
    expect(result.posts[0].newSentimentCount).toBe(3);
    expect(result.generatedAt).toBeInstanceOf(Date);
  });

  it("should return empty sentiments array for post with zero sentiments", async () => {
    const { generateSentimentDigest } = await import(
      "../../src/lib/sentiment-digest.js"
    );

    mockKV.get.mockResolvedValue(null);
    mockKV.put.mockResolvedValue(undefined);

    mockPrisma.post.findMany.mockResolvedValue([
      {
        id: "post-2",
        text: "A post with no reactions",
        sentiments: [],
      },
    ]);

    const since = new Date("2025-01-01");
    const result = await generateSentimentDigest("user-1", since, mockEnv);

    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].sentiments).toEqual([]);
    expect(result.posts[0].newSentimentCount).toBe(0);
  });

  it("should include multiple posts in digest", async () => {
    const { generateSentimentDigest } = await import(
      "../../src/lib/sentiment-digest.js"
    );

    mockKV.get.mockResolvedValue(null);
    mockKV.put.mockResolvedValue(undefined);

    mockPrisma.post.findMany.mockResolvedValue([
      {
        id: "post-1",
        text: "First post",
        sentiments: [{ sentiment: "joy" }],
      },
      {
        id: "post-2",
        text: "Second post",
        sentiments: [{ sentiment: "love" }, { sentiment: "gratitude" }],
      },
    ]);

    const since = new Date("2025-01-01");
    const result = await generateSentimentDigest("user-1", since, mockEnv);

    expect(result.posts).toHaveLength(2);
    expect(result.posts[0].postId).toBe("post-1");
    expect(result.posts[1].postId).toBe("post-2");
  });

  it("should return cached result without DB query when cache is fresh", async () => {
    const { generateSentimentDigest } = await import(
      "../../src/lib/sentiment-digest.js"
    );

    const cachedDigest = {
      posts: [
        {
          postId: "post-cached",
          postPreview: "Cached post",
          sentiments: ["joy"],
          newSentimentCount: 1,
        },
      ],
      generatedAt: new Date().toISOString(), // fresh cache
    };

    mockKV.get.mockResolvedValue(JSON.stringify(cachedDigest));

    const since = new Date("2025-01-01");
    const result = await generateSentimentDigest("user-1", since, mockEnv);

    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].postId).toBe("post-cached");
    // DB should NOT have been queried
    expect(mockPrisma.post.findMany).not.toHaveBeenCalled();
  });

  it("should recompute when cache is expired", async () => {
    const { generateSentimentDigest } = await import(
      "../../src/lib/sentiment-digest.js"
    );

    const expiredDigest = {
      posts: [
        {
          postId: "post-old",
          postPreview: "Old post",
          sentiments: ["sadness"],
          newSentimentCount: 1,
        },
      ],
      // 2 hours ago — expired (TTL is 1 hour)
      generatedAt: new Date(
        Date.now() - 2 * 60 * 60 * 1000,
      ).toISOString(),
    };

    mockKV.get.mockResolvedValue(JSON.stringify(expiredDigest));
    mockKV.put.mockResolvedValue(undefined);

    mockPrisma.post.findMany.mockResolvedValue([
      {
        id: "post-fresh",
        text: "Fresh post",
        sentiments: [{ sentiment: "joy" }],
      },
    ]);

    const since = new Date("2025-01-01");
    const result = await generateSentimentDigest("user-1", since, mockEnv);

    // Should have queried DB since cache was expired
    expect(mockPrisma.post.findMany).toHaveBeenCalled();
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].postId).toBe("post-fresh");
  });

  it("should truncate post content to 100 characters for preview", async () => {
    const { generateSentimentDigest } = await import(
      "../../src/lib/sentiment-digest.js"
    );

    mockKV.get.mockResolvedValue(null);
    mockKV.put.mockResolvedValue(undefined);

    const longContent = "A".repeat(200);
    mockPrisma.post.findMany.mockResolvedValue([
      {
        id: "post-long",
        text: longContent,
        sentiments: [{ sentiment: "awe" }],
      },
    ]);

    const since = new Date("2025-01-01");
    const result = await generateSentimentDigest("user-1", since, mockEnv);

    expect(result.posts[0].postPreview).toHaveLength(100);
  });
});
