/**
 * Fedify Context Setup
 *
 * Creates and configures the Fedify context for Cloudflare Workers.
 * This is the main entry point for Fedify integration.
 */

import { createFederation, type Federation } from "@fedify/fedify";
import type { Env } from "../../../env.js";
import { getFedifyConfig } from "./config.js";
import { getLogger, Logger } from "../../logger.js";

/**
 * Get or create Fedify context for Cloudflare Workers
 *
 * @param env - Cloudflare Workers environment variables
 * @returns Fedify Federation instance configured for Cloudflare Workers
 */
export function getFedifyContext(env: Env): Federation<any> {
  const logger = getLogger();
  const config = getFedifyConfig(env);

  // Fedify automatically detects Cloudflare Workers environment
  // and uses global fetch, crypto, etc.
  const federation = createFederation(config as any);

  logger.debug("[Fedify] Created Federation instance");

  return federation;
}

/**
 * Get base URL for ActivityPub from environment.
 *
 * Canonical URIs are persisted (actor ids, object ids), so they must never be
 * derived from attacker-influenced input. When `ACTIVITYPUB_BASE_URL` is
 * configured it is the ONLY source: neither `requestUrl` (built from the
 * inbound Host header) nor `APP_DOMAIN` can override it (security review L3).
 *
 * When it is unset (federation is off by default; local dev/tests) the legacy
 * order is unchanged: `requestUrl`, then `APP_DOMAIN`, then a placeholder.
 */
export function getActivityPubBaseUrl(env: Env, requestUrl?: string): string {
  // Configured base URL wins outright.
  if (env.ACTIVITYPUB_BASE_URL) {
    try {
      const url = new URL(env.ACTIVITYPUB_BASE_URL);
      return `${url.protocol}//${url.hostname}`;
    } catch {
      // Invalid URL, fall through to the legacy order
    }
  }

  // Use requestUrl first if provided (legacy; only reachable when no valid
  // ACTIVITYPUB_BASE_URL is configured)
  if (requestUrl) {
    try {
      const url = new URL(requestUrl);
      return `${url.protocol}//${url.hostname}`;
    } catch {
      // Invalid URL, fall through
    }
  }

  // Try APP_DOMAIN
  if (env.APP_DOMAIN) {
    try {
      const url = new URL(env.APP_DOMAIN);
      return `${url.protocol}//${url.hostname}`;
    } catch {
      // Invalid URL, fall through
    }
  }

  // Default fallback
  return "https://example.com";
}

/**
 * Path prefixes served only by the federation route sets (see
 * `FEDERATION_ROUTE_SETS` and `MIXED_AP_ROUTE_SETS` in `lib/app.ts`; the
 * authenticated `/api/*` endpoints are deliberately NOT included).
 */
const FEDERATION_PATH_PREFIXES: readonly string[] = [
  "/.well-known/webfinger",
  "/.well-known/nodeinfo",
  "/users/",
  "/groups/",
  "/entities/",
  "/posts/",
  "/messages/",
  "/audiences/",
];

/** True when `pathname` is served by a federation route. Pure. */
export function isFederationPath(pathname: string): boolean {
  // Hono percent-decodes the path before routing, so `/%75sers/x` reaches
  // `/users/:username`. Test the raw AND decoded forms so the gate cannot be
  // sidestepped by encoding a prefix character.
  const candidates = [pathname];
  try {
    candidates.push(decodeURI(pathname));
  } catch {
    // malformed escape: raw form only
  }
  return candidates.some((p) =>
    FEDERATION_PATH_PREFIXES.some((prefix) =>
      prefix.endsWith("/") ? p.startsWith(prefix) : p === prefix || p.startsWith(`${prefix}/`),
    ),
  );
}

/** Lower-cased hostname from a Host header value, or undefined if unparseable. */
function hostnameOfHostHeader(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    const url = new URL(`http://${hostHeader}`);
    // Reject userinfo / path smuggled into the header.
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return undefined;
    }
    return url.hostname.replace(/\.$/, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/** The enforcement policy for federation routes. Built once at boot. */
export interface FederationHostGuard {
  /** Canonical origin (scheme + host + port) that federation requests are rewritten onto. */
  readonly origin: string;
  /** Lower-cased hostnames a federation request may carry in `Host`. */
  readonly allowedHosts: ReadonlySet<string>;
}

/**
 * Build the federation Host guard, or `undefined` when it does not apply
 * (federation disabled, or no usable `ACTIVITYPUB_BASE_URL`). Pure.
 *
 * @param baseUrl - `ACTIVITYPUB_BASE_URL`
 * @param extraHosts - `ACTIVITYPUB_ALLOWED_HOSTS`: comma-separated extra
 *   hostnames, for a proxy that rewrites `Host` (runtime config, default none)
 * @param federationEnabled - `ACTIVITYPUB_ENABLED === "true"`
 */
export function buildFederationHostGuard(
  baseUrl: string | undefined,
  extraHosts: string | undefined,
  federationEnabled: boolean,
): FederationHostGuard | undefined {
  if (!federationEnabled || !baseUrl) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const allowed = new Set<string>([url.hostname.toLowerCase()]);
  for (const raw of (extraHosts ?? "").split(",")) {
    const h = raw.trim().toLowerCase();
    if (h) allowed.add(h);
  }
  return { origin: url.origin, allowedHosts: allowed };
}

/**
 * Decide a request: `{ ok: true, url }` with the URL rebuilt on the canonical
 * origin (never the request's scheme/Host), `{ ok: false }` when a federation
 * route is hit under a Host that is not the configured one (answer 421
 * Misdirected Request), or `{ ok: true, url: undefined }` when the guard does
 * not apply to this request. Pure.
 */
export function applyFederationHostGuard(
  guard: FederationHostGuard | undefined,
  rawUrl: string,
  hostHeader: string | undefined,
):
  | { readonly ok: true; readonly url: URL | undefined }
  | { readonly ok: false; readonly reason: "host-mismatch" } {
  if (!guard) return { ok: true, url: undefined };
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, guard.origin);
  } catch {
    return { ok: true, url: undefined };
  }
  if (!isFederationPath(parsed.pathname)) return { ok: true, url: undefined };
  const host = hostnameOfHostHeader(hostHeader);
  if (!host || !guard.allowedHosts.has(host)) return { ok: false, reason: "host-mismatch" };
  // Absolute-form request targets are ignored: only path + query survive.
  return { ok: true, url: new URL(`${parsed.pathname}${parsed.search}`, guard.origin) };
}
