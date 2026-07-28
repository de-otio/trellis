/**
 * Boot-time guard for the scheduled-deletion (nightly) cron (plan 015 WS-B).
 *
 * The nightly GDPR-deletion core deletes external identities *best-effort* and
 * SILENTLY skips that step when `ctx.identity` is absent (nightly-cron.ts step
 * 4c). So enabling the cron with an unwired identity port erases the DB row
 * while leaving the Keycloak/Cognito user behind — a partial GDPR deletion,
 * invisible at runtime. This guard makes that a BOOT failure instead: the
 * container crash-loops (and alarms) rather than quietly under-deleting.
 *
 * Contract:
 *   - nightly DISABLED (parked via WORKER_DISABLED_CRONS): no requirement —
 *     the cron will not run, so absent ports are fine.
 *   - nightly ENABLED + identity absent ⇒ THROW (fail closed).
 *   - nightly ENABLED + email absent ⇒ WARN only. Email is a completion
 *     *confirmation*, not part of the erasure — a missing sender does not make
 *     the deletion partial (the core already treats it as best-effort).
 */

export interface NightlyPortsGuardInput {
  /** True when the nightly cron will actually be scheduled this run. */
  readonly nightlyEnabled: boolean;
  /** The resolved identity-admin port (undefined ⇒ external identity not deleted). */
  readonly identity: unknown;
  /** The resolved deletion-email port (undefined ⇒ no confirmation email). */
  readonly email: unknown;
  readonly logger: { warn: (message: string, data?: unknown) => void };
}

export function assertNightlyPortsWired(input: NightlyPortsGuardInput): void {
  if (!input.nightlyEnabled) return;

  if (input.identity === undefined || input.identity === null) {
    throw new Error(
      "nightly deletion cron is enabled but the identity-admin port is unwired: " +
        "external identities would NOT be deleted (silent partial GDPR deletion). " +
        "Park it via WORKER_DISABLED_CRONS=nightly or configure the identity provider " +
        "(IDENTITY_PROVIDER + its required vars).",
    );
  }

  if (input.email === undefined || input.email === null) {
    input.logger.warn(
      "nightly deletion cron is enabled but the deletion-email port is unwired: " +
        "account-deletion confirmation emails will NOT be sent (deletion still completes). " +
        "Set EMAIL_SERVICE + FROM_EMAIL (and the provider's vars) to enable them.",
    );
  }
}
