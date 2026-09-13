---
title: Operations Guide
description: How Trellis fits into a consuming application's runtime — the ports it needs served, the two deployment shapes, and the operational conventions it expects.
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
consuming application's environment, not here.** This guide documents what a
consuming application has to provision and the runtime conventions Trellis
expects, so that it can satisfy them consistently whichever provider it runs
on.

## Two processes

A Trellis deployment is two long-lived Node.js processes plus the services
they talk to:

- **The API** — a Hono app served over `node:http`, listening on `PORT`
  (default 3000). Stateless; scale it horizontally behind whatever load
  balancer or ingress the platform provides.
- **The worker** — `apps/worker`, a long-running container that consumes the
  background queues and runs the cron cadences in-process, with single-fire
  guaranteed through the key-value port. On AWS the same worker cores run as
  per-queue Lambda functions and EventBridge schedules instead; the
  extracted cores in `apps/api/src/lib/workers/*` are shared by both shapes.
  The worker's full environment contract is in
  [`apps/worker/README.md`](https://github.com/de-otio/trellis/blob/main/apps/worker/README.md).

Both read all of their configuration from environment variables at startup.
The consuming application supplies those variables; how they are sourced
(parameter store, secrets manager, a Kubernetes Secret, plain env) is the
application's choice. Secrets (database credentials, the session secret,
third-party API keys) are never read from the repository or compiled in — they
arrive through the environment at runtime.

## What a consuming application provisions — the ports

The core reaches every piece of infrastructure through a provider-neutral
port (the `@de-otio/saas-foundation` packages), and each port has more than
one adapter. The consuming application picks an adapter per port by setting
environment variables; Trellis never hard-codes an endpoint. This is the
layered view in the
[Architecture overview](../concepts/architecture-overview.md#layered-view),
read as a provisioning checklist:

| Port | What it must be | Selected by | Adapters |
|---|---|---|---|
| **Database** | PostgreSQL 16 **with PostGIS** (the `entity_location` migration needs the extension) | one of `DATABASE_URL` · `DB_SECRET_ARN` · `DB_SECRET_USERNAME`/`DB_SECRET_PASSWORD`/`DB_SECRET_HOST`[/`DB_SECRET_PORT`] + `DB_NAME` | any managed or self-hosted Postgres; accessed through Prisma with an in-process pool (`DATABASE_POOL_MAX`, default 10 — see [Database Connections](../guides/database-connections.md)) |
| **Key-value** | atomic primitives (put-if-absent, compare-and-set, increment, TTL) for rate limits, caches, CSRF tokens, the session blocklist, invitation state and cron locks | `KV_PROVIDER` — unset/`dynamodb` (default) or `postgres` | DynamoDB single table (`DYNAMODB_TABLE`, default `{stage}-trellis`) · the `kv_entries` table in the same Postgres. Only the exact string `postgres` selects Postgres; anything else is DynamoDB. Details: [`doc/02-technical/operations/kv-provider.md`](https://github.com/de-otio/trellis/blob/main/doc/02-technical/operations/kv-provider.md) |
| **Queue** | an SQS-compatible queue service with a dead-letter queue per queue | `SQS_QUEUE_URL_PREFIX` (a full prefix including the account segment and any name prefix), else `SQS_ENDPOINT` + `AWS_ACCOUNT_ID` with the `{stage}-{queue}` naming | AWS SQS · Scaleway MNQ (SQS API) · LocalStack in development |
| **Object storage** | an S3-API store, one bucket for media and one for exports | `MEDIA_BUCKET_NAME` (default `{stage}-{APP_NAME}-media`), `EXPORTS_BUCKET_NAME`; non-AWS endpoint via the SDK's own `AWS_ENDPOINT_URL_S3`; `S3_FORCE_PATH_STYLE=true` only where the provider needs it; an optional storage-specific credential pair `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` for platforms whose storage and queue credentials differ (set both or neither) | AWS S3 · any S3-compatible store (Scaleway Object Storage, Cloudflare R2, MinIO) |
| **Email** | a transactional sender | `EMAIL_SERVICE` — `aws-ses` (default), `smtp`, `scaleway-tem`, `resend`, `alibaba-directmail`, `tencent-ses`; plus `FROM_EMAIL` and the optional `EMAIL_BRAND_NAME` | SES · generic SMTP (`SMTP_HOST` required, `SMTP_PORT` default 587, `SMTP_SECURE`/`SMTP_STARTTLS`, `SMTP_USERNAME`/`SMTP_PASSWORD` both or neither) · Scaleway TEM (`TEM_PROJECT_ID`, `TEM_SECRET_KEY` or `SCW_SECRET_KEY`, `TEM_REGION`) · the provider APIs |
| **Identity** | an OIDC issuer whose tokens the API verifies at the edge | `OIDC_ISSUER_URL`, `OIDC_APP_CLIENT_ID`, and — for any non-Cognito issuer — `OIDC_JWKS_URL` (take `jwks_uri` from the issuer's `/.well-known/openid-configuration`); `IDENTITY_PROVIDER` = `cognito` (default) or `keycloak` selects the admin adapter | Amazon Cognito (the legacy `COGNITO_*` variables still derive the `OIDC_*` values byte-identically) · Keycloak (self-hosted) · any standards-compliant OIDC provider for verification |

Boot fails closed when a port is half-configured: a missing session secret, a
missing issuer or audience, a non-Cognito issuer without `OIDC_JWKS_URL`, a
half-set S3 credential pair, or `ACTIVITYPUB_ENABLED` without a shared
rate-limiter backend (`KV_PROVIDER=postgres` or `RATE_LIMIT_TABLE`) all refuse
to start with a message naming the variable. See
[`apps/api/src/env.ts`](https://github.com/de-otio/trellis/blob/main/apps/api/src/env.ts)
for the full environment schema and
[`apps/api/src/lib/auth/auth-config.ts`](https://github.com/de-otio/trellis/blob/main/apps/api/src/lib/auth/auth-config.ts)
for the identity resolution rules.

### The queues

The API produces to `user-export`, `delete-account`, `followers-events`,
`link-check` and `media-processing`. The worker consumes `delete-account`,
`media-processing`, `media-completion`, `link-check`, `followers-events` and
`federation-outbox` (the last is feature-gated and idle while federation is
off). Visibility timeouts must exceed the longest handler runtime — the
per-queue minimums are in the worker README — and dead-letter redrive is a
queue property the consuming application configures, not something Trellis
owns. Which of these queues have a real consumer and which are fail-closed
stubs is recorded in [Async processing](../concepts/async-processing.md).

### Two deployment shapes, one codebase

- **Managed cloud services (the AWS-shaped profile).** API container on a
  container service, per-queue Lambda workers and EventBridge schedules,
  DynamoDB for key-value, SQS, S3, SES, Cognito. This is the shape the
  [Compute](../concepts/compute.md), [Async processing](../concepts/async-processing.md)
  and [Storage and CDN](../concepts/storage-and-cdn.md) concept pages
  describe in detail.
- **A single node or a Kubernetes cluster (the ports profile).** API and
  worker containers, Postgres carrying both the application database and the
  key-value port (`KV_PROVIDER=postgres`), an SQS-compatible queue service,
  any S3-compatible store, SMTP or a provider API for email, and a
  self-hosted Keycloak (or another OIDC issuer) for identity. Nothing in this
  shape requires an AWS account.

Every adapter sits behind its port's contract, so moving a deployment
between the two shapes is a change of environment variables and
infrastructure, not of application code.

### The compose files are scaffolding, not a node

The repository ships three Docker Compose files. They exist for development
and CI; **none of them boots a complete Trellis deployment** — the API and
worker are started separately (`npm run dev`), and there is no
production-grade compose file.

| File | What it brings up | Purpose |
|---|---|---|
| `docker-compose.yml` | PostGIS-enabled Postgres (5432), DynamoDB Local (8000), LocalStack with S3/SQS/SES (4566) | the AWS-shaped development and test stack; what `npm test` and the CI lanes run against |
| `docker-compose.scaleway.yml` | PostGIS-enabled Postgres (5433), Keycloak with the magic-link provider (8081), Mailpit as the SMTP sink (1025, UI 8025); every image digest-pinned | the ports-profile substitute stack for local and CI end-to-end runs; host ports are offset so both stacks can run side by side. Run `scripts/scaleway-profile/fetch-keycloak-provider.sh` before the first `up` |
| `docker-compose.hatchet.yml` | a local Hatchet Lite workflow engine with its own Postgres | an evaluation, opt-in, explicitly not a deployment target |

See [Local Development Setup](local-setup.md) for the day-to-day use of the
first one.

## Configuration through environment

Beyond the ports above, a deployment sets:

- **`STAGE`** (`dev`, `prod`, …) and **`APP_NAME`** — they name the default
  bucket, table and queue prefixes.
- **`SESSION_SECRET`** (or `SESSION_SECRET_ARN` on AWS) — the session-sealing
  key; boot refuses to start without it. `SESSION_SECRET_FALLBACK` lets a
  rotation accept sessions sealed under the previous value. Where a
  `SESSION_BLOCKLIST_KV` binding is guaranteed, `SESSION_BLOCKLIST_REQUIRED=true`
  makes a *missing* binding deny rather than pass.
- **`APP_DOMAIN`** and/or **`ALLOWED_ORIGINS`** — the browser origins allowed
  to call the API with credentials. With neither set, only loopback origins
  are reflected and every remote origin is denied (see
  [Upgrading to 0.25](#upgrading-to-025)). `APP_DOMAIN` also seeds the
  absolute media URLs the API writes into its own responses; with it unset
  those URLs are relative to the API origin. The published core carries no
  deployment's hostname as a default.
- **Feature toggles and thresholds** — every rate limit, retention window
  and cap is runtime configuration with a conservative default; none is
  compiled into the published package (the threshold-secrecy rule). The
  sections below list the ones that need an operator's attention.

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

Store both as **encrypted secrets** in the platform's secret store and inject
them as environment variables at container start, the same way as
`SESSION_SECRET`. Trellis itself has no secret-store client — it is
provider-agnostic and reads `process.env`.

- **On AWS:** SSM Parameter Store `SecureString` (parity with
  `session-secret`) or Secrets Manager if you want its rotation tooling,
  resolved through the ECS task definition's `secrets:` block.
- **On Kubernetes:** a `Secret` populated by an external-secrets operator
  from the provider's secret manager, exposed to the container as env.
- Never store them plaintext in a task definition, a manifest, a config file,
  or the repo.
- For **`EMAIL_SUB_ENC_KEY`** specifically — the key that decrypts the entire
  stored-email table — consider a KMS-backed key rather than a plaintext
  secret where the platform offers one. The bundled `oauth/envelope-crypto.ts`
  supports a KMS KEK fetcher on AWS (`…_KMS_KEY_ID` → `KMS:Decrypt`, key held
  only in a memory buffer), so the raw 256-bit key need never sit recoverable
  in the environment or a memory dump. A plain encrypted secret is acceptable
  parity with `SESSION_SECRET`; a managed key is the stronger option for an
  at-rest decryption key.

Rotation is a **deliberate operation, not auto-rotate**: rotating
`EMAIL_SUB_HMAC_SECRET` invalidates in-flight confirm/unsubscribe links, and
rotating `EMAIL_SUB_ENC_KEY` requires a staged re-encrypt (the `keyVersion`
prefix on the stored `email_hash`/`email_enc` values exists for exactly this).

Environments that leave `email_subscriptions_enabled` off do not need either
secret. Every other operational parameter for these features (rate limits, token
TTLs, retention windows, collection caps) is env-driven with a safe default —
see the `EMAIL_SUB_*` and `COLLECTION_*` entries in
[`apps/api/src/env.ts`](https://github.com/de-otio/trellis/blob/main/apps/api/src/env.ts).

## Events

The Events primitive (events, RSVPs, and volunteer shifts — see the
[Events API](../reference/events-api.md)) ships **disabled by default** behind
the `events_enabled` global feature toggle. Enable it exactly like the Open
Social Web features above: apply the schema migration, then turn the toggle on
per environment (or per tenant with a `setToggle` override). Ticketing/payments
and recurrence/ICS are not part of this version.

The events tables ship as an ordinary **Prisma migration**, applied on deploy
like any other schema change — there is no separate provisioning step.

Every operational parameter is env-driven with a conservative default, so an
environment that enables events works without setting any of these; tune them
only where the default does not fit. All are read once in `resolveEventEnv()`
(`apps/api/src/env.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `EVENT_MAX_PER_TENANT` | `500` | Max live (non-cancelled) events per tenant. Create returns `409` at the cap; cancelling frees a slot. |
| `EVENT_MAX_SHIFTS_PER_EVENT` | `50` | Max shift slots per event. |
| `EVENT_MAX_GUESTS_PER_RSVP` | `10` | Max additional guests on one RSVP (party size = 1 + guests). Clamped at the request boundary. |
| `EVENT_RSVP_RATE_PER_HOUR` | `60` | Per-user RSVP writes allowed per hour (bucketed per user + event). `429` when exceeded. |
| `EVENT_UPDATE_RATE_PER_HOUR` | `20` | Per-event update writes allowed per hour (bucketed per event). `429` when exceeded. |
| `EVENT_UPDATE_NOTIFY_COOLDOWN_SECONDS` | `3600` | Debounce window that consolidates repeated `EVENT_UPDATED` notifications for one event (notification-amplification guard). |
| `EVENT_LIST_PAGE_MAX` | `50` | Upper bound on the `limit` query parameter for event/attendee listing. |

These defaults are conservative dev-safe values; the operative production values
are set through the environment (parameter/secret store) like every other
Trellis setting. As with all Trellis thresholds, they are runtime config — none
is compiled into the published package.

## Client-version policy (forced-upgrade backstop)

`GET /api/app/version-policy` and a 426 backstop middleware let an operator
signal a minimum supported client version and recommended store links,
without a deploy. Configuration is four optional environment variables, all
read once at boot and validated then — **unset means the mechanism is
dormant** (the endpoint returns `null` for that field; an unset
`CLIENT_MIN_SUPPORTED_VERSION` makes the 426 backstop a permanent no-op). See
the [Client Compatibility guide](../guides/client-compatibility.md) for the
full contract.

| Variable | Meaning | Contract |
|---|---|---|
| `CLIENT_MIN_SUPPORTED_VERSION` | Oldest client version the server still accepts. Below it, the policy endpoint's `minimumVersion` and the 426 backstop treat the client as unsupported. Unset = dormant (no version is ever rejected). | Bounded semver `x.y.z[+-suffix]`, ≤ 64 characters. Malformed value fails boot. |
| `CLIENT_RECOMMENDED_VERSION` | Version the client should nudge the user toward. Display-only, never enforced server-side. Unset = dormant (`recommendedVersion` is `null`). | Same bounded semver rule as above. |
| `CLIENT_STORE_URL_ANDROID` | Android store URL surfaced in `storeUrls.android`. Unset = dormant (`null`). | Must be `https:` and resolve to the `play.google.com` host — any other scheme or host fails boot validation. |
| `CLIENT_STORE_URL_IOS` | iOS store URL surfaced in `storeUrls.ios`. Unset = dormant (`null`). | Must be `https:` and resolve to the `apps.apple.com` host — any other scheme or host fails boot validation. |

## Agent surface (`/llms.txt`, `/openapi.json`, `/security.txt`)

Three unauthenticated, CORS-enabled discovery routes are always registered
(`apps/api/src/lib/routes/agent-surface.ts`). Two of them take their body from
the environment, through the same app-configuration path as `APP_DOMAIN` /
`ALLOWED_ORIGINS`:

| Route | Source | When unset | `Cache-Control` |
|---|---|---|---|
| `GET /llms.txt` | `AGENT_SURFACE_LLMS_TXT` | Trellis's generic default — describes only what core does, names no product | `public, max-age=3600` |
| `GET /openapi.json` | Generated from the route registry: every route that is `publicSpec` **and** declares `scopes`, published at its `/api/v1` path | Always served | `public, max-age=300` |
| `GET /security.txt` | `AGENT_SURFACE_SECURITY_TXT` | `404` with a structured error and one `[agent-surface]` warning at boot. There is deliberately no placeholder contact: RFC 9116 has no "not configured yet" convention, and a fake contact is worse than a 404 | `public, max-age=86400` |

Both values are served **verbatim** — no template substitution — so each must
be the complete llmstxt.org / RFC 9116 body. Trellis applies no route-level
rate limit to these three; the route file expects the gateway or WAF to do so.

## Upgrading to 0.25

Four behaviour changes in `0.25.0` need an operator's attention before the
roll. The CHANGELOG's Unreleased "Security" section carries the full reasoning;
this is the checklist.

- **Expect one forced re-login.** Session revocation is now enforced on every
  request, and the inactivity timeout with it. Sessions sealed by an earlier
  version carry no activity or issue timestamp, so the first request after the
  roll rejects them and every signed-in user logs in again once. Nothing to
  configure — schedule the roll accordingly. Where a `SESSION_BLOCKLIST_KV`
  binding is guaranteed, `SESSION_BLOCKLIST_REQUIRED=true` makes a *missing*
  binding deny rather than pass.
- **CORS fails closed unless configured.** With neither `APP_DOMAIN` nor
  `ALLOWED_ORIGINS` set, the previous version reflected any request `Origin`
  with credentials allowed. Now only loopback origins (`localhost`,
  `127.0.0.0/8`, `[::1]`, hostname-exact) are reflected; every remote origin is
  denied. Set `APP_DOMAIN` (a bare host; the `www.`/non-`www.` variant is
  derived) and/or a comma-separated `ALLOWED_ORIGINS` covering every browser
  origin that calls the API. The shipped allow-list of fixed domains was
  removed along with it — the only origins ever allowed are the ones the
  deployment configures.
- **`/api/admin/test/*` is off unless opted in.** The test-user seam is
  enabled only by a genuinely set `STAGE=dev`, a CI flag, or
  `ENABLE_TEST_ROUTES=true`, and never under `STAGE=prod`/`production`. When
  on, it requires a real `SUPER_ADMIN` session plus CSRF. A harness that
  called it anonymously now sees `403 {"error":"Forbidden: Test endpoints are
  not enabled"}` (gate) or `401 {"error":"Unauthorized"}` (no session). Update
  harnesses to seed one `SUPER_ADMIN` row, seal a session cookie with the
  server's secret, and fetch a CSRF token from `/api/csrf-token`.
- **CSRF is no longer waived by the shape of an `Authorization` header.** If a
  request carries a session cookie, CSRF applies regardless of any Bearer
  token. Pure Bearer clients (mobile, server-to-server) send no cookie and are
  unaffected; a browser client that sent both must now also send the CSRF
  token.

## Monitoring conventions

Because the consuming application owns the runtime, it also owns dashboards and
alerting. Trellis is built to support standard observability practices:

- structured logs emitted to stdout for collection by the platform's log
  pipeline,
- background-queue failures routed to dead-letter queues so they can be
  alerted on — the worker acks a message only on an explicit disposition, so
  any thrown error advances the receive count toward the DLQ,
- a worker liveness endpoint on `WORKER_HEALTH_HOST`/`WORKER_HEALTH_PORT`
  (default `127.0.0.1:8081`) that must never be attached to a public ingress,
- request tracing when the platform enables it (see the
  [Observability guide](../guides/observability.md)).

The naming, retention, and alarm thresholds for these are operational policy
and belong to the consuming application, not to Trellis.

## Health and lifecycle

Trellis starts as a normal process and exits cleanly on shutdown signals,
running any registered extension shutdown hooks first. Treat it like any other
stateless service container: scale horizontally, drain on deploy, and rely on
the database, the key-value port and the queues for durable state. The worker
drains in-flight handlers for `WORKER_DRAIN_TIMEOUT_MS` (default 25 s); keep
that below the orchestrator's grace period.

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
