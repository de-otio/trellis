/**
 * IdentityAdminPort — PROVISIONAL one-method admin port (WS-2 §1.0, X6).
 *
 * WS-3.3 will introduce the full `IdentityProviderPort`; it is unwritten, so
 * WS-2 defines the minimal slice the extracted workers need today
 * (delete-account, nightly-cron, and e2e-sweeper delete external identities).
 *
 * The AWS entrypoints inject a Cognito-backed implementation (wrapping
 * `AdminDeleteUserCommand`); the worker container injects the same today.
 * When WS-3.3 lands, this port is either absorbed into `IdentityProviderPort`
 * or kept as its narrow admin slice — a WS-3.3 decision, flagged in that plan.
 * Keeping it one method now means the WS-3.3 merge is a rename, not a
 * redesign. Do NOT grow this interface here.
 */
export interface IdentityAdminPort {
  /**
   * Delete the external identity for a user. Best-effort at the call sites
   * that swallow failure (delete-account §1.1); throwing is the caller's
   * choice.
   */
  deleteUser(input: { readonly email: string }): Promise<void>;
}
