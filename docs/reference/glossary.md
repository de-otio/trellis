---
title: Glossary
description: Definitions for core Trellis concepts and terms.
sidebar: Glossary
order: 10
---

# Glossary

| Term | Meaning |
|------|---------|
| **Entity** | The core social object — a polymorphic record whose `entityType` field identifies which extension owns it (e.g. the entity type registered by a domain extension). When ActivityPub federation is enabled, an entity can be projected as an ActivityPub actor. |
| **Extension** | A pluggable module (`TrellisExtension`) that adds a domain-specific entity type, metadata schema, routes, scheduled jobs, and display enrichment. A vertical defines it in its own repository and registers it via `registerExtension()` at startup; the core never statically imports an extension. |
| **ExtensionContext** | A scoped context passed to extensions — provides limited database access and config, never secrets or admin tables. |
| **Extension Registry** | Startup-validated list of loaded extensions (`apps/api/src/extensions.ts`). Rejects duplicate IDs, reserved names, and conflicting routes. |
| **Stage** | Deployment environment: `dev` or `prod`. |
| **Single table** | The DynamoDB table storing all KV/cache data for a given stage. |
| **Stateful stack** | CDK stack containing durable data resources (database, storage, auth). Protected from accidental deletion. |
| **Stateless stack** | CDK stack containing compute-only resources (API, workers, CDN). Can be recreated freely. |
| **DLQ** | Dead-Letter Queue — receives SQS messages that exhausted their processing retries, so worker failures can be inspected and alerted on. |
| **OAC** | Origin Access Control — CloudFront mechanism to keep S3 buckets private while serving assets through the CDN. |
| **Fedify** | The ActivityPub framework powering Trellis federation. |
| **Presigned URL** | Time-limited S3 URL for direct client uploads, bypassing the API server. |
| **Cognito trigger** | Lambda function invoked by Cognito on auth events (e.g. pre-signup, post-confirmation). |
