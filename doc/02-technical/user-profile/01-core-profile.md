# Core Profile Management

**Status:** implemented

## Overview

Core profile management covers basic account settings, profile information, and region preferences available to every user regardless of how the consuming application frames them (consumer vs. tenant/business user).

## Features

### 1. Profile settings

Users can update their basic profile preferences and settings.

**Read-only fields** (managed by the system, not user-editable):

- Email — managed by the authentication system (Cognito)
- Role — assigned by the system
- Account creation date

See [API Endpoints — `PATCH /api/user/profile`](./04-api.md#patch-apiuserprofile).

### 2. Region preferences

Users can set their preferred data region for compliance purposes.

**Supported regions:**

- `US` — United States
- `EU` — European Union
- `CN` — China (future)

**Purpose:**

- Data storage compliance
- Regional data routing
- Cross-region access consent

See [API Endpoints — `POST /api/user/region-preference`](./04-api.md#post-apiuserregion-preference).

### 3. Cross-region consent

Users can provide consent for cross-region data access (GDPR compliance).

**Use case:** when a user's data is stored in one region but they access from another, explicit consent is required. Consent is recorded as an append-only history (see the `Consent` model in [05-data-model.md](./05-data-model.md#consent-model)).

See [API Endpoints — `POST /api/user/cross-region-consent`](./04-api.md#post-apiusercross-region-consent).

## Data model

See [Data Model — User model](./05-data-model.md#user-model) for complete field definitions. Key fields:

- `region` — user's preferred / detected region (US, EU, CN)
- `dataRegion` — region where the user's data is stored (for compliance)
- `createdAt` — account creation timestamp

## Related

- [API Endpoints](./04-api.md)
- [Data Model](./05-data-model.md)
- [Privacy Settings](./02-privacy-settings.md)
