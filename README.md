# Trellis

Generic multi-tenant social-network platform core. Provides auth, **multi-tenancy with per-tenant IdP federation (SAML/OIDC)**, feeds, posts, comments, media handling, moderation, and ActivityPub federation as a foundation that vertical-specific applications extend.

## Status

Trellis is consumed by downstream vertical applications as an npm dependency. It is **not** currently deployed standalone — a consuming application owns the live AWS environment. Code lands here, gets published to npm via a tag-triggered workflow, and reaches production when a consuming application bumps its dependency. See [`CLAUDE.md`](CLAUDE.md) for more.

## Architecture (target)

- **API**: Node.js HTTP server, designed to run on ECS Fargate
- **Database**: PostgreSQL (Prisma ORM) + DynamoDB (KV/cache)
- **Auth**: AWS Cognito with custom Lambda triggers; **multi-tenant via per-tenant external IdPs (SAML/OIDC)**, JIT user provisioning, tenant-scoped roles. See [`doc/02-technical/identity-federation/`](doc/02-technical/identity-federation/).
- **Workers**: SQS-driven Lambda functions
- **Federation**: ActivityPub via Fedify (opt-in per environment)

## Building a Vertical

Trellis is extended by registering extensions at startup. See [`packages/extension-api/`](packages/extension-api/) for the `TrellisExtension` interface.

```typescript
import { registerExtension } from "@de-otio/trellis";
import { myExtension } from "./my-extension";

registerExtension(myExtension);
```

An extension provides:
- **id** and **terminology** — entity naming for the vertical
- **routes** — additional API route handlers
- **metadataSchema** — Zod schema for entity metadata validation
- **configSchema** (optional) — env var validation for extension-specific config

## Development Setup

```bash
npm install
bash scripts/dev-setup.sh      # Start Postgres + DynamoDB, run migrations, seed data
npm run dev                    # Start API in watch mode (port 3000)
```

## Testing

```bash
npm test                       # Run all unit tests
npm run test:coverage          # With coverage report
```

## Releasing

Trellis ships via npm. Tag-triggered publish workflow (`.github/workflows/publish.yml`):

- `extension-api-v<x.y.z>` → publishes `@de-otio/trellis-extension-api`
- `v<x.y.z>` → publishes `@de-otio/trellis`

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
  so you can build extensions — including proprietary ones — freely.

External contributions are **not currently being accepted** — see
[`CONTRIBUTING.md`](CONTRIBUTING.md). A [Contributor License Agreement](CLA.md)
is in place for if that changes; it keeps the dual-licensing model possible.
