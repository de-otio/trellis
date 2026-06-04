# Data Model

**Status:** partial — core profile, privacy, and region fields are in the schema; the account-transparency fields and `UsernameHistory` are not yet added.

> **Canonical source:** the `User`, `Consent`, and `Post` models live in `prisma/schema.prisma`. The snippets below summarize the profile-relevant fields and flag implemented vs. not-yet-added. Where this doc diverges from `schema.prisma`, the schema wins.

## Overview

Database schema for user-profile features: core profile management, privacy settings, region/consent, and the (not-yet-implemented) account-transparency fields.

## User model

### Core fields

```prisma
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  role      UserRole @default(END_USER)
  createdAt DateTime @default(now()) @map("created_at")

  // ActivityPub identity (federation), not AT Protocol
  actorUri String? @unique @map("actor_uri")
  handle   String? // "@user@example.com"

  // Cognito auth integration
  cognitoSub String? @unique @map("cognito_sub")
  // ... other fields
}
```

**Status:** implemented.

> The `id` is a CUID (`@default(cuid())`) — authentication is AWS Cognito (`cognitoSub` links to the pool). Earlier drafts described a Supabase UUID `@id` and AT-Protocol `did`/`handle` fields; those are obsolete. The federation identity fields are `actorUri` (ActivityPub actor URI) and `handle` (ActivityPub handle).

### Privacy fields

```prisma
model User {
  // Stealth mode
  stealthMode Boolean @default(false) @map("stealth_mode")

  // Presence visibility
  showOnlineStatus    Boolean @default(true) @map("show_online_status")
  showTypingIndicator Boolean @default(true) @map("show_typing_indicator")
  showLastSeen        Boolean @default(true) @map("show_last_seen")

  // Location tracking — 0=exact, 1=100m, 2=1km, 3=city-level
  locationTrackingEnabled    Boolean @default(true) @map("location_tracking_enabled")
  locationAnonymizationLevel Int     @default(0) @map("location_anonymization_level")

  // Analytics
  analyticsOptOut Boolean @default(false) @map("analytics_opt_out")
}
```

**Status:** implemented (preparatory — defaults preserve non-restrictive behavior; enforcement is per-consumer).

**Field descriptions:**

- `stealthMode` — hide online status, typing indicators, and last seen
- `showOnlineStatus` / `showTypingIndicator` / `showLastSeen` — per-signal presence visibility
- `locationTrackingEnabled` — enable/disable location tracking for posts
- `locationAnonymizationLevel` — location precision (0=exact, 1=100m, 2=1km, 3=city)
- `analyticsOptOut` — opt out of analytics tracking

### Region fields

```prisma
model User {
  region     String  @default("EU") @map("region")  // US, EU, CN
  dataRegion String? @map("data_region")             // where data is stored (compliance)
}
```

**Status:** implemented (preparatory — `dataRegion` routing activates when China expansion ships).

### Transparency fields (not yet implemented)

These fields are referenced by [03-account-transparency.md](./03-account-transparency.md) but are **not yet in `schema.prisma`**. Shown as a proposed addition:

```prisma
model User {
  // PROPOSED — not yet in schema
  vpnDetectedAtLastLogin Boolean? @map("vpn_detected_at_last_login")
  locationDisplayEnabled Boolean  @default(true) @map("location_display_enabled")
  hasPublicPosts         Boolean  @default(false) @map("has_public_posts") // cached, avoids COUNT
  usernameHistory        UsernameHistory[]
}
```

- `createdAt` and `region` already exist and serve the "account created" and "detected region" signals.
- The remaining fields are proposed. Adding them depends on settling the "has public posts" mapping against the `Post` audience model (see below).

## UsernameHistory model (not yet implemented)

Proposed model to track username changes for transparency (helps identify account manipulation):

```prisma
model UsernameHistory {
  id          String   @id @default(cuid())
  userId      String   @map("user_id")
  oldUsername String?  @map("old_username")
  newUsername String   @map("new_username")
  changedAt   DateTime @default(now()) @map("changed_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([changedAt])
  @@map("username_history")
}
```

## Consent model

Cross-region (and research) consent is recorded in the `Consent` model — an append-only history keyed by a `purpose` discriminator:

```prisma
model Consent {
  id           String         @id @default(cuid())
  userId       String         @map("user_id")
  purpose      ConsentPurpose @default(CROSS_REGION)
  studyId      String?        @map("study_id")     // research rows only
  dataRegion   String?        @map("data_region")  // cross-region rows only
  accessRegion String?        @map("access_region")
  consented    Boolean        @default(false)
  consentedAt  DateTime?      @map("consented_at")
  withdrawnAt  DateTime?      @map("withdrawn_at")
  ipAddress    String?        @map("ip_address")
  userAgent    String?        @map("user_agent")
  active       Boolean        @default(true)        // history discriminator
  supersededAt DateTime?      @map("superseded_at")
  createdAt    DateTime       @default(now()) @map("created_at")
  updatedAt    DateTime       @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, purpose, studyId])
  @@index([userId])
  @@index([consented])
  @@index([dataRegion, accessRegion])
  @@index([userId, purpose, active])
  @@map("consent")
}
```

**Status:** implemented. (This supersedes the earlier `CrossRegionConsent` model, which had a single fixed purpose and a `@@unique([userId, dataRegion, accessRegion])`; cross-region uniqueness is now enforced by a partial index in the migration, and `purpose = CROSS_REGION` discriminates cross-region rows from research consents.)

## Post model (relevant fields)

The `Post` model expresses audience via a **radius enum + `Privacy`**, not a single `visibility` field:

```prisma
enum PostRadius {
  WHISPER // inner circle (tier 0)
  NORMAL  // close friends + inner circle (tiers 0-1)
  LOUD    // community and closer (tiers 0-2)
  SHOUT   // everyone (all tiers)
}

model Post {
  id        String     @id @default(cuid())
  authorId  String     @map("author_id")
  radius    PostRadius @default(NORMAL)
  deletedAt DateTime?  @map("deleted_at")
  // ...

  @@index([authorId, radius, createdAt])
  @@map("posts")
}
```

**Relevance to transparency:** the "has public posts" signal must be defined in terms of this model (likely "any non-deleted post with `radius = SHOUT`"), not a `visibility: "PUBLIC"` predicate. This mapping is unresolved — see [03-account-transparency.md §open-questions](./03-account-transparency.md#open-questions).

## Indexes

Current `User`-model indexes relevant to profile features:

```prisma
@@index([role])
@@index([region])
@@index([dataRegion])
@@index([suspended])
@@index([username])
@@index([emailVerified])
@@index([identityVerified])
```

If the transparency fields are added, consider `@@index([hasPublicPosts])` and `@@index([locationDisplayEnabled])` for visibility-filtered queries.

## Migrations & triggers

When the transparency fields land, the migration adds the columns and indexes:

```sql
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "vpn_detected_at_last_login" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "location_display_enabled" BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS "has_public_posts" BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS "users_has_public_posts_idx" ON "users"("has_public_posts");
```

A `username_history` table accompanies the `UsernameHistory` model. The `hasPublicPosts` flag can be maintained either by application code (see [04-api.md §post-handler-integration](./04-api.md#post-handler-integration)) or by a Postgres trigger on the `posts` table that recomputes the flag on insert/update/delete — keyed off the public-audience predicate once it is defined.

## Related

- [Core Profile Management](./01-core-profile.md)
- [Privacy Settings](./02-privacy-settings.md)
- [Account Transparency](./03-account-transparency.md)
- [API Endpoints](./04-api.md)
