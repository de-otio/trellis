---
title: User profile API
description: Endpoints for managing user profile settings, region preference, and cross-region data-access consent.
sidebar: User profile API
order: 32
---

# User profile API

Endpoints for managing a user's profile settings, region preference, and
cross-region data-access consent.

- **Base path:** `/api/user`
- **Authentication:** all endpoints require a valid session.

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
