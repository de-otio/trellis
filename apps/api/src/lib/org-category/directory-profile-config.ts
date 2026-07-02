/**
 * Directory-profile runtime configuration resolver.
 *
 * Shaped like `resolveMediaEnv()` in `env.ts` — reads `NEIGHBORHOOD_*` env
 * vars and returns a typed config object. Wiring this output into the `Env`
 * interface and `buildEnv()` is a Phase 3 integration step; handlers receive
 * the config as a constructor argument so tests can inject arbitrary values
 * without touching `process.env`.
 *
 * Threshold-secrecy convention: the specific numeric default for the
 * NEIGHBORHOOD fuzz radius is NOT documented in a comment here or at any
 * call site — the npm tarball is public and a hardcoded published constant
 * would defeat the fuzz. The default is a safe non-zero value that guarantees
 * NEIGHBORHOOD-precision listings never silently serve exact coordinates when
 * the env var is absent.
 */

export interface DirectoryProfileConfig {
  /**
   * The radius in metres within which a NEIGHBORHOOD-precision tenant's true
   * coordinates are randomly displaced before storage in `displayLat` /
   * `displayLng`. Must be > 0; if the env var is unset or invalid, a safe
   * non-zero fallback is used (never zero, which would mean exact coordinates).
   */
  neighborhoodFuzzMeters: number;
}

// Safe non-zero fallback. Value is load-bearing; not published in comments
// per the threshold-secrecy convention (see CLAUDE.md §"Threshold-secrecy rule").
const _DEFAULT_FUZZ_METERS = 500;

/**
 * Build the directory-profile config from `process.env`.
 *
 * NEIGHBORHOOD_FUZZ_RADIUS_METERS — fuzz radius in metres for NEIGHBORHOOD
 * precision coordinate storage. Defaults to a safe non-zero value if unset,
 * zero, negative, or non-numeric.
 */
export function resolveDirectoryProfileConfig(): DirectoryProfileConfig {
  const raw = Number.parseFloat(process.env.NEIGHBORHOOD_FUZZ_RADIUS_METERS ?? "");
  const neighborhoodFuzzMeters =
    Number.isFinite(raw) && raw > 0 ? raw : _DEFAULT_FUZZ_METERS;
  return { neighborhoodFuzzMeters };
}
