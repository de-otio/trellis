/**
 * Client version policy — parsing, comparison, policy resolution, gate
 * decision, and telemetry shaping (Tier 0 "forced upgrade" mechanism).
 *
 * Everything here is pure except the small telemetry recorder at the bottom
 * (which holds the in-process cardinality state and forwards to an injected
 * `MetricsPort`). No DB, no KV, no network: the whole mechanism is a read of
 * four optional environment variables plus two request headers.
 *
 * WHY A SEPARATE MODULE. Three call sites must agree on the same bounded
 * semver rule — the `/api/app/version-policy` route, the 426 backstop
 * middleware, and the boot-time env validation in `env-schema.ts`. A second
 * spelling of "is this version older than that one" is how a forced-upgrade
 * mechanism ends up locking out the wrong clients.
 *
 * SECURITY / PRIVACY NOTES
 * - The raw `X-Client-Version` header is attacker-controlled. It is
 *   length-capped BEFORE any regex, matched against an anchored, bounded
 *   pattern (never the canonical semver monster), and is NEVER logged and
 *   NEVER used as a metric dimension. Metric dimensions are re-serialized
 *   from the parsed integer triple.
 * - Store URLs are constrained to `https:` on the two official store hosts,
 *   so a mis-set env var can never point clients at an arbitrary origin.
 * - Nothing here is persisted per user or per row (client-metadata rule).
 */

import type { MetricsPort } from "./workers/metrics-port.js";
import { noopMetrics } from "./workers/metrics-port.js";

// ── bounded semver ───────────────────────────────────────────────────────────

/**
 * Hard cap on the raw version string, applied BEFORE the regex. A version is
 * `x.y.z` with at most a short build/pre-release suffix; anything longer is
 * not a version, it is an attempt to make the regex engine work.
 */
export const MAX_CLIENT_VERSION_LENGTH = 64;

/**
 * Anchored, bounded pattern. Each numeric component is capped at four digits
 * and the optional suffix is a single unbounded-but-linear tail (no nested
 * quantifiers, so no catastrophic backtracking). The suffix is IGNORED for
 * comparison: `1.2.3-beta.1` and `1.2.3` compare equal.
 */
const CLIENT_VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})([+-].*)?$/;

/** Control characters are rejected outright (`$` would otherwise allow a trailing newline). */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/** A parsed version. Only the numeric triple survives parsing. */
export interface ClientVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Parse a raw version string. Returns `null` for anything that is not a
 * bounded `x.y.z[+-suffix]`. Never throws, for any input.
 */
export function parseClientVersion(
  raw: string | null | undefined,
): ClientVersion | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_CLIENT_VERSION_LENGTH) return null;
  if (CONTROL_CHAR_RE.test(raw)) return null;

  const match = CLIENT_VERSION_RE.exec(raw);
  if (!match) return null;

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/** Canonical `x.y.z` rendering of a PARSED version (never the raw input). */
export function formatClientVersion(version: ClientVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * Pure three-way comparison. `-1` when `a < b`, `0` when equal, `1` when
 * `a > b`. Suffixes are not part of the parsed value, so they never affect
 * the ordering — an equal triple is EQUAL, which is what keeps a client
 * running exactly the minimum supported version from being locked out.
 */
export function compareClientVersions(
  a: ClientVersion,
  b: ClientVersion,
): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

// ── platform ────────────────────────────────────────────────────────────────

/** The metric-safe platform vocabulary. Anything else collapses to "other". */
export type ClientPlatform = "android" | "ios" | "web" | "other";

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(["android", "ios", "web"]);

/**
 * Coerce the `X-Client-Platform` header to the closed vocabulary. Unbounded
 * caller-supplied strings must never reach a metric dimension.
 */
export function normalizeClientPlatform(
  raw: string | null | undefined,
): ClientPlatform {
  if (typeof raw !== "string") return "other";
  // Cap before lowercasing so a megabyte header is not transformed first.
  if (raw.length > 16) return "other";
  const value = raw.trim().toLowerCase();
  return KNOWN_PLATFORMS.has(value) ? (value as ClientPlatform) : "other";
}

// ── store URLs ──────────────────────────────────────────────────────────────

/**
 * The only hosts a store URL may point at. A forced-upgrade screen is the one
 * place in the app where the user is told "there is nowhere to go but this
 * link", so the link must not be operator-typo-able into an arbitrary origin.
 */
export const ALLOWED_STORE_URL_HOSTS: readonly string[] = [
  "play.google.com",
  "apps.apple.com",
];

/** `true` when `raw` is an `https:` URL on an allow-listed store host. */
export function isAllowedStoreUrl(raw: string | null | undefined): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return false;
  }
  if (CONTROL_CHAR_RE.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_STORE_URL_HOSTS.includes(url.hostname.toLowerCase());
}

// ── policy resolution ───────────────────────────────────────────────────────

/**
 * The environment slice this module reads. Structural, so `env-schema.ts` can
 * validate a raw `process.env` record and the route can pass the built `Env`
 * without either importing the other.
 */
export interface ClientVersionEnv {
  readonly CLIENT_MIN_SUPPORTED_VERSION?: string;
  readonly CLIENT_RECOMMENDED_VERSION?: string;
  readonly CLIENT_STORE_URL_ANDROID?: string;
  readonly CLIENT_STORE_URL_IOS?: string;
}

/** The `/api/app/version-policy` response body. All fields nullable. */
export interface VersionPolicy {
  readonly minimumVersion: string | null;
  readonly recommendedVersion: string | null;
  readonly storeUrls: {
    readonly android: string | null;
    readonly ios: string | null;
  };
}

/**
 * Resolve the served policy from the environment. Boot validation
 * (`env-schema.ts`) already refuses malformed values, so the defensive
 * `null`s here are defense in depth: an unparseable version or a
 * non-allow-listed store URL degrades to "policy unset" (dormant), never to
 * a value clients could act on.
 */
export function resolveVersionPolicy(env: ClientVersionEnv): VersionPolicy {
  const min = parseClientVersion(env.CLIENT_MIN_SUPPORTED_VERSION);
  const recommended = parseClientVersion(env.CLIENT_RECOMMENDED_VERSION);
  return {
    minimumVersion: min ? formatClientVersion(min) : null,
    recommendedVersion: recommended ? formatClientVersion(recommended) : null,
    storeUrls: {
      android: isAllowedStoreUrl(env.CLIENT_STORE_URL_ANDROID)
        ? (env.CLIENT_STORE_URL_ANDROID as string)
        : null,
      ios: isAllowedStoreUrl(env.CLIENT_STORE_URL_IOS)
        ? (env.CLIENT_STORE_URL_IOS as string)
        : null,
    },
  };
}

// ── gate exemptions ─────────────────────────────────────────────────────────

/** Exact paths the 426 gate never applies to. */
const EXEMPT_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/health",
  "/api/app/version-policy",
]);

/**
 * Path prefixes the gate never applies to: host-meta / WebFinger discovery and
 * the public ActivityPub object surface (`/users/*`, `/posts/*`, …). Remote
 * servers are not "clients" and must never be told to visit an app store.
 */
const EXEMPT_PATH_PREFIXES: readonly string[] = [
  "/.well-known/",
  "/users/",
  "/groups/",
  "/posts/",
  "/messages/",
  "/audiences/",
  "/entities/",
];

/** `true` when the 426 backstop must not run for this path. */
export function isVersionGateExemptPath(pathname: string): boolean {
  if (EXEMPT_EXACT_PATHS.has(pathname)) return true;
  return EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// ── gate decision (pure) ────────────────────────────────────────────────────

export interface ClientVersionGateInput {
  readonly method: string;
  readonly pathname: string;
  /** Raw `X-Client-Version` header value, or null when absent. */
  readonly versionHeader: string | null;
  /** Raw `X-Client-Platform` header value, or null when absent. */
  readonly platformHeader: string | null;
  readonly env: ClientVersionEnv;
}

/**
 * Why a request was allowed through — used for log hygiene: the log line
 * carries this token, never the raw header value.
 */
export type GateAllowReason =
  | "exempt-path"
  | "preflight"
  | "policy-unset"
  | "header-absent"
  | "header-invalid"
  | "version-supported";

export type ClientVersionGateDecision =
  | {
      readonly outcome: "allow";
      readonly reason: GateAllowReason;
      /** Present only when the header parsed. */
      readonly version: ClientVersion | null;
      readonly platform: ClientPlatform;
    }
  | {
      readonly outcome: "upgrade-required";
      readonly version: ClientVersion;
      readonly minimum: ClientVersion;
      readonly platform: ClientPlatform;
    };

/**
 * Decide whether a request must be answered with 426. Pure — no logging, no
 * metrics, no env reads beyond the supplied slice.
 *
 * The decision is deliberately conservative: it blocks ONLY when a policy is
 * configured, the header is present, the header parses, and the parsed
 * version is strictly older than the minimum. Everything else (federation
 * traffic, curl, health probes, an equal version, a garbage header) is
 * allowed. The gate never authenticates and never authorizes; it can only
 * turn a request into a 426.
 */
export function evaluateClientVersionGate(
  input: ClientVersionGateInput,
): ClientVersionGateDecision {
  const platform = normalizeClientPlatform(input.platformHeader);

  // CORS preflights must always succeed — an outdated web client still has to
  // learn it is outdated, and a browser that cannot preflight sees only an
  // opaque network error.
  if (input.method === "OPTIONS") {
    return { outcome: "allow", reason: "preflight", version: null, platform };
  }
  if (isVersionGateExemptPath(input.pathname)) {
    return { outcome: "allow", reason: "exempt-path", version: null, platform };
  }

  const minimum = parseClientVersion(input.env.CLIENT_MIN_SUPPORTED_VERSION);
  if (!minimum) {
    return { outcome: "allow", reason: "policy-unset", version: null, platform };
  }

  if (input.versionHeader === null) {
    return { outcome: "allow", reason: "header-absent", version: null, platform };
  }

  const version = parseClientVersion(input.versionHeader);
  if (!version) {
    return { outcome: "allow", reason: "header-invalid", version: null, platform };
  }

  if (compareClientVersions(version, minimum) < 0) {
    return { outcome: "upgrade-required", version, minimum, platform };
  }
  return { outcome: "allow", reason: "version-supported", version, platform };
}

// ── 426 body ────────────────────────────────────────────────────────────────

/**
 * The 426 body. Carries NO URL: a client must never navigate to a link handed
 * to it by an error response — the store link is compiled into the client (or
 * taken from the allow-listed `storeUrls` of the policy endpoint).
 */
export const UPGRADE_REQUIRED_BODY = {
  error: "UPGRADE_REQUIRED",
  message: "This app version is no longer supported.",
  remediation:
    "Update the app to the latest version from your device's official app store, then retry.",
} as const;

// ── telemetry ───────────────────────────────────────────────────────────────

/** Metric names. Alert/dashboard rules key off these strings. */
export const CLIENT_VERSION_METRICS = {
  /** One increment per request carrying a parseable client version. */
  seen: "client.version.seen",
  /** One increment per request refused with 426. */
  upgradeRequired: "client.upgrade_required",
} as const;

/**
 * Default cap on DISTINCT version dimension values per process. Beyond it,
 * further unseen versions are bucketed to "other" so a caller cannot inflate
 * the metrics backend's cardinality by iterating version strings. Not a
 * security threshold (nothing is enforced on it) — a cost guard.
 */
export const DEFAULT_MAX_VERSION_DIMENSIONS = 100;

/**
 * Cardinality-capped recorder. Dimensions are built ONLY from the parsed
 * triple and the coerced platform, so no attacker-controlled string ever
 * reaches the metrics backend.
 */
export class ClientVersionTelemetry {
  private readonly seenVersions = new Set<string>();

  constructor(
    private readonly metrics: MetricsPort,
    private readonly maxDistinctVersions: number = DEFAULT_MAX_VERSION_DIMENSIONS,
  ) {}

  /** The dimension value this recorder would use for a parsed version. */
  dimensionFor(version: ClientVersion): string {
    const serialized = formatClientVersion(version);
    if (this.seenVersions.has(serialized)) return serialized;
    if (this.seenVersions.size >= this.maxDistinctVersions) return "other";
    this.seenVersions.add(serialized);
    return serialized;
  }

  /**
   * Record one observation. `blocked` adds the upgrade-required counter to the
   * same metric blob (one dimension set = one blob, per the MetricsPort
   * contract). Fail-open: a metrics error never affects the request.
   */
  record(
    version: ClientVersion,
    platform: ClientPlatform,
    blocked: boolean,
  ): void {
    try {
      const dimensions = {
        clientVersion: this.dimensionFor(version),
        clientPlatform: platform,
      };
      const metrics = blocked
        ? [
            { name: CLIENT_VERSION_METRICS.seen, value: 1 },
            { name: CLIENT_VERSION_METRICS.upgradeRequired, value: 1 },
          ]
        : [{ name: CLIENT_VERSION_METRICS.seen, value: 1 }];
      this.metrics.emitCounts(dimensions, metrics);
    } catch {
      // Metrics are never load-bearing.
    }
  }

  /** Distinct versions currently held (test/introspection aid). */
  get distinctVersionCount(): number {
    return this.seenVersions.size;
  }
}

/**
 * Process-wide recorder. Defaults to the no-op port: the API container has no
 * MetricsPort wired yet (see `lib/metrics/README.md`), so an operator opts in
 * by calling {@link configureClientVersionTelemetry} from the composition
 * root once an adapter exists.
 */
let activeTelemetry = new ClientVersionTelemetry(noopMetrics);

/** Install a metrics port (and optionally a different cardinality cap). */
export function configureClientVersionTelemetry(
  metrics: MetricsPort,
  maxDistinctVersions: number = DEFAULT_MAX_VERSION_DIMENSIONS,
): void {
  activeTelemetry = new ClientVersionTelemetry(metrics, maxDistinctVersions);
}

/** Emit for a gate decision. No-op unless the header parsed. */
export function recordClientVersionDecision(
  decision: ClientVersionGateDecision,
): void {
  if (decision.outcome === "upgrade-required") {
    activeTelemetry.record(decision.version, decision.platform, true);
    return;
  }
  if (decision.version) {
    activeTelemetry.record(decision.version, decision.platform, false);
  }
}
