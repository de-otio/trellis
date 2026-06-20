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

[Unreleased]: https://github.com/de-otio/trellis/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/de-otio/trellis/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/de-otio/trellis/releases/tag/v0.9.0
