# Authentication: Amazon Cognito

> **See also:** Multi-tenant identity, per-tenant IdP federation (Entra/SAML/OIDC), self-service onboarding, and tenant-scoped roles are designed as a core framework feature. Canonical design: [`doc/02-technical/identity-federation/`](../identity-federation/). This file covers the base Cognito setup the federation work builds on.

## Why Cognito

- Native AWS — same account, same IAM, same billing
- First-class CDK support
- 50K MAU free, then $0.0055/MAU
- Built-in OAuth/OIDC, MFA (TOTP + SMS + email OTP)
- JWT validation in app middleware

## Cognito User Pool Configuration

```
User pool name:       trellis-users
Sign-in:              Email (primary), username (handle)
Password policy:      Min 8 chars, require uppercase + lowercase + number
MFA:                  Optional (TOTP) — required for admin roles (enforced in app)
Email verification:   Required
Account recovery:     Email
Self-signup:          Enabled (with invitation code validation via pre-signup trigger)
Custom attributes:    handle (string), role (string), dataRegion (string)
```

### App Client

```
Client name:          trellis-app
Auth flows:           USER_SRP_AUTH, REFRESH_TOKEN_AUTH
Token validity:
  - Access token:     1 hour
  - Refresh token:    30 days
  - ID token:         1 hour
OAuth scopes:         openid, email, profile
Callback URLs:        trellis://auth/callback, https://example.com/auth/callback
```

## Lambda Triggers

Cognito Lambda triggers handle auth lifecycle events:

| Trigger | Lambda | Purpose |
|---------|--------|---------|
| Pre sign-up | `preSignUpTrigger` | Validate invitation code, enforce sign-up restrictions |
| Post confirmation | `postConfirmationTrigger` | Create `User` record in RDS, set default role |
| Pre token generation | `preTokenGenerationTrigger` | Add custom claims (role, handle) to JWT |
| Custom message | `customMessageTrigger` | Branded email templates |

### Pre Token Generation (Key Trigger)

Adds application-specific claims to the JWT so the API can authorize without a DB lookup on every request. Uses DynamoDB cache to avoid hitting RDS on every token refresh (~hourly per user):

```typescript
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DYNAMO_TABLE!;

export const handler = async (event: PreTokenGenerationTriggerEvent) => {
  const sub = event.request.userAttributes.sub;
  const claims = await getCachedClaims(sub);

  event.response.claimsOverrideDetails = {
    claimsToAddOrOverride: {
      'custom:userId': claims.userId,
      'custom:role': claims.role,
      'custom:handle': claims.handle,
    },
  };
  return event;
};

async function getCachedClaims(cognitoSub: string) {
  // Try DynamoDB cache first
  const cached = await docClient.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `claims:${cognitoSub}`, sk: 'meta' },
  }));

  const now = Math.floor(Date.now() / 1000);
  if (cached.Item && cached.Item.ttl > now) {
    return cached.Item.data;
  }

  // Cache miss — query RDS
  const user = await db.user.findUnique({
    where: { cognitoSub },
    select: { id: true, role: true, handle: true },
  });

  if (!user) throw new Error(`User not found for sub: ${cognitoSub}`);

  // Cache for 1 hour (matches access token lifetime)
  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `claims:${cognitoSub}`,
      sk: 'meta',
      data: { userId: user.id, role: user.role, handle: user.handle },
      ttl: now + 3600,
    },
  }));

  return { userId: user.id, role: user.role, handle: user.handle };
}
```

**Why cache?** This trigger fires on every token refresh (~hourly per active user). Without caching:
- Every refresh hits RDS, adding latency and load
- If RDS is down, all token refreshes fail and users are locked out

With DynamoDB cache, RDS is only queried once per hour per user. If RDS is down, cached claims still work for up to 1 hour.

**Cache invalidation**: When a user's role or handle changes (rare), the API writes an updated cache entry to DynamoDB. The next token refresh picks it up immediately.

This Lambda runs **outside the VPC** (no RDS access needed when cache hits). On cache miss, it connects to RDS via a single short-lived connection. The `postConfirmationTrigger` (which creates the initial User record) also writes the initial cache entry.

## JWT Validation in Fargate

The Fargate API validates Cognito JWTs in application middleware. Use `aws-jwt-verify`:

```typescript
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  clientId: process.env.COGNITO_CLIENT_ID!,
  tokenUse: 'access',
});

export async function authMiddleware(req: Request): Promise<JwtClaims | null> {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) return null;

  try {
    const payload = await verifier.verify(token);
    return {
      sub: payload.sub,
      userId: payload['custom:userId'] as string,
      role: payload['custom:role'] as string,
      handle: payload['custom:handle'] as string,
    };
  } catch {
    return null; // Invalid or expired token
  }
}
```

The verifier caches Cognito's JWKS (public keys) automatically — no network call on every request.

## Flutter Integration

### Option A: Amplify Auth (Recommended)

```yaml
# pubspec.yaml
dependencies:
  amplify_flutter: ^2.0.0
  amplify_auth_cognito: ^2.0.0
```

Amplify provides:
- Hosted UI for OAuth flows (or custom UI with SRP)
- Secure token storage
- Automatic token refresh
- MFA enrollment UI helpers

### Option B: Direct Cognito API

If Amplify is too heavy, use `amazon_cognito_identity_dart_2` or direct HTTP calls to Cognito:
- Smaller dependency footprint
- Full control over UI
- More code to maintain

**Recommendation**: Start with Amplify Auth — it handles token lifecycle, secure storage, and edge cases. The Amplify Flutter SDK is modular; you only need `amplify_auth_cognito`.

## OAuth / Social Login (Future)

Cognito supports federated identity providers:
- Google, Apple, Facebook — built-in
- Microsoft Entra (Azure AD) — OIDC federation
- SAML — for B2B partner SSO

These can be added later without changing the app architecture.

## Session Management

The current app manages sessions via custom `SESSION_SECRET` encryption. With Cognito:
- **Access tokens** replace session tokens — stateless, JWT-based
- **Refresh tokens** are stored securely by Amplify on the client
- **Token revocation** via Cognito `GlobalSignOut` or `AdminUserGlobalSignOut`
- **Session blocklist** moves from KV to DynamoDB (for force-logout scenarios)
