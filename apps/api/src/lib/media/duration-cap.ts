/**
 * Duration cap gate — pure functional core unit.
 *
 * Determines whether a probed media duration exceeds the configured cap.
 * Fail-closed: any input that cannot be verified as a finite non-negative
 * number is treated as "too long" (rejected), so uncertainty never yields a
 * decision to process.
 *
 * Ships in the PUBLIC npm tarball: NO hard-coded operational thresholds here.
 * The cap arrives as a function argument sourced from Env.media.maxDurationSeconds.
 *
 * Pure functional core: no I/O, no clock, no network, no fs. Total over all inputs.
 */

/**
 * Returns `true` when `probedSeconds` exceeds the configured `capSeconds`,
 * meaning the media object is too long to process.
 *
 * Fail-closed boundary conditions:
 * - `probedSeconds` is NaN            => true  (cannot verify length; reject)
 * - `probedSeconds` is ±Infinity      => true  (cannot verify length; reject)
 * - `probedSeconds` is negative       => true  (invalid probe; reject)
 * - `probedSeconds === capSeconds`    => false (exactly at cap is allowed)
 * - `probedSeconds > capSeconds`      => true
 *
 * @param probedSeconds  The duration reported by the media probe (e.g. ffprobe).
 * @param capSeconds     The maximum allowed duration, sourced from Env.media.maxDurationSeconds.
 *                       Never a literal in this file.
 */
export function exceedsDurationCap(
  probedSeconds: number,
  capSeconds: number,
): boolean {
  // Fail closed on any un-verifiable probe value.
  if (!Number.isFinite(probedSeconds) || probedSeconds < 0) {
    return true;
  }

  // Exactly at cap is permitted; strictly over cap is rejected.
  return probedSeconds > capSeconds;
}
