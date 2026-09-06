# Changelog

All notable changes to `@de-otio/trellis-extension-testkit` are documented
here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
follows [Semantic Versioning](https://semver.org/) within its pre-1.0 `0.x`
line.

## [0.1.2] - 2026-08-17

### Fixed

- Split the OIDC step out of the build in the publish workflow, added a
  cooldown to the auto-release, and stopped `loadCore` misdiagnosing failures.

### Changed

- Tracked `@de-otio/trellis-extension-api` 0.10.0's scoped-surface contract
  (no testkit API change).

## [0.1.1] - 2026-08-16

### Changed

- The `@de-otio/trellis` peer dependency range catches up to core's current
  version.

## [0.1.0] - 2026-08-16

Initial release.

### Added

- The standalone lane: boot a real Trellis server against an extension and
  check what core itself does not.

[0.1.1]: https://github.com/de-otio/trellis/releases/tag/extension-testkit-v0.1.1
