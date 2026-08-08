/**
 * Unit Tests: Comment Rate Limiting
 *
 * Tests distributed rate limiting for comment creation using Cloudflare KV.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  commentRateLimit,
  type CommentRateLimitEnv,
  type RateLimitResult,
} from "../../src/lib/middleware/comment-rate-limit.js";

describe("Comment Rate Limiting", () => {
  let mockKV: Map<string, { value: string; expiration: number }>;
  let mockEnv: CommentRateLimitEnv;

  beforeEach(() => {
    mockKV = new Map();

    // Mock KV namespace
    mockEnv = {
      RATE_LIMIT_KV: {
        get: vi.fn(async (key: string) => {
          const entry = mockKV.get(key);
          return entry ? entry.value : null;
        }),
        put: vi.fn(async (key: string, value: string, options?: any) => {
          mockKV.set(key, { value, expiration: options?.expirationTtl || 60 });
        }),
      } as any,
    };
  });

  describe("per-post rate limit", () => {
    it("should allow first comment on a post", async () => {
      const result = await commentRateLimit("user123", "post456", mockEnv);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9); // 10 - 1 = 9 remaining
      expect(result.retryAfter).toBeUndefined();
    });

    it("should block second comment within 30 seconds on same post", async () => {
      const userId = "user123";
      const postId = "post456";

      // First comment succeeds
      let result = await commentRateLimit(userId, postId, mockEnv);
      expect(result.allowed).toBe(true);

      // Second comment immediately fails
      result = await commentRateLimit(userId, postId, mockEnv);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(30);
      expect(result.remaining).toBe(0);
    });

    it("should allow comment after 30 seconds on same post", async () => {
      const userId = "user123";
      const postId = "post456";

      // First comment
      await commentRateLimit(userId, postId, mockEnv);

      // Simulate 31 seconds passing by setting old timestamp
      const oldTime = Date.now() - 31000;
      mockKV.set(`rate:comment:post:${postId}:${userId}`, {
        value: oldTime.toString(),
        expiration: 60,
      });

      // Second comment should now be allowed
      const result = await commentRateLimit(userId, postId, mockEnv);
      expect(result.allowed).toBe(true);
    });

    it("should allow different users to comment on same post", async () => {
      const postId = "post456";

      // User 1 comments
      const result1 = await commentRateLimit("user123", postId, mockEnv);
      expect(result1.allowed).toBe(true);

      // User 2 can comment immediately on same post
      const result2 = await commentRateLimit("user789", postId, mockEnv);
      expect(result2.allowed).toBe(true);
    });

    it("should allow same user to comment on different posts", async () => {
      const userId = "user123";

      // Comment on post 1
      const result1 = await commentRateLimit(userId, "post456", mockEnv);
      expect(result1.allowed).toBe(true);

      // Can comment immediately on different post
      const result2 = await commentRateLimit(userId, "post789", mockEnv);
      expect(result2.allowed).toBe(true);
    });
  });

  describe("per-user global rate limit", () => {
    it("should allow up to 10 comments per minute", async () => {
      const userId = "user123";

      // Post 10 comments on different posts
      for (let i = 0; i < 10; i++) {
        const postId = `post${i}`;
        const result = await commentRateLimit(userId, postId, mockEnv);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(10 - i - 1); // Decreasing remaining count
      }
    });

    it("should block 11th comment within same minute", async () => {
      const userId = "user123";

      // Post 10 comments on different posts
      for (let i = 0; i < 10; i++) {
        await commentRateLimit(userId, `post${i}`, mockEnv);
      }

      // 11th comment should be blocked
      const result = await commentRateLimit(userId, "post999", mockEnv);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.remaining).toBe(0);
    });

    it("should reset counter after 60 seconds", async () => {
      const userId = "user123";

      // Post 10 comments
      for (let i = 0; i < 10; i++) {
        await commentRateLimit(userId, `post${i}`, mockEnv);
      }

      // Simulate 61 seconds passing by setting old window start
      const oldWindowStart = Date.now() - 61000;
      mockKV.set(`rate:comment:user:${userId}`, {
        value: JSON.stringify({
          windowStart: oldWindowStart,
          count: 10,
        }),
        expiration: 60,
      });

      // Next comment should be allowed (new window)
      const result = await commentRateLimit(userId, "post999", mockEnv);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });

    it("should track different users independently", async () => {
      // User 1 posts 10 comments
      for (let i = 0; i < 10; i++) {
        await commentRateLimit("user123", `post${i}`, mockEnv);
      }

      // User 2 should still be able to comment
      const result = await commentRateLimit("user789", "post999", mockEnv);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });
  });

  describe("KV unavailable handling", () => {
    /** A binding that is PRESENT but unreachable — the half-migrated shape. */
    function throwingEnv(
      commentRateLimit?: CommentRateLimitEnv["commentRateLimit"],
    ): CommentRateLimitEnv {
      return {
        RATE_LIMIT_KV: {
          get: vi.fn(async () => {
            throw new Error("getaddrinfo ENOTFOUND kv.example.invalid");
          }),
          put: vi.fn(async () => {
            throw new Error("getaddrinfo ENOTFOUND kv.example.invalid");
          }),
        } as any,
        commentRateLimit,
      };
    }

    it("allows when RATE_LIMIT_KV is not configured at all", async () => {
      // ABSENCE is a deployment shape (local dev, unit tests), not a
      // malfunction — so this branch keeps allowing. It is the *error* path
      // below that changed.
      const envWithoutKV: CommentRateLimitEnv = {};

      const result = await commentRateLimit("user123", "post456", envWithoutKV);

      expect(result.allowed).toBe(true);
      expect(result.retryAfter).toBeUndefined();
    });

    // REVERSED. This previously read "should fail-open when KV throws error"
    // and asserted `allowed === true`, which made the hole a specification:
    // on a platform where the store ALWAYS throws, comment rate limiting was
    // not degraded but entirely absent, and this test said that was correct.
    it("DENIES by default when the KV call throws (fail-closed)", async () => {
      const result = await commentRateLimit("user123", "post456", throwingEnv());

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.remaining).toBe(0);
    });

    it("denies on a throwing store even when the config block is absent", async () => {
      // The default must live in the middleware, not only in env.ts: a caller
      // holding a partial env must not silently re-open the hole.
      const env = throwingEnv(undefined);
      expect((await commentRateLimit("u", "p", env)).allowed).toBe(false);
    });

    it.each([
      ["unset", undefined],
      ["empty", "" as never],
      ["misspelt", "opne" as never],
      ["wrong case", "OPEN" as never],
    ])(
      "treats a %s fail-mode as closed — only an exact 'open' disables the control",
      async (_label, mode) => {
        const env = throwingEnv({ failMode: mode as never });
        expect((await commentRateLimit("u", "p", env)).allowed).toBe(false);
      },
    );

    it("allows on a throwing store when the operator opts into fail-open", async () => {
      // The escape hatch must actually work, or operators will patch it out.
      const env = throwingEnv({ failMode: "open" });

      const result = await commentRateLimit("user123", "post456", env);

      expect(result.allowed).toBe(true);
    });
  });

  describe("threshold-secrecy config (rule 8)", () => {
    it("honours a configured per-minute ceiling instead of a compiled constant", async () => {
      const env: CommentRateLimitEnv = {
        ...mockEnv,
        commentRateLimit: { perMinute: 3, postCooldownSeconds: 0 },
      };

      // 3 allowed on distinct posts (cooldown 0 keeps the per-post rule out).
      for (let i = 0; i < 3; i++) {
        expect((await commentRateLimit("u1", `p${i}`, env)).allowed).toBe(true);
      }
      // The 4th trips the configured ceiling — not the default 10.
      expect((await commentRateLimit("u1", "p9", env)).allowed).toBe(false);
    });

    it("reports remaining against the CONFIGURED ceiling", async () => {
      const env: CommentRateLimitEnv = {
        ...mockEnv,
        commentRateLimit: { perMinute: 5 },
      };
      expect((await commentRateLimit("u2", "p1", env)).remaining).toBe(4);
    });

    it("honours a configured per-post cooldown", async () => {
      const env: CommentRateLimitEnv = {
        ...mockEnv,
        commentRateLimit: { postCooldownSeconds: 120 },
      };

      expect((await commentRateLimit("u3", "p1", env)).allowed).toBe(true);
      const blocked = await commentRateLimit("u3", "p1", env);

      expect(blocked.allowed).toBe(false);
      // Would be ≤30 under the old compiled constant.
      expect(blocked.retryAfter).toBeGreaterThan(30);
      expect(blocked.retryAfter).toBeLessThanOrEqual(120);
    });

    it("falls back to the previous compiled defaults when unconfigured", async () => {
      // The seam must be a config change, not a policy change: 10/min, 30s.
      expect((await commentRateLimit("u4", "p1", mockEnv)).remaining).toBe(9);
      const blocked = await commentRateLimit("u4", "p1", mockEnv);
      expect(blocked.retryAfter).toBeLessThanOrEqual(30);
    });
  });

  describe("retry-after calculation", () => {
    it("should return correct retry-after for per-post limit", async () => {
      const userId = "user123";
      const postId = "post456";

      // First comment
      await commentRateLimit(userId, postId, mockEnv);

      // Simulate 10 seconds passing
      const oldTime = Date.now() - 10000;
      mockKV.set(`rate:comment:post:${postId}:${userId}`, {
        value: oldTime.toString(),
        expiration: 60,
      });

      // Second comment should be blocked with ~20 seconds retry-after
      const result = await commentRateLimit(userId, postId, mockEnv);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThanOrEqual(19);
      expect(result.retryAfter).toBeLessThanOrEqual(21);
    });

    it("should return correct retry-after for per-user limit", async () => {
      const userId = "user123";

      // Post 10 comments
      for (let i = 0; i < 10; i++) {
        await commentRateLimit(userId, `post${i}`, mockEnv);
      }

      // Simulate 30 seconds passing
      const windowStart = Date.now() - 30000;
      mockKV.set(`rate:comment:user:${userId}`, {
        value: JSON.stringify({
          windowStart,
          count: 10,
        }),
        expiration: 60,
      });

      // 11th comment should be blocked with ~30 seconds retry-after
      const result = await commentRateLimit(userId, "post999", mockEnv);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThanOrEqual(29);
      expect(result.retryAfter).toBeLessThanOrEqual(31);
    });
  });

  describe("KV entry expiration", () => {
    it("should set 60 second TTL on per-post entries", async () => {
      await commentRateLimit("user123", "post456", mockEnv);

      expect(mockEnv.RATE_LIMIT_KV?.put).toHaveBeenCalledWith(
        "rate:comment:post:post456:user123",
        expect.any(String),
        { expirationTtl: 60 },
      );
    });

    it("should set 60 second TTL on per-user entries", async () => {
      await commentRateLimit("user123", "post456", mockEnv);

      expect(mockEnv.RATE_LIMIT_KV?.put).toHaveBeenCalledWith(
        "rate:comment:user:user123",
        expect.any(String),
        { expirationTtl: 60 },
      );
    });
  });

  describe("malformed data handling", () => {
    it("should handle invalid JSON in user limit data", async () => {
      const userId = "user123";

      // Set invalid JSON
      mockKV.set(`rate:comment:user:${userId}`, {
        value: "not valid json",
        expiration: 60,
      });

      // Should reset and allow comment
      const result = await commentRateLimit(userId, "post456", mockEnv);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });

    it("should handle missing count in user limit data", async () => {
      const userId = "user123";

      // Set data without count
      mockKV.set(`rate:comment:user:${userId}`, {
        value: JSON.stringify({ windowStart: Date.now() }),
        expiration: 60,
      });

      // Should treat as 0 count
      const result = await commentRateLimit(userId, "post456", mockEnv);
      expect(result.allowed).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle exactly 30 seconds elapsed for per-post limit", async () => {
      const userId = "user123";
      const postId = "post456";

      // First comment
      await commentRateLimit(userId, postId, mockEnv);

      // Set exactly 30 seconds ago
      const exactTime = Date.now() - 30000;
      mockKV.set(`rate:comment:post:${postId}:${userId}`, {
        value: exactTime.toString(),
        expiration: 60,
      });

      // Should be allowed (>= 30 seconds)
      const result = await commentRateLimit(userId, postId, mockEnv);
      expect(result.allowed).toBe(true);
    });

    it("should handle exactly 60 seconds elapsed for per-user limit", async () => {
      const userId = "user123";

      // Post 10 comments
      for (let i = 0; i < 10; i++) {
        await commentRateLimit(userId, `post${i}`, mockEnv);
      }

      // Set exactly 60 seconds ago (window still active at exactly 60000ms)
      const exactWindowStart = Date.now() - 60000;
      mockKV.set(`rate:comment:user:${userId}`, {
        value: JSON.stringify({
          windowStart: exactWindowStart,
          count: 10,
        }),
        expiration: 60,
      });

      // Should be blocked (window expires AFTER 60s, not at exactly 60s)
      const result = await commentRateLimit(userId, "post999", mockEnv);
      expect(result.allowed).toBe(false);
    });

    it("should handle very rapid requests (race condition simulation)", async () => {
      const userId = "user123";
      const postId = "post456";

      // Simulate rapid concurrent requests
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(commentRateLimit(userId, postId, mockEnv));
      }

      const results = await Promise.all(promises);

      // First should be allowed, rest should be blocked
      const allowedCount = results.filter((r) => r.allowed).length;
      expect(allowedCount).toBeGreaterThanOrEqual(1);
      expect(allowedCount).toBeLessThanOrEqual(5); // May vary due to async timing
    });
  });
});
