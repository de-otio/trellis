---
title: Getting started
description: What Trellis is, the technology it uses, how the repository is laid out, and where to go next.
sidebar: Getting started
order: 1
---

# Getting started

Trellis is the foundation you set up locally and build on. This page is the
overview: what Trellis is, the technology it uses, how the repository is laid
out, and where to go next.

## What is Trellis?

Trellis is a generic, multi-tenant social-network platform core. It provides
the shared foundation — users, posts, feeds, follows, groups, media,
moderation, authentication, and multi-tenant identity federation (SAML/OIDC) —
that vertical-specific applications build on through **pluggable extensions**.

The core stays domain-agnostic. Extensions add domain-specific entity types,
metadata schemas, taxonomy, and terminology without modifying the core. A
vertical registers its extension at startup and ships its own product on top.

Trellis also speaks ActivityPub, so a deployment can federate with the wider
fediverse. ActivityPub federation is **disabled by default** and enabled per
environment.

## Tech stack

| Layer | Technology |
|-------|-----------|
| API | Node.js HTTP server (Hono on `node:http`) |
| Database | PostgreSQL via Prisma ORM |
| KV / cache | DynamoDB single-table |
| Auth | AWS Cognito with custom Lambda triggers |
| Queues | SQS with Lambda workers |
| Federation | ActivityPub via Fedify |

## Repository structure

```
apps/
  api/              Node.js HTTP API — routes, handlers, business logic
                    (published as @de-otio/trellis)
packages/
  extension-api/    Extension interface and types
                    (published as @de-otio/trellis-extension-api)
prisma/             Database schema + migrations
scripts/            Local dev helpers
docs/               This documentation
```

Verticals build on Trellis as separate repositories: they depend on
`@de-otio/trellis`, register a domain extension against it, and own their own
frontend and infrastructure.

## Where to go next

- **[Developer Guide](for-developers.md)** — prerequisites, first-time setup,
  daily workflow, and testing.
- **[Local Development Setup](local-setup.md)** — running services with Docker
  Compose, the database, and the dev server.
- **[Guides](../guides/)** — task-oriented how-tos (migrations, feature flags,
  configuring an identity provider, observability).
- **[Concepts](../concepts/)** — how Trellis is designed and why (architecture,
  tenancy, profiles).
- **[Reference](../reference/)** — precise specifications (APIs, data formats,
  the extension API, the glossary).
- **[Security & privacy](../security-and-privacy/)** — the security posture and
  privacy guarantees.
