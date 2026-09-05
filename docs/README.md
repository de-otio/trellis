---
title: Trellis Documentation
description: The published documentation for Trellis — a generic multi-tenant social-network platform core.
sidebar: Home
order: 0
---

# Trellis Documentation

Trellis is a generic, multi-tenant social-network platform core: auth and
multi-tenant identity federation (SAML/OIDC), feeds, posts, comments, media,
moderation, and ActivityPub federation. Vertical applications build on it via
extensions.

This folder is the **single source of truth** for Trellis's user-facing
documentation. The project website renders it per release; it also reads
correctly as plain Markdown on GitHub.

## Sections

- **[Getting started](getting-started/)** — install, run locally, first steps.
- **[Guides](guides/)** — task-oriented how-tos (migrations, feature flags,
  configuring an identity provider, observability).
- **[Concepts](concepts/)** — how Trellis is designed and why (architecture,
  tenancy, profiles, storage & CDN, the
  [media-moderation pipeline](concepts/media-moderation.md), and
  [feed ordering](concepts/feed-ordering.md)).
- **[Reference](reference/)** — precise specifications (APIs — including
  [blocks](reference/blocks-api.md) and
  [content reports](reference/content-reports-api.md) — data formats, the
  extension API, the glossary).
- **[Security & privacy](security-and-privacy/)** — the security posture and
  privacy guarantees.

## Conventions

See [CONTRIBUTING.md](CONTRIBUTING.md) for how this documentation is organized
and authored (single source of truth, frontmatter ordering, kebab-case).

## Project & legal

These live at the repository root on GitHub:

- [Principles](https://github.com/de-otio/trellis/blob/main/PRINCIPLES.md) — what Trellis is for and its design commitments · [Governance](https://github.com/de-otio/trellis/blob/main/GOVERNANCE.md) — stewardship and reciprocity
- [License](https://github.com/de-otio/trellis/blob/main/LICENSE)
- [Contributing](https://github.com/de-otio/trellis/blob/main/CONTRIBUTING.md) · [Code of conduct](https://github.com/de-otio/trellis/blob/main/CODE_OF_CONDUCT.md)
- [Security policy](https://github.com/de-otio/trellis/blob/main/SECURITY.md) — how to report a vulnerability
- [Commercial terms](https://github.com/de-otio/trellis/blob/main/COMMERCIAL.md) · [Contributor License Agreement](https://github.com/de-otio/trellis/blob/main/CLA.md)
- [Changelog](https://github.com/de-otio/trellis/blob/main/CHANGELOG.md) — what changed per release
