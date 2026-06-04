/**
 * Sentiment Digest Generator
 *
 * Generates a digest of sentiment activity on a user's posts.
 * Uses KV cache with 1-hour TTL to avoid repeated DB queries.
 * Part of Stream C: Sentiment Safeguards.
 */

import type { Env } from "../env.js";
import { createPrisma } from "../db.js";
import { getLogger, Logger } from "./logger.js";

export interface SentimentDigest {
  posts: Array<{
    postId: string;
    postPreview: string;
    sentiments: string[];
    newSentimentCount: number;
  }>;
  generatedAt: Date;
}

const DIGEST_CACHE_TTL_SECONDS = 3600; // 1 hour

export async function generateSentimentDigest(
  userId: string,
  since: Date,
  env: Env,
): Promise<SentimentDigest> {
  const logger = getLogger();
  const cacheKey = `digest:${userId}`;

  // 1. Try to read from KV cache
  if (env.FEED_CACHE_KV) {
    try {
      const cached = await env.FEED_CACHE_KV.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        const cachedAt = new Date(parsed.generatedAt);
        const now = new Date();
        const ageMs = now.getTime() - cachedAt.getTime();

        // Return cached if not expired (1 hour TTL)
        if (ageMs < DIGEST_CACHE_TTL_SECONDS * 1000) {
          return {
            ...parsed,
            generatedAt: cachedAt,
          };
        }
      }
    } catch (error) {
      logger.warn("Error reading digest cache, falling back to DB", error);
    }
  }

  // 2. Query DB for posts by userId that have sentiments since `since`
  const db = createPrisma(env);
  try {
    const posts = await db.post.findMany({
      where: {
        authorId: userId,
        sentiments: {
          some: {
            createdAt: { gte: since },
          },
        },
      },
      select: {
        id: true,
        text: true,
        sentiments: {
          where: {
            createdAt: { gte: since },
          },
          select: {
            sentiment: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50, // Circuit breaker: max 50 posts per digest
    });

    // 3. For each post: get unique sentiment types and count
    const digestPosts = posts.map((post) => {
      const sentiments = [
        ...new Set(post.sentiments.map((s: { sentiment: string }) => s.sentiment)),
      ];
      return {
        postId: post.id,
        postPreview: (post.text || "").slice(0, 100),
        sentiments,
        newSentimentCount: post.sentiments.length,
      };
    });

    const digest: SentimentDigest = {
      posts: digestPosts,
      generatedAt: new Date(),
    };

    // 4. Cache result in KV with 1-hour TTL
    if (env.FEED_CACHE_KV) {
      try {
        await env.FEED_CACHE_KV.put(cacheKey, JSON.stringify(digest), {
          expirationTtl: DIGEST_CACHE_TTL_SECONDS,
        });
      } catch (error) {
        logger.warn("Error writing digest cache", error);
      }
    }

    return digest;
  } finally {
    await db.release();
  }
}
