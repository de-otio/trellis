---
title: Events API
description: Endpoints, request shapes, and semantics for the Events primitive — events, RSVPs, attendee rosters, and shift (Dienstplan) sign-ups.
sidebar: Events API
order: 33
---

# Events API

The Events primitive lets a tenant create events, collect RSVPs (with capacity
and a waitlist), and organise volunteer **shifts** (Dienstplan slots) that
members sign up for. Events carry a visibility level, a privacy-filtered
location, and — once published — a companion feed post.

- **Base path:** `/api/events`
- **Authentication:** every endpoint requires a valid session **and** an active
  tenant. Requests without one return `401`.
- **Feature flag:** the whole surface is gated by the `events_enabled` feature
  toggle (global, **off by default**). While the toggle is off, every route
  responds `404` — indistinguishable from a route that does not exist. See
  [The feature flag](#the-feature-flag).

> **Not in this version.** Ticketing / payments and recurrence / calendar
> (ICS) export are **deferred** — there are no endpoints or fields for them in
> this release.

## Roles and capabilities

Authorization uses the tenant capability model (see
[Roles and Permissions](../concepts/roles-and-permissions.md)):

| Action | Capability | Who holds it |
|---|---|---|
| Create an event | `event.create` | MEMBER and above |
| Update / cancel an event, manage its shifts | `event.update` / `event.delete` | The event **creator** (own only), or a holder of `event.moderate` (ADMIN and above) |
| Moderate any event in the tenant | `event.moderate` | ADMIN and above |
| RSVP / withdraw, sign up for / withdraw from a shift | — (role floor) | MEMBER and above |
| Read events, attendees, shifts | — | Any authenticated member (subject to visibility) |

`GUEST` cannot create, RSVP, or sign up (the `MEMBER` floor is enforced at the
route). `event.update` / `event.delete` are **own-only** for a plain MEMBER:
acting on another member's event requires `event.moderate`.

## Common conventions

- **Request bodies** are JSON; mutations require CSRF (standard middleware).
- **Error envelope:** `{ "error": "CODE", "message": "…" }`.
- **Timestamps** are ISO 8601 with offset (e.g. `2025-06-01T18:00:00Z`).
  `startsAt` / `endsAt` accept an offset; a present `endsAt` must not precede
  `startsAt`.
- **Cursor pagination:** list endpoints return `{ items, cursor, hasMore }`.
  Pass the returned `cursor` back as the `cursor` query parameter for the next
  page. The cursor is an opaque keyset token over `(startsAt, id)`.

Status codes used across the surface:

| Code | Meaning |
|---|---|
| `200` | OK (read, or an RSVP/signup that changed or was unchanged) |
| `201` | Created (event, RSVP, shift, or signup created) |
| `204` | No content (withdrawal / shift deletion) |
| `400` | `VALIDATION_ERROR` / `INVALID_JSON` — malformed body or failed schema validation |
| `401` | No valid session / no active tenant |
| `403` | Capability or role check failed |
| `404` | `NOT_FOUND` — missing, soft-cancelled-and-invisible, cross-tenant, a `GROUP_ONLY` event the caller cannot see, a `DRAFT` event to a non-creator, **or the feature toggle is off** |
| `409` | `CONFLICT` / `LIMIT_EXCEEDED` / `CAPACITY_FULL` / `EVENT_CANCELLED` / `EVENT_STARTED` |
| `429` | Per-hour write-rate limit exceeded (RSVP or event-update) |
| `500` | `INTERNAL_ERROR` |

---

## Event object

The event serialization returned by the create / get / list / update endpoints:

```typescript
{
  id: string;
  tenantId: string;
  groupId: string | null;
  creatorId: string;
  title: string;
  description: string | null;
  status: "DRAFT" | "PUBLISHED" | "CANCELLED";
  visibility: "TENANT_ONLY" | "GROUP_ONLY" | "PUBLIC";
  startsAt: string;            // ISO 8601
  endsAt: string | null;
  timezone: string;            // IANA, e.g. "Europe/Berlin"
  location: {
    precision: "EXACT" | "NEIGHBORHOOD" | "CITY" | "HIDDEN";
    label: string | null;     // locationName, suppressed at HIDDEN
    lat: number | null;       // precision-filtered (see Location privacy)
    lng: number | null;
  };
  capacity: number | null;     // null = unlimited
  rsvpCount: number;           // confirmed (GOING) seats
  waitlistCount: number;       // waitlisted seats
  announcePostId: string | null; // companion feed post, once published
  createdAt: string;
  updatedAt: string;
}
```

The response **never** exposes the raw stored `lat`/`lng` below `EXACT`
precision — `location` is always the precision-filtered view (see
[Location privacy](#location-privacy)).

## POST `/api/events`

Create an event. Requires `event.create` (MEMBER+).

**Request body** (`createEventSchema`):

| Field | Type | Notes |
|---|---|---|
| `title` | string | Required, 1–200 chars (trimmed). |
| `description` | string | Optional, ≤ 5000 chars. |
| `visibility` | enum | `TENANT_ONLY` \| `GROUP_ONLY` \| `PUBLIC`. Default `TENANT_ONLY`. |
| `groupId` | string | Optional, 1–100 chars. **Required** when `visibility` is `GROUP_ONLY`; must be a group in the caller's tenant. |
| `startsAt` | string | Required, ISO 8601 with offset. |
| `endsAt` | string | Optional; must not precede `startsAt`. |
| `timezone` | string | Optional IANA identifier, 1–64 chars. Default `Europe/Berlin`. |
| `locationName` | string | Optional, 1–300 chars. |
| `lat` | number | Optional, −90…90. |
| `lng` | number | Optional, −180…180. |
| `locationPrecision` | enum | `EXACT` \| `NEIGHBORHOOD` \| `CITY` \| `HIDDEN`. Default `CITY`. |
| `capacity` | number \| null | Optional positive integer; `null` (or omitted) = unlimited. |

New events are created `DRAFT`. `displayLat`/`displayLng` are **derived** by the
server from `locationPrecision`; they are never accepted from the client.

**Response:** `201` with the [event object](#event-object).

**Errors:** `400` validation, `403` missing `event.create`, `404`
`GROUP_NOT_FOUND` (group not in tenant), `409` `LIMIT_EXCEEDED` (tenant is at
its event cap — see [Operational limits](#operational-limits)).

## GET `/api/events`

List events in the active tenant, visibility-filtered and cursor-paginated,
ordered by `(startsAt, id)` ascending.

**Query parameters** (`eventListQuerySchema`):

| Param | Type | Notes |
|---|---|---|
| `limit` | number | 1…`listPageMax` (env-bounded), default 20. |
| `cursor` | string | Opaque keyset cursor from a previous page. |
| `upcoming` | boolean | When true, only events with `startsAt >= now`. |
| `groupId` | string | Filter to one group. |
| `status` | enum | `DRAFT` \| `PUBLISHED` \| `CANCELLED`. |

Only events the caller may see are returned: `TENANT_ONLY` and `PUBLIC` in the
active tenant, plus `GROUP_ONLY` events for groups the caller belongs to.
`DRAFT` events are excluded unless the caller is the creator or holds
`event.moderate`.

**Response:** `200` with `{ items: Event[], cursor?: string, hasMore: boolean }`.

## GET `/api/events/mine`

List the caller's **own** events in the active tenant — events they created **or**
have an RSVP on. Same query parameters and `{ items, cursor, hasMore }` shape as
`GET /api/events`. No visibility filter applies (every row is already one the
caller owns or RSVP'd to).

> This static path is matched **before** the `/api/events/:id` item route, so an
> event whose id is literally `mine` is unreachable — an accepted trade-off.

## GET `/api/events/:id`

Fetch a single event by id.

**Response:** `200` with the [event object](#event-object).

**Errors:** `404` when the event does not exist, is in another tenant, is a
`GROUP_ONLY` event the caller cannot see, or is a `DRAFT` visible only to its
creator / a moderator. A private event in another tenant is indistinguishable
from a non-existent one.

## PATCH `/api/events/:id`

Update an event (partial). Requires `event.update` — own-only for MEMBER,
unconditional for `event.moderate` holders. This route also carries the
**`DRAFT` → `PUBLISHED` publish transition** (set `status: "PUBLISHED"`).

**Request body** (`editEventSchema`): every field from
[`POST /api/events`](#post-apievents) is accepted and **optional**, plus:

| Field | Type | Notes |
|---|---|---|
| `status` | enum | `PUBLISHED` publishes a draft. `CANCELLED` is accepted but cancellation is better done via `DELETE` (both routes soft-cancel). |

`endsAt`, `locationName`, `lat`, and `lng` are nullable (send `null` to clear).
Changing `visibility` to `GROUP_ONLY` requires the event to already have a
`groupId`.

**Rate limit:** bucketed **per event** at `updateRatePerHour` writes/hour;
exceeding it returns `429`.

**Side effects:**

- **Publishing** (`DRAFT` → `PUBLISHED`) creates the companion feed post and
  stores its id as `announcePostId` (see [Feed companion post](#feed-companion-post-on-publish)).
- **A material change** (`startsAt`, `endsAt`, or `location`) to an already-
  published event updates the companion post and notifies GOING attendees with
  `EVENT_UPDATED` (see [Notifications](#notifications)).

**Response:** `200` with the updated event.

**Errors:** `400` validation, `403` capability denied, `404` not found /
cross-tenant, `409` `CONFLICT` (a `CANCELLED` event cannot be edited), `429`
rate limited.

## DELETE `/api/events/:id`

**Soft-cancel** an event: sets `status` to `CANCELLED`. The row is retained.
Requires `event.delete` (own-only for MEMBER, else `event.moderate`).
**Idempotent** — cancelling an already-cancelled event returns `200`.

Cancelling a previously **published** event retracts its companion post and
notifies GOING attendees with `EVENT_CANCELLED`.

**Response:** `200` with the cancelled event.

---

## RSVPs

### POST `/api/events/:id/rsvp`

Create or change the caller's RSVP. **MEMBER floor** (a GUEST cannot RSVP).

**Request body** (`rsvpSchema`):

| Field | Type | Notes |
|---|---|---|
| `status` | enum | `GOING` \| `MAYBE` \| `NOT_GOING`. `WAITLISTED` is **never** client-selectable — the server assigns it. |
| `guests` | number | Additional guests, 0…`maxGuestsPerRsvp` (env-bounded), default 0. **Party size = 1 + guests.** Guests count only when `status` is `GOING`. |

**Rate limit:** bucketed per `(user, event)` at `rsvpRatePerHour` writes/hour;
`429` when exceeded.

**Response:**

- `201` — a new RSVP was created.
- `200` — an existing RSVP was changed, or was unchanged.
- The returned RSVP object:

```typescript
{ id, eventId, userId, status, guests, createdAt, updatedAt }
```

The final `status` may be `WAITLISTED` even though you requested `GOING`, if the
event is at capacity (see [Capacity and waitlist](#capacity-and-waitlist)).

**Errors:**

- `404` `NOT_FOUND` — event not visible, or a `DRAFT` (RSVP is not confirmed to
  exist).
- `409` `EVENT_CANCELLED` — the event was cancelled.
- `409` `EVENT_STARTED` — the event's `startsAt` is in the past.
- `409` `CAPACITY_FULL` — growing an existing GOING party could not claim the
  extra seats (the RSVP stays at its previous size; the current row is returned
  under `rsvp`).

### DELETE `/api/events/:id/rsvp`

Withdraw the caller's RSVP. MEMBER floor. **Idempotent** — withdrawing when no
RSVP exists still returns `204`. Releasing a GOING seat promotes the oldest
fitting waitlisted RSVP.

**Response:** `204 No Content`.

### GET `/api/events/:id/attendees`

The attendee **roster** for an event. Visibility-gated like the event itself.

**Query parameters:** `limit` (1…`listPageMax`, default 20), `cursor`, and an
optional `status` filter (`GOING` | `WAITLISTED` | `MAYBE` | `NOT_GOING`).
Without a `status` filter, `GOING`, `WAITLISTED`, and `MAYBE` rows are returned
(not `NOT_GOING`).

**Response:** `200` with `{ items, cursor?, hasMore }`, where each item is:

```typescript
{ userId, status, guests, createdAt }
```

> The roster carries **no event-location fields** — it answers only *who* and
> *how many*.

---

## Shifts (Dienstplan)

Shifts are named slots on an event (e.g. "Setup 14:00–16:00", "Bar shift") with
their own capacity and waitlist. They reuse the same atomic capacity/waitlist
mechanism as RSVPs.

### Shift object

```typescript
{ id, eventId, title, startsAt, endsAt, capacity, filledCount, createdAt, updatedAt }
```

`startsAt` / `endsAt` are nullable; `filledCount` is the number of confirmed
signups.

### POST `/api/events/:id/shifts`

Create a shift. Requires `event.update` (event creator, or `event.moderate`).

**Request body** (`shiftSchema`):

| Field | Type | Notes |
|---|---|---|
| `title` | string | Required, 1–200 chars. |
| `startsAt` | string | Optional, ISO 8601 with offset. |
| `endsAt` | string | Optional; must not precede `startsAt`. |
| `capacity` | number | Required positive integer. |

**Response:** `201` with the shift object.

**Errors:** `400` validation, `403`/`404` authorization, `409` `LIMIT_EXCEEDED`
when the event is at its shift cap (`maxShiftsPerEvent`).

### GET `/api/events/:id/shifts`

List an event's shifts (ordered by creation). Any member of the event's tenant
who can see the event.

**Response:** `200` with `{ shifts: Shift[] }`.

### PATCH `/api/events/:id/shifts/:shiftId`

Update a shift (partial: `title`, `startsAt`, `endsAt`, `capacity`). Requires
`event.update`.

Reducing `capacity` below the current `filledCount` is rejected with `409`
`LIMIT_EXCEEDED` (the reduction is applied race-safely against the live fill
count — a shift is never shrunk below its confirmed signups).

**Response:** `200` with the updated shift.

### DELETE `/api/events/:id/shifts/:shiftId`

Delete a shift. Requires `event.delete`. Cascades to its signup rows.

**Response:** `204 No Content`.

### POST `/api/events/:id/shifts/:shiftId/signup`

Sign up the caller for a shift. **MEMBER floor.** The event must be `PUBLISHED`.
The body is empty (`{}`); `CONFIRMED` vs `WAITLISTED` is decided by the server's
atomic capacity check, never chosen by the caller.

**Response:**

- `201` — a new signup (the first time, or re-signing after a withdrawal).
- `200` — the caller was already signed up (idempotent; existing row returned).
- The signup object:

```typescript
{ id, shiftId, userId, status, createdAt, updatedAt }
```

`status` is `CONFIRMED` when a seat was claimed, else `WAITLISTED`.

**Errors:** `409` `CONFLICT` when the event is not open for signups (not
`PUBLISHED` or soft-cancelled); `404` when the shift/event is not visible.

### DELETE `/api/events/:id/shifts/:shiftId/signup`

Withdraw the caller's signup. Marks it `CANCELLED` (unlike RSVP withdrawal, the
row is kept so a re-signup reuses it). If the withdrawn signup was `CONFIRMED`,
the freed seat is released and the oldest `WAITLISTED` signup is promoted.

**Response:** `204 No Content`. Returns `404` when there is no active signup to
withdraw.

---

## Capacity and waitlist

Events and shifts share one capacity model:

- **`capacity` is seat-based.** An RSVP's party size is `1 + guests`; a shift
  signup is always one seat.
- **`capacity: null` means unlimited** (events only; shift capacity is always a
  positive integer).
- A seat claim is a single **atomic conditional update** guarded by the live
  count under a row lock. Its affected-row count decides `GOING`/`CONFIRMED`
  versus `WAITLISTED`, so concurrent claims for the last seat can never both
  win and the count can never exceed capacity.
- **Waitlist promotion is FIFO.** When a confirmed seat is released (a
  withdrawal, a downgrade to `MAYBE`/`NOT_GOING`, or a party shrink), the oldest
  waitlisted entry that fits is promoted. Promotion stops at the first oldest
  entry that does not fit.
- `Event.rsvpCount` counts confirmed (GOING) seats; `Event.waitlistCount` counts
  waitlisted seats; `EventShift.filledCount` counts confirmed shift seats.

For RSVPs, **growing** a GOING party claims only the delta; if the delta cannot
be claimed the change is rejected with `409 CAPACITY_FULL` and the party stays
at its previous size. Guests are immutable while an RSVP is waitlisted.

## Event visibility

`visibility` controls who can read an event and how it federates:

| Visibility | Who can read | Companion post |
|---|---|---|
| `PUBLIC` | Any authenticated caller, any tenant | Feed post at `SHOUT` radius (federates) |
| `TENANT_ONLY` | Members of the event's tenant | Feed post at `NORMAL` radius (no federation) |
| `GROUP_ONLY` | The event's tenant **and** members of `event.groupId` (plus the creator / moderators) | **None** — no feed radius safely limits to a group |

`DRAFT` events are visible only to their creator and to `event.moderate` holders
of the owning tenant, regardless of `visibility`. Cross-tenant reads of a
non-`PUBLIC` event return `404`.

## Location privacy

Each event stores true coordinates but only ever **serves** a precision-filtered
location, derived from `locationPrecision`:

| Precision | `label` | `lat` / `lng` served |
|---|---|---|
| `EXACT` | location name | the true coordinates |
| `NEIGHBORHOOD` | location name | a **fuzzed** display pair (`displayLat`/`displayLng`), randomised within a configured radius |
| `CITY` | location name | none |
| `HIDDEN` | none | none |

The fuzzed display coordinates for `NEIGHBORHOOD` are computed server-side and
stored separately; raw `lat`/`lng` are never returned below `EXACT`. The same
filtering applies to the companion feed post body.

## Feed companion post on publish

When an event is published (`DRAFT` → `PUBLISHED`), Trellis creates a companion
feed **Post** authored by the event creator and stores its id as
`announcePostId`:

- `PUBLIC` → post at `SHOUT` radius (federates via ActivityPub when federation
  is enabled).
- `TENANT_ONLY` → post at `NORMAL` radius (no federation).
- `GROUP_ONLY` → **no companion post** is created (`announcePostId` stays null).

A later material change updates the companion post (ActivityPub `Update`);
cancellation retracts it (ActivityPub `Delete`).

## Notifications

Two notification types target the event's current **GOING** attendees:

- **`EVENT_UPDATED`** — a published event's `startsAt`, `endsAt`, or `location`
  changed. Repeated updates to one event are debounced/consolidated within
  `updateNotifyCooldownSeconds` to prevent notification amplification.
- **`EVENT_CANCELLED`** — a published event was cancelled.

Delivery respects each recipient's notification preferences and is best-effort:
a notification failure never fails the underlying event write. RSVP changes and
shift signups do not themselves emit notifications.

## Operational limits

The following are runtime-configurable (env-driven) with conservative defaults;
operators tune them per environment. See the
[Operations guide](../getting-started/for-operations.md#events) for the variable
names and defaults.

| Limit | Effect when exceeded |
|---|---|
| Max events per tenant (live, non-cancelled) | `409 LIMIT_EXCEEDED` on create |
| Max shifts per event | `409 LIMIT_EXCEEDED` on shift create |
| Max guests per RSVP | `guests` is validated/clamped at the request boundary |
| RSVP writes per user per hour | `429` |
| Event-update writes per event per hour | `429` |
| Max list page size | caps the `limit` query parameter |

Cancelling an event frees its tenant slot (only live, non-`CANCELLED` events
count toward the per-tenant cap).

## The feature flag

The entire Events surface is gated by the **`events_enabled`** global feature
toggle, **off by default**. While it is off, every `/api/events…` route returns
`404` and resolution fails closed to disabled if the toggle cannot be read.
Enable it per environment (or per tenant via a `setToggle` override) as
described in the [Feature Flags guide](../guides/feature-flags.md), after the
events schema migration has been applied. See also the
[Operations guide](../getting-started/for-operations.md#events).
