/**
 * Cognito adapter for [IdpAdminPort] — tenant-level identity federation.
 *
 * Holds the user pool and app client it administers, so no Cognito identifier
 * appears in the port's signatures. See `../identity/idp-admin-port.ts` for why
 * the port is shaped the way it is.
 */
import {
  CognitoIdentityProviderClient,
  CreateIdentityProviderCommand,
  UpdateIdentityProviderCommand,
  DeleteIdentityProviderCommand,
  DescribeIdentityProviderCommand,
  DescribeUserPoolClientCommand,
  UpdateUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { TenantRole } from "@prisma/client";

import type {
  AdvisoryLockClient,
  CreateOidcProviderInput,
  IdpAdminPort,
  IdpAttributeMapping,
  OidcProviderDetails,
  SetProviderEnabledInput,
  UpdateOidcProviderInput,
} from "../identity/idp-admin-port.js";

export type {
  AdvisoryLockClient,
  CreateOidcProviderInput,
  IdpAttributeMapping,
  OidcProviderDetails,
  UpdateOidcProviderInput,
};

/** Default attribute mapping per 04-cognito-federation.md §attribute-mapping. */
export function defaultOidcAttributeMapping(): IdpAttributeMapping {
  return {
    email: "email",
    given_name: "given_name",
    family_name: "family_name",
    "custom:idpGroups": "groups",
  };
}

function buildOidcProviderDetails(d: OidcProviderDetails): Record<string, string> {
  const out: Record<string, string> = {
    client_id: d.clientId,
    client_secret: d.clientSecret,
    oidc_issuer: d.issuerUrl,
    attributes_request_method: "GET",
    authorize_scopes: d.scopes ?? "openid email profile groups",
  };
  return out;
}

export interface CognitoIdpSdkConfig {
  userPoolId: string;
  /** The app client whose `SupportedIdentityProviders` list gates sign-in. */
  appClientId: string;
}

export class CognitoIdpSdk implements IdpAdminPort {
  constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly config: CognitoIdpSdkConfig,
  ) {}

  defaultAttributeMapping(): IdpAttributeMapping {
    return defaultOidcAttributeMapping();
  }

  async createOidcProvider(input: CreateOidcProviderInput): Promise<void> {
    await this.client.send(
      new CreateIdentityProviderCommand({
        UserPoolId: this.config.userPoolId,
        ProviderName: input.providerName,
        ProviderType: "OIDC",
        ProviderDetails: buildOidcProviderDetails(input.details),
        AttributeMapping: stripUndefined(input.attributeMapping),
        IdpIdentifiers: input.idpIdentifiers,
      }),
    );
  }

  async updateOidcProvider(input: UpdateOidcProviderInput): Promise<void> {
    const providerDetails = input.details
      ? buildOidcProviderDetailsPartial(input.details)
      : undefined;
    await this.client.send(
      new UpdateIdentityProviderCommand({
        UserPoolId: this.config.userPoolId,
        ProviderName: input.providerName,
        ...(providerDetails ? { ProviderDetails: providerDetails } : {}),
        ...(input.attributeMapping
          ? { AttributeMapping: stripUndefined(input.attributeMapping) }
          : {}),
        ...(input.idpIdentifiers ? { IdpIdentifiers: input.idpIdentifiers } : {}),
      }),
    );
  }

  async deleteProvider(providerName: string): Promise<void> {
    await this.client.send(
      new DeleteIdentityProviderCommand({
        UserPoolId: this.config.userPoolId,
        ProviderName: providerName,
      }),
    );
  }

  async providerExists(providerName: string): Promise<boolean> {
    try {
      await this.client.send(
        new DescribeIdentityProviderCommand({
          UserPoolId: this.config.userPoolId,
          ProviderName: providerName,
        }),
      );
      return true;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "ResourceNotFoundException") return false;
      throw err;
    }
  }

  /**
   * Read the app client's current `SupportedIdentityProviders`, mutate the list,
   * and write it back — under an advisory lock, because this is a
   * read-modify-write on state shared by every tenant.
   *
   * `UpdateUserPoolClient` is a **full replace**, so two admins connecting an
   * IdP concurrently would each write a list computed before the other's, and
   * one tenant's federation would vanish with no error anywhere. The lock is
   * taken inside this method rather than left to callers precisely so that
   * cannot be forgotten.
   *
   * The rest of the existing client config is carried through explicitly for
   * the same reason: anything omitted is *cleared*.
   */
  async setProviderEnabled(input: SetProviderEnabledInput): Promise<void> {
    await withUserPoolClientLock(input.tx, this.config.userPoolId, async () => {
      const desc = await this.client.send(
        new DescribeUserPoolClientCommand({
          UserPoolId: this.config.userPoolId,
          ClientId: this.config.appClientId,
        }),
      );
      const existing = desc.UserPoolClient;
      if (!existing) throw new Error("DescribeUserPoolClient returned no client");

      const set = new Set(existing.SupportedIdentityProviders ?? []);
      if (input.enabled) set.add(input.providerName);
      else set.delete(input.providerName);

      await this.client.send(
        new UpdateUserPoolClientCommand({
          UserPoolId: this.config.userPoolId,
          ClientId: this.config.appClientId,
          ClientName: existing.ClientName,
          AccessTokenValidity: existing.AccessTokenValidity,
          IdTokenValidity: existing.IdTokenValidity,
          RefreshTokenValidity: existing.RefreshTokenValidity,
          TokenValidityUnits: existing.TokenValidityUnits,
          ReadAttributes: existing.ReadAttributes,
          WriteAttributes: existing.WriteAttributes,
          ExplicitAuthFlows: existing.ExplicitAuthFlows,
          AllowedOAuthFlows: existing.AllowedOAuthFlows,
          AllowedOAuthScopes: existing.AllowedOAuthScopes,
          AllowedOAuthFlowsUserPoolClient: existing.AllowedOAuthFlowsUserPoolClient,
          CallbackURLs: existing.CallbackURLs,
          LogoutURLs: existing.LogoutURLs,
          DefaultRedirectURI: existing.DefaultRedirectURI,
          PreventUserExistenceErrors: existing.PreventUserExistenceErrors,
          EnableTokenRevocation: existing.EnableTokenRevocation,
          EnablePropagateAdditionalUserContextData:
            existing.EnablePropagateAdditionalUserContextData,
          AuthSessionValidity: existing.AuthSessionValidity,
          SupportedIdentityProviders: Array.from(set),
        }),
      );
    });
  }
}

function buildOidcProviderDetailsPartial(d: Partial<OidcProviderDetails>): Record<string, string> {
  const out: Record<string, string> = {};
  if (d.clientId) out.client_id = d.clientId;
  if (d.clientSecret) out.client_secret = d.clientSecret;
  if (d.issuerUrl) out.oidc_issuer = d.issuerUrl;
  if (d.scopes) out.authorize_scopes = d.scopes;
  if (Object.keys(out).length > 0) out.attributes_request_method = "GET";
  return out;
}

function stripUndefined(map: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Stable 64-bit advisory-lock key derived from the user pool id. Postgres
 * `pg_advisory_xact_lock(bigint)` is used so the lock is auto-released at
 * transaction end. We only need a single number — collisions on different
 * pool ids would just mean false serialization, which is fine.
 *
 * **Cognito-specific, and deliberately not part of [IdpAdminPort].** It exists
 * because Cognito has one shared, wholesale-replaced provider list per app
 * client. A provider with independently addressable per-tenant resources needs
 * no equivalent — see the port doc.
 */
export function userPoolAdvisoryLockKey(userPoolId: string): bigint {
  let h = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  for (let i = 0; i < userPoolId.length; i++) {
    h = (h ^ BigInt(userPoolId.charCodeAt(i))) & MASK;
    h = (h * PRIME) & MASK;
  }
  if (h >= 0x8000000000000000n) h = h - 0x10000000000000000n;
  return h;
}

/**
 * Run `fn` while holding a Postgres advisory lock keyed on the user pool id.
 * Lock is released at the end of the wrapping transaction; the caller passes
 * the inner `tx` from `prisma.$transaction((tx) => ...)`.
 */
export async function withUserPoolClientLock<T>(
  tx: AdvisoryLockClient,
  userPoolId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = userPoolAdvisoryLockKey(userPoolId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;
  return fn();
}

/** Mapper for tests; the route catalog references this for typing. */
export type IdpDefaultRole = TenantRole | null;
