/**
 * Abuse Prevention for ActivityPub federation (F6).
 *
 * What this replaces:
 *
 *   - **No blocklist at all.** There was no defederation mechanism anywhere in
 *     the codebase. An abusive instance could only be stopped by turning
 *     federation off entirely.
 *   - **Per-process, in-memory rate limiting** (`actorRequestCounts`, a bare
 *     `Map`). It reset on restart and was not shared across replicas, so the
 *     ceiling was really `limit × replicas` and a rolling deploy cleared it.
 *     It was also keyed per ACTOR, which is free to mint: one instance can
 *     present a thousand actor URIs and get a thousand buckets. Limits are now
 *     keyed by the remote INSTANCE DOMAIN, which is what actually costs an
 *     attacker something, and they use the shared distributed token bucket.
 *   - **`detectAbuse` that always returned false** and, in its catch, returned
 *     false again — i.e. an error in the abuse checker ADMITTED the activity.
 *     Nothing about "we failed to evaluate this" implies "this is fine".
 *
 * Failure policy: `validateActivity` fails CLOSED. If the limiter or the
 * blocklist cannot be consulted, the activity is rejected. Federation traffic
 * is not latency-critical and the sender will retry; admitting unevaluated
 * traffic from arbitrary instances is the worse trade.
 */

import type { Env } from "../../../env.js";
import { getLogger } from "../../logger.js";
import { consumeSharedBucket } from "../../rate-limit.js";

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  requestsPerMinute: number;
  requestsPerHour: number;
  requestsPerDay: number;
}

/**
 * Default rate limit configuration
 */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  requestsPerMinute: 60,
  requestsPerHour: 1000,
  requestsPerDay: 10000,
};

/** Bucket-key namespace for federation limits. */
const AP_BUCKET_PREFIX = "ap:instance";

/** Why an activity was refused admission. */
export type AdmissionDenial =
  | "blocked-instance"
  | "rate-limited"
  | "unresolvable-origin"
  | "abusive"
  | "check-failed";

export interface AdmissionResult {
  readonly admitted: boolean;
  readonly reason?: AdmissionDenial;
  readonly detail?: string;
}

const ADMITTED: AdmissionResult = { admitted: true };

/**
 * Extra environment this module reads. All optional: a deployment that
 * configures nothing still gets domain-keyed rate limiting via the shared
 * limiter's in-memory fallback.
 */
export interface AbusePreventionEnv {
  /**
   * Comma- or whitespace-separated domains to refuse outright. A leading `.`
   * or `*.` blocks the domain and everything under it.
   */
  ACTIVITYPUB_BLOCKED_DOMAINS?: string;
  /** Per-minute inbox request ceiling per remote instance. */
  ACTIVITYPUB_INSTANCE_RATE_LIMIT?: string;
}

/**
 * Parse the blocklist into a normalised set. Entries are lowercased and
 * stripped of a leading `.`/`*.`; the suffix semantics are applied at match
 * time so `example.com` also blocks `mastodon.example.com`.
 */
export function parseBlockedDomains(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase().replace(/^\*?\./, ""))
      .filter((d) => d.length > 0),
  );
}

/**
 * True when `domain` is the blocked domain or a subdomain of it.
 *
 * Suffix matching is on LABEL boundaries — `notexample.com` must not be caught
 * by a block on `example.com`.
 */
export function isDomainBlocked(
  domain: string,
  blocked: ReadonlySet<string>,
): boolean {
  if (blocked.size === 0) return false;
  const host = domain.toLowerCase().replace(/\.$/, "");
  for (const entry of blocked) {
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** Extract the instance domain from an actor URI, or null if unparseable. */
export function instanceDomainOf(actorUri: string): string | null {
  try {
    const host = new URL(actorUri).hostname.toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/**
 * Check the per-INSTANCE rate limit using the shared distributed bucket.
 *
 * Keyed by domain rather than actor URI: actor URIs are free to mint, so a
 * per-actor bucket is not a limit on anything an attacker cannot trivially
 * multiply.
 *
 * @param actorUri - Actor URI (only its host is used)
 * @param env - Environment
 * @returns false when the instance has exceeded its ceiling
 * @throws when the limiter cannot be consulted — the caller must fail closed
 */
export async function checkRateLimit(
  actorUri: string,
  env: Env,
): Promise<boolean> {
  const domain = instanceDomainOf(actorUri);
  if (!domain) return false;

  const configured = Number.parseInt(
    (env as AbusePreventionEnv).ACTIVITYPUB_INSTANCE_RATE_LIMIT ?? "",
    10,
  );
  const limit =
    Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_RATE_LIMITS.requestsPerMinute;

  const result = await consumeSharedBucket(
    env as any,
    `${AP_BUCKET_PREFIX}:${domain}`,
    limit,
    60,
  );

  if (!result.allowed) {
    getLogger().warn("[AbusePrevention] Instance rate limit exceeded", {
      domain,
      limit,
      retryAfter: result.retryAfter,
    });
  }

  return result.allowed;
}

/**
 * Detect abusive activity patterns.
 *
 * Currently structural only — the heuristic work (spam scoring, burst
 * detection) is deliberately not invented here. What matters for this change
 * is the FAILURE behaviour: the previous implementation swallowed its own
 * errors and returned `false` (= not abusive = admit). It now signals the
 * failure to the caller by throwing, and the caller fails closed.
 *
 * @param activity - Activity to check
 * @param actorUri - Actor URI
 * @param env - Environment
 * @returns True if the activity appears abusive
 */
export function detectAbuse(
  activity: any,
  actorUri: string,
  env: Env,
): boolean {
  // A malformed activity is not something we should be storing.
  if (!activity || typeof activity !== "object") return true;
  if (typeof activity.type !== "string" || activity.type.length === 0) {
    return true;
  }
  return false;
}

/**
 * Admission check for an inbound federated activity.
 *
 * Order matters: the blocklist is consulted first, so a defederated instance
 * cannot consume rate-limit budget or reach any further logic.
 *
 * @param activity - Activity to validate
 * @param actorUri - Actor URI
 * @param env - Environment
 * @returns Admission decision, with the reason when refused
 */
export async function admitActivity(
  activity: any,
  actorUri: string,
  env: Env,
): Promise<AdmissionResult> {
  const logger = getLogger();

  const domain = instanceDomainOf(actorUri);
  if (!domain) {
    return {
      admitted: false,
      reason: "unresolvable-origin",
      detail: `cannot derive an instance domain from ${actorUri}`,
    };
  }

  // 1. Defederation.
  const blocked = parseBlockedDomains(
    (env as AbusePreventionEnv).ACTIVITYPUB_BLOCKED_DOMAINS,
  );
  if (isDomainBlocked(domain, blocked)) {
    logger.warn("[AbusePrevention] Rejecting activity from blocked instance", {
      domain,
    });
    return { admitted: false, reason: "blocked-instance", detail: domain };
  }

  // 2. Shared, domain-keyed rate limit. A limiter failure is NOT an admission.
  try {
    if (!(await checkRateLimit(actorUri, env))) {
      return { admitted: false, reason: "rate-limited", detail: domain };
    }
  } catch (error) {
    logger.error(
      "[AbusePrevention] Rate-limit check failed — failing CLOSED",
      { domain, error: (error as Error).message },
    );
    return {
      admitted: false,
      reason: "check-failed",
      detail: "rate limiter unavailable",
    };
  }

  // 3. Abuse heuristics. Same rule: an error is a refusal.
  try {
    if (detectAbuse(activity, actorUri, env)) {
      logger.warn("[AbusePrevention] Abusive activity detected", {
        domain,
        activityType: activity?.type,
      });
      return { admitted: false, reason: "abusive", detail: domain };
    }
  } catch (error) {
    logger.error(
      "[AbusePrevention] Abuse detection failed — failing CLOSED",
      { domain, error: (error as Error).message },
    );
    return {
      admitted: false,
      reason: "check-failed",
      detail: "abuse detection unavailable",
    };
  }

  return ADMITTED;
}

/**
 * Boolean wrapper over {@link admitActivity}, kept for existing call sites.
 *
 * @param activity - Activity to validate
 * @param actorUri - Actor URI
 * @param env - Environment
 * @returns True if the activity is safe to admit
 */
export async function validateActivity(
  activity: any,
  actorUri: string,
  env: Env,
): Promise<boolean> {
  return (await admitActivity(activity, actorUri, env)).admitted;
}
