---
title: User profile API
description: Endpoints for reading the caller's resolved identity and managing profile settings, region preference, and cross-region data-access consent.
sidebar: User profile API
order: 32
---

# User profile API

Endpoints for reading the caller's own identity, and for managing a user's
profile settings, region preference, and cross-region data-access consent.

- **Base paths:** `/api/users/me`, `/api/user`
- **Authentication:** all endpoints require a valid session.

## GET `/api/users/me`

The caller's identity **as the server resolved it**. Returns the trellis
`User.id`, the active tenant, and the caller's roles.

**Use this instead of decoding the ID token.** Reading `custom:userId` /
`custom:activeTenantId` out of the token only works on AWS Cognito, where a
pre-token-generation Lambda writes those claims. On any other OIDC issuer the
claim names are chosen per deployment (a Keycloak realm maps whatever its
`claim_mappers` say, and may map nothing at all), so a token-decoding client
gets `null` and fails silently. This endpoint has no such dependency: the
server resolves the identity from the token `sub` — claims cache, then the
database, then first-contact provisioning — so it behaves identically across
identity providers.

It is also **fresher than the token**. `activeTenantId` changes when the user
switches tenants (`POST /api/auth/switch-tenant`); a claim carries the old
value until the next token refresh, whereas this endpoint is correct on the
next request.

**Response (200):**

```json
{
  "userId": "cmqurmq7x000002i80nqmgfr8",
  "activeTenantId": "cmqurmq7x000002i80nqmgfr9",
  "email": "user@example.com",
  "globalRole": "END_USER",
  "tenantSlug": "acme",
  "tenantRole": "OWNER",
  "handle": "alice"
}
```

| Field | Description |
|---|---|
| `userId` | Trellis `User.id` (a cuid). The id every other endpoint expects. |
| `activeTenantId` | `Tenant.id` the caller is currently acting as. |
| `email` | The caller's email address. |
| `globalRole` | Platform-wide role (`UserRole`). |
| `tenantSlug` | Slug of the active tenant. |
| `tenantRole` | Role within the active tenant (`TenantRole`). |
| `handle` | ActivityPub-style handle; empty string when unset. |

**Errors:** `401` when the request is unauthenticated, or when the caller's
user row no longer exists (deletion racing the request) — the endpoint fails
closed rather than returning a partially populated identity.

**Caching:** responses are `private, no-store`. The values are per-caller and
change on tenant switch, so they must not be shared or persisted by an
intermediary. Clients may hold the result in memory for the session, but should
re-fetch after a tenant switch.

**Cost:** all fields except `email` come from the identity the authentication
middleware already resolved for the request; `email` adds a single primary-key
read. Cheap enough to call at application startup.

## PATCH `/api/user/profile`

Update profile settings. The only writable field accepted by this endpoint is
`stealth_mode` (a boolean). Other profile-related columns on the `User` model
are not editable through this route.

**Request body:**

```json
{
  "stealth_mode": true
}
```

**Response (200):**

```json
{
  "id": "user-123",
  "email": "user@example.com",
  "role": "END_USER",
  "stealth_mode": true,
  "actor_uri": "https://example.com/users/alice",
  "handle": "alice",
  "created_at": "2025-01-01T00:00:00Z"
}
```

`actor_uri` is nullable (present once the account has an ActivityPub actor URI);
`handle` is always present.

**Errors:** `400` invalid body (e.g. `stealth_mode` not a boolean), `401`
invalid or missing session, `404` user not found, `500` server error.

## POST `/api/user/region-preference`

Set the user's region preference.

**Request body:**

```json
{ "region": "EU" }
```

**Response (200):**

```json
{ "success": true, "region": "EU", "data_region": "EU" }
```

`region` is the user's updated preference; `data_region` reflects where the
user's data is stored and is **not** changed by this endpoint.

**Errors:** `400` missing or invalid region, `401`, `500`.

## POST `/api/user/cross-region-consent`

Record the user's consent for cross-region data access. Consent is persisted to
the append-only `Consent` record with `purpose = CROSS_REGION`.

**Request body:**

```json
{
  "dataRegion": "US",
  "accessRegion": "EU",
  "consented": true
}
```

**Response (200):**

```json
{
  "success": true,
  "consented": true,
  "dataRegion": "US",
  "accessRegion": "EU"
}
```

**Errors:** `400` invalid region or data-region mismatch, `401`, `404` user not
found, `500`.

## Former parental-controls endpoints

Accounts are 18+ (enforced server-side; see
[Compliance — Minimum age](../security-and-privacy/compliance.md#minimum-age)),
so there are no linked child accounts for a guardian to manage. The seven
guardian endpoints stay registered and return **`410 Gone`** with
`{"error":"MINOR_ACCOUNTS_NOT_SUPPORTED", "message", "remediation"}` — a `404`
would say "no such path", which a client retries; `410` says the capability is
withdrawn, which is the truth and terminal:

- `GET /api/parental/children`
- `GET /api/parental/children/:childId/settings`
- `PUT /api/parental/children/:childId/settings`
- `PUT /api/parental/children/:childId/quiet-hours`
- `PUT /api/parental/children/:childId/dm-access`
- `PUT /api/parental/children/:childId/profile-visibility`
- `DELETE /api/parental/children/:childId/link`

The gated form keeps CORS and its rate limit but drops CSRF (the response
changes no state, and a `403` would misdescribe why the call failed). None of
these appear in `/openapi.json`.
