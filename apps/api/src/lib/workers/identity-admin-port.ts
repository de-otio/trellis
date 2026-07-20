/**
 * IdentityAdminPort — the narrow admin slice of the identity port (X6,
 * resolved by WS-3.3).
 *
 * Originally WS-2's PROVISIONAL one-method port; WS-3.3 absorbed it into the
 * full `IdentityProviderPort` (`@de-otio/saas-foundation/identity`), which is
 * a structural superset — every implementation of the full port satisfies
 * this slice unchanged.
 *
 * This narrow interface stays deliberately: the WS-2 worker contexts depend
 * on it (not the full port) so the secret-blast-radius rule holds — a worker
 * whose `Pick<WorkerContext, …>` includes `identity` gains ONLY external
 * identity deletion, never magic-link initiation. Wiring goes through
 * `lib/identity/identity-provider.ts` (`makeIdentityAdminPort`,
 * `IDENTITY_PROVIDER` selection, default cognito). Do NOT grow this
 * interface; add capabilities on the foundation port instead.
 */
export interface IdentityAdminPort {
  /**
   * Delete the external identity for a user. Best-effort at the call sites
   * that swallow failure (delete-account §1.1); throwing is the caller's
   * choice.
   */
  deleteUser(input: { readonly email: string }): Promise<void>;
}
