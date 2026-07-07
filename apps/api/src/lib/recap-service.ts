/**
 * Recap Service (year-in-review core primitive)
 *
 * Aggregates a subject's (user or entity) OWN activity over a window into a
 * neutral, domain-free `RecapPayload`. This is the core half of the
 * "year-in-review" mechanic — verticals attach their own domain aggregates
 * (e.g. Skybber: walks logged, pack-mates met) via the optional
 * `extendRecap` extension hook; core itself never emits domain vocabulary.
 *
 * Safer-social alignment (non-negotiable — see
 * doc/02-technical/architecture and the design at
 * trellis-internal/plans/open-social-web/04-skybber-year-in-review.md):
 * - Own data only. No comparison to other subjects, no leaderboard, no
 *   rank, no percentile. Every query below is scoped to a single subject.
 * - Aggregation only — no new PII, no new collection. Reads existing
 *   tables (Post, PostSentiment, Relationship) and returns counts.
 *
 * Caching mirrors sentiment-digest.ts: KV (DynamoDB-backed), cache-first,
 * bounded on-demand compute on a miss. The recap window is stable once
 * closed, so the TTL is long (default 90 days, `RECAP_CACHE_TTL_DAYS`).
 */

import type { TrellisExtension } from "@de-otio/trellis-extension-api";
import type { Env } from "../env.js";
import { createPrisma } from "../db.js";
import { getExtensions } from "../extensions.js";
import { createExtensionContext } from "./extension-context.js";
import { getLogger, Logger } from "./logger.js";

export interface RecapInput {
  subjectType: "user" | "entity";
  subjectId: string;
  window: { from: Date; to: Date };
  tenantId: string;
}

export interface RecapPayload {
  window: { from: string; to: string };
  posts: {
    count: number;
    firstAt?: string;
    mostReactedPostId?: string;
  };
  /** Sentiment counts received on the subject's own posts, by emotion. */
  sentimentsReceived: Record<string, number>;
  /** New Relationship edges involving the subject, created within the window. */
  connectionsMade: number;
  topMoments: Array<{ postId: string; at: string }>;
  /**
   * NOTE (SEC-11, review blocker): `sentimentsReceived` / `topMoments` are
   * raw counts. This primitive stays neutral, but the PRESENTATION layer
   * (e.g. a public shareable card) MUST bucket or cap these before display
   * ("many" vs. exact numbers) — a year-in-review that surfaces exact
   * popularity counts becomes the vanity-metric surface the safer-social
   * rules prohibit. Do not remove this note when editing this interface.
   */
  extension?: Record<string, unknown>;
}

const RECAP_CACHE_TTL_DAYS_DEFAULT = 90;
// Circuit breaker: bound the number of posts fetched for aggregation in a
// single recap compute. `posts.count` itself is a separate, unbounded
// `count()` query, so the displayed total stays accurate even if the
// aggregation detail (topMoments, per-post sentiment) is capped.
const RECAP_MAX_POSTS = 1000;
const RECAP_MAX_TOP_MOMENTS = 3;
const EXTEND_RECAP_TIMEOUT_MS = 5_000;

function cacheKey(input: RecapInput): string {
  return [
    "recap",
    input.tenantId,
    input.subjectType,
    input.subjectId,
    input.window.from.toISOString(),
    input.window.to.toISOString(),
  ].join(":");
}

/**
 * Threshold-secrecy: the cache TTL is runtime config, not a compiled-in
 * constant (this file ships in the public npm tarball). Read directly from
 * process.env rather than widening the (already large) `Env` interface for
 * a single optional knob.
 */
function resolveCacheTtlSeconds(): number {
  const raw = process.env.RECAP_CACHE_TTL_DAYS;
  const days = raw ? Number(raw) : NaN;
  const effectiveDays = Number.isFinite(days) && days > 0 ? days : RECAP_CACHE_TTL_DAYS_DEFAULT;
  return effectiveDays * 24 * 60 * 60;
}

export class RecapService {
  /**
   * Generate (or return the cached) recap payload for a subject + window.
   */
  async generateRecap(input: RecapInput, env: Env): Promise<RecapPayload> {
    const logger = getLogger();
    const key = cacheKey(input);

    if (env.FEED_CACHE_KV) {
      try {
        const cached = await env.FEED_CACHE_KV.get(key);
        if (cached) {
          return JSON.parse(cached) as RecapPayload;
        }
      } catch (error) {
        logger.warn("Error reading recap cache, falling back to DB", error);
      }
    }

    const payload = await this.computeRecap(input, env);

    if (env.FEED_CACHE_KV) {
      try {
        await env.FEED_CACHE_KV.put(key, JSON.stringify(payload), {
          expirationTtl: resolveCacheTtlSeconds(),
        });
      } catch (error) {
        logger.warn("Error writing recap cache", error);
      }
    }

    return payload;
  }

  private async computeRecap(input: RecapInput, env: Env): Promise<RecapPayload> {
    const db = createPrisma(env);
    try {
      const { subjectType, subjectId, tenantId, window } = input;

      // Own data only: scope every query to this single subject.
      const postWhere =
        subjectType === "user" ? { authorId: subjectId } : { primaryEntityId: subjectId };

      const dateRange = { gte: window.from, lte: window.to };

      const postCount = await db.post.count({
        where: {
          ...postWhere,
          tenantId,
          deletedAt: null,
          createdAt: dateRange,
        },
      });

      const posts = await db.post.findMany({
        where: {
          ...postWhere,
          tenantId,
          deletedAt: null,
          createdAt: dateRange,
        },
        select: {
          id: true,
          createdAt: true,
          sentiments: {
            where: { createdAt: dateRange },
            select: { sentiment: true },
          },
        },
        orderBy: { createdAt: "asc" },
        take: RECAP_MAX_POSTS, // Circuit breaker
      });

      const sentimentsReceived: Record<string, number> = {};
      let mostReactedPostId: string | undefined;
      let mostReactedCount = 0;
      const postsBySentimentCount: Array<{ postId: string; at: string; count: number }> = [];

      for (const post of posts) {
        const count = post.sentiments.length;
        for (const s of post.sentiments as Array<{ sentiment: string }>) {
          sentimentsReceived[s.sentiment] = (sentimentsReceived[s.sentiment] ?? 0) + 1;
        }
        postsBySentimentCount.push({ postId: post.id, at: post.createdAt.toISOString(), count });
        if (count > mostReactedCount) {
          mostReactedCount = count;
          mostReactedPostId = post.id;
        }
      }

      const topMoments = [...postsBySentimentCount]
        .sort((a, b) => b.count - a.count)
        .slice(0, RECAP_MAX_TOP_MOMENTS)
        .map(({ postId, at }) => ({ postId, at }));

      // New Relationship edges involving the subject, created in the window.
      // For a user: edges the user initiated. For an entity: edges other
      // users made toward the entity (an entity cannot itself be
      // `Relationship.userId`, which is always a user).
      const connectionWhere =
        subjectType === "user"
          ? { userId: subjectId }
          : { targetType: "entity", targetId: subjectId };

      const connectionsMade = await db.relationship.count({
        where: {
          ...connectionWhere,
          tenantId,
          createdAt: dateRange,
        },
      });

      const payload: RecapPayload = {
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        posts: {
          count: postCount,
          firstAt: posts[0]?.createdAt.toISOString(),
          mostReactedPostId: mostReactedCount > 0 ? mostReactedPostId : undefined,
        },
        sentimentsReceived,
        connectionsMade,
        topMoments,
      };

      const extensionFields = await this.callExtendRecap(payload, input, env, db);
      if (extensionFields) {
        payload.extension = extensionFields;
      }

      return payload;
    } finally {
      await db.release();
    }
  }

  /**
   * Call the registered extension's `extendRecap`, if it provides one.
   * Fire-and-catch: an extension failure never fails the core recap.
   * Mirrors hook-dispatcher.ts's per-call timeout (without the persistent
   * circuit breaker — recap generation is rare/batched, not hot-path).
   */
  private async callExtendRecap(
    payload: RecapPayload,
    input: RecapInput,
    env: Env,
    db: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    const logger = getLogger();
    let merged: Record<string, unknown> | undefined;

    for (const ext of getExtensions() as readonly TrellisExtension[]) {
      if (!ext.extendRecap) continue;
      try {
        const ctx = createExtensionContext(ext, env, db);
        const subject = {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          window: payload.window,
        };
        const result = await Promise.race([
          ext.extendRecap(payload, subject, ctx),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`extendRecap timed out after ${EXTEND_RECAP_TIMEOUT_MS}ms`)),
              EXTEND_RECAP_TIMEOUT_MS,
            ),
          ),
        ]);
        merged = { ...(merged ?? {}), ...result };
      } catch (error) {
        logger.warn(`Extension "${ext.id}" extendRecap failed`, error);
      }
    }

    return merged;
  }
}
