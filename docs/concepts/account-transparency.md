---
title: Account Transparency
description: How Trellis surfaces account-authenticity signals through an "About this profile" view, governed by friendship and public-post visibility rules.
sidebar: Account Transparency
order: 60
---

# Account Transparency

Account-transparency surfaces account metadata so people can assess how
authentic an account is. The idea follows the "About this profile" pattern seen
on large social platforms: exposing signals — such as account age — that help
distinguish genuine accounts from bots, coordinated influence operations, and
impersonators.

## Transparency signals

The transparency view is built around a small set of authenticity signals.

### Account creation date

The account's creation date is always available, drawn from `createdAt` on the
`User` model.

- **Purpose:** helps identify new or suspicious accounts.
- **Privacy impact:** low — it reveals only when the account was created.
- **Visibility:** always visible — to friends, followers, and the general
  public. It cannot be hidden.

Displayed as "Account created: [date]".

### Region

A region-level signal (for example "US" or "EU"), never an exact location.

- **Purpose:** helps surface signals relevant to foreign influence operations.
- **Privacy impact:** medium — region-level only.
- **Accuracy caveat:** the view notes that a country or region may not be
  accurate, since location data can reflect recent travel rather than a base
  location.

Displayed as "Location: [region]" or "Location: Not disclosed".

### VPN status

An indicator of whether a VPN was detected.

- **Purpose:** a useful signal when assessing potentially manipulative accounts.
- **Privacy impact:** low — it indicates only that a VPN was in use, never which
  service.
- **Important:** VPN users are never blocked. Using a VPN is a legitimate privacy
  choice; transparency only surfaces it.

Displayed as a "Using VPN" indicator when detected.

### Username-change count

A count of how many times the account's username has changed.

- **Purpose:** frequent username changes can indicate account manipulation.
- **Privacy impact:** low — only the count is shown; the underlying history stays
  private.

Displayed as "Username changed [X] times".

## Visibility rules

Transparency visibility is governed by friendship and by whether the user posts
publicly.

### Friends

Transparency signals are **always visible to friends**, regardless of any other
setting. Friendship is a bidirectional relationship resolved through the graph
layer.

### Followers and the general public

- **The user has public posts** — transparency signals are visible to everyone.
- **The user has no public posts** — the user may hide transparency signals from
  followers and the general public.
- **Automatic re-exposure** — if a user with hidden transparency signals creates a
  new public post, the signals become visible again automatically.

## "About this profile"

A dedicated profile-transparency section, reachable from a user's profile,
gathers these signals in one place:

- Account creation date
- Location (when the user allows it and has public posts)
- VPN status (when detected)
- Username-change count
- Identity-verification status and method (when the consuming application
  implements verification)

## Efficient evaluation

Two strategies keep transparency reads cheap:

- **Friendship first.** Because friends always see transparency signals, the
  viewer's friendship is checked before the public-visibility rules are
  evaluated.
- **Cached public-posts flag.** A cached "has public posts" boolean avoids
  recomputing an expensive count on every read. It is maintained as posts are
  created, deleted, or have their audience changed: creating a public post sets
  the flag, and removing or re-scoping posts rechecks whether any public post
  remains.

## Related

- [Core Profile](./core-profile.md)
