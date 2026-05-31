# Cognito Federation Design

How the existing Cognito user pool is extended to support N tenant-specific identity providers, how the JWT carries tenant context, and the concrete Entra ID setup. Builds on [`architecture/05-auth.md`](../architecture/05-auth.md) (the base Cognito design).

> **MVP scope reminder:** the architecture below is IdP-agnostic by design. **What ships in MVP is the OIDC path with Microsoft Entra ID as the only validated IdP.** SAML support, Okta, Google Workspace, and other IdPs are designed-in but Phase 2 deliverables. Sections marked _MVP_ are required to ship; sections marked _Phase 2_ describe the same code paths but are not exercised end-to-end until a non-Entra customer needs them.

## Pool topology decision

**Decision: single Cognito user pool, N IdP records (one per federated tenant).**

The two real options:

| Option | Cognito setup | Pros | Cons |
|---|---|---|---|
| **A. Single pool, N IdPs** ✅ | One user pool. One `UserPoolIdentityProvider` per tenant. | One CDK resource, one set of triggers. Cognito quota easily covers it (300 IdPs default, 1,000 max — see [Quotas](#quotas)). User dedup across tenants. Single hosted UI. | All tenants share Cognito-side rate quotas. Pool-wide outage affects all tenants. |
| B. Pool per tenant | One user pool per tenant. | Hard isolation. Pool-wide config per tenant (custom triggers, different password policy). | CDK stack-per-tenant is operationally untenable for self-service. AWS recommends against it for SaaS multi-tenancy. |

We pick A. Cognito's [own multi-tenant guidance](https://aws.amazon.com/blogs/security/use-saml-with-amazon-cognito-to-support-a-multi-tenant-application-with-a-single-user-pool/) recommends this exact pattern.

## Quotas

Relevant [Cognito user pool quotas](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html):

| Resource | Default | Adjustable max |
|---|---|---|
| **Identity providers per pool** | **300** | **1,000** |
| App clients per pool | 1,000 | 10,000 |
| Users per pool | 40,000,000 | contact AWS |
| Groups per pool | 10,000 | not adjustable |
| Groups per user | 100 | not adjustable |
| Custom attributes per pool | 50 | not adjustable |
| Characters in identity provider name | 32 | not adjustable |
| Characters in custom attribute name | 20 | not adjustable |
| `UserFederation` request rate | 25 RPS | adjustable |

**Capacity planning:**

- **300 federated tenants** with the default quota is enough for Phase 2 (we target 5–10 B2B partners) and well into Phase 3.
- At ~250 federated tenants, request a quota increase to 1,000.
- If we ever approach 1,000 federated tenants in a single region, the architecture has earned the right to revisit pool-per-tenant. Until then, we don't pre-optimize.
- `UserFederation` 25 RPS is the federation throughput across *all* tenants. With 1,000 tenants and bursty 8am sign-in spikes, raise this. Set up CloudWatch alarms on `ThrottleCount` for the `UserFederation` category.

## CDK additions

The base user pool was defined in [`architecture/05-auth.md`](../architecture/05-auth.md). For tenancy:

```typescript
// infra/lib/stacks/auth-stack.ts (sketch)

const userPool = new cognito.UserPool(this, 'UserPool', {
  userPoolName: `trellis-${stage}-users`,
  signInAliases: { email: true, username: true },
  selfSignUpEnabled: true,
  customAttributes: {
    handle:        new cognito.StringAttribute({ mutable: true, maxLen: 32 }),
    role:          new cognito.StringAttribute({ mutable: true, maxLen: 32 }),  // global UserRole
    activeTenantId:new cognito.StringAttribute({ mutable: true, maxLen: 32 }),
    tenantRole:    new cognito.StringAttribute({ mutable: true, maxLen: 16 }),
    tenantSlug:    new cognito.StringAttribute({ mutable: true, maxLen: 32 }),
  },
  lambdaTriggers: {
    preSignUp:           preSignUpFn,
    postConfirmation:    postConfirmFn,        // creates User + personal Tenant
    preTokenGeneration:  preTokenGenFn,        // resolves tenant context per token
    customMessage:       customMessageFn,
  },
  // ... existing settings
});

// One app client for the Flutter app (existing)
const flutterClient = userPool.addClient('FlutterClient', {
  userPoolClientName: 'trellis-flutter',
  authFlows: { userSrp: true, userPassword: true },
  oAuth: {
    flows: { authorizationCodeGrant: true },
    scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
    callbackUrls: ['trellis://auth/callback', 'https://example.com/auth/callback', 'https://app.example.com/auth/callback'],
  },
  // SupportedIdentityProviders is *mutated dynamically* by the API on tenant IdP enable/disable.
  supportedIdentityProviders: [
    cognito.UserPoolClientIdentityProvider.COGNITO,  // password auth
    // tenant IdPs are added programmatically — not via CDK
  ],
});

// Custom domain for hosted UI: auth.example.com
const domain = userPool.addDomain('CognitoDomain', {
  customDomain: { domainName: 'auth.example.com', certificate: authCert },
});
```

Two important consequences:

1. **CDK does not own per-tenant IdP records.** They're created at runtime via the SDK from the API when an admin connects an IdP. CDK owns the pool, app client, and triggers — that's it.
2. **`supportedIdentityProviders` on the app client is mutated at runtime.** When an IdP is enabled, the API calls `UpdateUserPoolClient` to append the new provider name; on disable, it removes it. This is why the value in CDK is the seed list, not the truth.

## IdP CRUD via the SDK

When an admin connects/edits/disconnects an IdP, the API uses `@aws-sdk/client-cognito-identity-provider`.

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
  const providerName = cognitoIdpName(tenant.id);  // "tenant-{first-12-chars-of-cuid}"

  await cognito.send(new CreateIdentityProviderCommand({
    UserPoolId: env.COGNITO_USER_POOL_ID,
    ProviderName: providerName,
    ProviderType: 'OIDC',
    ProviderDetails: {
      client_id: config.clientId,
      client_secret: config.clientSecret,           // plaintext at create time only
      attributes_request_method: 'GET',
      oidc_issuer: config.issuerUrl,
      authorize_scopes: 'openid email profile groups',
      // Cognito auto-discovers endpoints from issuer's .well-known/openid-configuration
    },
    AttributeMapping: {
      email:       'email',
      given_name:  'given_name',
      family_name: 'family_name',
      'custom:tenantSlug': '__trellis_constant__',  // see attribute mapping section below
    },
    IdpIdentifiers: tenant.domains
      .filter(d => d.verifiedAt)
      .map(d => d.domain),  // these enable email-domain SP-initiated routing
  }));

  // Append to app client supportedIdentityProviders
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
    // re-pass everything else unchanged — UpdateUserPoolClient is a full replace
  }));
}
```

### Create (SAML) — Phase 2

Same shape; `ProviderType: 'SAML'`, `ProviderDetails: { MetadataURL: '...' }` or `MetadataFile`. Cognito fetches the metadata and caches the signing certificate.

The handler exists in MVP for symmetry with OIDC (so the schema and route shape are stable) but the SAML branch is **not exercised in MVP**: the IdP-connect Flutter UI doesn't expose SAML, and we don't ship a SAML walkthrough doc. First non-Entra customer in Phase 2 unlocks this path with no architecture changes.

### Update / Disable / Delete

- `UpdateIdentityProviderCommand` — change the metadata, attribute mapping, or scopes. Provider name is immutable.
- **Disable** — keep the IdP record, remove the providerName from `SupportedIdentityProviders` on the app client. Sign-in fails fast; record is preserved for re-enable.
- **Delete** — `DeleteIdentityProviderCommand`. Used when a tenant disconnects permanently. Causes existing federated users to error on next sign-in (they're effectively orphaned in Cognito with `external_provider` referencing a now-missing IdP).

## Attribute mapping

Cognito's IdP `AttributeMapping` translates IdP claims → Cognito user attributes. Defaults we ship:

| Cognito attribute | OIDC source claim | SAML source attribute | Notes |
|---|---|---|---|
| `email` | `email` | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` | Required |
| `given_name` | `given_name` | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname` | Optional but recommended |
| `family_name` | `family_name` | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname` | Optional |
| `custom:idpGroups` | `groups` | `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups` | List of strings; resolved to TenantRole by pre-token-gen |

`custom:idpGroups` is a 2,048-byte custom attribute. For tenants whose group list exceeds that (rare; Entra emits group object IDs which are GUIDs ~36 bytes each — ~50 groups max), Cognito truncates. We handle this with **group filtering at the IdP** (Entra has "filter groups assigned to the application" config) rather than in our pipeline.

The tenant admin can override mapping via the admin UI, which writes to `TenantIdentityProvider.attributeMapping` in Postgres and replays the `UpdateIdentityProvider` call.

## JWT shape

The Cognito-issued ID token (after pre-token-generation Lambda enrichment) carries:

```json
{
  "iss": "https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_xxxxx",
  "sub": "abc12345-...",
  "aud": "client-id-...",
  "exp": 1714612800,
  "iat": 1714609200,
  "token_use": "id",

  "email": "alice@de-otio.org",
  "email_verified": true,
  "cognito:username": "tenant-abc12_alice@de-otio.org",
  "identities": [{
    "userId": "alice@de-otio.org",
    "providerName": "tenant-abc12345xxx",
    "providerType": "OIDC",
    "issuer": null,
    "primary": "true",
    "dateCreated": "1714000000000"
  }],

  "custom:userId":         "u_clxxxx...",        // Trellis User.id (cuid)
  "custom:globalRole":     "B2B_PARTNER",         // UserRole enum
  "custom:activeTenantId": "t_clyyyy...",         // Trellis Tenant.id
  "custom:tenantSlug":     "de-otio",
  "custom:tenantRole":     "ADMIN",               // TenantRole enum (resolved per-token)
  "custom:handle":         "alice"
}
```

Trellis auth middleware reads:

```typescript
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const verifier = CognitoJwtVerifier.create({
  userPoolId: env.COGNITO_USER_POOL_ID,
  clientId:   env.COGNITO_CLIENT_ID,
  tokenUse:   'access',  // we use access tokens for API calls
});

export interface AuthContext {
  cognitoSub: string;
  userId: string;
  globalRole: UserRole;
  activeTenantId: string;
  tenantSlug: string;
  tenantRole: TenantRole;
  handle: string;
  // The list of all tenants the user belongs to — fetched lazily for tenant switching UI
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

## Pre-token-generation Lambda

This is the linchpin. On every token issuance, it:

1. Reads `cognitoSub` from the event.
2. Cache lookup in DynamoDB: `pk=claims:{sub} sk=meta`.
3. On miss, queries RDS for User + active TenantMember + role mapping.
4. If federated and User row missing, creates User + personal Tenant + TenantMember in a single transaction (the JIT path, see [06-just-in-time-provisioning.md](./06-just-in-time-provisioning.md)).
5. Resolves `custom:tenantRole` from `custom:idpGroups` via `TenantRoleMapping`.
6. Writes claims to event response, caches with 1h TTL.

```typescript
// trellis: apps/api/src/lambda/pre-token-generation.ts (sketch)
export const handler = async (event: PreTokenGenerationTriggerEvent) => {
  const sub = event.userName;  // Cognito username
  const cognitoUserAttrs = event.request.userAttributes;
  const idpGroupsRaw = cognitoUserAttrs['custom:idpGroups'] ?? '';
  const isFederated = !!event.request.userAttributes['identities'];

  let claims = await dynamoCache.get(sub);
  if (!claims) {
    if (isFederated) {
      claims = await jitProvision(sub, cognitoUserAttrs, idpGroupsRaw.split(','));
    } else {
      claims = await loadFromRds(sub);
    }
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

**Why DynamoDB cache:** the trigger runs on every token refresh (~hourly). Without cache, every refresh hits RDS and a buggy or downed RDS locks all users out. Same pattern as the existing design in [`architecture/05-auth.md`](../architecture/05-auth.md).

**Cache invalidation:** when the active tenant changes (user switches tenants), the API writes a fresh DDB record before issuing a new token. Same when `TenantRole` changes via admin UI. Cache TTL is the safety net.

**Lambda memory + concurrency:** 256 MB. Reserved concurrency 50 (this is on the auth hot path). Keep it outside the VPC unless RDS connectivity is needed (it is; we accept the cold-start cost — VPC + RDS Proxy mitigates).

## Email-domain routing

Two ways Cognito routes a user to their tenant's IdP:

### A. SP-initiated, identifier-based (preferred)

The hosted UI URL accepts an `idp_identifier` query param. We pass the user's email domain:

```
GET https://auth.example.com/oauth2/authorize
  ?response_type=code
  &client_id={clientId}
  &redirect_uri={redirect}
  &scope=openid+email+profile
  &idp_identifier=de-otio.org           ← email domain
```

Cognito looks up the IdP whose `IdpIdentifiers` array contains `de-otio.org` and redirects there. This requires us to set `IdpIdentifiers` on every IdP create with the tenant's verified domains, and to update them when domains are added/removed.

### B. SP-initiated, provider-name-based (fallback)

```
&identity_provider=tenant-abc12345xxx
```

Used when our `/api/auth/discover` endpoint returns the explicit `cognitoIdpName`.

### C. IdP-initiated

Entra-side: user clicks "Trellis" in their My Apps tile, Entra POSTs to the Cognito SAML/OIDC endpoint without an `idp_identifier`. Cognito identifies the IdP from the response signature and proceeds. Works without any config beyond the IdP record itself.

We default to **A** in our discovery endpoint (cleanest URL, doesn't leak our internal IdP names) and accept **C** for users who start at Entra.

## Entra-specific configuration

What an Entra admin does:

1. **Entra Admin Center → App registrations → New registration:**
   - Name: "Trellis"
   - Supported account types: "Accounts in this organizational directory only"
   - Redirect URI (Web): `https://auth.example.com/oauth2/idpresponse`

2. **API permissions:**
   - `Microsoft Graph → openid` (delegated)
   - `Microsoft Graph → profile` (delegated)
   - `Microsoft Graph → email` (delegated)
   - `Microsoft Graph → User.Read` (delegated)
   - For groups: `GroupMember.Read.All` (delegated, admin consent required) — emits user's group membership in the token.

3. **Certificates & secrets → New client secret** — Trellis uses this; Entra will not show it again.

4. **Token configuration → Add groups claim:**
   - Which groups to include: "Security groups" (or "All groups")
   - Customize token properties → Group ID (recommended) — emits group object IDs (GUIDs) into the `groups` claim
   - Apply to ID token, access token, and SAML token if doing SAML

5. **Optional: Authentication → Enable ID tokens** if using OIDC.

What the Trellis admin does:

1. Settings → Identity Provider → Connect Microsoft Entra (OIDC).
2. Paste:
   - **Issuer URL:** `https://login.microsoftonline.com/{entra-tenant-guid}/v2.0`
   - **Client ID:** from app registration
   - **Client Secret:** from step 3
3. Click "Connect."
4. Trellis probes the issuer's `.well-known/openid-configuration`, validates, creates Cognito IdP record, stores secret in Secrets Manager, returns success.
5. Admin defines role mappings: `{Entra group object ID for "Trellis-Admins"} → ADMIN`, etc. (or uses the default-role fallback for now).
6. Admin clicks "Test" — Trellis redirects to Entra, the admin authenticates with their own Entra account, lands back on a "Configuration verified" page.

Total time: ~10 minutes if the admin has the Entra values handy.

## Operational concerns

### Tenant suspension

When a tenant is suspended:
1. API calls `UpdateUserPoolClient` to remove the providerName from `SupportedIdentityProviders` (no new sign-ins via the IdP).
2. API calls `AdminUserGlobalSignOut` for every active TenantMember to revoke existing tokens.
3. `TenantIdentityProvider.status = DISABLED`.

### Tenant unsuspension

Symmetric: re-add to `SupportedIdentityProviders`. Existing user records in Cognito remain.

### IdP rotation (cert/secret rotation)

OIDC client secret rotation: admin requests new secret in Entra → pastes in Trellis → Trellis writes new secret to Secrets Manager (new version) → calls `UpdateIdentityProviderCommand` with the new secret → old secret left as historical version (for rollback). 7-day rollback window via Secrets Manager versioning.

SAML certificate rotation: if `metadataUrl` is configured, Cognito auto-fetches the new cert. If `metadataXml` was pasted, admin must re-paste.

### Failure isolation

A misconfigured tenant IdP (`status=ERROR`) should not affect other tenants. Pre-token-gen Lambda's RDS lookup fails for that tenant and we return a synthetic `ACCESS_DENIED` claim that the API treats as 403. This contains the blast radius.

## Open question

**Hosted UI vs custom UI in Flutter.** Cognito's hosted UI is the simplest path for federation (it handles the IdP redirects), but it means a browser context-switch in the Flutter app. Alternatives:

- **WebView-embedded hosted UI** — works on iOS/Android but counts as in-app browser; users see Cognito's URL.
- **Custom Flutter UI driving the OAuth code flow directly** — full control, more code, edge cases with deep-links.

**Recommendation for MVP: hosted UI, opened via the platform's secure-auth browser** (`SFAuthenticationSession` / `Custom Tabs`). Good UX, minimal code. Revisit if branding becomes a blocker. See implementation plan in [09-implementation-plan.md](./09-implementation-plan.md).
