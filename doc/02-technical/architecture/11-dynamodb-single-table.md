# DynamoDB Single-Table Design

## Overview

A single DynamoDB table backs all KV namespaces. On-demand billing means zero cost at zero traffic and pennies at low traffic.

## Table Definition

```typescript
// CDK
const table = new dynamodb.Table(this, 'MainTable', {
  tableName: `${stage}-trellis`,
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'ttl',
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  pointInTimeRecovery: true,
  removalPolicy: stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
});

// GSI for reverse lookups and queries by type
table.addGlobalSecondaryIndex({
  indexName: 'gsi1',
  partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});
```

## Access Patterns and Key Design

Each row has `pk` (partition key), `sk` (sort key), optional `gsi1pk`/`gsi1sk` for the secondary index, optional `ttl` for auto-expiry, and a `data` attribute holding the payload.

### Rate Limiting

Replaces: KV rate limiting namespace.

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

Replaces: KV feed caching namespace.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Get user's feed cache | `feed:{userId}` | `page:{pageNum}` | +300s (5 min) | `{ postIds: [...] }` |
| Invalidate feed | Delete items with `pk = feed:{userId}` | — | — | — |

### Feature Toggles Cache

Replaces: In-memory feature toggle cache (backed by DB).

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Get all toggles | `config:feature-toggles` | `all` | +300s | `{ posts_enabled: true, ... }` |

Feature toggles are read from RDS and cached in DynamoDB for 5 minutes. Avoids a DB query on every request.

### Session Blocklist

Replaces: KV session blocklist namespace.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Block a session (force logout) | `session:blocked` | `{cognitoSub}` | +30d | `{ reason: "admin_action" }` |
| Check if session blocked | GetItem on above | — | — | — |

### CSRF Tokens

Replaces: KV CSRF namespace.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Store CSRF token | `csrf:{token}` | `meta` | +3600s (1 hour) | `{ userId, createdAt }` |

### Moderation Results Cache

Replaces: KV moderation results namespace.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Cache moderation result | `moderation:{contentHash}` | `result` | +86400s (24h) | `{ flagged: false, categories: [...] }` |

### Safe Browsing Cache

Replaces: KV threat intel namespace.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Cache URL check result | `safebrowsing:{urlHash}` | `result` | +86400s (24h) | `{ safe: true, checkedAt }` |

### Cost Protection

Used by OpenAI request budget and cost accumulator (see [12-cost-estimates.md](12-cost-estimates.md)).

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| OpenAI hourly counter | `costbudget:openai:hourly:{YYYY-MM-DDTHH}` | `v` | +2h | `{ count: 42 }` |
| OpenAI daily counter | `costbudget:openai:daily:{YYYY-MM-DD}` | `v` | +48h | `{ count: 350 }` |
| Daily cost per service | `costtrack:{YYYY-MM-DD}:{service}` | `v` | +48h | `{ units: 1000 }` |

### Export/Deletion Job Tracking

Replaces: KV export and deletion job tracking namespaces.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Track export job | `export:{jobId}` | `status` | +7d | `{ status, s3Key, userId }` |
| Track deletion job | `deletion:{userId}` | `status` | +30d | `{ status, steps: [...] }` |

### Taxonomy Cache

Replaces: KV taxonomy cache namespace.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Cache full taxonomy tree | `taxonomy:{tenantId}` | `tree` | +3600s | `{ dimensions: [...] }` |

### Cognito Claims Cache

Used by pre-token generation trigger (see [05-auth.md](05-auth.md)).

| Access Pattern | pk | sk | ttl | gsi1pk | gsi1sk | data |
|---|---|---|---|---|---|---|
| Cache user claims | `claims:{cognitoSub}` | `meta` | +3600s (1h) | — | — | `{ userId, role, handle }` |

### ActivityPub: Fedify KV Store

Used by Fedify framework (see [07-activitypub.md](07-activitypub.md)).

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Store actor key pair | `fedify:key:{actorUri}` | `pair` | none | `{ publicKey, privateKey }` |
| Store HTTP signature nonce | `fedify:nonce:{nonce}` | `meta` | +300s | `{ seen: true }` |
| Cache remote actor document | `fedify:actor:{actorUri}` | `doc` | +3600s | `{ actor JSON-LD }` |

### Privacy Preferences Cache

Replaces: KV privacy preferences namespace.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Cache user privacy settings | `privacy:{userId}` | `prefs` | +3600s | `{ locationVisible, metadataVisible }` |

### Connection Codes

Replaces: KV connection codes namespace.

| Access Pattern | pk | sk | ttl | data |
|---|---|---|---|---|
| Store friend connection code | `connect:{code}` | `meta` | +600s (10 min) | `{ userId, createdAt }` |

## GSI Usage

The `gsi1` index enables reverse lookups:

| Use Case | gsi1pk | gsi1sk |
|---|---|---|
| Find all rate limits for a user | `user:{userId}` | `ratelimit:{timestamp}` |
| Find all export jobs by status | `export-status:{status}` | `{createdAt}` |
| Find all deletion jobs by status | `deletion-status:{status}` | `{createdAt}` |

## TTL Strategy

Almost every item has a TTL. DynamoDB automatically deletes expired items (within ~48 hours of TTL expiry, eventually consistent). This provides:

- **Free cleanup** — no cron job needed to purge expired data
- **Cost control** — table size stays bounded
- **Rate limit reset** — counters auto-expire

Items without TTL (permanent storage):
- `fedify:key:*` — actor key pairs (must persist)
- `config:feature-toggles` — refreshed but never deleted

## Capacity Estimation

| Pattern | Reads/Month | Writes/Month | Notes |
|---------|-------------|-------------|-------|
| Rate limiting | ~300K | ~300K | Every API request |
| Feed cache | ~100K | ~10K | Cache hits avoid DB |
| Feature toggles | ~300K | ~8K | Read on every request |
| Session blocklist | ~300K | ~100 | Read on every request, rare writes |
| All others | ~50K | ~20K | Low frequency |
| **Total** | **~1M** | **~340K** | |

At on-demand pricing:
- Reads: $0.25 per million = $0.25/month
- Writes: $1.25 per million = $0.43/month
- **Total: ~$0.68/month**

## Cost Guardrails

DynamoDB on-demand has no upper limit by default. Protect against runaway writes:

1. **Application-level circuit breaker** — if write errors spike, stop writing
2. **CloudWatch alarm** on `ConsumedWriteCapacityUnits` — alert if > 10x normal
3. **AWS Budget** — DynamoDB is included in the overall $75/month budget alarm

```typescript
// CDK
new Alarm(this, 'DynamoWriteSpike', {
  metric: table.metricConsumedWriteCapacityUnits({ period: Duration.minutes(5) }),
  threshold: 500,  // 500 WCU in 5 min = 10x normal
  evaluationPeriods: 2,
  treatMissingData: TreatMissingData.NOT_BREACHING,
  alarmActions: [alertTopic],
});
```
