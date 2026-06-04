# API Endpoints

**Status:** partial — core profile endpoints implemented; transparency endpoints designed, not yet implemented

## Overview

API endpoints for user-profile management, privacy settings, and account-transparency features.

**Base path:** `/api/user` or `/api/users`
**Authentication:** all endpoints require a valid session (session cookie).

> The transparency endpoints and code samples below are **illustrative pseudocode**. They predate the current `Post` audience model (`radius` enum + `Privacy`) and reference a `visibility: "PUBLIC"` field that does not exist on the trellis `Post` model. Treat the public-post checks as "any post whose audience is public" — see [03-account-transparency.md §open-questions](./03-account-transparency.md#open-questions).

## Core profile endpoints

### PATCH `/api/user/profile`

Update user profile settings. **Status:** implemented.

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

**Errors:** `401` invalid/missing session, `400` invalid body, `500` server error.

### POST `/api/user/region-preference`

Update user region preference. **Status:** implemented.

**Request body:**

```json
{ "region": "US" }
```

`region` ∈ `"US" | "EU" | "CN"`.

**Response (200):**

```json
{ "success": true, "region": "US" }
```

**Errors:** `401`, `400` invalid region, `500`.

### POST `/api/user/cross-region-consent`

Record user consent for cross-region data access. **Status:** implemented.

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

Consent is persisted to the append-only `Consent` model (`purpose = CROSS_REGION`). See [05-data-model.md §Consent model](./05-data-model.md#consent-model).

**Errors:** `401`, `400` invalid body, `500`.

## Account-transparency endpoints

### GET `/api/users/:userId/profile-transparency`

Get transparency fields for a user profile. **Status:** not implemented.

**Response (200):**

```json
{
  "accountCreatedAt": "2025-01-01T00:00:00Z",
  "location": "US",
  "vpnDetected": false,
  "usernameChangeCount": 2,
  "visibleTo": "friends"
}
```

**Response (200 — limited visibility):**

```json
{
  "accountCreatedAt": "2025-01-01T00:00:00Z",
  "location": null,
  "vpnDetected": null,
  "usernameChangeCount": null,
  "message": "Transparency fields are only visible to friends, or to everyone when you have public posts."
}
```

**Visibility logic:**

1. A user can always see their own transparency data.
2. Friends can always see transparency data.
3. Followers and the general public can see it if the user has public posts (`hasPublicPosts = true`) and has not hidden transparency (`locationDisplayEnabled = true`).

**Errors:** `401`, `404` user not found, `500`.

**Illustrative implementation** (pseudocode — friend resolution goes through the graph service; the public-post check assumes a public audience):

```typescript
// GET /api/users/:userId/profile-transparency
async function getTransparencyFields(
  userId: string,
  viewerId: string | null,
  env: Env,
): Promise<Response> {
  const db = createPrisma(env);

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      createdAt: true,
      region: true,
      locationDisplayEnabled: true, // not yet in schema
      vpnDetectedAtLastLogin: true, // not yet in schema
      hasPublicPosts: true, // not yet in schema
      usernameHistory: { select: { id: true } }, // not yet in schema
    },
  });

  if (!user) {
    return new Response("User not found", { status: 404 });
  }

  // Friendship is a bidirectional graph relationship — resolve via the
  // graph service, not a Prisma join.
  let isFriend = false;
  if (viewerId && viewerId !== userId) {
    isFriend = await env.graph.areFriends(userId, viewerId);
  }

  const isOwnProfile = viewerId === userId;
  const canSeeTransparency =
    isOwnProfile ||
    isFriend ||
    (user.hasPublicPosts && user.locationDisplayEnabled);

  if (!canSeeTransparency) {
    return new Response(
      JSON.stringify({
        accountCreatedAt: user.createdAt.toISOString(),
        location: null,
        vpnDetected: null,
        usernameChangeCount: null,
        message:
          "Transparency fields are only visible to friends, or to everyone when you have public posts.",
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      accountCreatedAt: user.createdAt.toISOString(),
      location: user.locationDisplayEnabled ? user.region : null,
      vpnDetected: user.vpnDetectedAtLastLogin,
      usernameChangeCount: user.usernameHistory.length,
      visibleTo: isOwnProfile ? "you" : isFriend ? "friends" : "everyone",
    }),
    { headers: { "content-type": "application/json" } },
  );
}
```

### PATCH `/api/user/profile-transparency/hide`

Hide transparency fields from followers and the general public (they remain visible to friends). **Status:** not implemented.

**Request body:** none (uses the authenticated user).

**Response (200):**

```json
{ "success": true }
```

**Error (403 — has public posts):**

```json
{
  "error": "CANNOT_HIDE_TRANSPARENCY",
  "message": "You must make all public posts private before hiding transparency fields from the general public. You currently have 3 public post(s). Note: Fields will remain visible to your friends.",
  "publicPostCount": 3
}
```

### PATCH `/api/posts/make-all-private`

Make all public posts private (required before hiding transparency fields). **Status:** not implemented. Returns `{ "success": true, "postsUpdated": N }`.

## Post handler integration

When creating or updating posts, automatically maintain the transparency flags. **Status:** not implemented.

```typescript
// On creation of a post with a public audience
async function handlePublicPostCreation(userId: string, env: Env): Promise<void> {
  const db = createPrisma(env);
  await db.user.update({
    where: { id: userId },
    data: { hasPublicPosts: true, locationDisplayEnabled: true },
  });
}

// On a post's audience changing away from public
async function handlePostAudienceChange(
  userId: string,
  wasPublic: boolean,
  isPublic: boolean,
  env: Env,
): Promise<void> {
  const db = createPrisma(env);
  if (wasPublic && !isPublic) {
    const remaining = await db.post.count({
      where: { authorId: userId, /* public-audience predicate */ deletedAt: null },
    });
    if (remaining === 0) {
      await db.user.update({ where: { id: userId }, data: { hasPublicPosts: false } });
    }
  } else if (!wasPublic && isPublic) {
    await db.user.update({
      where: { id: userId },
      data: { hasPublicPosts: true, locationDisplayEnabled: true },
    });
  }
}
```

## Related

- [Core Profile Management](./01-core-profile.md)
- [Privacy Settings](./02-privacy-settings.md)
- [Account Transparency](./03-account-transparency.md)
- [Data Model](./05-data-model.md)
