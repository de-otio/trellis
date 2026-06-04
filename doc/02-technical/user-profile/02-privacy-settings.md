# Privacy Settings

**Status:** implemented (schema fields present; enforcement is a per-consumer concern)

## Overview

Privacy settings let users control their online presence, location tracking, and analytics participation. These *reduce* what the user exposes — distinct from [Account Transparency](./03-account-transparency.md), which *increases* visibility of account metadata.

The fields below exist on the `User` model as preparatory privacy controls; default values preserve current (non-restrictive) behavior so adding them is non-breaking. Enforcing them in presence indicators, location handling, and analytics emission is the consuming application's responsibility.

## Features

### 1. Stealth mode

**Purpose:** hide online status, typing indicators, and last-seen information from other users.

**Behavior:**

- Enabled — user appears offline, no typing indicators shown, last-seen hidden
- Disabled — normal presence indicators shown

**Field:** `stealthMode` (Boolean, default `false`)

### 2. Online-status visibility

**Purpose:** control which presence information is visible to others.

**Fields:**

- `showOnlineStatus` — show/hide online status (default `true`)
- `showTypingIndicator` — show/hide typing indicators (default `true`)
- `showLastSeen` — show/hide last-seen timestamp (default `true`)

### 3. Location tracking

**Purpose:** control location data collection for posts and content.

**Fields:**

- `locationTrackingEnabled` — enable/disable location tracking (default `true`)
- `locationAnonymizationLevel` — location precision (default `0`)
  - `0` = exact location
  - `1` = 100m precision
  - `2` = 1km precision
  - `3` = city-level precision

**Note:** this is separate from location *display* in account transparency. See [Account Transparency](./03-account-transparency.md) for transparency-related location features.

### 4. Analytics opt-out

**Purpose:** allow users to opt out of analytics tracking.

**Field:** `analyticsOptOut` (Boolean, default `false`)

**Behavior:** when enabled, the user's activity is not tracked for analytics purposes.

## Data model

See [Data Model — Privacy fields](./05-data-model.md#privacy-fields) for complete field definitions.

## Related

- [API Endpoints](./04-api.md)
- [Data Model](./05-data-model.md)
- [Account Transparency](./03-account-transparency.md) — different from privacy settings
