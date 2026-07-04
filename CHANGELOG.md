# Changelog

All notable changes to Trellis are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Trellis publishes two npm packages from this repository, each with its own tag
series:

- `@de-otio/trellis` — tags `v<x.y.z>`
- `@de-otio/trellis-extension-api` — tags `extension-api-v<x.y.z>`

Entries below are for `@de-otio/trellis` unless noted otherwise.

## [Unreleased]

### Added

- **`@de-otio/trellis-extension-api` 0.4.0 — structural DTOs for the extension contract (AR13).** New exported types `ExtensionEntity`, `ExtensionPost`, `ExtensionRelationship`, `ExtensionPaginatedResult`, `ExtensionCircleMember`, `ExtensionCircleTierStatus`, `ExtensionCircleEntityStatus`, `ExtensionGlanceItem`, `ExtensionVisiblePost`, `ExtensionEntityRelationship` (plus the `ExtensionNodeType`/`ExtensionCircleTier`/`ExtensionConnectionMethod` vocabulary). `ExtensionGraphService`'s relationship/circle query returns are now typed with these DTOs instead of `unknown`, and `ExtensionHooks.onPostCreated`/`onEntityCreated` receive `ExtensionPost`/`ExtensionEntity` instead of `any`. Core asserts at compile time that its internal types satisfy the DTOs (`apps/api/src/lib/extension-dto-contract.ts`) — a core field rename now fails the build before publish instead of breaking extensions at runtime. Prisma types remain core-internal and are not published. Discovery/recommendation result shapes stay `unknown` for now (follow-up).

- **Organization classification, feed decluttering by org category, and a public organization directory.** Tenants can self-declare what kind of organization they are (business, non-profit, community group, government, educational, or other — via a platform-curated category tree, `PlatformCategory`) independently of `TenantType`, which only ever described membership structure, not commercial nature. Feed views gain a second, independent filter axis alongside circle tier: viewers can exclude or isolate posts by an author's organization category (e.g. "no business posts," or "non-profits only"), denormalized onto `Post.authorOrgRootCategoryCode` for the same cheap, indexed filtering already used for region/sensitivity/content-category. A new opt-in directory (`TenantDirectoryProfile`) lets a classified tenant become searchable by name, category, and location; location precision is a named level (`EXACT`/`NEIGHBORHOOD`/`CITY`/`HIDDEN`), not a boolean — `CITY`/`HIDDEN` listings are structurally excluded from distance-sorted search (not just response-shaped) to close a triangulation vector where ranking order alone could otherwise leak an intentionally-imprecise location. See [Organization Classification & Directory](docs/concepts/org-classification-and-directory.md) and [Classify and List Your Organization](docs/guides/classify-and-list-your-organization.md). Self-declared only in this release — third-party verification (TechSoup, Haus des Stiftens) and AI-assisted category-suggestion are planned follow-ups; org-to-org relationships (membership/subsidiary) and cross-tenant resource-sharing grants are designed but deliberately out of scope for this release.

## [0.14.0] — 2026-06-30

### Added

- **Synchronous image moderation wired into the upload path.** The sync-image
  upload now follows **stage → moderate → promote-on-approve**: cleaned
  (re-encoded) bytes are written to a `processing/` staging key, the staged
  object is moderated via the injected `MediaModerationProvider.moderateImage`,
  and the bytes are promoted to the canonical `cas/` key **only** when the
  verdict is `approved`. A `review` or `quarantine` verdict leaves the bytes at
  staging and records the row `REVIEW`/`QUARANTINED`, so `cas/` only ever holds
  approved bytes and the APPROVED-only serve gate can serve them. Images now
  reach `APPROVED` through the provider rather than being recorded approved by
  default — the moderation seam was previously never called. The provider is
  injected at startup via the new `setMediaModerationProvider` export (mirrors
  `setRealtimeProvider`); when unset, the path degrades to a fail-closed Null
  provider (every verdict `review`), never auto-approving and never 500-ing.
  Moderation is **fail-closed throughout**: any provider throw or timeout is
  treated as `review` (no `cas/` write), and the injected provider owns all
  thresholds (none are compiled into the public tarball).

## [0.13.0] — 2026-06-29

### Fixed

- **No-audio video no longer pins forever in review.** A video with no audio
  stream (a silent clip, a screen recording, a GIF-style mp4) has nothing to
  transcribe, so the worker no longer starts a speech-to-text job that would
  fault and fail the AUDIO track closed to `REVIEW` permanently. The
  transcode seam now reports whether the cleaned output carries an audio
  stream (`TranscodeVideoResult.hasAudio`, from a probe of the produced
  bytes — never a guess); when it does not, the processing worker starts no
  transcription and records the AUDIO track as **vacuously approved** (no
  audio content ⇒ nothing to be unsafe) under a synthetic, non-referenceable
  job id, so the VISUAL completion fans in against a settled AUDIO decision.
  Fail-closed is preserved: this is a positive verdict on a track with no
  content, not approval-from-doubt — an errored or absent track still
  degrades the object to `REVIEW`.

## [0.12.3] — 2026-06-26

### Fixed

- **Read-after-write race in `custom:userId` minting.** The
  pre-token-generation trigger could emit an empty `custom:userId` when the
  user row was not yet visible on a brand-new signup (the first token minted
  before the row settled), conflating a transient race with permanent
  post-restore drift. A token with an empty `custom:userId` makes every
  downstream `where: { id: userId }` lookup miss (e.g. media-upload tenant
  resolution → 500) until re-auth. The null-user path now bridges the window
  with a bounded RDS retry, and an empty-`userId` cache entry is treated as a
  miss. Genuine drift still exhausts the budget and falls through to the
  sentinel exactly as before. Retry bound + delay are runtime config
  (`PRETOKEN_RDS_RETRY_*`), not compiled-in.

## [0.12.2] — 2026-06-26

### Fixed

- **`SessionManager.getSession` derives `userId` from `custom:userId`.**
  Companion to 0.12.1: the JWT-Bearer strategy in `SessionManager.getSession`
  (the path the media routes authenticate through) also returned the Cognito
  `sub` (a UUID) instead of the `custom:userId` claim (the Trellis `User.id`
  cuid). Media uploads still 500'd with "Tenant resolution failed" after
  0.12.1 because the cuid-keyed row lookup missed. Now prefers
  `custom:userId`, falling back to `sub` only for legacy tokens minted without
  the claim.

## [0.12.1] — 2026-06-26

### Fixed

- **JWT-Bearer `session.userId` is the `custom:userId` claim, not the Cognito
  `sub`.** `getSessionFromRequest`'s JWT-Bearer strategy returned the Cognito
  `sub` (a UUID), but `User.id` is a cuid and every handler looks the session
  user up via `where: { id: session.userId }`. JWT-Bearer requests therefore
  missed the cuid-keyed row — most visibly P0b media tenant resolution.
  Derive `userId` from `custom:userId` (written by the pre-token-generation
  trigger), falling back to `sub` only for legacy tokens.

## [0.12.0] — 2026-06-26

### Added

- **Media-moderation pipeline (P0a fail-closed serve gate + P0b dual-track
  async moderation).** Media becomes a first-class tenant-scoped resource
  with a moderation lifecycle, and bytes are served only after an explicit
  approval.

  - **Moderation lifecycle.** `MediaFile` gains a `ModerationStatus` enum
    (`PENDING` / `APPROVED` / `REVIEW` / `QUARANTINED` / `REJECTED`),
    defaulting to `PENDING` so every object is born fail-closed. A pure state
    machine (`moderation-status.ts`) owns the legal transitions; a CSAM hit is
    handled by a separate statutory provider and drives `REJECTED` from any
    state.
  - **Fail-closed serve gate (P0a).** `serveMediaByHash` serves bytes **only**
    when `moderationStatus === "APPROVED"` (and the object is not hidden /
    soft-deleted), for every viewer — there is no owner exception. Every other
    outcome (not-yet-approved, not-found, DB error) returns one byte-identical
    "not found" response so the endpoint cannot be used as a
    moderation-threshold oracle.
  - **Hardened image ingest (P0a).** Every uploaded image is re-encoded to a
    canonical raster format before hashing (the polyglot / zero-click defense)
    under a decompression-bomb pixel cap; EXIF/GPS is stripped and verified
    absent. The `gpsLatitude` / `gpsLongitude` columns and their geo-index are
    dropped (data minimization), and `metadataVisible` now defaults to
    `false` (private-by-default metadata).
  - **Dual-track async pipeline (P0b).** Video/audio uploads land in a
    `pending/` quarantine prefix (`PENDING`, hashing deferred). The
    processing worker transcodes-and-discards to a staging key, hashes the
    **cleaned** bytes, and starts two independent moderation tracks: a VISUAL
    track via the video-moderation provider and an AUDIO track via
    transcription → text moderation. A fail-closed fan-in
    (`combineTrackVerdicts`) yields `APPROVED` only when **both** tracks are
    decided and approved; a missing, errored, or uncertain track degrades to
    `REVIEW`, and a quarantine on either track dominates. The completion
    worker promotes the cleaned staging bytes to the served `cas/` prefix only
    on approval — served bytes always equal moderated bytes.
  - **Injected capability seams.** Core ships the interfaces
    (`MediaModerationProvider`, `TextModerationProvider`, `TranscodePort`,
    `TranscribePort`, `StoragePort`) plus a fail-closed Null provider and
    in-memory Mocks; the consuming application injects the concrete cloud
    adapters at startup. Core imports no cloud SDK. A startup guard refuses to
    run the Null provider outside dev.
  - **Single canonical CAS key scheme** (`cas/{tenantId}/{sha256}`), tenant-
    scoped dedup (`@@unique([tenantId, contentHash])`, never cross-tenant),
    and a dedup-safe upsert that never transfers ownership or resets
    moderation status on a dedup hit.
  - Operational parameters (duration cap, upload quota, per-category
    moderation thresholds, rate limits, canonical format) are `Env.media`
    runtime config — no thresholds are compiled into the published package.

## [0.11.0] — 2026-06-20

### Added

- **Realtime / server-blind settings sync + delivery safety floor.** A
  `RealtimeTransport` capability seam (poll default; a consuming app injects a
  concrete transport — e.g. AppSync Events — via the new `setRealtimeProvider`
  export, so core stays infra-agnostic). Server-blind `EncryptedUserSetting`
  store + `GET/PUT /api/settings/:namespace` and `GET /api/settings/changes`
  (opaque AEAD ciphertext, CAS versioning, offline-backfill cursor); a reserved
  `__keyring` namespace for the wrapped-DEK bundle. The notification delivery
  floor is migrated into `CalmDeliveryResolver` and now **enforces** blocked-
  sender and minor-protection drops (quiet-hours / preference behavior
  preserved), plus a best-effort content-free push hand-off. New
  `EncryptedUserSetting` and `BlockedUser` Prisma models. Operational thresholds
  are runtime config (`REALTIME_*` env vars); no compiled-in values.

## [0.10.7] — 2026-06-07

### Changed

- **BREAKING:** the entity feed route is renamed `/api/feeds/dog/*` →
  `/api/feeds/entity/*` (the handler already used `entityRef` / `getEntityFeed`
  internally; only the path was dog-named). Consumers update their feed client.
- Restructured documentation into a published `docs/` folder (Diátaxis
  sections, frontmatter-driven ordering). The repository `README.md` is now a
  thin pointer into `docs/`.

### Added

- This changelog.

## [0.10.0] — 2026-06-06

### Added

- Canonical, non-null, unique user handle as the identity primitive (S-CP2).

## [0.9.0] — 2026-06-05

Baseline release of the public Trellis package.

[Unreleased]: https://github.com/de-otio/trellis/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/de-otio/trellis/compare/v0.12.3...v0.13.0
[0.12.3]: https://github.com/de-otio/trellis/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/de-otio/trellis/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/de-otio/trellis/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/de-otio/trellis/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/de-otio/trellis/compare/v0.10.7...v0.11.0
[0.10.7]: https://github.com/de-otio/trellis/compare/v0.10.0...v0.10.7
[0.10.0]: https://github.com/de-otio/trellis/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/de-otio/trellis/releases/tag/v0.9.0
