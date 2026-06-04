# User Profile

**Status:** partial — core profile + privacy fields implemented; account-transparency fields designed, not yet implemented
**Companions:** [`architecture/05-auth.md`](../architecture/05-auth.md) (Cognito auth), [`architecture/03-database.md`](../architecture/03-database.md) (Postgres data model), [`identity-federation/`](../identity-federation/) (tenant-scoped roles)

> **Where this lives.** User profile management — core account settings, privacy controls, and account-transparency signals — is a **trellis framework capability**, available to any product built on trellis regardless of its B2B/B2C framing. This folder is the canonical design. Consuming applications layer their own domain profile concepts (e.g. product-specific profile types, verification flows, UI) on top in their own repos.

## What this is

How a trellis-based product lets a user manage their account: basic profile fields, region preferences, privacy/presence controls, and the "About this profile" transparency signals that help other users assess account authenticity. These features are protocol-agnostic and apply to both consumer and tenant (business) users — the consuming application decides how to surface them.

## Feature areas

| Area | Status | File |
|---|---|---|
| Core profile management | implemented | [01-core-profile.md](./01-core-profile.md) |
| Privacy settings | implemented | [02-privacy-settings.md](./02-privacy-settings.md) |
| Account transparency | design — not yet implemented | [03-account-transparency.md](./03-account-transparency.md) |
| API endpoints | partial | [04-api.md](./04-api.md) |
| Data model | partial | [05-data-model.md](./05-data-model.md) |

## Scope notes

- **Privacy vs. transparency are distinct.** Privacy settings (stealth mode, presence visibility, location-tracking precision, analytics opt-out) let a user *reduce* what they expose. Account transparency *increases* visibility of account metadata (creation date, detected region, VPN status, username-change count) to help others spot manipulative accounts. They are deliberately separate concerns.
- **Data model is canonical in Prisma.** The `User` model and related tables live in the trellis Prisma schema (`prisma/schema.prisma`). [05-data-model.md](./05-data-model.md) summarizes the relevant fields and flags which are implemented vs. preparatory.
- **Relationship/graph data is backend-neutral.** Friendship and follow relationships are resolved through the graph layer (Postgres edge tables), not through Prisma relations on `User`. Transparency visibility checks that depend on "is the viewer a friend?" go through the graph service, not a direct table join.

## Open questions

These are flagged for the consuming application / future design and are **not resolved here**:

- The account-transparency fields (`vpnDetectedAtLastLogin`, `locationDisplayEnabled`, `hasPublicPosts`) and the `UsernameHistory` model are **not yet in the Prisma schema**. The visibility rules in [03-account-transparency.md](./03-account-transparency.md) assume a "has public posts" signal; the current `Post` model expresses audience via a `radius` enum (`WHISPER`/`NORMAL`/`LOUD`/`SHOUT`) and `Privacy`, not a single `PUBLIC`/`PRIVATE` `visibility` field. Mapping "has public posts" onto the radius model is an open design item before this feature is implemented.
