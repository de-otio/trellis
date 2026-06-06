---
title: DynamoDB Single-Table Design
description: How Trellis consolidates all KV namespaces into one DynamoDB table.
sidebar: DynamoDB
order: 15
---

# DynamoDB Single-Table Design

## Overview

A single DynamoDB table backs the KV namespaces. On-demand billing means zero cost at zero traffic and automatic scaling without provisioning. The table name defaults to `${stage}-trellis` and is overridable via the `DYNAMODB_TABLE` environment variable (`apps/api/src/env.ts`).

> **How the API reaches the table.** Most application code does **not** talk to
> the DynamoDB SDK directly. The API binds a set of named KV namespaces
> (`RATE_LIMIT_KV`, `FEED_CACHE_KV`, `CSRF_TOKENS_KV`, …) built from
> `DynamoKv` (`@de-otio/saas-foundation/kv`), which exposes a
> Cloudflare-KV-compatible interface (`get`/`put`/`delete`) over the single
> table. A handful of paths — notably the Cognito claims cache
> (`apps/api/src/lib/auth/claims-cache.ts`) — use the raw DynamoDB SDK against
> the same `{stage}-trellis` table with explicit `pk`/`sk` keys. The CDK table
> definition itself lives in the deploying application's infrastructure
> (`@de-otio/saas-foundation`), not in this repo.

## Table Structure

The table uses a composite key (`pk` + `sk`), a `ttl` attribute for auto-expiry, and a `data`/value attribute holding the payload. The illustrative shape:

```typescript
// Illustrative — the real definition lives in the deploying app's infra.
const table = new dynamodb.Table(this, 'MainTable', {
  tableName: `${stage}-trellis`,
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'ttl',
});
```

> **Status — access-pattern catalogue.** The tables below enumerate the KV
> access patterns Trellis uses or plans to use. The namespaces actually bound in
> `apps/api/src/env.ts` today are: `ratelimit`, `privacy`, `friends`,
> `connections`, `feed`, `moderation`, `comments`, `threatintel`, `taxonomy`,
> `followers`, `export`, `delete`, `csrf`, `session`, `invitations` (plus the
> raw-SDK claims cache). Entries below for namespaces not in that list —
> e.g. the `fedify:*` key store, `safebrowsing:*`, and `costbudget:*`/`costtrack:*` —
> are design-stage and may not have shipped backing yet. Verify against the code
> before relying on them. Some auxiliary stores (idempotency, the token-bucket
> rate limiter, device-auth, agent-refresh) use their own dedicated tables, each
> behind its own `*_TABLE` env var, rather than the shared `{stage}-trellis`
> table.

## Access Patterns and Key Design

### Rate Limiting

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Check/increment user rate | `ratelimit:user:{userId}` | `{endpoint}:{minuteBucket}` | +60s | `{ count: N }` |
| Check/increment IP rate | `ratelimit:ip:{ip}` | `{endpoint}:{minuteBucket}` | +60s | `{ count: N }` |
| Check/increment domain rate (federation) | `ratelimit:domain:{domain}` | `inbox:{minuteBucket}` | +60s | `{ count: N }` |

```typescript
// Atomic increment with conditional check
const result = await docClient.update({
  TableName: TABLE,
  Key: { pk: `ratelimit:user:${userId}`, sk: `${endpoint}:${bucket}` },
  UpdateExpression: 'ADD #count :inc SET #ttl = if_not_exists(#ttl, :ttl)',
  ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
  ExpressionAttributeValues: {
    ':inc': 1,
    ':ttl': Math.floor(Date.now() / 1000) + 60,
    ':limit': maxRequests,
  },
  ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
  ReturnValues: 'UPDATED_NEW',
});
```

### Feed Cache

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Get user's feed cache | `feed:{userId}` | `page:{pageNum}` | +300s | `{ postIds: [...] }` |
| Invalidate feed | Delete items with `pk = feed:{userId}` | — | — | — |

### Feature Toggles Cache

Feature toggles are read from RDS and cached in DynamoDB to avoid a database query on every request.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Get all toggles | `config:feature-toggles` | `all` | +300s | `{ posts_enabled: true, ... }` |

### Session Blocklist

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Block a session (force logout) | `session:blocked` | `{cognitoSub}` | long | `{ reason: "admin_action" }` |
| Check if session blocked | GetItem on above | — | — | — |

### CSRF Tokens

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Store CSRF token | `csrf:{token}` | `meta` | +3600s | `{ userId, createdAt }` |

### Moderation Results Cache

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Cache moderation result | `moderation:{contentHash}` | `result` | +86400s | `{ flagged: false, categories: [...] }` |

### Safe Browsing Cache

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Cache URL check result | `safebrowsing:{urlHash}` | `result` | +86400s | `{ safe: true, checkedAt }` |

### Cost Protection

Used by the OpenAI request budget and cost accumulator.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| OpenAI hourly counter | `costbudget:openai:hourly:{YYYY-MM-DDTHH}` | `v` | short | `{ count: N }` |
| OpenAI daily counter | `costbudget:openai:daily:{YYYY-MM-DD}` | `v` | short | `{ count: N }` |
| Daily cost per service | `costtrack:{YYYY-MM-DD}:{service}` | `v` | short | `{ units: N }` |

### Export/Deletion Job Tracking

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Track export job | `export:{jobId}` | `status` | long | `{ status, s3Key, userId }` |
| Track deletion job | `deletion:{userId}` | `status` | long | `{ status, steps: [...] }` |

### Taxonomy Cache

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Cache full taxonomy tree | `taxonomy:{tenantId}` | `tree` | +3600s | `{ dimensions: [...] }` |

### Cognito Claims Cache

Used by the pre-token generation trigger.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Cache user claims | `claims:{cognitoSub}` | `meta` | +3600s | `{ userId, role, handle }` |

### ActivityPub: Fedify KV Store

Used by the Fedify framework.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Store actor key pair | `fedify:key:{actorUri}` | `pair` | none | `{ publicKey, privateKey }` |
| Store HTTP signature nonce | `fedify:nonce:{nonce}` | `meta` | +300s | `{ seen: true }` |
| Cache remote actor document | `fedify:actor:{actorUri}` | `doc` | +3600s | `{ actor JSON-LD }` |

### Privacy Preferences Cache

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Cache user privacy settings | `privacy:{userId}` | `prefs` | +3600s | `{ locationVisible, metadataVisible }` |

### Connection Codes

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Store connection code | `connect:{code}` | `meta` | +600s | `{ userId, createdAt }` |

## GSI Usage

A `gsi1` (`gsi1pk` + `gsi1sk`) reverse-lookup index is used in the shipped code on
the **agent-refresh** table (`apps/api/src/lib/oauth/refresh-detection.ts`) — for
example listing all agent sessions for a user via `gsi1pk = u#{userId}`. The
illustrative reverse-lookup patterns below describe how a GSI on the shared table
*would* be used for job/rate-limit queries; they are design-stage and not all
present in the current code, so verify before relying on them.

| Use Case | gsi1pk | gsi1sk |
|---|---|---|
| Find all agent sessions for a user (shipped) | `u#{userId}` | `s#{sessionId}` |
| Find all export jobs by status | `export-status:{status}` | `{createdAt}` |
| Find all deletion jobs by status | `deletion-status:{status}` | `{createdAt}` |

## TTL Strategy

Almost every item has a TTL. DynamoDB automatically deletes expired items (within ~48 hours of TTL expiry, eventually consistent). This provides:

- **Free cleanup** — no cron job needed to purge expired data
- **Cost control** — table size stays bounded
- **Rate limit reset** — counters auto-expire

Items without TTL (permanent storage):
- `fedify:key:*` — actor key pairs (must persist indefinitely)
- `config:feature-toggles` — refreshed continuously but never deleted
