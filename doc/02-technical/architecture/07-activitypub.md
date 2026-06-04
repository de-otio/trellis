# ActivityPub Federation on AWS

## Overview

ActivityPub federation (via Fedify) is **disabled by default** and enabled per environment via `config.features.activityPub`. When enabled, Fedify is compatible with any environment that supports `fetch()` — it runs natively in the Fargate API container alongside all other routes.

## Enablement preconditions (blocking)

Federation is, by design, data sharing with servers trellis does not control.
Public ActivityPub collections (followers/following) are free OSINT for graph
fusion — exactly the harvesting threat described in the surveillance threat
model ([`05-activitypub-exposure.md`](../surveillance-threat-model/05-activitypub-exposure.md)).
Because no vertical has enabled federation yet, these controls cost nothing to
require now and become a breaking retrofit the day after someone flips the flag.

**This is a hard gate.** The `features.activityPub` flag **MUST NOT** be enabled
in any deployment (dev, staging, prod, or a vertical's own environment) until
**all four** of the following controls exist and are active. This mirrors the
go-public gate pattern: enablement is blocked, not merely discouraged.

1. **Authorized fetch (secure mode).** The server **MUST** require a valid HTTP
   signature on `GET` requests to actor documents and collection endpoints
   (followers, following, outbox), not only on inbox `POST`s. Unsigned or
   invalidly-signed GETs **MUST** receive a reduced response (e.g. `401`, or an
   actor stub without `publicKey`/endpoints and collections returning only
   `totalItems`). Rationale: this forces scraping to come from a real,
   identifiable, revocable federated actor instead of anonymous HTTP — see
   [`05-activitypub-exposure.md` §"Proposed enablement preconditions" item 1](../surveillance-threat-model/05-activitypub-exposure.md#proposed-enablement-preconditions).

2. **Follower/following-list visibility setting.** Per-user control over whether
   the followers/following collections enumerate their members or return only
   `totalItems` **MUST** exist, and the privacy-preserving mode (count only)
   **MUST** be the default. Rationale: this is the single highest-value control
   against graph harvesting — see
   [`05-activitypub-exposure.md` §"Proposed enablement preconditions" item 2](../surveillance-threat-model/05-activitypub-exposure.md#proposed-enablement-preconditions).

3. **Instance deny/allow-list (defederation).** A per-environment (and
   eventually per-tenant) deny/allow-list **MUST** be in place so hostile or
   abusive instances can be defederated. Inbound activities and outbound
   delivery to denied instances **MUST** be refused. Rationale: federation
   without a defederation lever cannot respond to a hostile peer — see
   [`05-activitypub-exposure.md` §"Proposed enablement preconditions" item 3](../surveillance-threat-model/05-activitypub-exposure.md#proposed-enablement-preconditions).

4. **Distributed federation rate limiting.** Federation rate limits **MUST** be
   enforced through the shared distributed token-bucket infrastructure
   (`apps/api/src/lib/rate-limit.ts`), **NOT** an in-process / in-memory window.
   Limits **MUST** hold across all Fargate tasks, not per-process. Rationale: an
   in-memory limit is trivially bypassed by spreading requests across tasks —
   see [`05-activitypub-exposure.md` §"Proposed enablement preconditions" item 4](../surveillance-threat-model/05-activitypub-exposure.md#proposed-enablement-preconditions).

**Residual exposure (acknowledged, not waivable).** Even with all four controls,
a hostile federated server can retain whatever it legitimately receives.
Authorized fetch and visibility settings reduce bulk harvesting; they cannot
prevent retention by a peer that has been granted access. That residual risk
belongs in each vertical's explicit decision to enable federation at all — which
is precisely why federation is a per-deployment flag, not a default.

## Architecture

ActivityPub endpoints run in the **same Fargate container** as the main API. HTTP Signature verification runs as route-specific middleware, not a separate service. This simplifies the architecture (one process, one DB pool) while keeping federation logic isolated in its own route module.

### Endpoints

```
GET  /.well-known/webfinger                    → Actor discovery
GET  /users/{username}                          → Person actor document
POST /users/{username}/inbox                    → Receive activities
GET  /users/{username}/outbox                   → Activity history
GET  /users/{username}/followers                → Followers collection (sourced from Neo4j RELATES_TO edges when AP enabled)
GET  /users/{username}/following                → Following collection (sourced from Neo4j RELATES_TO edges when AP enabled)
GET  /users/{username}/friends                  → Friends collection
GET  /entities/{entityType}/{entityId}            → Entity actor (type-aware)
GET  /groups/{groupId}                          → Group actor
GET  /audiences/{audienceId}                    → Custom audience
POST /users/{username}/messages                 → DM inbox
```

## Fedify in the Fargate Container

Fedify uses the web standard `Request`/`Response` API. In the Fargate container, integrate it with the Node.js HTTP server:

```typescript
import { createFederation } from '@fedify/fedify';

const federation = createFederation<AppContext>({
  kv: new DynamoDbKvStore(TABLE_NAME, docClient),
  queue: new SqsMessageQueue(FEDERATION_OUTBOX_URL, sqsClient),
});

// In the route registry
router.get('/.well-known/webfinger', (req) => federation.fetch(req, { contextData: getContext() }));
router.all('/users/:username/*', (req) => federation.fetch(req, { contextData: getContext() }));
router.get('/entities/:entityType/:entityId', (req) => federation.fetch(req, { contextData: getContext() }));
router.get('/groups/:groupId', (req) => federation.fetch(req, { contextData: getContext() }));
```

### Fedify KV Store (DynamoDB)

Fedify needs a key-value store for actor key pairs, HTTP Signature nonce tracking, and actor document caching. See [11-dynamodb-single-table.md](11-dynamodb-single-table.md) for the key design (`fedify:key:*`, `fedify:nonce:*`, `fedify:actor:*`).

```typescript
import { KvStore, KvKey } from '@fedify/fedify';

export class DynamoDbKvStore implements KvStore {
  constructor(private tableName: string, private client: DynamoDBDocumentClient) {}

  async get<T>(key: KvKey): Promise<T | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `fedify:${this.keyToString(key)}`, sk: 'value' },
    }));
    if (!result.Item || (result.Item.ttl && result.Item.ttl < Math.floor(Date.now() / 1000))) {
      return undefined;
    }
    return result.Item.data as T;
  }

  async set<T>(key: KvKey, value: T): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `fedify:${this.keyToString(key)}`,
        sk: 'value',
        data: value,
        ttl: this.getTtl(key),
      },
    }));
  }

  async delete(key: KvKey): Promise<void> {
    await this.client.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { pk: `fedify:${this.keyToString(key)}`, sk: 'value' },
    }));
  }

  private keyToString(key: KvKey): string {
    return key.join(':');
  }

  private getTtl(key: KvKey): number | undefined {
    // Nonces expire in 5 min, actor cache in 1 hour, keys never expire
    const prefix = key[0];
    const now = Math.floor(Date.now() / 1000);
    if (prefix === 'nonce') return now + 300;
    if (prefix === 'actor') return now + 3600;
    return undefined; // Key pairs persist
  }
}
```

### Fedify Message Queue (SQS)

Outgoing activity delivery is async via the `federation-outbox` SQS queue (see [06-async-processing.md](06-async-processing.md)):

```typescript
import { MessageQueue } from '@fedify/fedify';

export class SqsMessageQueue implements MessageQueue {
  constructor(private queueUrl: string, private sqsClient: SQSClient) {}

  async enqueue(message: any): Promise<void> {
    await this.sqsClient.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(message),
    }));
  }
}
```

The `federationOutboxWorker` Lambda (see [02-compute.md](02-compute.md)) processes outgoing deliveries.

## HTTP Signatures

ActivityPub requires HTTP Signatures for server-to-server authentication.

| Aspect | Implementation |
|--------|---------------|
| Signing algorithm | `rsa-sha256` (ActivityPub standard) |
| Key storage | DynamoDB (`fedify:key:{actorUri}`) |
| Key generation | Fedify generates RSA-2048 key pairs on actor creation |
| Signing | Fedify handles outgoing request signing automatically |
| Verification | Fedify verifies incoming signatures via middleware |
| Nonce tracking | DynamoDB with 5-minute TTL (prevents replay attacks) |

Actor key pairs are generated when a User or Entity is created and stored permanently in DynamoDB. Fedify handles all signing/verification mechanics.

## Extension Actor Enrichment

Entity actors use type-aware URIs (`/entities/{type}/{id}`) and a generic `EntityActorDispatcher` (replaces the former type-specific dispatchers). Extensions can add display-only fields to actor documents via the `enrichActor` hook:

```typescript
// Extension provides display-only enrichment
const enrichment: ActorEnrichment = {
  summary: "Acme Model X, released 2024",
  icon: { type: "Image", url: "https://..." },
  attachment: [
    { type: "PropertyValue", name: "Category", value: "Model X" },
  ],
};
```

**Security boundary**: Extensions can only set `summary`, `icon`, and `attachment`. The core always owns `id`, `publicKey`, `inbox`, `outbox`, `endpoints`, `@context`, and `preferredUsername` — these are never overridable by extensions, preventing federation impersonation.

## DNS and Discovery

WebFinger (`/.well-known/webfinger`) must be accessible at the domain root. With CloudFront → ALB → Fargate:

- CloudFront behavior: `/.well-known/*` → ALB origin → Fargate container
- No caching on WebFinger responses (they may change)
- `Content-Type: application/jrd+json`

## Rate Limiting for Federation

Federation traffic can be abused. DynamoDB-backed rate limiting (see [11-dynamodb-single-table.md](11-dynamodb-single-table.md)):

| Limit | Value | Key Pattern |
|-------|-------|-------------|
| Inbox POST per remote domain | 60/min | `ratelimit:domain:{domain}` → `inbox:{minuteBucket}` |
| WebFinger lookups per IP | 30/min | `ratelimit:ip:{ip}` → `webfinger:{minuteBucket}` |
| Outbox reads per IP | 120/min | `ratelimit:ip:{ip}` → `outbox:{minuteBucket}` |

DynamoDB TTL automatically cleans up expired rate limit entries.

## Feature Flag: Federation On/Off

Federation can be disabled globally via the `FeatureToggle` table (e.g., `federation_enabled`). When disabled:
- Federation routes return `503 Service Unavailable`
- No outgoing activities are enqueued to `federation-outbox`
- Incoming activities are dropped (not queued)

The toggle is cached in DynamoDB (see [11-dynamodb-single-table.md](11-dynamodb-single-table.md), `config:feature-toggles`), so disabling takes effect within 5 minutes.
