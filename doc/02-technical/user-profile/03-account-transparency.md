# Account Transparency

**Status:** design — not yet implemented (transparency fields and `UsernameHistory` are not yet in the Prisma schema; see [open questions](#open-questions))

## Overview

Account-transparency features expose account metadata so users can assess account authenticity. The pattern is inspired by the "About this profile" feature on large social platforms: surfacing signals (account age, detected region, VPN usage, username churn) that help identify potentially manipulative accounts (bots, coordinated influence operations, impersonators).

**Policy:** transparency fields are **always visible to friends**, regardless of other settings. For followers and the general public, visibility depends on whether the user has public-radius posts.

## Transparency fields

### 1. Account creation date

**Status:** already available (`createdAt` on `User`).

- **Purpose:** helps identify new / suspicious accounts.
- **Privacy impact:** low — only shows when the account was created.
- **Visibility:** always visible to friends; always visible to followers and the general public (cannot be hidden).

**Display:** "Account created: [date]".

### 2. Detected region

**Status:** planned (requires a `locationDisplayEnabled` field, not yet in schema).

- **Field:** `region` (String) — region-level only, not exact location.
- **Purpose:** helps identify foreign influence operations.
- **Privacy impact:** medium — shows region-level location (e.g. "US", "EU", "Eastern Europe").
- **Visibility:** always visible to friends; visible to followers and the general public when the user has public posts (hideable when they have none).
- **Accuracy warning:** must display "Country or region may not be accurate" — location data can reflect recent travel rather than base location.

**Display:** "Location: [region]" or "Location: Not disclosed".

### 3. VPN detection status

**Status:** not implemented (requires a `vpnDetectedAtLastLogin` field, not yet in schema).

- **Purpose:** high-value signal for identifying manipulative accounts.
- **Privacy impact:** low — only indicates VPN usage, not which VPN service.
- **Visibility:** always visible to friends; visible to followers and the general public when the user has public posts (hideable when they have none).
- **Important:** do **not** block VPN users — only provide transparency (VPN use is a legitimate privacy choice).

**Display:** "Using VPN" indicator if detected.

### 4. Username-change count

**Status:** not implemented (requires a `UsernameHistory` model, not yet in schema).

- **Purpose:** helps identify account manipulation (frequent username changes).
- **Privacy impact:** low — only shows the count, not the history details.
- **Visibility:** always visible to friends; visible to followers and the general public when the user has public posts (hideable when they have none).

**Display:** "Username changed [X] times" (history details remain private).

## Visibility rules

### Friends

Transparency fields are **always visible to friends**, regardless of other settings. Friendship is a bidirectional relationship resolved through the graph layer (Postgres edge tables), not a Prisma relation.

### Followers and general public

- **User has public posts** — transparency fields are visible to everyone.
- **User has no public posts** — the user can hide transparency fields from followers and the general public.
- **Automatic re-exposure** — if a user with hidden transparency fields creates a new public post, the fields automatically become visible again.

See [API Endpoints — `GET /api/users/:userId/profile-transparency`](./04-api.md#get-apiusersuseridprofile-transparency) for the visibility-check implementation.

## "About this profile" section

A dedicated profile-transparency section accessible from a user's profile.

**Content:**

- Account creation date
- Location (if the user allows it and has public posts)
- VPN status (if detected)
- Username-change count
- Identity-verification status (if the consuming application implements verification)
- Verification method (if verified)

## Implementation strategy

### Efficient tracking

- **Cached boolean:** a `hasPublicPosts` flag avoids expensive COUNT queries on every transparency read.
- **Automatic updates:** update flags when posts are created / deleted / their audience changes.
- **Relationship check first:** check whether the viewer is a friend (friends always see) before computing public-visibility rules.

### Automatic updates

- **On public-post creation:** set `hasPublicPosts = true` and force `locationDisplayEnabled = true`.
- **On post-audience change:** recompute flags based on whether any public posts remain.
- **On post deletion:** recheck whether any public posts exist and update `hasPublicPosts` accordingly.

See [API Endpoints — Post handler integration](./04-api.md#post-handler-integration).

## Open questions

- The transparency fields (`vpnDetectedAtLastLogin`, `locationDisplayEnabled`, `hasPublicPosts`) and the `UsernameHistory` model are **not yet in the Prisma schema**.
- The "has public posts" signal assumes a `PUBLIC`/`PRIVATE` post-visibility model. The current `Post` model expresses audience via the `radius` enum (`WHISPER`/`NORMAL`/`LOUD`/`SHOUT`) plus the `Privacy` enum — there is no single `visibility` field. Mapping "has public posts" onto the radius model (likely "any post with `radius = SHOUT`") must be settled before implementation, and the API/data-model snippets that reference `visibility: "PUBLIC"` are illustrative pseudocode pending that decision.

## Related

- [API Endpoints](./04-api.md)
- [Data Model](./05-data-model.md)
- [Privacy Settings](./02-privacy-settings.md)
