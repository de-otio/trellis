/**
 * Directory-search runtime configuration (standalone resolver module).
 *
 * Shaped like `resolveMediaEnv()` in `env.ts`: reads every operational
 * threshold from `process.env` with a conservative safe default, so that no
 * abuse-limit constant is compiled into the published npm tarball (CLAUDE.md
 * rule 8 — threshold-secrecy: "the npm tarball is public, so a hard-coded
 * threshold is a published threshold"). Handlers/executors receive a resolved
 * `DirectorySearchConfig` and never read `process.env` themselves.
 *
 * Wiring this resolver's output into the `Env` interface / `buildEnv()` in
 * `env.ts` is a Phase 3 integration step (see the plan's "Grounding" note on
 * `env.ts` being a shared-file barrier). Until then `getDirectorySearchConfig()`
 * reads `env.directorySearch` if present and otherwise falls back to resolving
 * directly, so this task does not have to edit `env.ts`.
 *
 * The concrete pagination minimums (max page size, max page depth) are fixed by
 * the implementation plan and are safe *minimums* — tunable strictly upward via
 * the env vars below, never a bare literal in the query code. A broad filter
 * (e.g. category=business) combined with a large page size is a near-complete
 * directory scrape even under rate limiting, so these bounds are the load-bearing
 * anti-enumeration guard (security review S18), not cosmetic.
 */

/** Resolved directory-search configuration consumed by the search executor + route. */
export interface DirectorySearchConfig {
  /**
   * Minimum trigram query length enforced at the API boundary before a name
   * query reaches Postgres (S10). `pg_trgm` similarity is meaningless below
   * trigram length and short queries generate disproportionately large GIN
   * candidate sets.
   */
  minQueryLength: number;
  /** Maximum results returned per page ("tens, not hundreds" — S18). */
  maxPageSize: number;
  /**
   * Maximum reachable page index count (a hard ceiling on cumulative
   * extraction). Valid page indices are `0 .. maxPageDepth - 1`.
   */
  maxPageDepth: number;
  /**
   * Upper bound (metres) on a location-radius query window. A caller may request
   * a smaller radius; anything above this (or an omitted radius) is clamped to
   * it, so no request can trigger an unbounded-radius scan.
   */
  maxRadiusMeters: number;
  /**
   * Postgres `statement_timeout` (ms) applied to the search query as a
   * defense-in-depth backstop against an expensive plan surviving the
   * query-shape limits (S10/S18). Runtime config, never hardcoded at the
   * call site.
   */
  statementTimeoutMs: number;
  /** Per-user rate-limit ceiling (requests) over `rateLimitWindowSeconds`. */
  rateLimit: number;
  /** Rate-limit window in seconds. */
  rateLimitWindowSeconds: number;
}

/** Parse a positive integer env var, falling back to a safe default. */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve directory-search config from `process.env`. Mirrors
 * `resolveMediaEnv()`'s `{ <namespace>: {...} }` return shape so Phase 3 can
 * spread it straight into `buildEnv()`.
 *
 * Defaults are the plan-mandated safe minimums (max page size, max page depth)
 * plus conservative dev-safe values for the timeout/rate-limit backstops; the
 * operative production values are injected per-environment via the env vars,
 * so no operational ceiling is baked into `dist/`.
 */
export function resolveDirectorySearchEnv(): { directorySearch: DirectorySearchConfig } {
  return {
    directorySearch: {
      minQueryLength: parsePositiveInt(process.env.DIRECTORY_SEARCH_MIN_QUERY_LENGTH, 3),
      maxPageSize: parsePositiveInt(process.env.DIRECTORY_SEARCH_MAX_PAGE_SIZE, 25),
      maxPageDepth: parsePositiveInt(process.env.DIRECTORY_SEARCH_MAX_PAGE_DEPTH, 40),
      maxRadiusMeters: parsePositiveInt(process.env.DIRECTORY_SEARCH_MAX_RADIUS_METERS, 50000),
      statementTimeoutMs: parsePositiveInt(process.env.DIRECTORY_SEARCH_STATEMENT_TIMEOUT_MS, 5000),
      rateLimit: parsePositiveInt(process.env.DIRECTORY_SEARCH_RATE_LIMIT, 30),
      rateLimitWindowSeconds: parsePositiveInt(process.env.DIRECTORY_SEARCH_RATE_WINDOW_SECONDS, 60),
    },
  };
}

/**
 * Read the directory-search config, preferring an already-wired
 * `env.directorySearch` (Phase 3) and otherwise resolving directly. Lets the
 * route/executor stay agnostic to whether `env.ts` wiring has landed yet.
 */
export function getDirectorySearchConfig(env: unknown): DirectorySearchConfig {
  const wired = (env as { directorySearch?: DirectorySearchConfig } | null | undefined)?.directorySearch;
  if (wired) return wired;
  return resolveDirectorySearchEnv().directorySearch;
}
