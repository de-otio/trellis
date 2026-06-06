---
title: Privacy Settings
description: User-facing privacy controls for online presence, location, and analytics.
sidebar: Privacy Settings
order: 40
---

# Privacy Settings

Privacy settings let users control their online presence, location data, and analytics participation. These controls *reduce* what a user exposes to others — distinct from account transparency settings, which *increase* the visibility of account metadata.

> **Implementation status.** Of the settings below, only **stealth mode** is
> currently writable through the user API (`PATCH /api/user/profile`, field
> `stealth_mode`). The presence, location, and analytics fields exist on the
> `User` model with the documented defaults, but Trellis does not yet expose a
> user-facing endpoint to change them individually, and the presence/location
> behaviours they describe are not yet enforced. They are documented here
> because they are part of the data model and govern future behaviour.

### Stealth mode

Hides online status, typing indicators, and last-seen information from other users.

| State | Behaviour |
|-------|-----------|
| Enabled | User appears offline; no typing indicators; last-seen hidden |
| Disabled | Normal presence indicators shown |

**Field:** `stealthMode` (Boolean, default `false`)

### Online-status visibility

Granular control over which presence signals are visible.

| Field | Default | Description |
|-------|---------|-------------|
| `showOnlineStatus` | `true` | Show or hide online status |
| `showTypingIndicator` | `true` | Show or hide typing indicators |
| `showLastSeen` | `true` | Show or hide last-seen timestamp |

### Location tracking

Controls location data collection for posts and content.

| Field | Default | Description |
|-------|---------|-------------|
| `locationTrackingEnabled` | `true` | Enable or disable location tracking |
| `locationAnonymizationLevel` | `0` | Location precision (see below) |

**Anonymization levels:**

| Value | Precision |
|-------|-----------|
| `0` | Exact location |
| `1` | ~100 m |
| `2` | ~1 km |
| `3` | City-level |

> Note: this is separate from location *display* in account transparency settings.

### Analytics opt-out

| Field | Default | Description |
|-------|---------|-------------|
| `analyticsOptOut` | `false` | When `true`, the user's activity is excluded from analytics |

## Data model

See [Core profile](../concepts/core-profile.md) for how profile fields fit together, and the [user-profile API](../reference/user-profile-api.md) for the `PATCH /api/user/profile` endpoint that updates `stealth_mode`.
