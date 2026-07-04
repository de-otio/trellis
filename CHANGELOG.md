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

### Fixed

- **Un-implemented queue workers now fail closed instead of silently acking.**
  The stub SQS workers (`link-check`, `followers-events`, `federation-outbox`)
  previously logged each record and returned successfully, deleting real
  messages from their queues with zero operational signal — for `link-check`
  this silently disabled a live security control (async link threat-intel
  checks enqueued on post/comment creation). Each stub now throws, so batches
  retry and dead-letter onto the DLQ where the consumer's DLQ alarm pages. The
  `federation-outbox` worker is feature-guarded: it throws only when
  `ACTIVITYPUB_ENABLED === "true"` and stays inert (warn + drop) when
  federation is disabled, matching the platform's fail-closed federation
  default. Deployments that enable federation must set
  `ACTIVITYPUB_ENABLED=true` on the federation-outbox worker's environment.
  (The fourth stub, `media-reconciliation`, is removed entirely together with
  its only producer — see the batch-upload cas/-bypass entry below — so
  deployers must also drop its queue/worker wiring.)

### Removed

- **Batch upload no longer bypasses moderation — the legacy direct-to-`cas/`
  upload path is deleted (breaking, internal).** `POST /api/media/upload/batch`
  used to write bytes straight to the approved `cas/{tenant}/{hash}` prefix via
  `MediaUploadService` with **no moderation verdict and no video re-encode**,
  then enqueued to the stub media-reconciliation worker (which silently acked) —
  violating the core media-safety invariant that `cas/` holds only approved,
  cleaned bytes produced by the moderated pipeline (stage → moderate →
  promote-on-APPROVED). The serve gate kept those bytes unservable, so this was
  a latent landmine rather than an active leak, but the invariant was false and
  batch uploads never became visible anyway. The route now returns
  `501 Not Implemented`; `MediaUploadService`, the media-reconciliation queue
  producer/consumer/service/types, the stub `media-reconciliation-worker`
  Lambda entry, and the `MEDIA_RECONCILIATION_QUEUE` env binding are deleted.
  Every remaining `cas/` write is gated on an APPROVED verdict (sync-image
  promote, completion-worker promote). Batch semantics, if wanted post-beta,
  will be rebuilt on the presigned direct-to-S3 upload flow. **Internal
  breaking notes for deployers:** the `dist/lambda/media-reconciliation-worker`
  bundle entry no longer exists (remove the worker + queue from infra and
  reclaim its reserved concurrency), and `Env` no longer has
  `MEDIA_RECONCILIATION_QUEUE`. Nothing on the public package API
  (`startServer`, `registerExtension`, provider seams) changed.

### Changed

- **Session key derivation is now cached at module scope (AR9 perf fix).**
  `SessionManager` is constructed per request (~160 call sites), so its
  previous instance-level `SessionCookie` cache never got a warm hit and every
  cookie-authenticated `getSession`/`encryptSession` re-paid the full
  600,000-iteration PBKDF2 (~65 ms locally, ~100–250 ms on Fargate vCPU; twice
  on the primary+fallback rotation path). The derived-key cache now lives at
  module scope keyed by the exact (secret, fallback-secret, salt) triple, so
  the KDF runs once per distinct secret per process instead of once per
  request (~1,200× faster warm `getSession` in the micro-benchmark). Rotation
  semantics are unchanged and covered by new tests: a rotated config is a new
  cache key (both new keys derived and cached; a stale pre-rotation key is
  never served), and the cache is bounded (FIFO, 32 entries). No public API
  change; no crypto parameter (iteration count, cipher, key size) changed.

- **`@prisma/client` is now a `peerDependency` (was a regular `dependency`).**
  `@de-otio/trellis` ships `dist` compiled against its own Prisma client, but
  a consuming application generates its own client from the schema shipped in
  the tarball with the consumer's own `@prisma/client`/`prisma` pins — the two
  can silently drift apart with no install-time signal. Declaring the peer
  range (`^7.8.0`) makes npm enforce alignment at install time instead. **This
  is a semver-relevant, consumer-facing change**: an application that was
  relying on `@de-otio/trellis` to pull in `@prisma/client` transitively must
  now depend on a compatible `@prisma/client` version itself (most consumers
  already do, since they run their own `prisma generate` against the shipped
  schema). The consumer-install smoke test (`apps/api/scripts/smoke-pack.sh`)
  now asserts the installed `@prisma/client` version satisfies this peer
  range as part of its tarball verification.
### Fixed

- **GDPR account deletion now actually erases the user's media** (AR7). Both
  account-deletion paths (the delete-account worker and the nightly scheduled
  cron) deleted the S3 prefix `originals/user-{id}/` — a scheme that no longer
  exists under tenant-scoped content-addressed storage
  (`cas/{tenantId}/{contentHash}`), so account deletion removed **zero media
  bytes**, a GDPR Art. 17 erasure gap. Media erasure now happens inside
  `deleteUserData`: every `MediaFile` row uploaded by the user is either
  **soft-deleted into the existing nightly GC purge** (which hard-deletes the
  row and its CAS bytes within its bounded 7-day window) when nothing else
  references it, or **retained with the personal link (`uploadedBy`) scrubbed**
  when another user's post/comment still references the deduplicated row — so
  erasure can never destroy another user's published content. The
  "still-referenced?" determination uses the single shared storage-accounting
  object-state predicate (`lib/media/storage-accounting.ts`: a CAS object is
  unreferenced iff no live `(tenantId, contentHash)` row remains; live =
  `deletedAt IS NULL`, the same predicate the upload quota counts). The
  user-scoped staging objects (`pending/…`, `processing/…`), which the GC purge
  does not track, are deleted directly by the calling worker via a new chunked
  batch-delete helper that structurally refuses `cas/*` keys. `DeletionResult`
  gains `mediaFilesErased`, `mediaFilesRetainedShared`, and `mediaStagingKeys`.
### Security

- **Invitation gate now fails closed when the `INVITATIONS_KV` binding is
  absent or erroring.** Previously, invitation session-token validation
  returned `valid: true` when the KV binding was missing ("backward
  compatibility"), so a misconfigured deployment silently disabled the
  invite-only gate — a fail-open on the front door. Now: a missing binding
  rejects session-token validation and invitation validation (generic
  `Invalid or unavailable invitation code`, no internals leaked, and without
  claiming/burning the code), a KV read error during token verification also
  rejects, and `storeSessionToken` throws instead of silently issuing a token
  that could never be verified. The failure mode is **visible-closed, not
  silent-closed**: every rejection logs a loud `SECURITY:`-prefixed error, and
  `validateEnv()` now refuses startup when `INVITATIONS_KV` is missing (it is
  always constructed by `buildEnv()`, so this only fires for a hand-built or
  miswired `Env`). Also removed the dead, never-called
  `createFriendshipFromInvitation`/`addToFriendsList` private helpers from the
  invitation handler (friendship from an invitation is user-confirmed via the
  friends handler).

### Added

- **Boot-time environment validation (fail fast on misconfig).** `startServer()`
  now validates the raw `process.env` against a Zod schema
  (`apps/api/src/env-schema.ts`) before constructing any AWS client or
  resolving any secret, and refuses to start with a message naming each
  missing or invalid key — misconfiguration that previously surfaced only as
  runtime 500s found via post-deploy e2e now fails the deploy at boot.
  Required in every stage: database config (`DATABASE_URL`, `DB_SECRET_ARN`,
  or the legacy `DB_SECRET_USERNAME/PASSWORD/HOST` triple), the session secret
  (`SESSION_SECRET` ≥ 32 chars or `SESSION_SECRET_ARN`), and the Cognito
  pool/client ids. Required in prod only (dev-only-overridable):
  `SESSION_SALT` and `MEDIA_THRESHOLDS_JSON` (the media-moderation gate —
  absent in dev it safely fail-closes every category to review, but a prod
  deploy without it is operator error). Optional keys are format-checked when
  set (numeric `MEDIA_*` caps, the `MEDIA_*_JSON` allowlists/presets,
  `MEDIA_CANONICAL_FORMAT`/`_QUALITY`, `ACTIVITYPUB_ENABLED` must be exactly
  `"true"`/`"false"`) — a malformed value that the runtime resolvers would
  silently replace with a dev default (or fail-close) is now a boot failure;
  the runtime fallbacks themselves are unchanged (defense in depth). A
  correctly configured environment boots exactly as before, and the public
  package API is unchanged. The larger `Env`-slicing refactor remains a filed
  follow-up (architecture-review §7.1); the Cloudflare-shim retirement stays
  deferred until the legacy router is gone.

- **`/health` now reports build provenance (`buildSha`).** The health response
  includes `buildSha`, read from the `BUILD_SHA` environment variable that a
  consuming app's CI stamps into the container image (a Docker build arg set
  to the image tag). Deploy pipelines can assert the field equals the tag they
  just built, making "the new code is actually serving" machine-checkable
  instead of inferred from a green rollout. `null` when unset (local builds).
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
