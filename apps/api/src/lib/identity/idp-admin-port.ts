/**
 * The **tenant-federation admin** port (plan 016 WS-2b step 10).
 *
 * This is the surface the tenant IdP handler uses to register a B2B customer's
 * own identity provider with ours — "let this customer's staff sign in through
 * their own corporate directory". It is a different concern from `IdentityProviderPort`
 * (`identity-provider.ts`), which is about *end users* signing in; this one is
 * about the *federation configuration* that makes that possible.
 *
 * ## Why extract it
 *
 * Until now the handler talked to `CognitoIdpSdk` directly, so Cognito's
 * vocabulary — `userPoolId`, `clientId`, `SupportedIdentityProviders` — was
 * spread across an 908-line handler. None of those concepts exist in Keycloak,
 * where a realm's identity-provider instance is a resource in its own right.
 *
 * ## Two deliberate shape changes from the Cognito SDK it replaces
 *
 * **1. No pool/client identifiers in any signature.** Which pool, realm or app
 * client an adapter administers is the adapter's own configuration, resolved
 * once where it is constructed. Passing them per-call is what made the handler
 * read `COGNITO_USER_POOL_ID` in four separate places.
 *
 * **2. Serialization is part of the operation, not a rule callers must follow.**
 * `setProviderEnabled` takes the caller's open transaction so an adapter that
 * needs to serialize can. Cognito does: enabling a provider means
 * read-modify-write on the app client's shared `SupportedIdentityProviders`
 * list, and `UpdateUserPoolClient` is a full replace, so two concurrent
 * connects lose one provider. Keycloak does not: an identity-provider instance
 * is per-realm and independently addressable, with nothing shared to race on.
 *
 * That distinction used to live in the handler, which wrapped every call in
 * `withUserPoolClientLock` — three call sites, each of which had to remember.
 * A missed one is invisible: it works every time until two admins connect an
 * IdP in the same second, and then one tenant's federation silently disappears.
 * Making the lock an invariant of the operation removes the chance to forget,
 * and puts "does this need a lock?" in the adapter that knows the answer.
 */

/** OIDC client credentials for the tenant's own provider. */
export interface OidcProviderDetails {
  clientId: string;
  clientSecret: string;
  issuerUrl: string;
  scopes?: string;
}

/**
 * Maps claims from the tenant's provider onto our user attributes.
 *
 * Keys are OUR attribute names and values are THEIRS, so the concrete key set
 * is provider-shaped (Cognito writes `custom:idpGroups`; a Keycloak realm names
 * its own). Callers should start from [IdpAdminPort.defaultAttributeMapping]
 * rather than hard-coding a key set.
 */
export interface IdpAttributeMapping {
  email: string;
  given_name?: string;
  family_name?: string;
  [key: string]: string | undefined;
}

/**
 * The provider's OIDC endpoints, as discovered — and SSRF-hardened — by
 * `probeOidcIssuer`. Required, not optional: Keycloak's generic `oidc`
 * provider takes explicit endpoint URLs (it does no discovery on create), and
 * an optional field that one adapter silently needs is the dropped-field trap
 * this port exists to avoid. Cognito ignores it (it discovers from
 * `oidc_issuer` itself); requiring it costs the Cognito caller nothing because
 * the handler always probes before creating.
 */
export interface OidcProviderEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

export interface CreateOidcProviderInput {
  /** Our stable name for this tenant's provider. */
  providerName: string;
  details: OidcProviderDetails;
  /** From the issuer probe — see [OidcProviderEndpoints]. */
  endpoints: OidcProviderEndpoints;
  attributeMapping: IdpAttributeMapping;
  /**
   * The tenant's verified email domains. These drive home-realm discovery —
   * "someone@example.org signs in through example.org's IdP" — which is why they are only
   * ever populated from *verified* domains: an unverified one would route
   * another organisation's users into this tenant's provider.
   */
  idpIdentifiers: string[];
}

export interface UpdateOidcProviderInput {
  providerName: string;
  details?: Partial<OidcProviderDetails>;
  attributeMapping?: IdpAttributeMapping;
  idpIdentifiers?: string[];
}

/**
 * The slice of a Prisma transaction client an adapter may use to serialize
 * itself. Deliberately minimal: an adapter gets to take a lock, not to read or
 * write the caller's tables.
 */
export interface AdvisoryLockClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface SetProviderEnabledInput {
  providerName: string;
  enabled: boolean;
  /**
   * The caller's open transaction. Adapters that must serialize this operation
   * take a lock on it; adapters that need not, ignore it. Either way the lock
   * is released when the caller's transaction ends, so a crashed request cannot
   * strand it.
   */
  tx: AdvisoryLockClient;
}

/**
 * Administers tenant-level identity federation.
 *
 * Implementations: `CognitoIdpSdk` (`../cognito/idp-sdk.ts`) and
 * `KeycloakIdpAdmin` (`./keycloak-idp-admin.ts`).
 */
export interface IdpAdminPort {
  /**
   * The attribute mapping to use when the tenant supplies none. Provider-shaped
   * — see [IdpAttributeMapping].
   */
  defaultAttributeMapping(): IdpAttributeMapping;

  createOidcProvider(input: CreateOidcProviderInput): Promise<void>;

  updateOidcProvider(input: UpdateOidcProviderInput): Promise<void>;

  deleteProvider(providerName: string): Promise<void>;

  /** Whether the provider exists. Must not throw when it simply does not. */
  providerExists(providerName: string): Promise<boolean>;

  /**
   * Make the provider selectable (or not) by end users.
   *
   * Separate from create/delete because the two lifecycles differ: a tenant's
   * provider can exist while disabled (configured but not yet live), and
   * disabling is the reversible half of disconnect — deleting is not.
   */
  setProviderEnabled(input: SetProviderEnabledInput): Promise<void>;
}
