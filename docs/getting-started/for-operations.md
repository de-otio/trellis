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
  origin that calls the API. `example.com` was also removed from the shipped
  allow-list.
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
