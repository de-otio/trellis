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

Update profile settings.

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
  "created_at": "2025-01-01T00:00:00Z"
}
```

**Errors:** `400` invalid body, `401` invalid or missing session, `500` server
error.

## POST `/api/user/region-preference`

Set the user's region preference.

**Request body:**

```json
{ "region": "EU" }
```

**Response (200):**

```json
{ "success": true, "region": "EU" }
```

**Errors:** `400` invalid region, `401`, `500`.

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
  "consent": {
    "dataRegion": "US",
    "accessRegion": "EU",
    "consented": true,
    "consentedAt": "2025-01-01T00:00:00Z"
  }
}
```

**Errors:** `400` invalid body, `401`, `500`.
