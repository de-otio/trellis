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
