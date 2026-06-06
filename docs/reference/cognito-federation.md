---
title: Cognito federation
description: How a single Cognito user pool federates to per-tenant identity providers, how tenant context is carried in the JWT, and how OIDC and SAML providers are managed.
sidebar: Cognito federation
order: 41
---

# Cognito federation

Trellis federates authentication through a single Cognito user pool that holds
one identity-provider (IdP) record per federated tenant. A tenant connects its
own IdP over OIDC or SAML; users from that tenant sign in through their IdP, and
Trellis enriches the issued token with tenant context.

This page describes the pool model, how IdP records are created and managed, the
shape of the JWT, and how Cognito routes a user to the right tenant's IdP. See
the [identity federation data model](./identity-federation-data-model.md) for
the backing schema and
[just-in-time provisioning](./just-in-time-provisioning.md) for how user and
membership rows appear on first login.

## Pool model

There is **one user pool with N IdP records** — one
`UserPoolIdentityProvider` per federated tenant. A single pool gives one set of
triggers, user deduplication across tenants, and a single hosted sign-in UI.
This is the pattern Cognito's own multi-tenant guidance recommends.

The custom attributes carried per user:

| Attribute | Purpose |
|---|---|
| `custom:handle` | The user's handle |
| `custom:role` | Platform-wide role (`UserRole`) |
| `custom:activeTenantId` | The user's active tenant |
| `custom:tenantRole` | The user's role within the active tenant |
| `custom:tenantSlug` | The active tenant's slug |

Four Lambda triggers are wired to the pool:

| Trigger | Responsibility |
|---|---|
| **PreSignUp** | Sign-up checks |
| **PostConfirmation** | Create the Trellis user and personal tenant |
| **PreTokenGeneration** | Resolve and inject tenant context per token |
| **CustomMessage** | Customize Cognito messages |

Two consequences of this model:

1. **Per-tenant IdP records are created at runtime**, not as static
   infrastructure. The pool, app client, and triggers are fixed; individual IdP
   records are created through the SDK when an admin connects an IdP.
2. **The app client's `SupportedIdentityProviders` list is mutated at runtime.**
   Enabling an IdP appends its provider name; disabling removes it.

## Managing IdP records

When an admin connects, edits, or disconnects an IdP, the API calls the Cognito
Identity Provider SDK.

### Create (OIDC)

```typescript
import {
  CognitoIdentityProviderClient,
  CreateIdentityProviderCommand,
  UpdateUserPoolClientCommand,
  DescribeUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});

async function createOidcIdp(tenant: Tenant, config: OidcConfig) {
  const providerName = cognitoIdpName(tenant.id); // "tenant-{first-12-chars}"

  await cognito.send(new CreateIdentityProviderCommand({
    UserPoolId: env.COGNITO_USER_POOL_ID,
    ProviderName: providerName,
    ProviderType: 'OIDC',
    ProviderDetails: {
      client_id: config.clientId,
      client_secret: config.clientSecret,      // supplied at create time only
      attributes_request_method: 'GET',
      oidc_issuer: config.issuerUrl,
      authorize_scopes: 'openid email profile groups',
      // Endpoints are auto-discovered from the issuer's
      // .well-known/openid-configuration document.
    },
    AttributeMapping: {
      email:       'email',
      given_name:  'given_name',
      family_name: 'family_name',
    },
    // Verified tenant domains enable email-domain routing.
    IdpIdentifiers: tenant.domains
      .filter(d => d.verifiedAt)
      .map(d => d.domain),
  }));

  // Append the provider to the app client's supported list.
  const { UserPoolClient } = await cognito.send(new DescribeUserPoolClientCommand({
    UserPoolId: env.COGNITO_USER_POOL_ID,
    ClientId: env.COGNITO_CLIENT_ID,
  }));

  await cognito.send(new UpdateUserPoolClientCommand({
    UserPoolId: env.COGNITO_USER_POOL_ID,
    ClientId: env.COGNITO_CLIENT_ID,
    SupportedIdentityProviders: [
      ...(UserPoolClient!.SupportedIdentityProviders ?? []),
      providerName,
    ],
    // UpdateUserPoolClient is a full replace — re-pass all other settings.
  }));
}
```

### Create (SAML)

The same shape with `ProviderType: 'SAML'` and
`ProviderDetails: { MetadataURL: '...' }` or a `MetadataFile`. Cognito fetches
the metadata and caches the signing certificate.

### Update, disable, delete

- **Update** — `UpdateIdentityProviderCommand` changes the metadata, attribute
  mapping, or scopes. The provider name is immutable.
- **Disable** — keep the IdP record but remove its provider name from the app
  client's `SupportedIdentityProviders`. Sign-in fails fast; the record is
  preserved for re-enable.
- **Delete** — `DeleteIdentityProviderCommand`, used when a tenant disconnects
  permanently. Existing federated users referencing the removed provider can no
  longer sign in.

## Attribute mapping

Cognito's IdP `AttributeMapping` translates IdP claims into user attributes. The
shipped defaults:

| User attribute | OIDC source claim | SAML source attribute | Notes |
|---|---|---|---|
| `email` | `email` | `…/identity/claims/emailaddress` | Required |
| `given_name` | `given_name` | `…/identity/claims/givenname` | Recommended |
| `family_name` | `family_name` | `…/identity/claims/surname` | Optional |
| `custom:idpGroups` | `groups` | `…/identity/claims/groups` | List of strings; resolved to a tenant role by the pre-token-generation trigger |

`custom:idpGroups` is a fixed-size custom attribute. When a tenant's group list
would exceed it, filter the groups at the IdP (most IdPs can emit only the
groups assigned to the application) rather than in the Trellis pipeline.

A tenant admin can override the mapping; the change is written to
`TenantIdentityProvider.attributeMapping` and replayed through
`UpdateIdentityProvider`.

## JWT shape

After the pre-token-generation trigger enriches the token, it carries:

```json
{
  "iss": "https://cognito-idp.<region>.amazonaws.com/<user-pool-id>",
  "sub": "abc12345-...",
  "aud": "<client-id>",
  "exp": 1714612800,
  "iat": 1714609200,
  "token_use": "access",

  "email": "alice@example.com",
  "email_verified": true,
  "identities": [{
    "userId": "alice@example.com",
    "providerName": "tenant-abc12345xxx",
    "providerType": "OIDC",
    "primary": "true"
  }],

  "custom:userId":         "u_clxxxx...",
  "custom:globalRole":     "B2B_PARTNER",
  "custom:activeTenantId": "t_clyyyy...",
  "custom:tenantSlug":     "example-org",
  "custom:tenantRole":     "ADMIN",
  "custom:handle":         "alice"
}
```

The auth middleware verifies the token and builds an auth context from these
claims:

```typescript
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const verifier = CognitoJwtVerifier.create({
  userPoolId: env.COGNITO_USER_POOL_ID,
  clientId:   env.COGNITO_CLIENT_ID,
  tokenUse:   'access',
});

export interface AuthContext {
  cognitoSub: string;
  userId: string;
  globalRole: UserRole;
  activeTenantId: string;
  tenantSlug: string;
  tenantRole: TenantRole;
  handle: string;
  // All tenants the user belongs to — loaded lazily for the tenant switcher.
  membershipsLoader: () => Promise<TenantMembership[]>;
}

export async function authMiddleware(req: Request): Promise<AuthContext | null> {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) return null;
  try {
    const claims = await verifier.verify(token);
    return {
      cognitoSub:     claims.sub,
      userId:         claims['custom:userId'] as string,
      globalRole:     claims['custom:globalRole'] as UserRole,
      activeTenantId: claims['custom:activeTenantId'] as string,
      tenantSlug:     claims['custom:tenantSlug'] as string,
      tenantRole:     claims['custom:tenantRole'] as TenantRole,
      handle:         claims['custom:handle'] as string,
      membershipsLoader: () => loadMemberships(claims['custom:userId'] as string),
    };
  } catch {
    return null;
  }
}
```

## Pre-token-generation trigger

This trigger runs on every token issuance and refresh. It resolves the user's
tenant context and writes it into the token. To avoid hitting the database on
every refresh, resolved claims are cached in DynamoDB keyed by the Cognito
subject, with a one-hour TTL.

On each run it:

1. Reads the Cognito subject from the event.
2. Looks up cached claims in DynamoDB.
3. On a cache miss, loads the user, active membership, and role mapping from the
   database — or, for a federated user with no existing row, runs JIT
   provisioning (see
   [just-in-time provisioning](./just-in-time-provisioning.md)).
4. Re-resolves `custom:tenantRole` from `custom:idpGroups` via
   `TenantRoleMapping`, so a role change at the IdP takes effect on the next
   refresh.
5. Writes the claims to the token and refreshes the cache.

```typescript
export const handler = async (event: PreTokenGenerationTriggerEvent) => {
  const sub = event.userName;
  const cognitoUserAttrs = event.request.userAttributes;
  const idpGroupsRaw = cognitoUserAttrs['custom:idpGroups'] ?? '';
  const isFederated = !!event.request.userAttributes['identities'];

  let claims = await dynamoCache.get(sub);
  if (!claims) {
    claims = isFederated
      ? await jitProvision(sub, cognitoUserAttrs, idpGroupsRaw.split(','))
      : await loadFromRds(sub);
    await dynamoCache.put(sub, claims, /* ttlSeconds */ 3600);
  }

  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        'custom:userId':         claims.userId,
        'custom:globalRole':     claims.globalRole,
        'custom:activeTenantId': claims.activeTenantId,
        'custom:tenantSlug':     claims.tenantSlug,
        'custom:tenantRole':     claims.tenantRole,
        'custom:handle':         claims.handle,
      },
      groupOverrideDetails: { groupsToOverride: [] },
    },
  };
  return event;
};
```

**Cache invalidation.** When a user switches tenants or an admin changes a
user's tenant role, the API writes a fresh cache record before the next token is
issued. The TTL is the backstop.

## Email-domain routing

Cognito routes a user to their tenant's IdP in one of three ways.

### Identifier-based (preferred)

The hosted UI accepts an `idp_identifier` query parameter set to the user's
email domain:

```
GET https://<auth-domain>/oauth2/authorize
  ?response_type=code
  &client_id=<clientId>
  &redirect_uri=<redirect>
  &scope=openid+email+profile
  &idp_identifier=example.com        ← email domain
```

Cognito matches the domain against each IdP's `IdpIdentifiers` array and
redirects accordingly. This requires `IdpIdentifiers` to be set to the tenant's
verified domains on IdP create and kept in sync as domains change.

### Provider-name-based (fallback)

```
&identity_provider=tenant-abc12345xxx
```

Used when the discovery endpoint returns the explicit provider record name.

### IdP-initiated

A user starts at their IdP (for example, an application tile) and the IdP posts
to the Cognito endpoint without an `idp_identifier`. Cognito identifies the IdP
from the response signature and proceeds. No extra configuration is needed
beyond the IdP record itself.

The discovery endpoint defaults to the identifier-based flow (cleanest URL,
does not expose internal provider names) and also accepts the IdP-initiated
flow.

## Connecting an OIDC IdP

What an IdP administrator configures on their side:

1. Register an application for Trellis, scoped to their directory.
2. Set the redirect URI to the Cognito OIDC response endpoint
   (`https://<auth-domain>/oauth2/idpresponse`).
3. Grant delegated permissions for `openid`, `profile`, `email`, and basic
   profile read; for group-based roles, grant the permission that emits group
   membership in the token.
4. Create a client secret.
5. Add a groups claim to the token (group object ids are recommended), applied
   to the ID and access tokens.

What the tenant admin does in Trellis:

1. Open identity-provider settings and choose to connect an OIDC provider.
2. Enter the issuer URL, client id, and client secret.
3. Connect. Trellis probes the issuer's
   `.well-known/openid-configuration`, validates it, creates the Cognito IdP
   record, stores the secret in the managed secret store, and returns success.
4. Define role mappings (for example, a group id → `ADMIN`) or rely on the
   default-role fallback.
5. Test the connection: Trellis redirects to the IdP, the admin authenticates,
   and lands on a confirmation page.

## Operational behaviour

### Tenant suspension

1. The API removes the provider name from the app client's
   `SupportedIdentityProviders`, so no new sign-ins occur via the IdP.
2. The API calls `AdminUserGlobalSignOut` for every active member to revoke
   existing tokens.
3. `TenantIdentityProvider.status` is set to `DISABLED`.

Unsuspension is symmetric: re-add the provider name; the Cognito user records
remain.

### Secret and certificate rotation

- **OIDC client secret** — the admin generates a new secret at the IdP and
  pastes it into Trellis. Trellis writes a new version to the managed secret
  store and calls `UpdateIdentityProvider`; the previous version remains
  available for rollback.
- **SAML certificate** — when a metadata URL is configured, Cognito
  auto-fetches the new certificate. When metadata was pasted, the admin
  re-pastes it.

### Failure isolation

A misconfigured tenant IdP (`status = ERROR`) does not affect other tenants. The
pre-token-generation trigger returns a synthetic `ACCESS_DENIED` claim for that
tenant, which the API treats as a 403, containing the blast radius.

## Related

- [Identity federation data model](./identity-federation-data-model.md)
- [Just-in-time provisioning](./just-in-time-provisioning.md)
