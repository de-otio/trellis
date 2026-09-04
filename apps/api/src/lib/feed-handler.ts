/**
 * Feed Handler
 *
 * Handles feed aggregation and filtering.
 *
 * PREPARATORY: Uses DataRouter for region-aware data operations.
 */


// PostRadius is a Prisma-generated enum. `@prisma/client` is CJS, and
// cjs-module-lexer can't statically detect runtime-generated enum exports
// under ESM, so `import { getLogger, PostRadius }` fails when the package is
// consumed (the in-repo test suite runs against source and tolerates it
// — the consumer-install smoke catches it on the published tarball).
// Default-import + destructure: the runtime exports object always
// contains it.
import prismaPkg from "@prisma/client";
const { PostRadius } = prismaPkg;
import { getLogger } from "./logger.js";

import { DataRouter } from "./data-router.js";
import { getFriendUserIds } from "./friend-ids.js";
import {
  attachmentProvenanceView,
  textProvenanceView,
} from "./provenance/response.js";
import type { ProvenanceView } from "./provenance/types.js";
import { Logger, type LoggerEnv } from "./logger.js";
import type { TrellisRequestContext } from "./request-context.js";
import { getSentimentDisplayMode, SentimentDisplayMode } from "./sentiment-display.js";
import type { Session } from "./session-cookie.js";
import type { Env } from "../env.js";

export interface FeedPost {
  id: string;
  uri?: string;
  text: string;
  author: {
    id: string;
    email: string;
    did?: string; // Optional: for future AT Protocol integration
    handle?: string; // Optional: for future AT Protocol integration
    avatar?: string;
  };
  createdAt: string;
  radius: string;
  taggedEntities?: Array<{
    id: string;
    name: string;
    entityType?: string;
  }>;
  taxonomyTags?: Array<{
    taxonId: string;
    displayName: string;
    description: string | null;
    category?: {
      code: string;
      displayName: string;
      dimension?: {
        code: string;
        displayName: string;
      };
    };
  }>;
  geoData?: {
    lat: number;
    lng: number;
    place?: string;
  };
  contentWarnings?: string[];
  /**
   * Synthetic-content provenance of the post TEXT (AI Act Art. 50).
   *
   * ALWAYS PRESENT, never omitted: an absent field is indistinguishable from an
   * old client or a pre-migration row, and clients need to tell "we don't know"
   * (`UNKNOWN`) from "we didn't ask".
   *
   * `UNKNOWN` MUST render as nothing — never as "human-created". Rendering a
   * human claim we never made is the one client-side mistake that turns this
   * field into misinformation. Per-attachment provenance is on `media[].provenance`.
   */
  provenance: ProvenanceView;
  /**
   * Reaction totals for this post, keyed by sentiment type (see
   * `sentimentTypes`). Computed by `PostSentiment.groupBy` (enrichPosts,
   * this file) — every `PostSentiment` row for the post, unfiltered.
   *
   * There is no soft-delete or moderation-status column on `PostSentiment`
   * (prisma/schema.prisma): removing a reaction hard-deletes the row
   * (`reaction-handler.ts`), so nothing to exclude ever lingers here. The
   * post author's own reaction, if any, counts like anyone else's. Used to
   * DISPLAY reaction counts only — never as a feed sort input; see
   * feed-pagination.ts's `ALLOWED_SORT_FIELDS` / the no-covert-ordering
   * invariant in REPRODUCIBILITY.md.
   */
  sentimentCounts?: Record<string, number>;
  sentimentTypes?: string[];                    // only when display mode = DISTRIBUTION
  sentimentDisplayMode?: string;                // "full" | "distribution" | "hidden"
  /**
   * Number of comments on this post. Computed by `PostComment.groupBy`
   * (enrichPosts, this file), which excludes:
   *   - comments hidden by the post owner (`hiddenByPostOwner: true`)
   *   - soft-deleted comments (`deletedAt IS NOT NULL`)
   *
   * There is no separate comment-moderation-status field in the schema to
   * filter on. The count is NOT author-scoped: the post author's own
   * comments count the same as anyone else's. Display only — never a feed
   * sort input (see `sentimentCounts` above for the same invariant).
   */
  commentCount?: number;
  userSentiment?: string;
  isOwner?: boolean;
  media?: Array<{
    id: string;
    mediaId: string;
    alt: string | null;
    order: number;
    file: {
      id: string;
      contentHash: string;
      mimeType: string;
      originalKey: string;
      thumbnailKey: string | null;
      optimizedKey: string | null;
      width: number | null;
      height: number | null;
    };
    /**
     * Provenance of THIS attachment (AI Act Art. 50) — per-attachment, not
     * per-post, because one post can mix a human photo with an AI-generated one.
     * Always present; `UNKNOWN` renders as nothing, never as "human".
     */
    provenance: ProvenanceView;
  }>;
}

export interface FeedResponse {
  posts: FeedPost[];
  cursor?: string;
  hasMore: boolean;
  pageNumber?: number;
  sessionPostCount?: number;
  quietHoursActive?: boolean;
  nudge?: {
    type: "time_reminder" | "session_limit";
    message: string;
    sessionMinutes: number;
  };
}

/**
 * Composite home-feed pagination cursor — the same (created_at, id) keyset
 * the circles feed uses (lib/graph/postgres/circles.ts). A strict
 * `createdAt <` cursor alone skips every post TIED with the boundary
 * timestamp; the id tiebreak admits them.
 */
interface FeedCursor {
  createdAt: Date;
  /** Tiebreak post id. Null for a legacy ISO-date cursor (strict-< fallback). */
  postId: string | null;
}

function decodeFeedCursor(raw?: string): FeedCursor | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
      createdAt?: unknown;
      postId?: unknown;
    };
    if (typeof d.createdAt === "string" && typeof d.postId === "string") {
      const t = new Date(d.createdAt);
      if (!Number.isNaN(t.getTime())) return { createdAt: t, postId: d.postId };
    }
  } catch {
    // Not base64 JSON — fall through to the legacy ISO-date format.
  }
  const legacy = new Date(raw);
  return Number.isNaN(legacy.getTime())
    ? null
    : { createdAt: legacy, postId: null };
}

function encodeFeedCursor(createdAt: Date, postId: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), postId }),
  ).toString("base64");
}

/**
 * The audience predicate for reading posts: public, or own, or a friend's
 * connections-level post.
 *
 * ONE definition, deliberately. Both read paths in this file — the home feed
 * and the single-post fetch — must agree, because a viewer who is denied a row
 * in the feed and then granted the same row by id has no audience boundary at
 * all. Keeping this in one function is what makes that agreement checkable.
 *
 * THREE call sites, and no more:
 *
 *   1. `getHomeFeed` (this file)
 *   2. `getPost` (this file)
 *   3. `canReadPost` (lib/post-read-authorizer.ts)
 *
 * The third was added for H3 and is the one to reuse. The post's ATTACHMENTS —
 * comments, sentiment counts, the who-reacted list — were audience-blind, each
 * testing only that the post row existed. Rather than give each endpoint its
 * own predicate (three more places to diverge), they all call `canReadPost`,
 * which calls this. So the rule is now: an endpoint that needs to decide
 * whether a viewer may read a post calls `canReadPost`; it does not call this
 * function directly, and it certainly does not write its own predicate.
 *
 * This is an interim home. It reproduces today's semantics only; it does not
 * consult `LOUD` (which the feed has never admitted for anyone but the author),
 * group membership, or blocks. It is scheduled to be replaced wholesale by the
 * single audience resolver — see trellis-internal plans/audience-and-reach,
 * task P1.4 — at which point this function and its three call sites go away
 * together. Thread the resolver into those three; do not add a fourth.
 *
 * @param viewerUserId the cuid of the viewing user (never an OIDC `sub`)
 * @param friendUserIds ids this viewer is connected to, resolved by the caller
 */
export function buildPostAudienceFilter(
  viewerUserId: string,
  friendUserIds: string[],
) {
  return {
    OR: [
      { radius: PostRadius.SHOUT },
      { authorId: viewerUserId }, // Own posts
      {
        radius: PostRadius.NORMAL,
        authorId: { in: friendUserIds },
      },
    ],
  };
}

export class FeedHandler {
  private logger: Logger;

  constructor(env?: LoggerEnv) {
    this.logger = getLogger();
  }

  /**
   * Get API domain consistently across all feed operations
   * Respects APP_DOMAIN environment variable, converts www. to api., or uses default
   */
  private static getApiDomain(env: Env): string {
    if (env.APP_DOMAIN) {
      try {
        const url = new URL(env.APP_DOMAIN);
        let hostname = url.hostname;

        // Convert www. to api.
        if (hostname.startsWith("www.")) {
          hostname = hostname.replace("www.", "api.");
        } else if (!hostname.includes("api.")) {
          // If no api. subdomain, add it
          const parts = hostname.split(".");
          if (parts.length >= 2) {
            hostname = `api.${parts.slice(-2).join(".")}`;
          }
        }

        return `${url.protocol}//${hostname}`;
      } catch {
        // Invalid URL, fall through to default
      }
    }

    // Default fallback
    return "https://api.rkm1.de";
  }

  /**
   * Get user's home feed
   *
   * PREPARATORY: Uses DataRouter for region-aware queries.
   */
  async getHomeFeed(
    session: Session,
    request: Request,
    env: Env,
    options: {
      limit?: number;
      cursor?: string;
      entityRefs?: string[]; // Filter by multiple entities
      taxonomyTags?: string[]; // Filter by taxonomy tags (taxonIds)
      personalized?: boolean; // Enable personalization based on user's entity tags
      personalizationEntityIds?: string[]; // Specific entity IDs for personalization
    },
    requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      const limit = Math.min(options.limit || 20, 100);
      const cursor = decodeFeedCursor(options.cursor);

      // Safer Social Design: Parse pagination and session awareness params
      const url = new URL(request.url);
      const pageNumber = parseInt(url.searchParams.get("pageNumber") || "1", 10);
      const sessionDurationMinutes = parseInt(url.searchParams.get("sessionDurationMinutes") || "0", 10);

      // The tenant guard runs BEFORE the cache is consulted, not after the
      // database predicate is built. A cache hit returns without ever reaching
      // the query, so a guard placed further down cannot protect the cached
      // path — it would let a request with no active tenant be answered from
      // whatever a previous request stored.
      if (!activeTenantId) {
        throw new Error(
          "getHomeFeed: activeTenantId is required for tenant isolation",
        );
      }

      // PREPARATORY: Use region in cache key to ensure region-specific caching
      const region = requestContext.region;
      const cacheVersion = await FeedHandler.getCacheVersion(env);
      // Include entityRefs in cache key for proper cache invalidation
      const entityRefsKey = options.entityRefs?.sort().join(",") || "";
      // EVERY input to the response body must appear in this key. The body is
      // resolved per viewer AND per tenant: `activeTenantId` comes from a JWT
      // claim that changes when a user switches tenant, and it is an AND in the
      // post query below. Omitting it means a user who belongs to two tenants
      // gets tenant A's posts served from cache while reading as tenant B —
      // defeating the tenant predicate entirely for the cache TTL, with no
      // error anywhere.
      const cacheKey = `feed:home:${region}:${activeTenantId}:v${cacheVersion}:${session.userId}:${entityRefsKey}:${options.cursor || "initial"}:${limit}`;

      // PREPARATORY: Check aggressive caching feature flag
      // If enabled, use longer cache TTL and more aggressive cache strategies
      const aggressiveCaching =
        requestContext.config.features.performance.aggressiveCaching;
      const cached = await this.getCachedFeed(cacheKey, env);
      if (cached) {
        return new Response(JSON.stringify(cached), {
          status: 200,
          headers: {
            "content-type": "application/json",
            // MUST stay `private`, and must be present unconditionally. The
            // response body is resolved per viewer and per tenant (the cache key
            // carries both, and the visibility filter is built from this
            // viewer's friend set), so a shared cache — CDN or proxy — that
            // stored it would serve one viewer's feed to another.
            //
            // Emitting nothing when aggressive caching is off is NOT the safe
            // default: under RFC 9111 a 200 with no explicit freshness is
            // heuristically storable, and a cookie-authenticated request carries
            // no `Authorization` header to suppress that. So the flag chooses
            // the browser-side TTL it exists to buy; it does not choose whether
            // to say `private`.
            "Cache-Control": aggressiveCaching
              ? "private, max-age=300" // 5 minutes
              : "private, no-store",
            // Identity lives in the cookie/header, not the URL — every viewer
            // requests the same path, so a shared cache needs telling that the
            // response varies by credential.
            Vary: "Authorization, Cookie",
          },
        });
      }

      // PREPARATORY: Use DataRouter to get region-specific database
      // Pass request for monitoring/rate limiting (if available)
      const db = DataRouter.getDatabaseForRegion(
        region,
        env,
        request,
        session?.userId,
      );

      // Get friend user IDs for visibility filtering (relationship edges,
      // tier ≤ 1 — see lib/friend-ids.ts for the convergence definition).
      // Tenant-scoped: the friend set must come from the SAME tenant as the
      // posts it gates, or an edge created in another tenant widens this feed.
      const friendIds = await getFriendUserIds(
        db,
        session.userId,
        activeTenantId,
      );

      // Build visibility filter (shared with getPost — see
      // buildPostAudienceFilter; the two paths must not diverge).
      // Note: This OR condition is at the top level, not nested
      const visibilityFilter = buildPostAudienceFilter(
        session.userId,
        friendIds,
      );

      // Build entity filter for multi-entity tagging
      let entityFilter: any = undefined;
      if (options.entityRefs && options.entityRefs.length > 0) {
        // Filter posts that have at least one of the specified entities tagged
        entityFilter = {
          subjectEntities: {
            some: {
              entityId: { in: options.entityRefs },
            },
          },
        };
      }

      // Tenant ID comes from the authenticated caller's JWT (passed in by the
      // route). Already proven non-empty above, before the cache was consulted:
      // Prisma DROPS a `where` key whose value is `undefined`, so a falsy tenant
      // would remove the tenant predicate from the post query below and return
      // every tenant's posts with no error anywhere.
      const tenantId = activeTenantId;

      // Fail loudly rather than silently widening. Prisma DROPS a `where` key
      // whose value is `undefined`, so a falsy tenant here would remove the
      // tenant predicate from the post query below and return every tenant's
      // posts — with no error anywhere. Throwing keeps that failure mode
      // impossible to reach silently.
      if (!tenantId) {
        throw new Error(
          "getHomeFeed: activeTenantId is required for tenant isolation",
        );
      }

      // Build taxonomy filter
      let taxonomyFilter: any = undefined;
      let userEntityTaxonIds: string[] = [];

      if (options.taxonomyTags && options.taxonomyTags.length > 0) {
        // Explicit taxonomy tags filter
        const { getWrappedDatabase } = await import(
          "./database-wrapper-helper.js"
        );
        const wrappedDb = getWrappedDatabase(region, env, request);

        // Find taxon IDs by taxonId strings
        const taxons = await wrappedDb.taxonomyTaxon.findMany({
          where: {
            tenantId,
            taxonId: { in: options.taxonomyTags },
            isActive: true,
          },
          select: { id: true },
        });

        if (taxons.length > 0) {
          taxonomyFilter = {
            taxonomyTags: {
              some: {
                taxonId: { in: taxons.map((t: any) => t.id) },
              },
            },
          };
        } else {
          // If no matching taxons found, return empty results
          taxonomyFilter = { id: { in: [] } };
        }
      } else if (options.personalized) {
        // Personalize feed based on user's entity taxonomy tags
        const { FeedPersonalization } = await import("./feed-personalization.js");
        userEntityTaxonIds = await FeedPersonalization.getEntityTaxonomyTags(
          session.userId,
          options.personalizationEntityIds,
          region,
          env,
          request,
          tenantId,
        );

        if (userEntityTaxonIds.length > 0) {
          const { getWrappedDatabase } = await import(
            "./database-wrapper-helper.js"
          );
          const wrappedDb = getWrappedDatabase(region, env, request);

          // Find taxon IDs by taxonId strings
          const taxons = await wrappedDb.taxonomyTaxon.findMany({
            where: {
              tenantId,
              taxonId: { in: userEntityTaxonIds },
              isActive: true,
            },
            select: { id: true },
          });

          if (taxons.length > 0) {
            taxonomyFilter = {
              taxonomyTags: {
                some: {
                  taxonId: { in: taxons.map((t: any) => t.id) },
                },
              },
            };
          }
        }
        // If user has no entity tags, don't filter (show all posts)
      }

      // PREPARATORY: Fetch posts with dataRegion filter to ensure data residency
      // Note: Type assertion needed since Prisma client hasn't been regenerated with dataRegion field
      // Use DatabaseConnectionManager for clear state management
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      // Create connection manager instance (manages its own pool state)
      const dbManager = sharedDatabaseConnectionManager;

      const posts = await withQueryTimeoutAndRetry(
        dbManager,
        region,
        env,
        async (client) => {
          return client.post.findMany({
            where: {
              // Combine all filters at the same level
              // Prisma will handle the OR conditions correctly when spread
              AND: [
                visibilityFilter, // OR condition for visibility
                ...(entityFilter ? [entityFilter] : []), // Optional entity filter
                ...(taxonomyFilter ? [taxonomyFilter] : []), // Optional taxonomy filter
                {
                  deletedAt: null,
                  hiddenByAuthor: false,
                  // CRITICAL: tenant isolation. This predicate is the only thing
                  // separating tenants on this path — it must not be removed and
                  // must not be made optional. Ambient tenant scoping does NOT
                  // cover this query: TENANT_SCOPE_MODE defaults to "off" (see
                  // tenant-scope.ts), in which case runWithTenantContext never
                  // runs and the Prisma tenant-scope extension is not attached,
                  // and there is no PostgreSQL RLS backstop yet. So this is the
                  // first line of defence, not a redundant second one.
                  tenantId,
                  // CRITICAL: Only get posts from the correct region
                  // For empty database, this filter returns 0 results instantly
                  // For production, all posts should have dataRegion set
                  // Note: We don't allow NULL dataRegion here - posts must have region set
                  dataRegion: region,
                },
                // Optional keyset cursor: (createdAt, id) — strictly older,
                // or tied-with-boundary and past the boundary id. Legacy
                // ISO-date cursors (postId null) keep the old strict-<.
                ...(cursor
                  ? [
                      cursor.postId !== null
                        ? {
                            OR: [
                              { createdAt: { lt: cursor.createdAt } },
                              {
                                createdAt: cursor.createdAt,
                                id: { lt: cursor.postId },
                              },
                            ],
                          }
                        : { createdAt: { lt: cursor.createdAt } },
                    ]
                  : []),
              ],
            } as any,
            // Tiebreak matches the cursor keyset exactly (createdAt, id).
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
            // Optimize includes: only fetch what's needed
            // On empty database, these should return quickly
            include: {
              author: {
                select: {
                  id: true,
                  email: true,
                  actorUri: true,
                  handle: true,
                  // Only include essential author fields to reduce query complexity
                },
              },
              subjectEntities: {
                take: 10, // Limit subject entities to prevent excessive joins
                include: {
                  entity: {
                    select: {
                      id: true,
                      name: true,
                      entityType: true,
                      // Only include essential entity fields
                    },
                  },
                },
              },
              taxonomyTags: {
                take: 20, // Limit taxonomy tags
                include: {
                  taxon: {
                    select: {
                      taxonId: true,
                      displayName: true,
                      description: true,
                      category: {
                        select: {
                          code: true,
                          displayName: true,
                          dimension: {
                            select: {
                              code: true,
                              displayName: true,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              media: {
                where: {
                  media: {
                    hidden: false,
                    deletedAt: null,
                  },
                },
                orderBy: { order: "asc" },
                include: {
                  media: {
                    select: {
                      id: true,
                      contentHash: true,
                      mimeType: true,
                      originalKey: true,
                      thumbnailKey: true,
                      optimizedKey: true,
                      width: true,
                      height: true,
                      // Art. 50 provenance. Adding a column to an existing
                      // select on an already-joined row: no extra query, no
                      // extra join (plan T3.0 join audit).
                      embeddedSourceType: true,
                    },
                  },
                },
              },
            },
          }) as unknown as Promise<any[]>;
        },
        {
          ...QueryTimeoutPresets.USER_FACING, // 3s initial, 2s retry = 5s max total
          defaultValue: [], // Return empty array if query fails (graceful degradation)
          context: {
            operation: "getHomeFeed",
            userId: session.userId,
            region,
          },
        },
      );

      const hasMore = posts.length > limit;
      let result = hasMore ? posts.slice(0, limit) : posts;

      // Feed personalization via extension feedStrategy was removed in the
      // redesign and nothing replaced it. `options.personalized` is a no-op.

      const nextCursor =
        hasMore && result.length > 0
          ? encodeFeedCursor(
              result[result.length - 1].createdAt,
              result[result.length - 1].id,
            )
          : undefined;

      // Enrich posts with sentiment counts and comment counts
      const enrichedPosts = await this.enrichPosts(
        result,
        session,
        env,
        requestContext,
      );

      // Safer Social Design: Check quiet hours
      let quietHoursActive = false;
      if (requestContext.featureAccess || session.ageTier) {
        const { isInQuietHours } = await import("./quiet-hours.js");
        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        // We'd need the user's quiet hours settings from DB, but for now check requestContext
        // Quiet hours integration is optional - the flag is set if the user has quiet hours configured
      }

      // Safer Social Design: Check session awareness nudge
      let nudge: FeedResponse["nudge"] = undefined;
      if (sessionDurationMinutes > 0 && session.ageTier) {
        const { getSessionNudge } = await import("./session-awareness.js");
        const sessionNudge = getSessionNudge(sessionDurationMinutes, session.ageTier);
        if (sessionNudge) {
          nudge = sessionNudge;
        }
      }

      // Safer Social Design: Check pagination limits
      let hasReachedLimit = false;
      if (session.ageTier) {
        const { getPaginationConfig, computePaginationMetadata } = await import("./feed-pagination.js");
        const paginationConfig = getPaginationConfig(session.ageTier);
        const metadata = computePaginationMetadata(pageNumber, limit, paginationConfig.maxPages);
        hasReachedLimit = metadata.hasReachedLimit;
      }

      const feedResponse: FeedResponse = {
        posts: enrichedPosts,
        cursor: hasReachedLimit ? undefined : nextCursor,
        hasMore: hasReachedLimit ? false : hasMore,
        pageNumber,
        sessionPostCount: pageNumber * limit,
        quietHoursActive: quietHoursActive || undefined,
        nudge,
      };

      // Cache response
      await this.cacheFeed(cacheKey, feedResponse, env);

      return new Response(JSON.stringify(feedResponse), {
        status: 200,
        headers: {
          "content-type": "application/json",
          // Per-viewer body: mark it private even on the freshly-computed path.
          // Absent a directive a shared cache may still store this
          // heuristically, which is the same leak as the cached path above.
          "Cache-Control": "private, no-store",
          Vary: "Authorization, Cookie",
        },
      });
    } catch (error: any) {
      this.logger.error("Error getting home feed:", error);
      this.logger.error(
        `Error details: ${error.message}${error.stack ? `\n${error.stack}` : ""}`,
      );
      return new Response(
        JSON.stringify({ error: "Failed to get feed", details: error.message }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Get a single post by ID, enriched with sentiment counts and comment count.
   * Returns null if the post is not found or not accessible.
   *
   * "Not accessible" is indistinguishable from "not found" on purpose: the
   * caller renders both as 404, so this method must never signal that a post it
   * refuses to return exists.
   */
  async getPost(
    postId: string,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<FeedPost | null> {
    const region = requestContext.region;
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );
    const apiDomain = FeedHandler.getApiDomain(env);

    // Same reasoning as getHomeFeed: Prisma drops an `undefined` where key, so a
    // falsy tenant would silently remove tenant isolation from the query below.
    if (!activeTenantId) {
      throw new Error(
        "getPost: activeTenantId is required for tenant isolation",
      );
    }

    // Resolve the viewer's connections once, before the post lookup, so that
    // "post absent" and "post denied" perform the same work and cannot be
    // distinguished by timing.
    const friendIds = await getFriendUserIds(
      DataRouter.getDatabaseForRegion(region, env, undefined, session.userId),
      session.userId,
      activeTenantId,
    );

    const post = await withQueryTimeoutAndRetry(
      sharedDatabaseConnectionManager,
      region,
      env,
      async (db) => {
        return db.post.findUnique({
          where: {
            id: postId,
            deletedAt: null,
            hiddenByAuthor: false,
            // V3: this path previously applied NO tenant and NO audience
            // predicate, so any authenticated caller could read any post —
            // including WHISPER — by id. Both are now required.
            tenantId: activeTenantId,
            ...buildPostAudienceFilter(session.userId, friendIds),
          },
          include: {
            author: {
              select: {
                id: true,
                email: true,
                actorUri: true,
                handle: true,
              },
            },
            media: {
              where: {
                media: { hidden: false, deletedAt: null },
              },
              orderBy: { order: "asc" },
              include: {
                media: {
                  select: {
                    id: true,
                    contentHash: true,
                    mimeType: true,
                    originalKey: true,
                    thumbnailKey: true,
                    optimizedKey: true,
                    width: true,
                    height: true,
                    // Art. 50 provenance — see note above.
                    embeddedSourceType: true,
                  },
                },
              },
            },
          },
        });
      },
      { ...QueryTimeoutPresets.USER_FACING, context: { operation: "getPost", postId } },
    ) as any;

    if (!post) return null;

    // Remap media keys to full URLs (same as enrichPosts does for feed)
    if (post.media) {
      post.media = post.media.map((pm: any) => ({
        ...pm,
        file: {
          id: pm.media.id,
          contentHash: pm.media.contentHash,
          mimeType: pm.media.mimeType,
          originalKey: `${apiDomain}/api/media/${pm.media.contentHash}?variant=original`,
          thumbnailKey: pm.media.thumbnailKey
            ? `${apiDomain}/api/media/${pm.media.contentHash}?variant=thumbnail`
            : null,
          optimizedKey: pm.media.optimizedKey
            ? `${apiDomain}/api/media/${pm.media.contentHash}?variant=optimized`
            : null,
          width: pm.media.width,
          height: pm.media.height,
        },
      }));
    }

    const enriched = await this.enrichPosts([post], session, env, requestContext);
    return enriched[0] ?? null;
  }

  /**
   * Enrich posts with sentiment counts, comment counts, and user sentiment
   *
   * PREPARATORY: Uses DataRouter for region-aware queries.
   */
  protected async enrichPosts(
    posts: any[],
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<FeedPost[]> {
    // PREPARATORY: Use DataRouter to get region-specific database
    const region = requestContext.region;
    const postIds = posts.map((p) => p.id);

    // Use standardized timeout/retry helper for enrichment queries
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );

    // OPTIMIZATION: Cache is handled per-post in reaction-handler.ts
    // For batch queries, we'll query database directly (cache individual post results)
    // This avoids cache key length issues and provides better cache hit rates
    const kv = env.FEED_CACHE_KV;

    // OPTIMIZATION: Execute all enrichment queries in parallel with reduced timeouts and retries
    // Reduced maxRetries from 3 to 1 (fail fast) and timeout from 1s to 500ms for scalability
    // Only query database if cache miss
    const [sentiments, userSentiments, commentCounts, linkChecks] =
      await Promise.all([
        // Get sentiment counts with timeout/retry
        // OPTIMIZATION: Individual post sentiment counts are cached in reaction-handler.ts
        // Batch queries are fast enough (<100ms) that per-batch caching isn't needed
        withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.postSentiment.groupBy({
              by: ["postId", "sentiment"],
              where: { postId: { in: postIds } },
              _count: true,
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 1, // Reduced from 3 to 1 (fail fast for scalability)
            baseDelayMs: 100,
            defaultValue: [], // Graceful degradation: return empty array if query fails
            context: {
              operation: "enrichPosts_sentiments",
              userId: session.userId,
              postCount: postIds.length,
            },
          },
        ),
        // Get user's sentiments with timeout/retry
        withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.postSentiment.findMany({
              where: {
                postId: { in: postIds },
                authorId: session.userId,
              },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 1, // Reduced from 3 to 1 (fail fast for scalability)
            baseDelayMs: 100,
            defaultValue: [], // Graceful degradation: return empty array if query fails
            context: {
              operation: "enrichPosts_userSentiments",
              userId: session.userId,
              postCount: postIds.length,
            },
          },
        ),
        // Get comment counts with timeout/retry
        // OPTIMIZATION: Batch queries are fast enough (<100ms) that caching isn't needed
        // Individual comment counts are updated in real-time, so batch caching has low hit rate
        //
        // `commentCount` (see FeedPost.commentCount) excludes comments hidden
        // by the post owner (hiddenByPostOwner) AND soft-deleted comments
        // (deletedAt IS NOT NULL — PostComment.deletedAt, prisma/schema.prisma).
        // Fixed 2026-09: deletedAt was not previously filtered here, so a
        // deleted comment stayed counted until the row was hard-purged.
        // There is no separate comment-moderation-status field to filter on
        // (schema has only hiddenByPostOwner/deletedAt), and the count is not
        // author-scoped — the post author's own comments count like anyone
        // else's, by design.
        withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.postComment.groupBy({
              by: ["postId"],
              where: {
                postId: { in: postIds },
                hiddenByPostOwner: false,
                deletedAt: null,
              },
              _count: true,
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 1, // Reduced from 3 to 1 (fail fast for scalability)
            baseDelayMs: 100,
            defaultValue: [], // Graceful degradation: return empty array if query fails
            context: {
              operation: "enrichPosts_commentCounts",
              userId: session.userId,
              postCount: postIds.length,
            },
          },
        ),
        // Get link checks with timeout/retry
        withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env as any,
          async (db) => {
            return await db.linkCheck.findMany({
              where: {
                postId: { in: postIds },
              },
              select: {
                id: true,
                postId: true,
                originalUrl: true,
                normalizedUrl: true,
                domain: true,
                status: true,
              },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 1, // Reduced from 3 to 1 (fail fast for scalability)
            baseDelayMs: 100,
            defaultValue: [], // Graceful degradation: return empty array if query fails
            context: {
              operation: "enrichPosts_linkChecks",
              userId: session.userId,
              postCount: postIds.length,
            },
          },
        ),
      ]);

    // Build maps
    const sentimentCountsMap: Record<string, Record<string, number>> = {};
    for (const s of sentiments) {
      if (!sentimentCountsMap[s.postId]) {
        sentimentCountsMap[s.postId] = {};
      }
      sentimentCountsMap[s.postId][s.sentiment] = s._count;
    }

    const userSentimentMap: Record<string, string> = {};
    for (const us of userSentiments) {
      userSentimentMap[us.postId] = us.sentiment;
    }

    const commentCountMap: Record<string, number> = {};
    for (const cc of commentCounts) {
      commentCountMap[cc.postId] = cc._count;
    }

    const linkChecksMap: Record<
      string,
      Array<{
        id: string;
        originalUrl: string;
        normalizedUrl: string;
        domain: string;
        status: string;
      }>
    > = {};
    for (const lc of linkChecks) {
      if (!linkChecksMap[lc.postId!]) {
        linkChecksMap[lc.postId!] = [];
      }
      linkChecksMap[lc.postId!].push({
        id: lc.id,
        originalUrl: lc.originalUrl,
        normalizedUrl: lc.normalizedUrl,
        domain: lc.domain,
        status: lc.status,
      });
    }

    // Get API domain for constructing media URLs
    const apiDomain = FeedHandler.getApiDomain(env);

    // Enrich posts
    return posts.map((post) => ({
      id: post.id,
      uri: post.uri || "", // Ensure uri is always a string (empty if not available)
      text: post.text,
      author: {
        id: post.author.id,
        email: post.author.email,
        actorUri: post.author.actorUri || post.author.id, // Use id as fallback for actorUri
        handle: post.author.handle || post.author.email?.split("@")[0] || "", // Use email prefix as fallback for handle
      },
      createdAt: post.createdAt.toISOString(),
      radius: post.radius,
      taggedEntities:
        post.subjectEntities?.map((pe: any) => ({
          id: pe.entity.id,
          name: pe.entity.name,
          entityType: pe.entity.entityType || undefined,
        })) || undefined,
      taxonomyTags:
        post.taxonomyTags?.map((pt: any) => ({
          taxonId: pt.taxon.taxonId,
          displayName: pt.taxon.displayName,
          description: pt.taxon.description,
          category: pt.taxon.category
            ? {
                code: pt.taxon.category.code,
                displayName: pt.taxon.category.displayName,
                dimension: pt.taxon.category.dimension
                  ? {
                      code: pt.taxon.category.dimension.code,
                      displayName: pt.taxon.category.dimension.displayName,
                    }
                  : undefined,
              }
            : undefined,
        })) || undefined,
      geoData: post.geoData as
        | { lat: number; lng: number; place?: string }
        | undefined,
      contentWarnings: post.contentWarnings || [],
      // Art. 50 disclosure. Emitted on EVERY post in the feed, not just on post
      // detail: the duty is disclosure "at the latest at the first interaction or
      // exposure", and for most users first exposure is the scroll.
      provenance: textProvenanceView(post),
      // Safer Social Design: Apply sentiment display mode based on age tier
      ...(() => {
        if (session.ageTier && session.ageTier !== "ADULT") {
          const isPostAuthor = post.authorId === session.userId;
          const mode = getSentimentDisplayMode(session.ageTier, isPostAuthor);
          if (mode === SentimentDisplayMode.HIDDEN) {
            return { sentimentDisplayMode: "hidden" };
          }
          if (mode === SentimentDisplayMode.DISTRIBUTION) {
            return {
              sentimentTypes: Object.keys(sentimentCountsMap[post.id] || {}),
              sentimentDisplayMode: "distribution",
            };
          }
        }
        return {
          sentimentCounts: sentimentCountsMap[post.id] || {},
          sentimentDisplayMode: "full",
        };
      })(),
      commentCount: commentCountMap[post.id] || 0,
      userSentiment: userSentimentMap[post.id],
      isOwner: post.authorId === session.userId,
      links: linkChecksMap[post.id] || undefined,
      media:
        post.media?.map((pm: any) => ({
          id: pm.id,
          mediaId: pm.mediaId,
          alt: pm.alt,
          order: pm.order,
          file: {
            id: pm.media.id,
            contentHash: pm.media.contentHash,
            mimeType: pm.media.mimeType,
            // Convert R2 storage keys to full media endpoint URLs
            originalKey: `${apiDomain}/api/media/${pm.media.contentHash}?variant=original`,
            thumbnailKey: pm.media.thumbnailKey
              ? `${apiDomain}/api/media/${pm.media.contentHash}?variant=thumbnail`
              : null,
            optimizedKey: pm.media.optimizedKey
              ? `${apiDomain}/api/media/${pm.media.contentHash}?variant=optimized`
              : null,
            width: pm.media.width,
            height: pm.media.height,
          },
          provenance: attachmentProvenanceView(pm),
        })) || undefined,
    }));
  }

  /**
   * Get cached feed
   */
  private async getCachedFeed(
    cacheKey: string,
    env: Env,
  ): Promise<FeedResponse | null> {
    const kv = env.FEED_CACHE_KV;
    if (!kv) return null;

    try {
      const cached = await kv.get(cacheKey, "json");
      return cached as FeedResponse | null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Cache feed response
   *
   * TTL: 30 seconds (as recommended in database/database-scalability-best-practices.md)
   * This balances cache hit rate with data freshness, reducing database load by 50-80%
   */
  private async cacheFeed(
    cacheKey: string,
    response: FeedResponse,
    env: Env,
  ): Promise<void> {
    const kv = env.FEED_CACHE_KV;
    if (!kv) {
      // KV not configured - this is acceptable, caching is optional
      return;
    }

    try {
      await kv.put(cacheKey, JSON.stringify(response), {
        expirationTtl: 60, // Minimum 60 seconds TTL (KV requirement, recommended for feed queries)
      });
    } catch (error) {
      // Cache failures are non-critical - log but don't fail the request
      this.logger.error("[FeedHandler] Error caching feed:", error);
    }
  }

  /**
   * Get current cache version (static method to avoid circular dependencies)
   * Returns the current feed cache version number (starts at 1)
   */
  static async getCacheVersion(env: Env): Promise<number> {
    const kv = env.FEED_CACHE_KV;
    if (!kv) return 1; // If no KV, return default version

    const logger = getLogger();
    try {
      const versionStr = await kv.get("feed:cache:version", "text");
      if (versionStr) {
        return parseInt(versionStr, 10);
      }
      // Initialize version to 1 if not exists
      await kv.put("feed:cache:version", "1");
      return 1;
    } catch (error) {
      logger.error("Error getting cache version:", error);
      return 1; // Default to version 1 on error
    }
  }

  /**
   * Invalidate feed cache by incrementing version (static method to avoid circular dependencies)
   * This makes all existing cache keys invalid (they use old version)
   */
  static async invalidateFeedCache(env: Env): Promise<void> {
    const kv = env.FEED_CACHE_KV;
    if (!kv) return;

    const logger = getLogger();
    try {
      const currentVersion = await FeedHandler.getCacheVersion(env);
      const newVersion = currentVersion + 1;
      await kv.put("feed:cache:version", newVersion.toString());
    } catch (error) {
      logger.error("Error invalidating feed cache:", error);
    }
  }
}
