/**
 * Cognito Identity Provider SDK wrapper.
 *
 * The route handler talks to Cognito only through this surface so the
 * Cognito-shaped commands stay in one place and the rollback paths in
 * the route are easier to reason about.
 *
 * Concurrency: `setSupportedIdentityProviders` performs a
 * Describe → mutate → Update sequence which is racy across concurrent
 * connect/disconnect calls. The route handler must wrap the call in a
 * Postgres advisory lock keyed on the user pool id; the helper
 * `withUserPoolClientLock` here implements that pattern.
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

export interface OidcProviderDetails {
  clientId: string;
  clientSecret: string;
  issuerUrl: string;
  scopes?: string;
}

export interface IdpAttributeMapping {
  email: string;
  given_name?: string;
  family_name?: string;
  "custom:idpGroups"?: string;
  [key: string]: string | undefined;
}

export interface CreateOidcProviderInput {
  userPoolId: string;
  providerName: string;
  details: OidcProviderDetails;
  attributeMapping: IdpAttributeMapping;
  idpIdentifiers: string[];
}

export interface UpdateOidcProviderInput {
  userPoolId: string;
  providerName: string;
  details?: Partial<OidcProviderDetails>;
  attributeMapping?: IdpAttributeMapping;
  idpIdentifiers?: string[];
}

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

export class CognitoIdpSdk {
  constructor(private readonly client: CognitoIdentityProviderClient) {}

  async createOidcProvider(input: CreateOidcProviderInput): Promise<void> {
    await this.client.send(
      new CreateIdentityProviderCommand({
        UserPoolId: input.userPoolId,
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
        UserPoolId: input.userPoolId,
        ProviderName: input.providerName,
        ...(providerDetails ? { ProviderDetails: providerDetails } : {}),
        ...(input.attributeMapping
          ? { AttributeMapping: stripUndefined(input.attributeMapping) }
          : {}),
        ...(input.idpIdentifiers ? { IdpIdentifiers: input.idpIdentifiers } : {}),
      }),
    );
  }

  async deleteProvider(userPoolId: string, providerName: string): Promise<void> {
    await this.client.send(
      new DeleteIdentityProviderCommand({
        UserPoolId: userPoolId,
        ProviderName: providerName,
      }),
    );
  }

  async describeProvider(userPoolId: string, providerName: string): Promise<boolean> {
    try {
      await this.client.send(
        new DescribeIdentityProviderCommand({
          UserPoolId: userPoolId,
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
   * Read the app client's current `SupportedIdentityProviders`, mutate the
   * list (add or remove `providerName`), and write it back. UpdateUserPoolClient
   * is a full replace, so we carry the rest of the existing config through.
   *
   * NOT race-safe in isolation. The caller must hold an advisory lock
   * keyed on (userPoolId, clientId).
   */
  async setSupportedIdentityProvider(
    userPoolId: string,
    clientId: string,
    providerName: string,
    op: "add" | "remove",
  ): Promise<void> {
    const desc = await this.client.send(
      new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }),
    );
    const existing = desc.UserPoolClient;
    if (!existing) throw new Error("DescribeUserPoolClient returned no client");

    const current = existing.SupportedIdentityProviders ?? [];
    const set = new Set(current);
    if (op === "add") set.add(providerName);
    else set.delete(providerName);
    const next = Array.from(set);

    await this.client.send(
      new UpdateUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
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
        SupportedIdentityProviders: next,
      }),
    );
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

export interface AdvisoryLockClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
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
