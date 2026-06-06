---
title: Core Profile
description: The built-in profile fields, region preference, and cross-region consent that every Trellis user account carries.
sidebar: Core Profile
order: 20
---

# Core Profile

Every user account in Trellis carries a set of built-in profile fields that are
independent of any vertical extension. These cover basic account settings,
region preference, and cross-region data-access consent.

## Profile settings

Users can update their basic profile preferences via `PATCH /api/user/profile`.

The following fields are **read-only** — managed by the system, not
user-editable:

- **Email** — managed by the authentication system
- **Role** — assigned by the system
- **Account creation date**

## Region preference

Users can declare a preferred data region via `POST /api/user/region-preference`.

Supported values:

| Value | Region |
|-------|--------|
| `US`  | United States |
| `EU`  | European Union |

The declared preference is used for data-storage compliance, regional data
routing, and cross-region access consent decisions.

## Cross-region consent

When a user's data is stored in one region but they access the platform from
another, explicit consent is required (GDPR compliance). Users grant or update
that consent via `POST /api/user/cross-region-consent`.

Consent is recorded as an append-only history rather than a single overwritten
flag, so the full consent trail is preserved.

## Data model

Key fields on the `User` model relevant to the core profile:

| Field | Description |
|-------|-------------|
| `region` | User's preferred / detected region |
| `dataRegion` | Region where the user's data is stored |
| `createdAt` | Account creation timestamp |
