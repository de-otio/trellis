# Trellis

Generic multi-tenant social-network platform core. Provides auth,
multi-tenancy with per-tenant IdP federation (SAML/OIDC), feeds, posts,
comments, media handling, moderation, and ActivityPub federation as a
foundation that vertical-specific applications extend.

Trellis is **public-interest digital infrastructure for the social layer** —
an open core, federated by default, stewarded by [De Otio](https://de-otio.org)
in the public interest, with reciprocity required of those who build commercial
products on it. It is not "open source" in the thin, code-only sense: the
design commitments (data sovereignty, no engagement-maximising objective,
provenance) and the governance that backs them are part of what Trellis *is*.

- **[Principles](PRINCIPLES.md)** — what Trellis is for and the design
  commitments that follow.
- **[Governance](GOVERNANCE.md)** — how Trellis is stewarded and the reciprocity
  expected of commercial users (including De Otio's own verticals).

## Documentation

The documentation lives in [`docs/`](docs/) and is the single source of truth:

- **[Getting started](docs/getting-started/)** — what Trellis is, the tech
  stack, repository layout, local setup, and first steps.
- **[Guides](docs/guides/)** — task-oriented how-tos.
- **[Concepts](docs/concepts/)** — architecture, tenancy, and design.
- **[Reference](docs/reference/)** — APIs, data formats, and the extension API.
- **[Security & privacy](docs/security-and-privacy/)** — security posture and
  privacy guarantees.

To build a vertical, register an extension at startup against
`@de-otio/trellis` — see [`packages/extension-api/`](packages/extension-api/).

## Packages

| Package | Description | License |
|---------|-------------|---------|
| `@de-otio/trellis` | Core HTTP API server and all handlers | AGPL-3.0-or-later |
| `@de-otio/trellis-extension-api` | Extension interface and types | MIT |

## License

Trellis is **dual-licensed**.

- The **core** (this repository and `@de-otio/trellis`) is licensed under the
  **GNU Affero General Public License v3.0 or later** ([`LICENSE`](LICENSE)).
  If you run a modified Trellis as a network service, the AGPL requires you to
  make your modified source available to its users.
- A **commercial license** is available for use without the AGPL's
  source-disclosure obligations — see [`COMMERCIAL.md`](COMMERCIAL.md).
- The **extension API** (`@de-otio/trellis-extension-api`) is **MIT**-licensed,
  so you can write extensions against it freely. Note that a *closed-source*
  extension run as a network service is a combined work with the AGPL core and
  needs a commercial license (open-source AGPL extensions are free) — see
  [`COMMERCIAL.md`](COMMERCIAL.md).

External contributions are **not currently being accepted** — see
[`CONTRIBUTING.md`](CONTRIBUTING.md). A [Contributor License Agreement](CLA.md)
is in place for if that changes; it keeps the dual-licensing model possible.
