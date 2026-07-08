---
title: Operations Guide
description: How Trellis fits into a consuming application's runtime, and the operational conventions it expects.
sidebar: For Operations
order: 30
---

# Operations Guide

Trellis ships as an npm library (`@de-otio/trellis`), not as a standalone
service. It does not deploy itself: there is no infrastructure project, no
deploy script, and no live environment in this repository. A vertical
application embeds Trellis as a dependency and owns the deployment, the cloud
account, and day-to-day operations.

This means **end-to-end and infrastructure verification happens in the
consuming application's environment, not here.** This guide documents the
runtime conventions Trellis expects so that a consuming application can satisfy
them consistently.

## Where Trellis runs

The API is a Node.js HTTP server (Hono, served over `node:http`) that listens on port 3000 and is
designed to run as a long-lived service container. The consuming application is
responsible for provisioning everything around it:

- a PostgreSQL database (accessed via Prisma),
- a DynamoDB table for key-value and cache data,
- SQS queues for background work,
- an identity provider for authentication (Cognito JWTs are validated at the
  edge),
- object storage and a CDN for media.

Trellis reads all of its configuration from environment variables at startup.
The consuming application supplies those variables; how they are sourced
(parameter store, secrets manager, plain env) is the application's choice.

## Configuration through environment

Trellis resolves the resources it needs from environment variables rather than
hard-coded endpoints. The consuming application populates these — typically
from its own parameter or secret store — before starting the process.

The values Trellis expects include a database connection string, the
DynamoDB table name, queue endpoints, the identity provider settings used to
validate sessions, and the media/CDN origin. See
[`apps/api/src/env.ts`](https://github.com/de-otio/trellis/blob/main/apps/api/src/env.ts) for the full environment
schema and which variables are required.

Secrets (database credentials, session secret, third-party API keys) are never
read from the repository or compiled in — they arrive through the environment
at runtime.

## Opt-in capability features (Open Social Web)

Three capabilities ship **disabled by default**, each gated by a global feature
toggle (see the [Feature Flags guide](../guides/feature-flags.md)):
`email_subscriptions_enabled`, `collections_enabled`, and
`year_in_review_enabled`. While a toggle is off its routes return 404, so
embedding the library never exposes these endpoints until an operator opts in
per environment.

**Enabling a feature in an environment** is two steps:

1. **Apply the schema migration** that ships with the feature (Prisma
   migrations, as part of your release — see [Health and lifecycle](#health-and-lifecycle)).
2. **Turn the toggle on** — set it `true` in that environment's `FEATURE_FLAGS`
   config (the source of truth that `seed:feature-toggles` writes to the DB on
   deploy), or flip it for a single tenant with a `setToggle` override.

**Follow-by-email additionally requires two secrets.** Email addresses are PII,
and these guard them; both are **required whenever the feature is used and never
fall back to any other secret** (a deliberate key-separation property). If either
is missing while the toggle is on, the subscribe path returns a generic 500
rather than silently degrading:

| Variable | Purpose | Contract |
|---|---|---|
| `EMAIL_SUB_HMAC_SECRET` | Signs the confirm/unsubscribe capability tokens and keys the email lookup-hash (via HKDF sub-keys) | High-entropy string, **≥ 32 characters**. Rotating it invalidates in-flight confirm/unsubscribe links issued under the old value. |
| `EMAIL_SUB_ENC_KEY` | Key-encryption key for the per-record envelope encryption of stored email addresses | **Base64 that decodes to exactly 32 bytes** (256-bit). Provision from your secret store; do **not** reuse `SESSION_SECRET`. |

### Storing the secrets

Store both as **encrypted secrets**, following the same convention as
`session-secret` and the RDS `db-secret-arn` (`/{appName}/{stage}/…`):

- Use **SSM Parameter Store `SecureString`** (simplest, and parity with
  `session-secret`) or **AWS Secrets Manager** if you want its rotation tooling.
  Never store them plaintext in a task definition, a config file, or the repo.
- **Inject them via the ECS task definition's `secrets:` block**, which resolves
  the SSM/Secrets Manager value at container start and exposes it as the env var
  Trellis reads. The value originates in the secret store; it only becomes an env
  var inside the running task. (Trellis itself has no secret-store client — it is
  cloud-agnostic and reads `process.env`, exactly like `SESSION_SECRET`.)
- For **`EMAIL_SUB_ENC_KEY`** specifically — the key that decrypts the entire
  stored-email table — consider **KMS-backing it** rather than a plaintext
  `SecureString`. The bundled `oauth/envelope-crypto.ts` already supports a KMS
  KEK fetcher (`…_KMS_KEY_ID` → `KMS:Decrypt`, key held only in a memory buffer),
  so the raw 256-bit key need never sit recoverable in the environment or a
  memory dump. A `SecureString` is acceptable MVP parity with `SESSION_SECRET`;
  KMS is the stronger option for an at-rest decryption key.

Rotation is a **deliberate operation, not auto-rotate**: rotating
`EMAIL_SUB_HMAC_SECRET` invalidates in-flight confirm/unsubscribe links, and
rotating `EMAIL_SUB_ENC_KEY` requires a staged re-encrypt (the `keyVersion`
prefix on the stored `email_hash`/`email_enc` values exists for exactly this).

Environments that leave `email_subscriptions_enabled` off do not need either
secret. Every other operational parameter for these features (rate limits, token
TTLs, retention windows, collection caps) is env-driven with a safe default —
see the `EMAIL_SUB_*` and `COLLECTION_*` entries in
[`apps/api/src/env.ts`](https://github.com/de-otio/trellis/blob/main/apps/api/src/env.ts).

## Monitoring conventions

Because the consuming application owns the runtime, it also owns dashboards and
alerting. Trellis is built to support standard observability practices:

- structured logs emitted to stdout for collection by the platform's log
  pipeline,
- background-queue failures routed to dead-letter queues so they can be
  alerted on,
- request tracing when the platform enables it.

The naming, retention, and alarm thresholds for these are operational policy
and belong to the consuming application, not to Trellis.

## Health and lifecycle

Trellis starts as a normal process and exits cleanly on shutdown signals,
running any registered extension shutdown hooks first. Treat it like any other
stateless service container: scale horizontally, drain on deploy, and rely on
the database and queues for durable state.

Schema changes are applied with Prisma migrations as part of the consuming
application's release process. For zero-downtime changes, use an
expand-contract sequence so old and new code can run against the schema at the
same time.

## Incident response

Operational runbooks — error-rate spikes, rollbacks, database incidents — are
specific to a live environment and therefore live with the application that
operates that environment, alongside its dashboards and alarms. Trellis does
not ship environment-specific runbooks, because it does not own an environment.

What Trellis does provide is predictable behaviour to build those runbooks on:
configuration is externalised, failures surface through logs and dead-letter
queues, and the service is stateless and safe to restart.
