# 05 — Connection protocol and `IGraphConnection` impact

## Neptune speaks Bolt natively

The self-hosted analysis implies Neptune requires a different protocol, but
this is only partially correct. Neptune supports **two openCypher connection
modes**:

1. **Bolt (TCP)** — the Neo4j binary protocol, port 8182, using `bolt://`
   URI scheme. Uses the standard Neo4j driver (`neo4j` npm package,
   `neo4j-driver` in Python, etc.).
2. **HTTPS** — REST-style HTTP/1.1 endpoint at
   `https://endpoint:8182/openCypher`. Uses the AWS SDK or raw HTTP.

The existing `IGraphConnection` interface is Bolt-centric. Neptune's Bolt
support means a `NeptuneServerlessConnection` can expose a `bolt://` URI
and use the same Neo4j driver the rest of the stack already depends on.

## Authentication model difference

This is the real divergence from the self-hosted design, not the protocol.

| | Self-hosted Neo4j | Neptune (no IAM) | Neptune (IAM auth) |
|---|---|---|---|
| Credential type | Username + password | None (`AuthTokens.none()`) | AWS SigV4 token |
| Where stored | Secrets Manager secret | N/A | Not stored — generated from ECS task role |
| `credentialsSecret` role | Required | Unused / null | Optional (role grant instead) |

### Option A: Neptune without IAM auth

Neptune IAM authentication is **optional**. With it disabled, the cluster
accepts any Bolt connection from within the VPC — the VPC security group
is the access control boundary (the same posture as the self-hosted design).

The Neo4j driver still needs an auth parameter; Neptune ignores it:

```typescript
const driver = neo4j.driver(
  'bolt://cluster-endpoint.neptune.amazonaws.com:8182',
  neo4j.auth.none(),   // Neptune ignores credentials when IAM auth is off
  { encrypted: true, trust: 'SYSTEM' }
);
```

Security analysis: same as the self-hosted design — VPC isolation + security group
restrict access to the API task's security group. No credentials in flight.
Acceptable for a private VPC deployment.

### Option B: Neptune with IAM auth

With IAM auth enabled, every Bolt request is signed with AWS Signature v4.
The Neo4j driver supports this via a custom auth token provider.

**Historical caveat (now resolved):** Older Neo4j Bolt drivers for Python,
JavaScript, .NET, and Go did not automatically renew the SigV4 token after
expiry (typically 5 minutes). This caused drivers to fail mid-session.
These issues are fixed in recent driver versions (check driver changelog
before pinning a version). Java driver was always unaffected.

With IAM auth there is no username/password at all — the ECS task role
is granted `neptune-db:*` (or a scoped subset) on the cluster:

```typescript
cluster.grantConnect(apiTaskDefinition.taskRole);
```

This is strictly more secure: no static credential to rotate, no secret
to manage, and access control is fully auditable via CloudTrail (IAM calls)
rather than secret rotation logs.

### Recommendation for `NeptuneServerlessConnection`

Use **IAM auth**. The marginal complexity (driver version check, SigV4
token provider) is a one-time build cost, and it eliminates the
`credentialsSecret` from the `IGraphConnection` shape entirely for Neptune.

## Impact on `IGraphConnection`

The current interface ([the self-hosted analysis](../graph-db-self-host-ai-revisit.md)):

```typescript
export interface IGraphConnection {
  readonly boltUriParameter: ssm.IStringParameter;    // bolt://…:7687
  readonly credentialsSecret: secretsmanager.ISecret; // user + password
}
```

For Neptune with IAM auth, there is no credential secret. Two options for
handling this:

### Option 1: Add an optional `grantConnect()` method

```typescript
export interface IGraphConnection {
  readonly boltUriParameter: ssm.IStringParameter;
  readonly credentialsSecret: secretsmanager.ISecret | null;
  grantConnect?(grantee: iam.IGrantable): void;
}
```

- Neo4j / AuraDB implementations: `credentialsSecret` is non-null,
  `grantConnect` is a no-op or omitted.
- Neptune implementation: `credentialsSecret` is null, `grantConnect`
  grants `neptune-db:*` to the grantee.
- Consumers test `credentialsSecret !== null` to decide whether to inject
  the secret env var, and call `grantConnect` when present.

### Option 2: Keep the interface, use a dummy secret for Neptune

Neptune doesn't use credentials in no-IAM mode, so `credentialsSecret`
could be an empty/placeholder Secrets Manager secret (a blank JSON object).
Consumers always inject it, Neptune always ignores it. This keeps the
existing interface shape identical.

**Downside:** a standing empty secret wastes a small amount of cost and
is misleading to readers of the construct.

### Recommended: Option 1 with a `grantConnect()` extension

It accurately represents what Neptune needs, doesn't break existing consumers
(the new fields are optional/nullable), and avoids the confusing empty-secret
antipattern. The self-hosted design's `AuraGraphConnection` keeps
`credentialsSecret` and ignores `grantConnect`; `NeptuneServerlessConnection` sets
`credentialsSecret = null` and implements `grantConnect`.

## Bolt endpoint URL format

Neptune's cluster endpoint is a DNS name like:

```
your-cluster.cluster-xxxx.eu-central-1.neptune.amazonaws.com
```

The bolt URI becomes:

```
bolt://your-cluster.cluster-xxxx.eu-central-1.neptune.amazonaws.com:8182
```

This is stored in the SSM parameter by `NeptuneServerlessConnection` exactly
as the Neo4j self-hosted construct stores its Route53 record, so consumers
see the same `boltUriParameter` contract.

## Lambda: use HTTPS, not Bolt

AWS documents explicitly recommend **not** using the Bolt driver inside Lambda
functions, because Bolt maintains a persistent TCP connection and has
non-trivial startup cost. For Lambda-based graph access (e.g. a Lambda that
triggers on a DynamoDB stream and updates the graph), use the HTTPS endpoint
with `@aws-sdk/client-neptunedata` instead.

The ECS API service uses long-lived Bolt connections (the driver is
instantiated once, reused for the process lifetime) — that is the intended
Bolt usage pattern and not affected by the Lambda caveat.

## Post-failover reconnection

After Neptune fails over to the reader replica, the cluster DNS endpoint
resolves to the new writer. The Bolt driver caches DNS; it must be
**closed and reopened** to pick up the new IP. The application layer should:

1. Catch `ServiceUnavailable` or `SessionExpired` exceptions from the driver.
2. Close the driver (`driver.close()`).
3. Recreate it pointing to the same cluster endpoint URL (DNS will resolve
   to the new writer at that point).

This is a ~30-line retry-with-reconnect wrapper. It belongs in the graph
connection factory (`graph-factory.ts`) alongside the existing retry logic
for transient query errors.

## Open questions

- **Bolt driver version matrix.** Confirm which driver version is in use and
  verify its SigV4 token-renewal behaviour before enabling IAM auth. The
  JavaScript driver issue #993 was resolved, but pin a specific version and
  add it to the dependency audit.
- **Custom IAM actions.** `neptune-db:*` is broad. Neptune supports
  fine-grained IAM condition keys (`neptune-db:QueryLanguage`,
  `neptune-db:ReadDataViaQuery`, `neptune-db:WriteDataViaQuery`). A
  tighter grant is worth designing if the principle-of-least-privilege
  posture from the self-hosted design applies here.
