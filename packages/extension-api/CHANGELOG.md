# Changelog

All notable changes to `@de-otio/trellis-extension-api` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package follows [Semantic Versioning](https://semver.org/) within its
pre-1.0 `0.x` line, where a minor bump is the breaking unit.

## [0.10.0] - 2026-09-04

### Added

- Per-route `scopes` on `extensionRoutes`, enforced by the route wrapper before
  the handler runs (absent = first-party only, `[]` = any authenticated
  caller, non-empty = every listed scope required).
- `requestSchema` validation before the handler runs; a failing body returns a
  structured `400` the handler never sees.
- `publicSpec` + `scopes` publish a route into `/openapi.json`, mounted under
  `/api/v1` behind the public dispatcher.
- `responseSchema`, `idempotent`, `operationId`, and `stability` fields on
  `extensionRoutes`, carried through into the generated OpenAPI spec.
- A `scopes` vocabulary and an `events` catalog on `TrellisExtension`
  (declaration only in this release).
- `clientId` and `scopes` on `ExtensionSession`.
- `ctx.events.emit(type, payload)`, now required rather than optional; core
  always supplies it and writes a tenant-bound row to the domain-event outbox.

### Changed

- A route with `auth: "none"` and a non-empty `scopes` now **fails startup**,
  since there is no principal to check the declared scopes against.
- Documentation for the extension-context threat model was clarified to state
  explicitly that `scopes` and the restricted `ExtensionContext` are a guard
  rail against honest-but-wrong extensions and a confused-deputy defence
  against hostile callers, not a sandbox against a hostile extension (docs
  only — extension code has always run in-process and unsandboxed).

### Fixed

- The first-party-only branch of a route's `scopes` (absent `scopes`) is now
  actually enforced, closing a gap where it was documented but not checked.

### Security

- Fail-closed the admin test seam and read the revocation blocklist through
  one choke point for claims invalidation.

This release is additive: an extension written against `0.9.2` compiles and
behaves identically, because every new field is optional and defaults to the
previous behaviour.

## [0.9.2] - 2026-08-15

### Fixed

- A partial `ExtensionModelMap` delegate now fails at the map declaration
  rather than later at `registerExtension(...)`.

### Changed

- `ExtensionModelMap` is tightened from `Record<string, object>` to
  `Record<string, ScopedDelegate>`, with no runtime change. A hand-declared
  model map must now carry all thirteen scoped operations.

## [0.9.1] - 2026-08-13

### Added

- Extensions can type their own models on the scoped `db` surface.

## [0.9.0] - 2026-08-12

### Added

- Supporting types for the new `GET /api/users/me` endpoint (the caller's
  resolved identity).

### Removed

- Seven extension points that core never called, so the published contract
  matches what core actually reads.

## [0.8.1] - 2026-08-07

### Fixed

- Relative imports use explicit `.js` specifiers.

## [0.8.0] - 2026-08-06

### Added

- `EXTENSION_API_VERSION` startup compatibility check, so an extension can
  verify it is running against the contract version it was written for.
- Types supporting AI Act Art. 50 synthetic-content provenance disclosure.
- An OpenAPI additivity gate and a public-type snapshot check in CI, so a
  breaking change to the published contract fails the build rather than
  shipping.

### Documentation

- Client-version policy, platform flags, and `extensionApiVersion` documented
  in the guides.

## [0.7.0] - 2026-07-16

### Added

- Verified tenant context for extension route handlers, and a sanctioned
  cross-tenant `discover()` read path.

## [0.6.0] - 2026-07-12

### Added

- Shared contracts for extension-owned schema, and an enforce-always scoped-DB
  proxy with `ext_*` table registration.

## [0.5.0] - 2026-07-08

Released alongside Trellis core 0.21.0. No extension-api-specific changes
beyond the version bump.

## [0.4.0] - 2026-07-04

### Added

- Structural DTOs for the extension contract.

## [0.3.0] - 2026-06-05

Released alongside Trellis core 0.9.0.

### Added

- Repository field for npm provenance.

## [0.2.0] - 2026-06-04

Initial published version.

[0.10.0]: https://github.com/de-otio/trellis/compare/extension-api-v0.9.2...extension-api-v0.10.0
[0.9.2]: https://github.com/de-otio/trellis/compare/extension-api-v0.9.1...extension-api-v0.9.2
[0.9.1]: https://github.com/de-otio/trellis/compare/extension-api-v0.9.0...extension-api-v0.9.1
[0.9.0]: https://github.com/de-otio/trellis/compare/extension-api-v0.8.1...extension-api-v0.9.0
[0.8.1]: https://github.com/de-otio/trellis/compare/extension-api-v0.8.0...extension-api-v0.8.1
[0.8.0]: https://github.com/de-otio/trellis/compare/extension-api-v0.7.0...extension-api-v0.8.0
[0.7.0]: https://github.com/de-otio/trellis/compare/extension-api-v0.5.0...extension-api-v0.7.0
[0.5.0]: https://github.com/de-otio/trellis/compare/extension-api-v0.4.0...extension-api-v0.5.0
[0.4.0]: https://github.com/de-otio/trellis/compare/extension-api-v0.3.0...extension-api-v0.4.0
[0.3.0]: https://github.com/de-otio/trellis/releases/tag/extension-api-v0.3.0
