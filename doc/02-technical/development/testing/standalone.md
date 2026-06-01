# Standalone Testing & the Generic Dummy Target

Trellis is a **generic core**, published to npm and consumed by a vertical
application that calls `registerExtension()` + `startServer()` and owns the
live AWS environment. End-to-end verification of infrastructure-coupled code
has historically happened in the consuming vertical's account (see the
"Deployment Status" note in `CLAUDE.md`).

That dependency is a verification hazard: it means the most realistic tests
can only run somewhere else, on someone else's deploy cadence, against
infrastructure this repo doesn't control. This document defines how to test
**as much of Trellis as possible without any consuming vertical and without
live AWS**, and the plan for a **generic dummy target** that exercises the
full request path independently.

Two goals:

1. **Maximise independent coverage** — every layer that *can* run against
   local infrastructure (or no infrastructure) *should*, in this repo's CI.
2. **Replace the real consumer with a dummy** — a minimal reference vertical
   fixture that registers via the public extension API and boots the server,
   so the extension contract and the full HTTP path are verified here, not
   downstream.

---

## Status — implemented (Stages 0–2)

The lane exists and is green. `docker compose up -d` then
`npm run test:standalone -w @de-otio/trellis` boots the real server in-process
with the dummy extensions and drives the full HTTP path — no AWS, no consuming
vertical. It is wired into CI as the `standalone` job, and `smoke-pack.sh`
asserts the fixtures never ship.

- **Fixture:** `apps/api/test/fixtures/example-extension/` — `exampleExtension`
  (id `example`, terminology `widget`/`widgets`, exercising every optional
  `TrellisExtension` surface) + `minimalExtension` (required fields only).
- **Harness:** `apps/api/test/standalone/` — `global-setup.ts` (creates the
  DynamoDB-local table, seeds feature toggles, boots, health-gates, tears down
  cleanly) + `vitest.standalone.config.ts`. Auth reuses `test-auth.ts`
  (cookie-minted sessions via the real `SessionManager`).
- **Suites:** health/gating, extension routes (`ping`/`whoami`/`echo` — auth
  + CSRF), and entity metadata-schema validation.

**Local-infra note:** DynamoDB-local must run **in-memory** (`-inMemory`); the
file-backed (`-dbPath`) mode can deadlock and hang every DynamoDB op while the
HTTP port still answers. `docker-compose.yml` uses in-memory.

### Bugs this lane surfaced (all in Trellis, not the foundation packages)

1. **Hardcoded SSL pool option** (`database-connection-manager.ts`) made the
   pg driver request TLS against any local Postgres → "server does not support
   SSL connections". Fixed: SSL is skipped for local hosts, kept for RDS.
2. **Neo4j driver leaked per request** — `createGraphServiceFromEnv` built (and
   never closed) a new driver on every call across ~10 handlers + the extension
   wrapper, leaking Bolt sockets + timers. Fixed: memoized into a shared,
   closeable singleton (`closeSharedGraphService`), closed on shutdown.
3. **`EntityHandler.createEntityProfile` doesn't set `tenantId`** — the v0.7
   tenancy migration made `Entity.tenant` a required relation (the POST-post
   path stamps it; the entity path was not updated), so entity create 500s.
   The happy-path create test is `skip`ped with a pointer to identity-federation
   Stage 3 ("all handlers updated to include tenantId"); the metadataSchema
   *validation* contract is still proven (it runs before the DB write).
4. **`getTerminology()` returned the shared default by reference** (`terminology.ts`)
   — the no-extension fallback path returned the module-level
   `DEFAULT_TERMINOLOGY` constant directly (no spread), so any caller mutating
   the result corrupted the global default for every later call (the
   extension-override path already spread, so only the fallback leaked). Found
   by the Stage 5 unit-coverage pass. Fixed: the fallback now spreads; a
   regression test asserts successive fallback calls return distinct objects
   and that mutation does not bleed across calls.

### Latent hardening notes (not live bugs)

These are gaps the unit pass surfaced that are **not** currently exploitable but
worth a team decision before the surface grows:

1. **CSV formula-injection in `audit/csv-export.ts`.** `escapeCsvField`
   implements RFC 4180 *quoting* only; it does not neutralise spreadsheet
   formula prefixes (`=`, `+`, `-`, `@`), so a cell like `=1+1` is emitted
   verbatim and a spreadsheet client would execute it. **The one live call site
   ([`routes/tenant-audit.ts`](../../../../apps/api/src/lib/routes/tenant-audit.ts))
   is not exploitable today**: the `payload` cell is always
   `JSON.stringify(metadata)` (begins with `{`), and the other columns are
   server-generated ULIDs, action enums, ISO timestamps, and shape-validated
   IPs — none can begin with a formula trigger. The risk is latent: a future
   call site that feeds `escapeCsvField` raw user-controlled strings (e.g. a
   `displayName` export) would be vulnerable. Recommended fix *if/when* that
   happens — neutralise at the export boundary (prefix a `'`/tab) rather than
   changing the documented RFC-4180 contract of `escapeCsvField`. A unit test
   pins the current (unsanitised) behaviour so any future change is deliberate.
2. **Domain mutations emit no audit events** (`tenant/domain-handler.ts`).
   `RoleMappingHandler` and `MemberHandler` both call `emitTenantAudit` on every
   mutation; `DomainHandler` (claim / verify / remove) calls it **zero** times,
   even though a verified domain gates federated SSO sign-in (JIT provisioning),
   making these among the more security-sensitive tenant operations. This is a
   **deliberate-looking deferral, not a one-line wiring fix**: the audit taxonomy
   ([`audit-actions.ts`](../../../../apps/api/src/lib/audit-actions.ts)) defines
   `TENANT_DOMAIN_ADDED` and `TENANT_DOMAIN_VERIFIED` but **no
   `TENANT_DOMAIN_REMOVED`**, and `emitTenantAudit`'s `action`/`targetType`
   unions ([`tenant/audit-emit.ts`](../../../../apps/api/src/lib/tenant/audit-emit.ts))
   carry no domain cases. Wiring it properly means: extend both unions + the
   `actionFor` map, **define a new `tenant.domain.removed` audit action** (a
   taxonomy decision touching compliance art-30 records / dashboards — left to
   the team), then emit on claim→added, verify→verified, delete→removed. Tracked
   here rather than guessed at in code.
3. **Capability naming inconsistency** (`auth/capabilities.ts`). All capability
   values follow `<resource>.<verb>` (dotted) except
   `ManageAgentSessions: "manage:agent_sessions"`, which uses a colon. Cosmetic
   — it works and is unique — but it breaks the catalog's own naming convention
   and any dashboard/grouping that splits on `.`. A future catalog revision
   could align it (e.g. `agent_session.manage`); the capabilities test allows
   the outlier explicitly rather than failing on it.
4. **Reconciliation `maxRecordsPerModel` cap is page-granular**
   (`graph/reconciliation-service.ts`). The circuit breaker (10 consecutive
   failures) and the cap both work and the loop always terminates, but the cap
   gates only the *next-page* fetch — an in-flight batch is processed in full,
   so a run can process up to `maxRecordsPerModel + batchSize − 1` records
   instead of exactly the cap. Not a runaway risk; just looser than "Maximum
   records per model" implies. A record-granular clamp (slice the final batch)
   would make it exact. Locked at current behaviour by a test with a comment.

> **Co-developing the foundation packages.** When `@de-otio/saas-foundation` is
> npm-linked (`scripts/link-foundation.sh`), it carries its own nested
> `@aws-sdk` copy, so passing a client across the boundary trips TS's nominal
> type check under `tsc`. `apps/api/tsconfig.json` sets
> `preserveSymlinks: true` so the linked package resolves the consumer's single
> `@aws-sdk` copy — a no-op for a normal registry install. The standalone lane
> (vitest/esbuild) is unaffected either way.

---

## Independence Layers

What each test layer needs, and whether it runs standalone today.

| Layer | Needs | Standalone today? | Target |
|-------|-------|-------------------|--------|
| `tsc --noEmit` / `npm run lint` | nothing | ✅ yes | — |
| Unit (`vitest.config.ts`) | nothing (all deps mocked) | ✅ yes | in-process |
| Integration (`vitest.integration.config.ts`) | Postgres + DynamoDB-local (+ LocalStack: S3/SQS/SES) | ✅ yes | docker-compose |
| Schema (`vitest.schema.config.ts`) | Postgres | ✅ yes | docker-compose |
| Graph (`vitest.graph.config.ts`) | Neo4j (`bolt://localhost:7687`, `test` DB) | ✅ yes | local Neo4j |
| Consumer-install smoke (`scripts/smoke-pack.sh`) | nothing (packs + installs the tarball) | ✅ yes | fresh temp project |
| E2E (`vitest.e2e.*.config.ts`) | **deployed** Cognito + SSM + S3 maildummy | ❌ no — needs the consumer's AWS | **gap → dummy target** |
| Post-deployment (`vitest.postdeployment.*.config.ts`) | **deployed** RDS + DynamoDB + ECS | ❌ no — needs the consumer's AWS | **gap → dummy target** |

The first six layers are the bulk of the suite and already run independently
in CI ([`ci.yml`](../../../../.github/workflows/ci.yml): Postgres +
DynamoDB-local services, migrate, lint, `npm test`, then `smoke-pack.sh`).
The bottom two are the gap this document closes.

> **Doc drift to be aware of.** [`ci-cd.md`](ci-cd.md) and parts of
> [`testing.md`](../testing.md) describe a deploy pipeline (`deploy.yml`,
> `@de-otio/trellis-infra`, ECR/ECS, maildummy) and workspaces
> (`packages/crypto`, `apps/flutter`, `infra/`) that live in the **consuming
> vertical**, not in this repo. Trellis's own CI is a single
> `lint-and-test` job plus the consumer-install smoke. Treat the deploy-
> pipeline docs as describing the *downstream* environment; the goal here is
> to need it as little as possible.

---

## Local Infrastructure Map

Everything the independent layers need is already declared in
[`docker-compose.yml`](../../../../docker-compose.yml):

| Service | Image | Port | Used by |
|---------|-------|------|---------|
| Postgres 16 | `postgres:16-alpine` | 5432 | integration, schema, dummy-target |
| DynamoDB Local | `amazon/dynamodb-local` | 8000 | integration, KV/cache, dummy-target |
| LocalStack | `localstack/localstack` (`s3,sqs,ses`) | 4566 | media, queues, email, dummy-target |

Neo4j is **not** in docker-compose (graph tests expect a locally-run
instance). The dummy-target work below should add a Neo4j service to
docker-compose so the full stack comes up with one command.

What is **not** available locally, and how the dummy target substitutes it:

| Real (consumer) dependency | Local substitute |
|----------------------------|------------------|
| Cognito user pool + magic-link auth | Mint an encrypted session cookie directly via `SessionManager` with a known `SESSION_SECRET` (no Cognito round-trip). JWT-verify paths (`src/lib/auth/cognito-jwt.ts`) are exercised by unit tests with mocked verifiers. |
| SSM Parameter Store secrets | Plain `process.env` (the dummy boot reads config from env, same as `buildEnv()`). |
| S3 (media) | LocalStack S3 bucket created in setup. |
| SQS (queues) | LocalStack SQS queues, or in-process fake consumers. |
| SES (email) | LocalStack SES, or a capture stub (the deployed suite uses "maildummy"; locally we don't need email at all because auth is cookie-minted). |

---

## The Generic Dummy Target

### What it is

A **minimal reference vertical** — call it the *example extension* — that
implements the `TrellisExtension` contract
([`packages/extension-api/src/extension.ts`](../../../../packages/extension-api/src/extension.ts))
with neutral, domain-free terminology (e.g. `entity: "widget"`,
`entityPlural: "widgets"`). It is **not** any real product. It lives in this
repo, under test fixtures, and exists only to drive Trellis through its
public surface.

It registers via the published entry point exactly as a real consumer would:

```ts
import { registerExtension, startServer } from "@de-otio/trellis";
import { exampleExtension } from "./example-extension";

registerExtension(exampleExtension);
const server = await startServer();
```

### Why this is the right shape

- It is the **only** way to verify the extension contract end-to-end in this
  repo. Today [`test/unit/extensions.test.ts`](../../../../apps/api/test/unit/extensions.test.ts)
  only tests the registry's `push`/`find` logic with inline stubs — nothing
  boots a registered extension through a real request.
- It exercises the wiring the consumer depends on but Trellis can't currently
  see fail: route mounting under `/api/ext/{id}/…`, the core-wrapped handler
  path ([`extension-route-wrapper.ts`](../../../../apps/api/src/lib/extension-route-wrapper.ts)),
  scoped `ExtensionContext` / `ExtensionDb`, terminology substitution,
  `metadataSchema` validation on entity create/update, `configSchema`
  validation at boot, lifecycle `init`/`shutdown`, hooks, taxonomy seeding,
  and `activityPub.enrichActor`.
- It de-risks every extension-API change *before* publish, instead of finding
  breakage when the downstream vertical bumps the dependency.

### What the example extension must cover

One fixture, deliberately exercising every optional surface so a breaking
change to any of them fails a test here:

| `TrellisExtension` field | Dummy provides | Verifies |
|--------------------------|----------------|----------|
| `id`, `terminology` | `"example"`, `{widget, widgets}` | registration, reserved-word rejection, terminology rendering |
| `metadataSchema` | small Zod object (`{ color, size }`) | metadata validation on entity create/update |
| `routes` / `extensionRoutes` | one of each | raw route mount + core-wrapped handler path, auth modes |
| `configSchema` | one required key | boot-time scoped-env validation (and failure on missing key) |
| `hooks` | `onPostCreated`, `onEntityCreated` recording to a spy | hooks fire after the operation commits |
| `taxonomySeed` | tiny dimension/category/taxon set | seed application |
| `relationshipSignalProvider` | constant signal | signal blends into scoring |
| `entityRelationshipTypes` | `["LINKED_TO"]` | global registration |
| `discoveryFacets` | one `exact` facet | discovery filtering |
| `activityPub.enrichActor` | summary + one attachment | actor enrichment (only when AP flag on) |
| `computeLifeStage` | trivial derivation | persisted `Entity.lifeStage` |
| `init` / `shutdown` | spies | lifecycle ordering, graceful shutdown |

A second, **near-empty** extension (only the required fields) should also
exist, to prove the contract works when every optional field is omitted.

### Where it lives

```
apps/api/test/
  fixtures/
    example-extension/        # the dummy vertical (NOT shipped — under test/)
      index.ts                # exampleExtension + minimalExtension
      boot.ts                 # registerExtension + startServer against local infra
  standalone/                 # NEW — local full-path tests
    *.test.ts                 # drive the booted server over HTTP on localhost
```

Keep the fixture under `test/` so it never lands in the published tarball
(`apps/api/package.json` `files` is `dist`, `prisma`, `src/lambda` — fixtures
are already excluded). `smoke-pack.sh` should additionally assert the dummy
extension is **absent** from the packed tarball.

### Local E2E config (`vitest.standalone.config.ts`)

A new config that mirrors `vitest.e2e.config.ts` but:

- `globalSetup` boots the dummy target: `docker-compose up`, migrate, seed,
  `registerExtension(exampleExtension)`, `startServer()` on `localhost:3000`.
- Auth setup mints session cookies via `SessionManager` + a fixed
  `SESSION_SECRET` instead of the Cognito/maildummy `E2eTestUser` flow.
- Tests target `http://localhost:3000` (no SSM `alb-dns-name` lookup).
- `globalTeardown` stops the server and tears down compose volumes.

This gives a **standalone e2e** lane: the real HTTP server, real Postgres /
DynamoDB / S3 (LocalStack), real routing and middleware, a real registered
extension — with zero AWS account and zero consuming vertical.

---

## Implementation Plan

> The sequenced, stage-by-stage work breakdown lives in
> **[implementation-plan.md](implementation-plan.md)** (Stages 0–6, with an
> estimate and a definition of done). The summary below is the priority
> register; the implementation plan is what to actually execute.

Prioritised in the same P0/P1/P2 register style as
[`strategy.md`](strategy.md#known-coverage-gaps). These are *new* gaps about
**independence**, distinct from the coverage gaps already tracked there.

### P0 — Establish independence

| Step | Outcome |
|------|---------|
| Add the `example-extension` fixture (full + minimal) under `test/fixtures/` | Extension contract has a concrete consumer in-repo |
| Add `test/standalone/` + `vitest.standalone.config.ts` booting `startServer()` against docker-compose | Full request path runs with no AWS account |
| Cookie-minting auth helper (`SessionManager` + fixed secret) | Authenticated standalone tests without Cognito |
| Add Neo4j to `docker-compose.yml` | One-command full local stack |
| Add a `standalone` job to `ci.yml` (compose services + the new config) | Independence is enforced, not aspirational |

### P1 — Broaden the standalone lane

| Step | Outcome |
|------|---------|
| Port the read-only / CRUD / social E2E shards to run against the dummy target | The bulk of E2E coverage runs independently; deployed E2E becomes a thin confirmation layer |
| LocalStack-backed media + queue paths in standalone | Media processing and async workers verified without AWS |
| Assert dummy extension is excluded from the packed tarball in `smoke-pack.sh` | Fixtures never leak into the published package |
| Extension-API contract tests: minimal extension, reserved-id rejection, bad `configSchema` halts boot, `metadataSchema` rejection returns 4xx | Breaking extension-API changes fail here, before publish |

### P2 — Reduce what only the consumer can verify

| Step | Outcome |
|------|---------|
| Document the residual set that genuinely requires deployed AWS (Cognito triggers against a real pool, ECS connection-pool behaviour, CloudFront→ALB path) | Clear, small, honest list of what standalone *cannot* cover |
| Contract/snapshot the published API surface (`src/index.ts` exports) so downstream breakage is caught at publish time | Consumer integration risk shifts left |

---

## The consumer-only residual (Stage 6)

Independence has a boundary. This is the **definitive, minimal set** of things
that genuinely cannot be verified in this repo and remain the consuming
vertical's responsibility — each confirmed to require real deployed AWS, not
just unbuilt local plumbing:

| Residual | Why it can't move to standalone | Where it's covered |
|----------|----------------------------------|--------------------|
| **Real Cognito triggers** in a live user pool (post-confirmation, pre-token-gen, custom-auth) | The pool + trigger wiring is AWS-managed; locally the Lambda handlers are unit-tested with mocked events, and the standalone lane mints sessions by cookie instead of Cognito | consumer deploy pipeline; `test/unit/lambda/` here |
| **ECS Fargate DB connection-pool exhaustion** under real concurrency | A single Fargate task with a small pool is the thing under test; one local server can't reproduce it | [post-deploy-speed.md](post-deploy-speed.md), consumer pipeline |
| **CloudFront → ALB → ECS → RDS** edge path + headers as seen from the edge | The CDN/ALB layer is consumer-owned infra (no `infra/` here) | consumer pipeline |
| **Data residency / regional routing** against real regional infrastructure | Requires multi-region RDS/Dynamo the local stack doesn't model | consumer pipeline |
| **Tenancy provisioning end-to-end** (personal-tenant creation → `custom:activeTenantId` claim → tenant-scoped writes) | `activeTenantId` is sourced from Cognito JWT claims set by the post-confirmation trigger; a local cookie session can't supply it | identity-federation plan, Stage 3; then the skipped entity-create test here unskips |

Everything **not** on this list should be verifiable here, with
`docker compose up -d` and `npm run test:standalone`. If a new feature would
add a row, prefer redesigning so it doesn't — keep the residual shrinking, not
growing. The deployed pipeline that owns this set is described in
[ci-cd.md](ci-cd.md).
