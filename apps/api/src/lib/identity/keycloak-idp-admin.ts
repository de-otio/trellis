/**
 * Keycloak adapter for [IdpAdminPort] — tenant federation via **Organizations**
 * (plan 016 WS-2b step 11).
 *
 * ## Why an organization per tenant, not just an IdP instance
 *
 * A core Keycloak OIDC identity provider has **no email-domain field**, so a
 * bare IdP instance gives no home-realm discovery — B2B users would pick their
 * employer's provider from a list. Organizations are the native equivalent of
 * the domain list Cognito attaches to a provider: the organization carries
 * `domains` and the provider is linked to it, after which the login flow can
 * route `someone@example.org` to that organization's provider automatically
 * (redirect mode `kc.org.broker.redirect.mode.email-matches`).
 *
 * So one tenant maps to a PAIR of realm resources sharing the provider name as
 * their alias:
 *
 * ```
 *   providerName ─┬─► identity-provider instance  (the OIDC client half)
 *                 └─► organization                (verified domains; the link)
 * ```
 *
 * ## Wire contract — verified against the Keycloak 26.6.3 tag's source
 *
 * Every path, representation field and config key below was checked against
 * the deployed version's own source (AGENTS.md golden rule 7), not recalled:
 *
 *  - IdP CRUD: `/admin/realms/{realm}/identity-provider/instances[/{alias}]`
 *    (singular `identity-provider`; confirmed live — 403 with a scoped token,
 *    404 only for a genuinely absent path).
 *  - Organizations: `POST/GET /admin/realms/{realm}/organizations`,
 *    `PUT/DELETE …/organizations/{id}`. `OrganizationRepresentation`:
 *    `{name, alias, enabled, domains: [{name, verified}]}`.
 *  - Linking: `POST …/organizations/{id}/identity-providers` with the
 *    provider **alias as the JSON body** (`OrganizationIdentityProvidersResource
 *    .addIdentityProvider(String id)`, `@Consumes(APPLICATION_JSON)`) — not a
 *    path segment.
 *  - OIDC config keys: `clientId`, `clientSecret`, `authorizationUrl`,
 *    `tokenUrl`, `defaultScope` (OAuth2IdentityProviderConfig), `jwksUrl`,
 *    `useJwksUrl`, `validateSignature` (OIDCIdentityProviderConfig), `issuer`
 *    (IdentityProviderModel.ISSUER).
 *  - Mappers: `POST …/identity-provider/instances/{alias}/mappers`,
 *    `identityProviderMapper: "oidc-user-attribute-idp-mapper"`
 *    (UserAttributeMapper.PROVIDER_ID), config `{claim, "user.attribute",
 *    syncMode}`.
 *
 * ## This adapter never fetches admin-supplied URLs
 *
 * The tenant's issuer endpoints arrive via `CreateOidcProviderInput.endpoints`,
 * i.e. from `probeOidcIssuer` — the one SSRF-hardened egress path for
 * admin-supplied URLs (T5). Doing discovery here instead would open a second,
 * unhardened fetch of an attacker-influenced URL from inside the API.
 *
 * ## No lock — and that is the point of the port
 *
 * Cognito's adapter serializes `setProviderEnabled` because it read-modify-
 * writes one shared list. Here a provider's `enabled` flag is a field on its
 * own resource; there is nothing shared to race on, so the caller's `tx` is
 * accepted and ignored, exactly as the port documents.
 *
 * ## Roles this needs (documented, NOT granted by default)
 *
 * `manage-identity-providers` — and, on Keycloak < 26.7, organization
 * administration additionally requires `manage-realm` (verified: 26.6.3's
 * AdminRoles has no narrower organization role; 26.7.0 added fine-grained
 * permissions for Organizations). See dot-identity `tofu/realm`'s
 * `api_manages_identity_providers` / `organizations_enabled` toggles. Until
 * those are granted, every call here fails with `unauthorized` — visibly, as
 * a 502 from the handler, never by silently skipping work.
 */
import type {
  AdvisoryLockClient,
  CreateOidcProviderInput,
  IdpAdminPort,
  IdpAttributeMapping,
  SetProviderEnabledInput,
  UpdateOidcProviderInput,
} from "./idp-admin-port.js";

// Re-exported so the config type is nameable without importing the port file.
export type { AdvisoryLockClient };

export class KeycloakIdpAdminError extends Error {
  constructor(
    readonly code: "unauthorized" | "config_missing" | "provider_error" | "not_found",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "KeycloakIdpAdminError";
  }
}

export interface KeycloakIdpAdminConfig {
  /** Keycloak base URL, e.g. `https://id.example.test` (no `/realms/...`). */
  baseUrl: string;
  realm: string;
  /** Service-account (client_credentials) client — see the roles note above. */
  adminClientId: string;
  adminClientSecret: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

/** Small safety margin so a token is never used in its final seconds. */
const TOKEN_SKEW_MS = 10_000;

interface OrgDomain {
  name: string;
  verified: boolean;
}

interface OrgRepresentation {
  id?: string;
  name: string;
  alias: string;
  enabled: boolean;
  domains: OrgDomain[];
}

export class KeycloakIdpAdmin implements IdpAdminPort {
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: KeycloakIdpAdminConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    if (!cfg.baseUrl || !cfg.realm || !cfg.adminClientId || !cfg.adminClientSecret) {
      throw new KeycloakIdpAdminError(
        "config_missing",
        "KeycloakIdpAdmin requires baseUrl, realm, adminClientId and adminClientSecret",
      );
    }
  }

  /**
   * Keycloak-shaped default mapping. Keys are OUR user attribute names —
   * `firstName`/`lastName` are Keycloak's user properties, where Cognito used
   * the claim names themselves, and the group list lands on `idpGroups`
   * (no `custom:` prefix; that is Cognito's namespace convention, meaningless
   * here). Values are the tenant IdP's claim names, same as Cognito's default.
   */
  defaultAttributeMapping(): IdpAttributeMapping {
    return {
      email: "email",
      firstName: "given_name",
      lastName: "family_name",
      idpGroups: "groups",
    };
  }

  // ── port operations ────────────────────────────────────────────────────────

  /**
   * Creates the pair: IdP instance (disabled — the handler enables it under
   * its own transaction, mirroring the Cognito sequence), organization with
   * the verified domains, the org→IdP link, and one mapper per attribute.
   *
   * Not atomic — Keycloak has no multi-resource transaction. On any failure
   * the handler's existing rollback calls [deleteProvider], which is written
   * to clean up whatever subset exists (every delete tolerates 404), so a
   * half-created pair cannot leak.
   */
  async createOidcProvider(input: CreateOidcProviderInput): Promise<void> {
    const alias = input.providerName;

    await this.request("POST", `/identity-provider/instances`, {
      alias,
      displayName: alias,
      providerId: "oidc",
      enabled: false,
      config: {
        clientId: input.details.clientId,
        clientSecret: input.details.clientSecret,
        issuer: input.details.issuerUrl,
        authorizationUrl: input.endpoints.authorizationUrl,
        tokenUrl: input.endpoints.tokenUrl,
        jwksUrl: input.endpoints.jwksUrl,
        useJwksUrl: "true",
        validateSignature: "true",
        defaultScope: input.details.scopes ?? "openid email profile",
      },
    });

    // Domains only ever come from the handler's VERIFIED set — an unverified
    // domain routing another organisation's users into this tenant's provider
    // is the failure this flag exists to prevent — so they are asserted
    // verified here too.
    const org = await this.request<OrgRepresentation>("POST", `/organizations`, {
      name: alias,
      alias,
      enabled: true,
      domains: input.idpIdentifiers.map((d) => ({ name: d, verified: true })),
    });

    // POST body is the bare alias, as a JSON string — see the wire contract.
    const orgId = org?.id ?? (await this.findOrgIdByAlias(alias));
    await this.request("POST", `/organizations/${orgId}/identity-providers`, alias);

    for (const [ourAttribute, theirClaim] of Object.entries(input.attributeMapping)) {
      if (typeof theirClaim !== "string" || theirClaim.length === 0) continue;
      await this.request("POST", `/identity-provider/instances/${alias}/mappers`, {
        name: `attr-${ourAttribute}`,
        identityProviderAlias: alias,
        identityProviderMapper: "oidc-user-attribute-idp-mapper",
        config: {
          claim: theirClaim,
          "user.attribute": ourAttribute,
          // FORCE re-syncs on every login, matching Cognito, which maps
          // attributes on each federation. IMPORT (the default) maps only the
          // first login — a user whose email changes at their employer would
          // silently keep the stale one here.
          syncMode: "FORCE",
        },
      });
    }
  }

  async updateOidcProvider(input: UpdateOidcProviderInput): Promise<void> {
    const alias = input.providerName;

    if (input.details) {
      // PUT replaces the representation, so read-merge-write.
      const current = await this.request<{ config?: Record<string, string> }>(
        "GET",
        `/identity-provider/instances/${alias}`,
      );
      if (!current) {
        throw new KeycloakIdpAdminError("not_found", `identity provider ${alias} not found`, 404);
      }
      const config = { ...(current.config ?? {}) };
      if (input.details.clientId) config.clientId = input.details.clientId;
      if (input.details.clientSecret) config.clientSecret = input.details.clientSecret;
      if (input.details.issuerUrl) config.issuer = input.details.issuerUrl;
      if (input.details.scopes) config.defaultScope = input.details.scopes;
      await this.request("PUT", `/identity-provider/instances/${alias}`, {
        ...current,
        config,
      });
    }

    if (input.attributeMapping) {
      await this.upsertMappers(alias, input.attributeMapping);
    }

    if (input.idpIdentifiers) {
      const orgId = await this.findOrgIdByAlias(alias);
      const org = await this.request<OrgRepresentation>("GET", `/organizations/${orgId}`);
      await this.request("PUT", `/organizations/${orgId}`, {
        ...org,
        domains: input.idpIdentifiers.map((d) => ({ name: d, verified: true })),
      });
    }
  }

  /**
   * Removes BOTH halves of the pair, IdP first. Each delete tolerates 404 so
   * this is safe as the rollback for a partially-failed create and idempotent
   * under handler retries. Deleting the organization matters as much as the
   * provider: a surviving org keeps claiming its email domains and routes
   * sign-ins at a provider that no longer exists.
   */
  async deleteProvider(providerName: string): Promise<void> {
    await this.requestTolerating404("DELETE", `/identity-provider/instances/${providerName}`);
    const orgId = await this.findOrgIdByAlias(providerName, { tolerateMissing: true });
    if (orgId) await this.requestTolerating404("DELETE", `/organizations/${orgId}`);
  }

  async providerExists(providerName: string): Promise<boolean> {
    const res = await this.rawRequest("GET", `/identity-provider/instances/${providerName}`);
    if (res.status === 404) return false;
    if (!res.ok) throw await this.errorFrom(res, "describe identity provider");
    return true;
  }

  /**
   * Flips `enabled` on the provider's own representation. `input.tx` is
   * ignored: this is a single-resource update with nothing shared to race on —
   * see the class doc, and the port's contract for why that is the adapter's
   * call to make.
   */
  async setProviderEnabled(input: SetProviderEnabledInput): Promise<void> {
    const alias = input.providerName;
    const current = await this.request<{ enabled?: boolean }>(
      "GET",
      `/identity-provider/instances/${alias}`,
    );
    if (!current) {
      throw new KeycloakIdpAdminError("not_found", `identity provider ${alias} not found`, 404);
    }
    await this.request("PUT", `/identity-provider/instances/${alias}`, {
      ...current,
      enabled: input.enabled,
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async upsertMappers(alias: string, mapping: IdpAttributeMapping): Promise<void> {
    const existing =
      (await this.request<Array<{ id: string; name: string }>>(
        "GET",
        `/identity-provider/instances/${alias}/mappers`,
      )) ?? [];
    const byName = new Map(existing.map((m) => [m.name, m.id]));

    for (const [ourAttribute, theirClaim] of Object.entries(mapping)) {
      if (typeof theirClaim !== "string" || theirClaim.length === 0) continue;
      const name = `attr-${ourAttribute}`;
      const body = {
        name,
        identityProviderAlias: alias,
        identityProviderMapper: "oidc-user-attribute-idp-mapper",
        config: { claim: theirClaim, "user.attribute": ourAttribute, syncMode: "FORCE" },
      };
      const id = byName.get(name);
      if (id) {
        await this.request("PUT", `/identity-provider/instances/${alias}/mappers/${id}`, {
          ...body,
          id,
        });
      } else {
        await this.request("POST", `/identity-provider/instances/${alias}/mappers`, body);
      }
    }
  }

  /**
   * Organizations are addressed by server-generated id, but the adapter's
   * stable handle is the alias, so resolution goes through exact search.
   * `exact=true` — a substring match could resolve `tenant-a` to `tenant-ab`
   * and delete the wrong tenant's federation.
   */
  private async findOrgIdByAlias(
    alias: string,
    opts?: { tolerateMissing: boolean },
  ): Promise<string | null> {
    const list =
      (await this.request<OrgRepresentation[]>(
        "GET",
        `/organizations?search=${encodeURIComponent(alias)}&exact=true`,
      )) ?? [];
    const hit = list.find((o) => o.alias === alias);
    if (!hit?.id) {
      if (opts?.tolerateMissing) return null;
      throw new KeycloakIdpAdminError("not_found", `organization ${alias} not found`, 404);
    }
    return hit.id;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const res = await this.rawRequest(method, path, body);
    if (!res.ok) throw await this.errorFrom(res, `${method} ${path}`);
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  }

  private async requestTolerating404(method: string, path: string): Promise<void> {
    const res = await this.rawRequest(method, path);
    if (res.status === 404) return;
    if (!res.ok) throw await this.errorFrom(res, `${method} ${path}`);
  }

  private async rawRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.serviceToken();
    return this.fetchImpl(`${this.cfg.baseUrl}/admin/realms/${this.cfg.realm}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private async errorFrom(res: Response, what: string): Promise<KeycloakIdpAdminError> {
    // Never include the response body: admin-API errors can echo config values.
    const code =
      res.status === 401 || res.status === 403
        ? "unauthorized"
        : res.status === 404
          ? "not_found"
          : "provider_error";
    return new KeycloakIdpAdminError(code, `Keycloak admin ${what} failed (${res.status})`, res.status);
  }

  private async serviceToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - TOKEN_SKEW_MS) {
      return this.token.value;
    }
    const res = await this.fetchImpl(
      `${this.cfg.baseUrl}/realms/${this.cfg.realm}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.cfg.adminClientId,
          client_secret: this.cfg.adminClientSecret,
        }).toString(),
      },
    );
    if (!res.ok) {
      throw new KeycloakIdpAdminError(
        "unauthorized",
        `Keycloak service-account token request failed (${res.status})`,
        res.status,
      );
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new KeycloakIdpAdminError("provider_error", "token response carried no access_token");
    }
    this.token = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 60) * 1000,
    };
    return this.token.value;
  }
}
