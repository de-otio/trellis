# DB Connection Management — Implementation Plan

**Goal:** implement the database-connection-management strategy for the graph
layer so a consuming deployment's first dev deploy is safe against Aura Free's
~50-connection cap, and so prod sizing is explicit rather than inherited from
driver defaults. (The connection-pool config and error-handling here are
trellis-core; the AuraDB/RDS hosting and per-stage sizing are owned by the
consuming deployment. A consuming application typically captures the strategy
in its own architecture doc, e.g. `15-database-connection-management.md`.)

**Scope:** AuraDB connection config (plumbing + defaults), basic safety alarms (Aura auth-failure + pool-acquire-timeout), DoS-mitigation posture for graph-heavy endpoints, and a fail-closed synth guard for prod. Postgres is already tuned acceptably (`DATABASE_POOL_MAX=10`, t4g.micro has ~85 ceiling, safe with `maxCount=2`).

**Out of scope (tracked as follow-ups):** full pool-stat metrics export to CloudWatch (active/idle/p99 acquire), circuit breaker implementation, RDS Proxy, read replicas.

**Security review:** this plan incorporates 9 findings from a 2026-04-12 security review. Key results: fail-closed prod synth guard, empirical probe hardening, in-scope alarms, `intEnv` input validation, Lambda pool clamp, error-path disclosure audit, and rollback-window documentation. Non-findings were also reviewed (SSM credential path, session isolation).

---

## Current state (2026-04-12)

| Driver option | Driver default | Our hardcoded value | Location |
|---|---|---|---|
| `maxConnectionPoolSize` | 100 | **50** | [`graph-factory.ts:42`](../../apps/api/src/lib/graph/graph-factory.ts) via `GraphPoolConfig.maxSize` |
| `connectionAcquisitionTimeout` | 60_000 ms | **30_000 ms** | same, via `GraphPoolConfig.acquireTimeoutMs` |
| `maxConnectionLifetime` | 3_600_000 ms | **3_600_000 ms** | [`neo4j-graph-service.ts:90`](../../apps/api/src/lib/graph/neo4j-graph-service.ts); **misleadingly named** `GraphPoolConfig.idleTimeoutMs` in the type — it's actually connection lifetime, not idle time |
| `connectionLivenessCheckTimeout` | `undefined` (disabled) | Not supported in `GraphPoolConfig` | — |
| Per-stage config | — | None | — |
| Pool metrics export | — | Not implemented | — |
| Circuit breaker | — | Documented, not implemented | — |

Driver defaults sourced from [`neo4j-javascript-driver` v5 `constants.ts`](https://github.com/neo4j/neo4j-javascript-driver/blob/5.0/packages/core/src/internal/constants.ts).

At `maxPoolSize=50` × `fargate.maxCount=2`, a dev auto-scale event can open up to 100 Bolt sessions. The Aura Free ceiling **is not officially documented by Neo4j** — community reports put it around 50, which means the current sizing is unsafe if that estimate is correct, and unknown-safe if it isn't. **Deploy is not safe without this change, and the actual ceiling must be confirmed empirically (see Validation §1).**

---

## Target state

Config field names match Neo4j JavaScript driver options exactly, so the mapping from the deployment's config → driver config is 1:1 and readable.

| Config field (deployment) | Dev | Prod (placeholder) | Env var (trellis) | Driver option |
|---|---|---|---|---|
| `graphDb.maxConnectionPoolSize` | 15 | 17 | `GRAPH_DB_POOL_MAX_SIZE` | `maxConnectionPoolSize` |
| `graphDb.connectionAcquisitionTimeout` | 5_000 | 5_000 | `GRAPH_DB_POOL_ACQUIRE_TIMEOUT_MS` | `connectionAcquisitionTimeout` |
| `graphDb.maxConnectionLifetime` | 1_800_000 | 1_800_000 | `GRAPH_DB_POOL_MAX_LIFETIME_MS` | `maxConnectionLifetime` |
| `graphDb.connectionLivenessCheckTimeout` | 120_000 | 120_000 | `GRAPH_DB_POOL_LIVENESS_CHECK_MS` | `connectionLivenessCheckTimeout` |
| `graphDb.queryTimeoutMs` (application-level) | 5_000 | 5_000 | `GRAPH_DB_QUERY_TIMEOUT_MS` | — (applied in `GraphService` wrappers) |

Prod values are placeholders pending the Aura-ceiling empirical probe (Validation §1). Do not deploy prod without completing that step.

---

## Changes

### A. trellis core

**A1. Fix the misleading field name in `GraphPoolConfig`** ([`types.ts`](../../apps/api/src/lib/graph/types.ts)).

The field currently called `idleTimeoutMs` is passed to the driver as `maxConnectionLifetime`, not as an idle timeout. Rename and add missing fields so the type matches the driver 1:1:

```typescript
export interface GraphPoolConfig {
  /** Driver option: maxConnectionPoolSize. Default 100 (driver). */
  maxConnectionPoolSize?: number;
  /** Driver option: connectionAcquisitionTimeout. Default 60_000 ms (driver). */
  connectionAcquisitionTimeout?: number;
  /** Driver option: maxConnectionLifetime. Default 3_600_000 ms (driver). */
  maxConnectionLifetime?: number;
  /** Driver option: connectionLivenessCheckTimeout. Default undefined (disabled). */
  connectionLivenessCheckTimeout?: number;
}
```

**A2. Extend `GraphServiceEnvConfig` in [`graph-factory.ts`](../../apps/api/src/lib/graph/graph-factory.ts)** with optional fields matching the renamed pool config. Drop the old names (`maxPoolSize`, `acquireTimeoutMs`).

```typescript
export interface GraphServiceEnvConfig {
  uri: string;
  user?: string;
  password?: string;
  region?: string;
  maxConnectionPoolSize?: number;
  connectionAcquisitionTimeout?: number;
  maxConnectionLifetime?: number;
  connectionLivenessCheckTimeout?: number;
  queryTimeoutMs?: number;
}
```

Update `buildConnectionConfig` to forward these fields into `GraphConnectionConfig.pool`.

**A3. Read pool env vars in `createGraphServiceFromEnv`.**

```typescript
return createGraphService({
  uri: process.env.GRAPH_DB_URI,
  user: process.env.GRAPH_DB_USER,
  password: process.env.GRAPH_DB_PASSWORD,
  region,
  maxConnectionPoolSize: intEnv("GRAPH_DB_POOL_MAX_SIZE"),
  connectionAcquisitionTimeout: intEnv("GRAPH_DB_POOL_ACQUIRE_TIMEOUT_MS"),
  maxConnectionLifetime: intEnv("GRAPH_DB_POOL_MAX_LIFETIME_MS"),
  connectionLivenessCheckTimeout: intEnv("GRAPH_DB_POOL_LIVENESS_CHECK_MS"),
  queryTimeoutMs: intEnv("GRAPH_DB_QUERY_TIMEOUT_MS"),
});
```

Where `intEnv(name)` is **strict**: it returns `undefined` if the variable is unset, but `throw`s at startup if it is set to anything that is not a finite positive integer. Fail-fast beats silently accepting `NaN` (from `parseInt("abc")`) or `-5` and passing it to the driver.

```typescript
function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    // Throwing at startup fails the ECS health check, triggering a
    // rollback via ECS circuitBreaker instead of running with bad config.
    throw new Error(`${name} must be a positive integer, got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}
```

The `String(parsed) !== raw.trim()` check rejects trailing garbage (`"15; rm -rf /"` → rejected, not silently truncated to 15).

**A4. Update `Neo4jGraphService.connect` to pass all four driver options.**

Current code wires `maxConnectionLifetime: config.pool?.idleTimeoutMs ?? 3_600_000` — rename the source field and pass `connectionLivenessCheckTimeout` when set:

```typescript
this.driver = neo4j.driver(config.endpoint, auth, {
  maxConnectionPoolSize: config.pool?.maxConnectionPoolSize ?? 100,
  connectionAcquisitionTimeout: config.pool?.connectionAcquisitionTimeout ?? 60_000,
  maxConnectionLifetime: config.pool?.maxConnectionLifetime ?? 3_600_000,
  ...(config.pool?.connectionLivenessCheckTimeout !== undefined && {
    connectionLivenessCheckTimeout: config.pool.connectionLivenessCheckTimeout,
  }),
  disableLosslessIntegers: true,
});
```

Rationale for keeping driver defaults as the fallback (not our in-doc recommendations): the library's defaults are the right fallback when no env var is set (e.g. local dev, integration tests). Per-stage overrides come from the consuming deployment's CDK config.

**A5. No default-tightening at the factory level.** Earlier draft suggested tightening acquire timeout from 30 s → 5 s as a factory default — backed out, because that makes local dev and integration tests diverge from driver defaults. The tightening lives only in the consuming deployment's per-stage config.

**A6. Lambda-safe pool clamp in `createGraphServiceFromEnv`.** Belt-and-suspenders guard: regardless of what `GRAPH_DB_POOL_MAX_SIZE` is set to, clamp `maxConnectionPoolSize` to **1** when running in a Lambda (detected by the presence of `AWS_LAMBDA_FUNCTION_NAME`). Lambdas scale by spawning concurrent execution contexts, each with its own pool; a pool of 15 per Lambda × 50 concurrent invocations would trivially exhaust Aura.

```typescript
const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const poolMax = isLambda ? 1 : intEnv("GRAPH_DB_POOL_MAX_SIZE");
```

Today no Lambda opens Bolt (dual-write design routes graph writes through the API), so this guard has no current effect — it exists so that a future refactor that imports `createGraphServiceFromEnv()` from a Lambda cannot silently blow up Aura.

**A7. Sanitize Neo4j driver error messages inside the `GraphError` base class.** Driver errors commonly embed the Bolt URI (e.g. `bolt+s://<instance-id>.databases.neo4j.io`), which leaks the Aura instance ID and makes targeted credential-stuffing easier. Sanitization must happen at error *construction* time, not at each handler boundary — the code already has four handlers (`circle-handler.ts:266`, `discovery-handler.ts:193`, `entity-relationship-handler.ts:302`, `relationship-handler.ts:282`) that check `error?.constructor?.name === "GraphConnectionError"`, so fixing the base class fixes every call site at once.

Edit [`apps/api/src/lib/graph/errors.ts`](../../apps/api/src/lib/graph/errors.ts):

```typescript
// Strip Bolt URIs and anything that looks like a password before the message
// reaches Error.message (and hence logs + optional 5xx body echoes).
// Matches bolt://, bolt+s://, neo4j://, neo4j+s://, and bare neo4j.io host refs.
const BOLT_URI = /(bolt\+?s?|neo4j\+?s?):\/\/[^\s"']+/gi;
const NEO4J_HOST = /\b[a-z0-9]+\.databases\.neo4j\.io(?::\d+)?/gi;
// Password-like tokens in driver error messages (e.g., "authentication failure (user=neo4j password=...)").
const PASSWORD_TOKEN = /\b(password|passwd|pwd)\s*[=:]\s*\S+/gi;

function sanitize(msg: string): string {
  return msg
    .replace(BOLT_URI, "[bolt-uri-redacted]")
    .replace(NEO4J_HOST, "[aura-host-redacted]")
    .replace(PASSWORD_TOKEN, "$1=[redacted]");
}

export abstract class GraphError extends Error {
  abstract readonly code: string;
  constructor(message: string, options?: ErrorOptions) {
    super(sanitize(message), options);
    this.name = this.constructor.name;
  }
}
```

The `GraphQueryError.query` field is already sanitized of parameters per its JSDoc; confirm this during A8 by unit-testing that the URI pattern never appears in the stored query.

**Handler check (paired with A7):** grep the four handlers and `dual-write-service.ts` for any `logger.*(err.message)` or `err.stack` logging in graph-error catch blocks. The current pattern only checks `constructor.name` and returns a response; verify no code path logs the raw driver message. If any does, log `err.code` instead.

**A8. Verify graph integration tests.** Run `npm test -w @de-otio/trellis apps/api/test/integration/graph` with a local Docker Neo4j. All 94 tests should still pass; nothing in the tests relied on the old field names because they didn't override pool config. Confirm type errors on the field rename do not leak into other modules (grep for `idleTimeoutMs`, `acquireTimeoutMs`, `maxSize` references in the graph lib).

### B. Consuming deployment — CDK config

> Deployment-side. Trellis is not deployed standalone; the consuming application
> owns the CDK config below (paths such as `infra/lib/config/*` are illustrative
> of a typical CDK layout). The env vars these set are read by trellis core at
> startup.

**B1. Add `GraphDbConfig` interface to the deployment's config (`infra/lib/config/index.ts`).**

Field names match the Neo4j driver options exactly (see [types.ts](../../apps/api/src/lib/graph/types.ts) `GraphPoolConfig`). Use `undefined` as the sentinel for "not yet calibrated" — consumed by the §B3 synth guard.

```typescript
export interface GraphDbConfig {
  /** Max Bolt connections per Fargate task. Undefined = not yet calibrated for this stage. */
  maxConnectionPoolSize: number | undefined;
  /** Fail fast when pool is exhausted; should be < ALB idle timeout. */
  connectionAcquisitionTimeout: number;
  /** Maximum lifetime of a pooled connection before forced rotation. */
  maxConnectionLifetime: number;
  /** Opt-in idle liveness check; undefined disables. */
  connectionLivenessCheckTimeout: number;
  /** Per-query timeout; individual long paths can override. */
  queryTimeoutMs: number;
}
```

Add to `StageConfig` and `StageOverrides`. Add sensible base defaults matching the dev values except for `maxConnectionPoolSize`, which is intentionally `undefined` at the base level so that any stage that forgets to set it cannot deploy.

**B2. Add per-stage override in `dev.ts` / `prod.ts`.**

```typescript
// dev.ts — pool size set after empirical probe; see Validation §1.
graphDb: {
  maxConnectionPoolSize: 15,           // calibrated: probe measured ~<RESULT> sessions; 15 × maxCount(2) ≤ 0.7 × ceiling
  connectionAcquisitionTimeout: 5_000, // fail fast within ALB window
  maxConnectionLifetime: 1_800_000,    // 30 min, matches Neo4j KB recommendation
  connectionLivenessCheckTimeout: 120_000, // opt-in: guards against stale connections behind NAT
  queryTimeoutMs: 5_000,
},
```

```typescript
// prod.ts — DO NOT SET maxConnectionPoolSize until prod ceiling is measured.
graphDb: {
  maxConnectionPoolSize: undefined,    // sentinel: synth guard (§B3) blocks prod deploy
  connectionAcquisitionTimeout: 5_000,
  maxConnectionLifetime: 1_800_000,
  connectionLivenessCheckTimeout: 120_000,
  queryTimeoutMs: 5_000,
},
```

**B3. Fail-closed synth guard in `getConfig()`.** After applying overrides, the function validates that prod is calibrated. This makes the prod safeguard structural rather than a policy comment a human might miss.

```typescript
if (stage === "prod" && config.graphDb.maxConnectionPoolSize === undefined) {
  throw new Error(
    "Refusing to synth prod: graphDb.maxConnectionPoolSize not set. " +
    "Run the empirical Aura ceiling probe per plans/redesign/db-connection-management-plan.md Validation §1, " +
    "then populate infra/lib/config/prod.ts with the measured value.",
  );
}
```

Dev and other stages are permitted to run with `undefined` in case an operator wants the driver defaults — only prod is fail-closed.

### C. Consuming deployment — api-stack.ts

**C1. Wire pool env vars into the API container environment.**

`maxConnectionPoolSize` is conditionally injected — when the stage config has it as `undefined`, the env var is omitted and `createGraphServiceFromEnv` falls through to the driver default. This matters for dev-like stages that intentionally want the default.

```typescript
const graphEnv: Record<string, string> = {
  GRAPH_DB_POOL_ACQUIRE_TIMEOUT_MS: String(config.graphDb.connectionAcquisitionTimeout),
  GRAPH_DB_POOL_MAX_LIFETIME_MS: String(config.graphDb.maxConnectionLifetime),
  GRAPH_DB_POOL_LIVENESS_CHECK_MS: String(config.graphDb.connectionLivenessCheckTimeout),
  GRAPH_DB_QUERY_TIMEOUT_MS: String(config.graphDb.queryTimeoutMs),
};
if (config.graphDb.maxConnectionPoolSize !== undefined) {
  graphEnv.GRAPH_DB_POOL_MAX_SIZE = String(config.graphDb.maxConnectionPoolSize);
}
// … spread graphEnv into the container's `environment:` block alongside the existing
// GRAPH_DB_CREDENTIALS_SSM_PARAM wiring.
```

**C2. Leave IAM unchanged.** No new permissions required for the env-var additions.

---

### D. Observability (deployment-side — addresses security-review MEDIUM-3 / LOW-6)

> Deployment-side. The alarms below live in the consuming deployment's CDK; the
> log tokens they match (`Neo.ClientError.Security.Unauthorized`,
> `graph_pool_acquire_timeout`) are emitted by trellis core (§A7 / T3), so the
> two must stay in sync. CDK paths are illustrative.

Pool metrics export remains a follow-up. These two alarms are ~30 lines of CDK each and close the most dangerous blind spots.

**D1 + D2 placement.** Both go in the deployment's `infra/lib/stacks/api-stack.ts`, directly after the `logGroup` construction, because that's where the log group is created and the metric-filter must target it. The alert topic is looked up from SSM (e.g. `/{appName}/{stage}/alert-topic-arn`). Pattern below applies to both alarms; only filter pattern + alarm name differ.

```typescript
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";

const alertTopicArn = ssm.StringParameter.valueForStringParameter(
  this, ssmPath(config.appName, stage, "alert-topic-arn"),
);
const alertTopic = sns.Topic.fromTopicArn(this, "AlertTopic", alertTopicArn);

// D1 — Aura authentication failure
const authFailures = new logs.MetricFilter(this, "GraphAuthFailuresFilter", {
  logGroup,
  metricNamespace: `${config.appName}/Graph`,
  metricName: "AuthFailures",
  filterPattern: logs.FilterPattern.literal('"Neo.ClientError.Security.Unauthorized"'),
  metricValue: "1",
  defaultValue: 0,
});
const authAlarm = new cloudwatch.Alarm(this, "GraphAuthFailuresAlarm", {
  alarmDescription: "AuraDB authentication failures — credential rotation bug, leaked creds in use, or Aura-side lockout",
  metric: authFailures.metric({ statistic: "Sum", period: cdk.Duration.minutes(5) }),
  threshold: 1,
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
authAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

// D2 — Pool acquisition timeout
const acquireTimeouts = new logs.MetricFilter(this, "GraphPoolAcquireTimeoutsFilter", {
  logGroup,
  metricNamespace: `${config.appName}/Graph`,
  metricName: "PoolAcquireTimeouts",
  filterPattern: logs.FilterPattern.literal('"graph_pool_acquire_timeout"'),
  metricValue: "1",
  defaultValue: 0,
});
const acquireAlarm = new cloudwatch.Alarm(this, "GraphPoolAcquireTimeoutsAlarm", {
  alarmDescription: "AuraDB pool acquire timeout — pool undersized, or DoS in progress",
  metric: acquireTimeouts.metric({ statistic: "Sum", period: cdk.Duration.minutes(2) }),
  threshold: 1,
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
acquireAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));
```

The filter-pattern literal strings (`"Neo.ClientError.Security.Unauthorized"`, `"graph_pool_acquire_timeout"`) are the **exact log-line tokens** §A7 emits — keep them in sync.

**D3 — deferred to follow-up.** An earlier draft proposed an Aura RTT p99 alarm using "the existing per-request graph-latency log line." That log line does not currently exist — no graph-query timing instrumentation is in `Neo4jGraphService`. Adding it is a separate ~50-line change (wrap each `session.run()` in a timing wrapper that emits a structured log). Tracked under Follow-up work below. Until that lands, liveness-check amplification (security-review LOW-6) is detectable only via RDS-level symptoms; acceptable risk given the low severity rating.

**D4. Reserved budget dashboard panel.** Add a single Grafana / CloudWatch dashboard row showing `maxConnectionPoolSize × desiredCount` vs observed Aura connection count (manual refresh at first; automated when full pool metrics ship). Lets responders answer "are we near the ceiling?" without a console dive.

### E. DoS mitigation (addresses security-review MEDIUM-2)

Short acquire timeout plus modest per-task pool sizes means a small number of slow concurrent requests can produce 503s for everyone. Add defenses before the tightened pool config reaches prod. E1 is deployment-side (WAF); E2/E3 are trellis-core handler behaviour.

**E1. WAF rate-based rule scoped to graph-heavy paths (deployment-side).** Extends the consuming deployment's existing `wafRules` array in its `infra/lib/stacks/network-stack.ts`. The existing `RateLimit` rule stays as a volumetric safety net (10 000 / 5 min prod); the new rule is a tighter cap scoped to graph paths only. Auth-vs-unauth distinction is intentionally NOT done at WAF — WAF doesn't see session state cleanly. The app-level per-session token bucket (follow-up E4) is the correct layer for that; WAF handles the IP-level volumetric layer.

Add a new stage config field (`waf.graphRateLimit`) so the threshold is tunable per stage.

```typescript
// infra/lib/config/index.ts — WafConfig
export interface WafConfig {
  ipRateLimit: number;
  graphRateLimit: number;   // NEW — per-IP, per-5-min for /api/circles/* and /api/discovery/*
  botControl: boolean;
  botControlInspectionLevel: string;
}
// dev override: graphRateLimit: 200
// prod override: graphRateLimit: 500
```

Then in `network-stack.ts`, insert a new rule with priority 0 (before the existing RateLimit rule):

```typescript
{
  name: "GraphPathRateLimit",
  priority: 0,
  action: { block: {} },
  statement: {
    rateBasedStatement: {
      limit: config.waf.graphRateLimit,
      aggregateKeyType: "IP",
      scopeDownStatement: {
        orStatement: {
          statements: [
            {
              byteMatchStatement: {
                fieldToMatch: { uriPath: {} },
                positionalConstraint: "STARTS_WITH",
                searchString: "/api/circles/",
                textTransformations: [{ priority: 0, type: "NONE" }],
              },
            },
            {
              byteMatchStatement: {
                fieldToMatch: { uriPath: {} },
                positionalConstraint: "STARTS_WITH",
                searchString: "/api/discovery/",
                textTransformations: [{ priority: 0, type: "NONE" }],
              },
            },
          ],
        },
      },
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: resourceName(config, "graph-rate-limit"),
    sampledRequestsEnabled: true,
  },
},
```

The `scopeDownStatement` makes the rate-based rule count only graph-path requests against the per-IP limit. Non-graph requests are counted only by the existing global `RateLimit` rule.

**E2. Generic 503 body on pool exhaustion.** Handler-boundary sanitization (§A7) already ensures no driver internals leak. Additionally, ensure the response body for pool-timeout 503s is the **same** generic `{"error":"service_unavailable"}` payload as other graph-unavailable states. No pool stats, retry-after headers only (`Retry-After: 1`).

**E3. Response-time jitter on pool-exhaustion 503s.** Before returning, `await new Promise(r => setTimeout(r, 50 + Math.random() * 100))`. Flattens the 5 ms (healthy) vs 5000 ms (exhausted) timing side channel so an unauthenticated attacker cannot precisely map pool capacity. Applies only on pool-acquire-timeout responses; other errors keep their natural timing.

**E4. In-app concurrency token bucket (defer to follow-up).** Per-session concurrent-graph-request cap (e.g., 5 per session) would prevent a single session from monopolizing the pool. Belongs in the same PR as a proper request-metering middleware; not blocking this plan.

---

## Order of operations

1. **trellis core A1–A4, A6, A7** — field rename, env plumbing, Lambda guard, error sanitization. Unit tests confirm the driver receives the right options and error messages don't leak driver internals.
2. **trellis core A8** — run integration tests locally with custom env vars to verify overrides work.
3. **deployment B1–B3** — config interface, per-stage values, fail-closed synth guard.
4. **deployment C1** (env-var wiring) and **D1–D3** (alarms) in the same PR.
5. **E1 (deployment) + E2–E3 (trellis core)** — WAF rate-based rule, generic 503 body wired into the handler boundary, timing jitter. May be a separate PR but must land before prod.
6. **Publish the trellis core package.** Required because the consuming deployment's API container imports the published package.
   - Trellis publishes to npm as `@de-otio/trellis` via the tag-triggered `publish.yml` workflow (see the repo's Release Checklist). Bump to `0.2.0` — MINOR, because the `GraphPoolConfig` field rename (A1) is a breaking change for any consumer.
   - After publish, the consuming deployment bumps `@de-otio/trellis` to `^0.2.0` in its `apps/api/package.json`, runs `npm install` so `package-lock.json` reflects the new version, and commits both changes.
7. **Empirical Aura ceiling probe against dev Free (deployment-side)** — per Validation §1 below. Before deploy, not after. Script committed to the deployment's `scripts/ops/` and reviewed. Result populates `dev.ts`.
8. **Deploy dev (deployment-side)** — the deployment's `cdk deploy --context stage=dev` (or equivalent).
9. **Validate in dev** — run Validation items 2–10.
10. **Prod path (separate PR, deployment-side):**
    - Run the empirical ceiling probe against the production-sized Aura Pro instance from within the VPC (CloudShell or short-lived EC2), read creds via piped SSM fetch.
    - Rotate the Aura Professional account password (see Validation §1).
    - Populate `prod.ts` `maxConnectionPoolSize` with the measured value. Synth must succeed.
    - Deploy prod.

---

## Validation checklist

Numbered items correspond to §8 of the strategy doc, hardened per security-review findings.

1. **Aura ceiling empirical probe (hardened).** Before the first dev deploy, and again before the first prod deploy. Fixes security-review finding HIGH-1.
   - **Commit the probe script** to `scripts/ops/aura-connection-ceiling-probe.mjs`. Code-review the script before it runs. Concrete skeleton (~60 lines, zero deps outside the project's existing `neo4j-driver`):
     ```javascript
     #!/usr/bin/env node
     // Usage (run from the consuming deployment, with its AWS profile):
     //   aws ssm get-parameter \
     //     --name /{appName}/{stage}/neo4j/auradb/credentials \
     //     --with-decryption --query 'Parameter.Value' --output text \
     //     | node scripts/ops/aura-connection-ceiling-probe.mjs
     //
     // Opens Bolt sessions serially against AuraDB, holding them open,
     // until a new session fails. Prints the ceiling to stdout and exits.
     // Never logs the bolt URI, username, or password.

     import neo4j from "neo4j-driver";
     import { readFileSync } from "node:fs";

     const MAX_ATTEMPTS = 500;
     const HOLD_MS = 50;

     const raw = readFileSync(0, "utf8").trim();
     let creds;
     try { creds = JSON.parse(raw); } catch { fatal("stdin is not JSON"); }
     const { NEO4J_URI: uri, NEO4J_USERNAME: user, NEO4J_PASSWORD: password } = creds;
     if (!uri || !user || !password) fatal("missing NEO4J_URI/USERNAME/PASSWORD");

     const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
       maxConnectionPoolSize: MAX_ATTEMPTS + 10,
       connectionAcquisitionTimeout: 10_000,
     });
     const sessions = [];
     let lastError = null;

     for (let i = 1; i <= MAX_ATTEMPTS; i++) {
       const s = driver.session();
       try {
         await s.run("RETURN 1");
         sessions.push(s);
         process.stderr.write(`opened ${i}\r`);
         await new Promise((r) => setTimeout(r, HOLD_MS));
       } catch (err) {
         lastError = err;
         await s.close().catch(() => {});
         break;
       }
     }

     console.log(JSON.stringify({
       opened: sessions.length,
       firstFailureCode: lastError?.code ?? null,
       firstFailureClass: lastError?.constructor?.name ?? null,
     }));

     for (const s of sessions) { await s.close().catch(() => {}); }
     await driver.close();
     process.exit(0);

     function fatal(msg) { console.error(msg); process.exit(1); }
     ```
     The script deliberately does NOT log `err.message` (which may contain the Aura URI). It emits only the error code and class name.
   - **Run from inside the VPC.** AWS CloudShell (web console) for dev; ephemeral `aws ecs run-task` for prod. Do NOT run from a laptop for the prod probe.
   - Record the `opened` count next to the corresponding `graphDb` block in `dev.ts` / `prod.ts`. Set `maxConnectionPoolSize ≤ ⌊0.7 × opened / maxCount⌋`.
   - **For the prod probe only:** rotate the Aura Professional account password after the probe completes — the creds have transited an operator context, so treat them as potentially observed. Update the SSM SecureString; the next ECS task restart picks up the new value automatically.
2. Unit tests pass for `createGraphServiceFromEnv` with each new env var set / unset / malformed (confirms `intEnv` throws on `NaN` and negatives).
3. Unit tests confirm Lambda pool clamp: with `AWS_LAMBDA_FUNCTION_NAME` set and `GRAPH_DB_POOL_MAX_SIZE=50`, the driver still receives `maxConnectionPoolSize=1`.
4. Integration tests (all 94) in trellis still pass against Docker Neo4j.
5. (deployment) `cdk diff --context stage=dev` shows only the expected env-var additions + alarms + WAF rule on the affected stacks — no unrelated drift.
6. (deployment) `cdk synth --context stage=prod` while `prod.ts` has `maxConnectionPoolSize: undefined` **fails** with the synth-guard error message. Confirms fail-closed behavior.
7. Dev deploy succeeds and `/health` returns `graph.healthy: true`.
8. Aura console shows `≤ maxConnectionPoolSize × desiredCount` active Bolt connections in steady state.
9. **Error-path disclosure audit.** Trigger a pool-acquire timeout (Validation §10) and an Aura auth failure (temporarily break the SSM JSON); verify:
    - HTTP 5xx body is generic (`{"error":"service_unavailable"}`); no Bolt URI, no Aura instance ID, no driver stack frames.
    - CloudWatch log line at ERROR/WARN contains the Neo4j error *code* but no URI/username/password (scan the full log line with `grep -iE 'bolt\\+s|neo4j.io|NEO4J_PASSWORD' <log>`).
10. **Load test** at `maxConnectionPoolSize + 1` concurrent long-running graph requests per task. Confirm:
    - The excess request receives 503 within 5 s (fails fast, not 504).
    - Response times for the 503 responses are distributed across a ≥100 ms window (jitter active; no sharp timing signal).
    - WAF rate-based rule kicks in if you exceed its threshold (returns 429 from WAF).
11. **NAT idle test.** Park a task idle for 30+ min, then issue a graph query. Confirms `maxConnectionLifetime` + `connectionLivenessCheckTimeout` prevent stale-connection errors.
12. Alarm verification: force each condition and confirm SNS delivery:
    - Temporarily break the SSM JSON → `{appName}/Graph/AuthFailures` fires.
    - Drive concurrent load per item 10 → `{appName}/Graph/PoolAcquireTimeouts` fires.

---

## Rollback

Default: `git revert` the merge commit + redeploy. No data migration or irreversible state. Do this first.

Pinned-revision rollback (emergency only, addresses security-review MEDIUM-5).
Deployment-side; commands below are illustrative — substitute the consuming
deployment's profile, cluster, service, and SSM param names:

```bash
# Prerequisite: confirm the target revision's expected SSM param still exists.
# A pinned task-def from before the AuraDB wiring would fail at Bolt connect.
aws ssm get-parameter \
  --name /{appName}/{stage}/neo4j/auradb/credentials \
  --with-decryption --region <region> > /dev/null

# Force ECS to run the previous task definition revision
aws ecs update-service \
  --cluster {appName}-{stage} \
  --service api \
  --task-definition {appName}-{stage}-api:<PREV_REVISION> \
  --force-new-deployment \
  --region <region>
```

**Rollback window: 30 days maximum.** A revision older than 30 days may:
- Predate the `GRAPH_DB_CREDENTIALS_SSM_PARAM` env var → task fails at Bolt connect.
- Reference an IAM task role that has since been narrowed (e.g., the `kms:Decrypt` grant) — pinning re-grants older, broader permissions.
- Reference a different SSM parameter name or shape.

For anything older, fall back to `git revert` + redeploy.

---

## Follow-up work (separate plans)

1. **Per-query graph-latency instrumentation + D3 alarm.** Wrap each `session.run()` call in `Neo4jGraphService` with a timing + structured-log emitter (e.g. `{ graph_query: "getCircleMembers", durationMs: 142 }`). Once that log line exists, wire a `{appName}/Graph/QueryLatencyP99` metric filter + alarm per the original D3 spec. Estimated ~50 lines of code.
2. **Full pool metrics → CloudWatch.** Beyond the in-scope D1–D2 alarms: wire the driver's active / idle / p99-acquire metrics into a periodic emitter (every 30 s) and the `{appName}/Graph/Pool.*` metric namespace. Create a full Grafana dashboard.
3. **Circuit breaker.** Implement the CLOSED/OPEN/HALF-OPEN state machine from [`circle-queries.md`](../../apps/api/src/lib/graph/circle-queries.md#graph-db-unavailability-fallback-strategy) around `GraphService` calls.
4. **Per-session concurrency token bucket (E4).** Per-session graph-request cap to prevent a single session from monopolizing the pool. Belongs with a general request-metering middleware refactor.
5. **Per-handler dedicated drivers.** Reconciliation and export paths open their own driver with `queryTimeoutMs: 60_000` so they don't starve request-path pools.
6. **RDS Proxy.** Only if/when Lambda concurrency grows past ~50.

---

## References

### Strategy and code
- Strategy: the consuming deployment's database-connection-management architecture doc (external; not in trellis core)
- Current graph factory: [`apps/api/src/lib/graph/graph-factory.ts`](../../apps/api/src/lib/graph/graph-factory.ts)
- Current service impl: [`apps/api/src/lib/graph/neo4j-graph-service.ts`](../../apps/api/src/lib/graph/neo4j-graph-service.ts)
- Current pool config type: [`apps/api/src/lib/graph/types.ts`](../../apps/api/src/lib/graph/types.ts) (`GraphPoolConfig`)

### Neo4j driver & Aura (as of 2026-04-12)
- [Neo4j JS driver defaults (v5 source)](https://github.com/neo4j/neo4j-javascript-driver/blob/5.0/packages/core/src/internal/constants.ts): `maxConnectionPoolSize=100`, `connectionAcquisitionTimeout=60_000`.
- [Neo4j JS driver Config interface](https://github.com/neo4j/neo4j-javascript-driver/blob/5.0/packages/core/src/types.ts): confirms `connectionLivenessCheckTimeout` is supported and disabled by default.
- [Neo4j KB — Limiting Bolt Threads vs Connections](https://neo4j.com/developer/kb/limiting-bolt-threads-vs-connections/): pool sizing depends on client concurrency, not server threads. Example settings: pool 50, lifetime 30 min, acquire 2 min.
- [Neo4j AuraDB FAQ](https://neo4j.com/cloud/platform/aura-graph-database/faq/): tier sizing. **Does not document per-tier connection caps.**
