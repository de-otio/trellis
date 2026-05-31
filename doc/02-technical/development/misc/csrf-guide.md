# CSRF Protection: Implementation, Testing & Maintenance Guide

This document is the single source of truth for how CSRF works in Trellis. Read this before writing any authenticated endpoint, test, or client code that makes state-changing requests.

## How It Works

Trellis uses the **Double Submit Cookie** pattern:

1. The CSRF token lives inside the encrypted session cookie (`trellis_session`). JavaScript cannot read it — the cookie is `HttpOnly`.
2. The client gets a copy of the token from `GET /api/csrf-token` and stores it in memory.
3. On state-changing requests (POST, PUT, PATCH, DELETE), the client sends the token in the `X-CSRF-Token` header.
4. The server decrypts the session cookie, extracts the embedded CSRF token, and compares it to the header value using constant-time comparison.
5. If they don't match, the server returns 403.

The security property: an attacker on a different origin can trigger the browser to send the cookie automatically, but cannot read the cookie contents (HttpOnly) or set the `X-CSRF-Token` header on a cross-origin request.

### JWT Bypass

Requests authenticated via `Authorization: Bearer <jwt>` skip CSRF validation entirely. JWT tokens are not auto-sent by the browser — an attacker would need to read the token from the victim's storage, which requires XSS (a different attack vector). This means API clients using Bearer tokens never need CSRF tokens.

## The CSRF Token Lifecycle

```
GET /api/csrf-token
  ├── Server decrypts session from cookie
  ├── Generates new token: crypto.randomUUID()
  ├── Stores token + timestamp in session object:
  │     session.csrfToken = "abc-123..."
  │     session.csrfTokenCreatedAt = Date.now()
  │     session.csrfTokenNeedsRotation = false
  ├── Re-encrypts session → new cookie value
  ├── Sets new Set-Cookie header on response
  └── Returns JSON: { token: "abc-123...", sessionToken: "<encrypted>" }

POST /api/some-endpoint (with X-CSRF-Token: abc-123...)
  ├── CSRF middleware extracts token from header
  ├── Decrypts session from cookie
  ├── Compares header token to session.csrfToken (constant-time)
  ├── If >24h old, sets session.csrfTokenNeedsRotation = true
  └── 403 if mismatch, passes through if valid
```

### Critical Detail: Session Cookie Changes on Token Generation

When the server generates a CSRF token, it modifies the session object and re-encrypts it. This means the `Set-Cookie` header in the `/api/csrf-token` response contains a **new, different** encrypted session value. **You must use this new session value for all subsequent requests.** The old session cookie no longer contains the CSRF token.

This is the #1 source of bugs in tests and client code.

## Core Files

| File | What it does |
|---|---|
| `apps/api/src/lib/csrf.ts` | Token generation, validation, session storage |
| `apps/api/src/lib/middleware.ts` (csrfMiddleware) | Route-level CSRF enforcement |
| `apps/api/src/lib/session-manager.ts` | Session encryption/decryption, cookie setting |
| `apps/api/src/lib/routes/health.ts` | `GET /api/csrf-token` endpoint |

## Implementing a New Endpoint

### Route Definition

Every state-changing endpoint must include `csrfMiddleware()`:

```typescript
{
  path: "/api/things",
  method: "POST",
  handler: async (request, env, { pathname, requestContext }) => {
    const sessionManager = new SessionManager();
    const securityHeaders = new SecurityHeaders(env);
    const session = await sessionManager.getSession(
      request,
      Secrets.getSessionSecret(env),
      env,
    );
    if (!session) {
      return securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    // ... handler logic
  },
  middleware: [corsMiddleware(), csrfMiddleware()], // <-- CSRF required
  description: "Create a thing",
}
```

### What Does NOT Need CSRF

- `GET`, `HEAD`, `OPTIONS` requests (safe methods — middleware skips them automatically)
- Endpoints authenticated exclusively via JWT Bearer tokens
- Unauthenticated endpoints (no session = no CSRF to validate)
- Test-only endpoints (e.g., `POST /api/admin/test/users`) that are gated by environment check

### Checklist for New Endpoints

- [ ] `middleware: [corsMiddleware(), csrfMiddleware()]` present in route definition
- [ ] Handler checks for valid session before performing side effects
- [ ] No state changes happen before auth + CSRF validation
- [ ] If returning a new session cookie, the response goes through `securityHeaders.addSecurityHeaders()`

## Writing Tests

### The Token + Session Dance

This is where most bugs live. The pattern is:

1. Create a test user → get initial session token
2. Fetch CSRF token → get new session token (from `Set-Cookie`)
3. Use the **new** session token + CSRF token for subsequent requests
4. If you make another mutating request, the session may change again

### Correct Pattern

```typescript
// Step 1: Create user with session
const { testUser, sessionToken } = await createTestUserWithSession({ ... });

// Step 2: Get CSRF token — this CHANGES the session
const csrfResponse = await authenticatedFetch(
  `${API_URL}/api/csrf-token`,
  sessionToken,
  { method: "GET" },
);
const csrfData = await csrfResponse.json();
const csrfToken = csrfData.token;

// CRITICAL: Extract the updated session from Set-Cookie
const setCookie = csrfResponse.headers.get("Set-Cookie") || "";
const match = setCookie.match(/trellis_session=([^;]+)/);
const currentSessionToken = match ? match[1] : sessionToken;
// OR if using csrfData.sessionToken:
// const currentSessionToken = csrfData.sessionToken || sessionToken;

// Step 3: Use BOTH the new session token AND the CSRF token
const response = await authenticatedFetch(
  `${API_URL}/api/things`,
  currentSessionToken,  // <-- MUST be the updated token
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,  // <-- From step 2
    },
    body: JSON.stringify({ ... }),
  },
);
```

### Reusable getCsrfToken Helper

Use the existing helper in test setup files:

```typescript
async function getCsrfToken(sessionToken: string): Promise<{
  token: string;
  updatedSessionToken?: string;
}> {
  const response = await authenticatedFetch(
    `${API_URL}/api/csrf-token`,
    sessionToken,
    { method: "GET" },
  );

  if (!response.ok) {
    throw new Error(`Failed to get CSRF token: ${response.status}`);
  }

  const body = await response.json();
  const setCookieHeader = response.headers.get("Set-Cookie");
  let updatedSessionToken = sessionToken;
  if (setCookieHeader) {
    const match = setCookieHeader.match(/trellis_session=([^;]+)/);
    if (match) {
      updatedSessionToken = match[1];
    }
  }

  return { token: body.token, updatedSessionToken };
}
```

Usage:

```typescript
const { token: csrfToken, updatedSessionToken } = await getCsrfToken(sessionToken);
const currentSession = updatedSessionToken || sessionToken;
// Use currentSession for all subsequent authenticatedFetch calls
```

### Common Test Mistakes

**Mistake 1: Using the old session token after getting a CSRF token**

```typescript
// WRONG — sessionToken is stale after CSRF fetch
const { token: csrfToken } = await getCsrfToken(sessionToken);
await authenticatedFetch(url, sessionToken, {  // <-- BUG: old session
  headers: { "X-CSRF-Token": csrfToken },
});
```

```typescript
// CORRECT
const { token: csrfToken, updatedSessionToken } = await getCsrfToken(sessionToken);
await authenticatedFetch(url, updatedSessionToken || sessionToken, {
  headers: { "X-CSRF-Token": csrfToken },
});
```

**Mistake 2: Reusing a CSRF token across multiple mutating requests without tracking session changes**

Each mutating request may return a new `Set-Cookie`. If the server rotates the session (e.g., because the CSRF token was flagged for rotation), the old session becomes invalid.

```typescript
// WRONG — second request may fail if first request changed the session
await authenticatedFetch(url1, session, { headers: { "X-CSRF-Token": csrf } });
await authenticatedFetch(url2, session, { headers: { "X-CSRF-Token": csrf } });
```

```typescript
// CORRECT — track session changes
const res1 = await authenticatedFetch(url1, session, { headers: { "X-CSRF-Token": csrf } });
const newCookie = res1.headers.get("Set-Cookie")?.match(/trellis_session=([^;]+)/)?.[1];
const session2 = newCookie || session;
await authenticatedFetch(url2, session2, { headers: { "X-CSRF-Token": csrf } });
```

**Mistake 3: Forging session cookies with a different secret than the API uses**

If test code encrypts a session locally using `SESSION_SECRET` from SSM, but the deployed API uses a different secret (e.g., from Cloudflare Workers secrets), the API cannot decrypt the cookie → 401.

Solution: Let the server create the session. The `POST /api/admin/test/users` endpoint returns a `Set-Cookie` header with a valid session. Extract it from the response instead of creating sessions locally.

**Mistake 4: Forgetting CSRF for a new endpoint**

If you add a new POST/PUT/PATCH/DELETE route without `csrfMiddleware()`, it's unprotected. The unit test for `csrfMiddleware` doesn't know about your new route. Add an integration test that verifies the endpoint rejects requests without a CSRF token.

## Client Implementation (Flutter)

### Token Acquisition

```dart
Future<String> getCsrfToken() async {
  final response = await apiClient.get('/api/csrf-token');
  final token = response.data['token'];
  // Store the token for subsequent requests
  _csrfToken = token;
  // If using localStorage approach, also store sessionToken:
  // _sessionToken = response.data['sessionToken'];
  return token;
}
```

### Sending State-Changing Requests

```dart
Future<Response> createPost(String text) async {
  if (_csrfToken == null) {
    await getCsrfToken();
  }
  return apiClient.post(
    '/api/posts',
    data: {'text': text},
    options: Options(headers: {'X-CSRF-Token': _csrfToken}),
  );
}
```

### Handling 403 (Token Expired/Invalid)

```dart
// In your HTTP interceptor:
if (response.statusCode == 403 && response.data['error'] == 'Invalid CSRF token') {
  // Refresh token and retry
  await getCsrfToken();
  return retry(request);
}
```

### Token Rotation

Tokens older than 24 hours are flagged for rotation. The client should proactively refresh:

- Refresh on app foreground (if >1 hour since last fetch)
- Refresh on 403 with CSRF error
- Refresh before critical operations (payments, deletion)

## Known Bug: Missing `env` in `getSession()` Causes 401

**Root cause (fixed 2026-03-21):** `SessionManager.getSession(request, secret, env?)` uses `env?.SESSION_SALT` for decryption. If `env` is omitted (2-arg call), salt is `undefined`, but the session was encrypted WITH the salt. Salt mismatch → decryption fails → 401 Unauthorized.

This bug was present in 15 route files that called `getSession(request, Secrets.getSessionSecret(env))` without passing `env` as the third argument. Routes that passed `env` (like `/api/feeds/home`, `/api/csrf-token`) worked fine, making the bug appear intermittent.

**The correct call:**

```typescript
// WRONG — missing env, salt will be undefined during decryption
const session = await sessionManager.getSession(
  request,
  Secrets.getSessionSecret(env),
);

// CORRECT — env provides SESSION_SALT for decryption
const session = await sessionManager.getSession(
  request,
  Secrets.getSessionSecret(env),
  env,
);
```

**Why this matters for CSRF:** The `/api/csrf-token` endpoint passed `env` and worked. Route handlers that didn't pass `env` returned 401. This made it look like CSRF was the problem (token fetch succeeded, next request failed) when the actual issue was session decryption.

## Debugging CSRF Failures

### Symptom: 403 with "CSRF token required"

The `X-CSRF-Token` header is missing. Check:
- Client is sending the header
- CORS preflight allows `X-CSRF-Token` (it does — configured in `corsMiddleware`)
- Proxy/CDN is not stripping custom headers

### Symptom: 403 with "Invalid CSRF token"

Token mismatch. Check:
- The session cookie sent with the request matches the session that was updated when the CSRF token was generated
- The token hasn't been regenerated (each call to `/api/csrf-token` invalidates the previous token)
- The session hasn't expired

### Symptom: 401 on requests after getting CSRF token

Session mismatch — the most common issue. The `/api/csrf-token` endpoint returns a new `Set-Cookie`, and subsequent requests must use that updated cookie. Check:
- Test code extracts and uses the updated session token from `Set-Cookie` or `csrfData.sessionToken`
- No intermediate request changed the session cookie without being tracked

### Diagnostic Logging

The CSRF middleware logs detailed diagnostics on validation failure:

```
[CSRF] Token validation failed for POST /api/posts
  - Header token present: true
  - Session token present: true
  - Tokens match: false
  - Token age: 86401000ms
  - Needs rotation: true
```

Check API logs via `./scripts/ops/logs.sh api 30` after a failure.

## Maintenance

### Adding CSRF to a New Route Module

1. Import: `import { csrfMiddleware } from "../middleware";`
2. Add to middleware array: `middleware: [corsMiddleware(), csrfMiddleware()]`
3. Add integration test that verifies 403 without CSRF token
4. Add integration test that verifies success with valid CSRF token

### Rotating Session Secrets

When rotating `SESSION_SECRET`:

1. Set the old secret as `SESSION_SECRET_FALLBACK`
2. Set the new secret as `SESSION_SECRET`
3. Deploy — the API tries the primary secret first, then falls back
4. Wait for all existing sessions to expire (max 90 days for long-lived sessions)
5. Remove `SESSION_SECRET_FALLBACK`

CSRF tokens embedded in sessions encrypted with the old secret will still validate during the fallback period.

### Removing the KV Fallback

The `CSRF_TOKENS_KV` KV namespace is a deprecated migration mechanism. To remove:

1. Verify no tokens are being stored in KV (check `CSRFProtection.validateToken` logs)
2. Remove KV lookup from `validateToken` in `csrf.ts`
3. Remove `storeTokenInKV` from `csrf.ts`
4. Remove `CSRF_TOKENS_KV` from CDK config
5. Run the CSRF unit tests — they should still pass

## Security Properties

| Property | How it's achieved |
|---|---|
| Token unpredictability | `crypto.randomUUID()` — 122 bits of entropy |
| Timing attack resistance | Constant-time comparison in `validateToken` |
| Cookie theft protection | `HttpOnly` flag — JS cannot read the cookie |
| Cross-origin protection | `SameSite` cookie attribute + CORS headers |
| Token binding | Token embedded in encrypted session — tied to specific user |
| Replay protection | Token regenerated on each `/api/csrf-token` call |
| Key stretching | PBKDF2 with 100,000 iterations for session encryption |
