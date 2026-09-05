---
title: Blocks API
description: Block, unblock, and list blocked users — the user-side remedy surface, and what a block changes on the read and write paths.
sidebar: Blocks API
order: 33
---

# Blocks API

A user can block another user in the same tenant. A block is **bidirectional
on the read paths** — neither party sees the other's posts or comments — and
it **refuses writes across the block**: the blocked account cannot comment on,
reply under, or react to the blocker's content, and vice versa. Blocking also
deletes both directed relationship edges between the two users in the same
transaction as the block row, so the blocked account leaves the blocker's
audience immediately rather than lingering via a stale edge.

- **Base path:** `/api/blocks`
- **Authentication:** every route requires **both** a valid session and a
  JWT that resolves to an active tenant. Either missing →
  `401 {"error":"Unauthorized"}`. The tenant is taken from the JWT, never
  from the request body: `blocked_users` is tenant-scoped by its unique key,
  so a caller who could name the tenant could write a block into a tenant it
  does not belong to.
- **CSRF:** required on `POST` and `DELETE`, like every other
  cookie-authenticated write.
- **Rate limit:** `POST` and `DELETE` use the default route rate limit (a
  token bucket of 20 requests per minute); exceeding it returns `429` with
  `X-RateLimit-*` headers. `GET` carries no route-level limit.
- Every response carries the standard security headers.

## POST `/api/blocks`

Block a user.

**Request body** (strict — unknown fields are rejected):

```json
{ "userId": "cmqurmq7x000002i80nqmgfr8" }
```

`userId` is the target's Trellis `User.id` (1–100 characters). The target must
be an `ACTIVE` member of the caller's active tenant.

**Response (201 Created)** — a new block:

```json
{
  "blockedUserId": "cmqurmq7x000002i80nqmgfr8",
  "createdAt": "2026-09-04T10:15:00.000Z",
  "alreadyBlocked": false,
  "relationshipsRemoved": 2
}
```

`relationshipsRemoved` is the number of directed relationship edges deleted
between the two users in the same transaction (0, 1 or 2).

**Response (200 OK)** — the block already existed. Blocking is idempotent: a
repeat returns the existing block with `alreadyBlocked: true` and
`relationshipsRemoved: 0`, not a `409`. The caller asked for a state ("this
account is blocked") that already holds, and a client retrying after a
dropped response must not have to distinguish its own retry from a failure. A
lost unique-key race is treated the same way.

**Errors:**

| Status | `error`            | When                                                                                                                              |
| ------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR` | Malformed JSON, an unknown field, a missing or oversized `userId`, or `userId` is the caller's own id (`"Cannot block yourself"`) |
| `401`  | `Unauthorized`     | No session, or the JWT carries no active tenant                                                                                   |
| `404`  | `NOT_FOUND`        | The target is not an active member of the caller's tenant                                                                         |
| `429`  | —                  | Rate limit exceeded                                                                                                               |
| `500`  | `INTERNAL_ERROR`   | Unexpected database failure — never reported as success                                                                           |

## DELETE `/api/blocks/:userId`

Unblock a user. Deletes only the caller's **own outgoing** block; a block the
other user holds against the caller is untouched.

**Response:** `204 No Content`. Idempotent — unblocking someone who was not
blocked is also `204`.

**Errors:** `400 VALIDATION_ERROR` when the path parameter is empty, `401`,
`429`, `500`.

## GET `/api/blocks`

List the caller's **outgoing** blocks, newest first.

**Query parameters:**

| Parameter | Default | Meaning                                                                                                                        |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `limit`   | `50`    | Page size, clamped to `1..100`                                                                                                 |
| `cursor`  | —       | Opaque keyset cursor from a previous page. A cursor the server did not issue is ignored (you get the first page), not an error |

**Response (200):**

```json
{
  "blocks": [
    {
      "userId": "cmqurmq7x000002i80nqmgfr8",
      "createdAt": "2026-09-04T10:15:00.000Z"
    }
  ],
  "cursor": "eyJjcmVhdGVkQXQiOi4uLn0",
  "hasMore": false
}
```

`cursor` is present only when `hasMore` is `true`. Pagination is an exact
`(createdAt, id)` keyset — the same encoding as the home feed's — so pages never
skip or repeat a row.

## What a block changes

Everything below is applied by core; a client does not have to filter.

- **Read paths, both directions.** The home feed, the single-post read, the
  post-read authorizer, the comment thread, sentiment counts, who-reacted, and
  the recommendation surfaces all exclude the other party's content. The
  exclusion is a `WHERE authorId NOT IN (…)` conjunct inside the same query
  that paginates — never a post-filter over an already-paginated page — so
  `hasMore` and the cursor always agree with the rows returned. The comment
  thread additionally hides a blocked account's comments under a third party's
  post, which the post-level gate cannot see.
- **Write guard.** Commenting, replying, and reacting (to a post or a comment)
  across a block are refused with
  `403 {"error":"BLOCKED", "message", "remediation"}`, symmetric in both
  directions, and succeed again once the block is lifted.
- **Relationships.** Both directed relationship edges are deleted with the
  block. Unblocking does not restore them.
- **Freshness.** Block and unblock bump the feed cache version, so the change
  is visible on the next request rather than when the cached feed expires.
- **Notifications.** The realtime delivery floor already consulted the block
  table before this API existed; it continues to.

There is no schema change for this surface: the `blocked_users` table
pre-dated the routes and had no write path until they landed.

## See also

- [Feed ordering](../concepts/feed-ordering.md) — block filtering narrows what
  is eligible for the feed; it never affects order.
- [Content reports API](./content-reports-api.md) — the other user-side
  remedy: reporting content rather than hiding an account.
