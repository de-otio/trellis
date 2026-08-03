---
title: Extension API
description: The TrellisExtension contract — how a vertical registers an extension and the surface it can implement.
sidebar: Extension API
order: 40
---

# Extension API

Trellis is a generic multi-tenant social-network platform core. A **vertical**
application builds on it by registering a `TrellisExtension` at startup to add
domain-specific routes, metadata schemas, terminology, lifecycle hooks, and
discovery behaviour. The extension contract is published as the
`@de-otio/trellis-extension-api` package, which ships only types and a version
constant — no runtime behaviour.

This page is the canonical reference for that contract. Types are described as
they appear in the package source; an extension should not rely on surface that
is not part of the published interface.

## Install

```bash
npm install @de-otio/trellis-extension-api
```

```ts
import type {
  TrellisExtension,
  ExtensionContext,
  ExtensionHandler,
} from "@de-otio/trellis-extension-api";
import { EXTENSION_API_VERSION } from "@de-otio/trellis-extension-api";
```

The package re-exports the `TrellisExtension` contract, the `ExtensionContext`
and its scoped `ExtensionDb` / `ExtensionGraphService`, the job types
(`ExtensionJobDecl`, `ExtensionJobContext`, `ExtensionJobSchedule`), the
opaque `TenantId` brand, the route and hook types, the strategy interfaces,
taxonomy-seed types, and the `EXTENSION_API_VERSION` constant. An extension
may read `EXTENSION_API_VERSION` at startup to verify it is running against
the expected contract version.

> **Current version: `0.6.0`.** The `0.5.0 → 0.6.0` bump added the scoped
> `ExtensionDb.tenant(tid)` surface (replacing the earlier raw-delegate
> shape) and the `jobs` / `ExtensionJobDecl` / `ExtensionJobContext` surface
> described below — both additive, so it is a minor bump.

## Registering an extension

Extensions are registered by the application entry point **before the server
starts** — the core never statically imports an extension, which keeps it free
of extension-specific dependencies. The host exposes `registerExtension(ext)`;
call it once per extension at boot.

```ts
import { registerExtension, startServer } from "@de-otio/trellis";
import { myExtension } from "./my-extension";

registerExtension(myExtension);

await startServer();
```

Registering an extension whose `id` is already registered is rejected, so
register each extension exactly once.

## The `TrellisExtension` contract

A `TrellisExtension` has four required fields; everything else is optional and
omitted when the vertical has no interest in that surface.

| Field | Required | Purpose |
| --- | --- | --- |
| `id` | yes | Unique extension identifier. Lowercase alphanumeric, 2–32 characters, and not a reserved word. Used as the entity type and as the route mount prefix. |
| `terminology` | yes | Display naming: `{ entity, entityPlural }` (for example `{ entity: "dog", entityPlural: "dogs" }`). |
| `routes` | yes | An array of raw `Route` definitions. May be empty when only `extensionRoutes` are used. Routes cannot use reserved prefixes. |
| `metadataSchema` | yes | A Zod schema validating `Entity.metadata` when an entity's type matches this extension's `id`. |
| `taxonomySeed` | no | Taxonomy dimensions, categories, and taxons to seed for this extension. |
| `hooks` | no | Lifecycle hooks the core calls after operations complete (see below). |
| `relationshipSignalProvider` | no | Domain-specific relationship-scoring signals. |
| `entityRelationshipTypes` | no | Entity-to-entity relationship type names declared globally for this entity type, e.g. `["PACK_MATE", "WALK_BUDDY"]`. |
| `discoveryFacets` | no | Metadata fields that are filterable in discovery. |
| `recommendationStrategy` | no | Domain-specific recommendation generation. |
| `jobs` | no | Scheduled work the extension declares, run in-process in the API container (see [Scheduled jobs](#scheduled-jobs)). |
| `extensionRoutes` | no | Core-wrapped route definitions — **preferred over raw `routes`**. |
| `configSchema` | no | A Zod schema declaring the env-var keys this extension requires. Validated against the extension's scoped config values only. |
| `activityPub` | no | Display-only ActivityPub Actor enrichment (`enrichActor`). |
| `computeLifeStage` | no | Compute a life-stage (or equivalent) value from entity metadata; the result is persisted as `Entity.lifeStage`. |
| `init` | no | Called once at startup with the extension's scoped context. |
| `shutdown` | no | Called on server shutdown (SIGTERM/SIGINT). |

### `id`

Must be lowercase alphanumeric, 2–32 characters, and not a reserved word. The
`id` doubles as the entity type (used to match `metadataSchema`) and as the
route mount prefix for `extensionRoutes` (`/api/ext/{id}/{path}`).

### `terminology`

```ts
terminology: {
  entity: string;        // "dog"
  entityPlural: string;  // "dogs"
}
```

Drives how the vertical's entity is named in the surrounding product.

### `metadataSchema`

A Zod schema. When an entity's type equals this extension's `id`, the core
validates `Entity.metadata` against this schema on create and update. Use a
strict object schema so unexpected fields are rejected.

```ts
import { z } from "zod";

const metadataSchema = z
  .object({
    color: z.string().min(1),
    size: z.enum(["s", "m", "l"]),
  })
  .strict();
```

### `configSchema`

A Zod schema declaring the env-var keys the extension needs. The core validates
it against the extension's **scoped** config values only — the extension never
sees core secrets such as `SESSION_SECRET`, `DATABASE_URL`, or API keys. The
validated values are exposed on `ExtensionContext.config`.

### `shutdown`

```ts
shutdown?: () => Promise<void>;
```

Called once on graceful server shutdown (SIGTERM/SIGINT). Use it to flush or
close resources the extension owns.

## Routes

An extension exposes HTTP routes in one of two ways.

### Core-wrapped routes (preferred)

`extensionRoutes` are the recommended form. The core wraps each one with auth,
CORS, security headers, and error handling; the handler returns a plain data
object and the core does the HTTP wiring.

```ts
interface ExtensionRouteDefinition {
  /** Path pattern — served at /api/ext/{extensionId}/{path} */
  path: string;
  method: string | string[];
  /** Auth requirement (default: "required") */
  auth?: "required" | "optional" | "none";
  description?: string;
  handle: ExtensionHandler;
}
```

The handler receives the parsed request, route params, the session (or `null`
when unauthenticated), and the scoped `ExtensionContext`, and returns an
`ExtensionResponse`:

> **`session.userId` is the Trellis `User.id` (a cuid), not the Cognito `sub`.**
> For JWT-Bearer requests it is derived from the `custom:userId` claim (written
> by the pre-token-generation trigger), falling back to `sub` only for legacy
> tokens minted without that claim. Use it directly in `where: { id: userId }`
> lookups — do not expect a Cognito UUID. See
> [Cognito federation](./cognito-federation.md).

```ts
type ExtensionHandler = (
  request: Request,
  params: Record<string, string>,
  session: { userId: string; email: string; role: string } | null,
  ctx: ExtensionContext,
) => Promise<ExtensionResponse>;

interface ExtensionResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}
```

```ts
const pingHandler: ExtensionHandler = async () => ({
  status: 200,
  body: { pong: true },
});
```

### Raw routes

`routes` is an array of `Route` definitions for cases that need direct control
over the HTTP `Response`. A `Route` matches by `path` (exact string, `*`
prefix, `:param` segment, or `RegExp`), an optional `method` (or `*`), an
optional ordered `middleware` array, and a `handler` that returns a full
`Response`. Raw routes cannot use reserved prefixes. Prefer `extensionRoutes`
unless raw control is required.

## The extension context

Every hook, handler, and lifecycle callback receives an `ExtensionContext` — a
deliberately restricted runtime environment. Core secrets are never exposed.

```ts
interface ExtensionContext {
  db: ExtensionDb;                       // scoped Prisma access
  graphService?: ExtensionGraphService;  // read-only graph access
  appDomain: string;                     // e.g. "example.com"
  appUrl: string;                        // e.g. "https://api.example.com"
  stage: string;                         // "dev", "prod"
  config: Record<string, string>;        // this extension's validated config
}
```

### `db` — scoped database access

`ExtensionDb` has exactly one member — there is no raw delegate bag:

```ts
interface ExtensionDb {
  tenant(tenantId: TenantId): ScopedDb;
}
```

`tenant(tenantId)` returns a `ScopedDb` whose every operation is bound to that
tenant **by construction**. `TenantId` is an opaque branded string with no
exported constructor in this package — an extension receives one (from the
session-bound `ExtensionContext.db` or from `ExtensionJobContext.tenant`, see
below) and cannot forge one from a user-supplied string.

`ScopedDb` exposes the tenant-carrying core delegates (`entity`, `post`,
`postMedia`, the taxonomy tables — `taxonomyTaxon`, `taxonomyCategory`,
`taxonomyDimension` — and `productTaxonomyTag`) by name, plus the extension's
own composed (`ext_*`) models via an index signature. Security-sensitive
tables (`user`, `securityEvent`, `featureToggle`, `mfaEnrollment`,
`encryptionKey`, `session`, admin tables) and two delegates that cannot carry
a per-tenant column (`activity`, which is global/federation data, and
`postEntity`, which has no corresponding model) are **not** reachable — any
access to them throws.

Every delegate on `ScopedDb` is a `ScopedDelegate`: `findMany`, `findFirst`,
`findUnique`, `create`, `createMany`, `update`, `updateMany`, `upsert`,
`delete`, `deleteMany`, `count`, `aggregate`, `groupBy`. Two things distinguish
it from a raw Prisma delegate:

- **Injection, not convention.** Every op has the bound tenant column merged
  into its `where`/`data` before it reaches the database — `findMany({})`
  returns only that tenant's rows. This holds **enforce-always**, independent
  of core's own `TENANT_SCOPE_MODE` rollout flag: an extension-owned table
  always holds tenant data.
- **By-id ops are rewritten, not passed through.** A raw Prisma `findUnique`,
  `update`, or `delete` selects by a unique id that cannot be AND-merged with
  a non-unique tenant column. The scoped surface rewrites them instead:
  `findUnique` becomes `findFirst` with the tenant merged in (a cross-tenant
  id returns `null`); `update`/`delete` become `updateMany`/`deleteMany` with
  the tenant merged in, followed by an assert that exactly one row was
  affected (a cross-tenant id is a 0-count failure, never a silent
  cross-tenant write). `upsert` by id is emulated the same way
  (read-before-write).

A few further guarantees, useful when debugging a rejected call:

- Writes may **not** set the tenant column directly — the tenant is bound
  solely through `tenant(tenantId)`.
- A write with FK fields the model declared against a core model (its
  `entityField`, or another allow-listed FK) is validated read-before-write:
  the referenced row must belong to the same tenant, or the op throws.
- Nested relation writes (`connect`, `create`, `connectOrCreate`, `update`,
  `upsert`, `delete`, `disconnect`, and their `*Many` forms nested inside
  `data`) are rejected — extension models are shallow in this release.
- `include`, and a `select` of a relation field, are rejected — a relation
  join is not tenant-filtered and could leak another tenant's rows. Query the
  related model separately through the scoped surface instead.
- `queryRaw`/`executeRaw` are not part of `ScopedDelegate` at all — there is
  no raw-SQL escape hatch from extension code.

All violations throw a `ScopedDbError` (or the corresponding not-found
condition for a by-id op) rather than silently narrowing or widening scope.

### `graphService` — read-only graph access

When present, `ExtensionGraphService` lets an extension query relationships,
circles, entity relationships, and discovery. It is **read-only**: graph
mutations (sync, remove, score writes, relationship creation) are reserved for
the core and are not exposed.

## Lifecycle hooks

`ExtensionHooks` are optional callbacks the core invokes **after** the named
operation completes. Omit any hook the extension does not need.

| Hook | Called when |
| --- | --- |
| `onPostCreated(post, ctx)` | a post is created |
| `onEntityCreated(entity, ctx)` | an entity is created |
| `onRelationshipCreated(userId, targetId, targetType, ctx)` | a relationship is created between users/entities |
| `onScoreRecompute(userId, scores, ctx)` | relationship scores are recomputed |
| `onEntityDeleted(entityId, entityType, ctx)` | an entity is deleted |

The hook interface is a **versioned contract**: any change to a hook signature,
or removal of a hook, is breaking for consumers and requires a coordinated
release of `@de-otio/trellis-extension-api`. Adding a new optional hook is a
minor change.

## Scheduled jobs

An extension declares recurring work via the optional `jobs` field instead of
being handed a cross-tenant database client:

```ts
type ExtensionJobSchedule = "hourly" | "daily";

interface ExtensionJobDecl {
  /** Stable job id, unique within the extension (e.g. "reminder-sweep"). */
  id: string;
  schedule: ExtensionJobSchedule;
  /** The extension's OWN models this job may scan cross-tenant. Never core models. */
  crossTenantRead: string[];
  run(jobCtx: ExtensionJobContext): Promise<void>;
}
```

```ts
interface ExtensionJobContext {
  /** Cross-tenant read access, keyed by model name — exactly the models
   *  declared in `crossTenantRead`, nothing else. */
  read: Record<string, CrossTenantReadDelegate>;
  /** Bind a tenant for correctly-scoped per-row work (core + own models). */
  tenant(tenantId: TenantId): ScopedDb;
  /** Deployment stage — for logging/metrics. */
  stage: string;
}
```

A job's manifest is its audit surface: the **only** cross-tenant reads it can
perform are the models named in `crossTenantRead`, each exposed as a
`CrossTenantReadDelegate` (`findMany`, `findFirst`, `count`, `aggregate`,
`groupBy` — read-only, no writes). Naming a model the runtime has no read
delegate for (a typo, or a core model) fails loudly when the context is built,
before the job body ever runs — it is never a silently `undefined` delegate.

To act on a row a job scans, call `tenant(tenantId)` with that row's tenant id
to get a fully tenant-scoped `ScopedDb` for the write — the same scoped
surface described above. There is no other way for a job to reach a core
model or perform a write.

Jobs run **in-process inside the API container** — never as a worker Lambda —
and are single-flighted across every running API task by a shared lock, so a
job manifest is all an extension author needs to reason about; the
in-process/no-Lambda distinction and the lock/timeout mechanics are documented
operationally in
[`doc/02-technical/operations/extension-job-runner.md`](../../doc/02-technical/operations/extension-job-runner.md).

## Strategy and enrichment interfaces

These optional fields let a vertical inject domain-specific behaviour:

- **`relationshipSignalProvider`** — a `RelationshipSignalProvider.computeSignal(...)`
  returns a `0.0`–`1.0` value that is blended into the base relationship score,
  or `null`/`undefined` to leave the score unaffected. It receives a
  `RelationshipSignalContext` (`currentScore`, `tier`, optional
  `entityMetadata`).
- **`discoveryFacets`** — an array of `DiscoveryFacet` (`field`, `type` of
  `"exact" | "range" | "geo"`, and `label`) declaring which metadata fields are
  filterable in discovery.
- **`recommendationStrategy`** — `getRecommendations(entityId, ctx)` returns
  domain-specific `Recommendation[]`.
- **`activityPub.enrichActor(entity)`** — returns display-only `ActorEnrichment`
  (`summary`, `icon`, `attachment`, custom `properties`). The core owns and
  blocks overriding identity-bearing Actor fields: `id`, `publicKey`, `inbox`,
  `outbox`, `endpoints`, `@context`, and `preferredUsername`.
- **`computeLifeStage(metadata, manualOverride, existingLifeStage)`** — computes
  a life-stage value persisted as `Entity.lifeStage`; return `null` when not
  applicable.

## Taxonomy seed data

`taxonomySeed` provides `TaxonomySeedData` — `dimensions`, `categories`, and
`taxons` — for the extension to seed at registration. Categories reference a
`dimensionCode`; taxons reference a `categoryCode`.

## Review criterion: tracker-free, anonymized client metadata

Trellis ships **no third-party trackers, analytics SDKs, or ad-network
integrations** in its server-side request handling. Extensions are part of the
trust boundary, so the same property is a **review criterion for every
extension**:

> An extension **must not** introduce third-party trackers, analytics SDKs, or
> ad-network integrations into server-side request handling. Client metadata
> (IP, User-Agent, device identifiers) may be stored only through a path that
> enforces anonymization or an explicit retention bound — never logged or
> persisted ad hoc alongside domain data.

A single tracking pixel or analytics beacon added by an extension reintroduces
exactly the third-party data flows the platform is designed to avoid, inside
the server-side path where users cannot block it. Extensions that need
telemetry must use the host's sanctioned, retention-bound audit/event paths.
**Extension review blocks on a violation.**

This is a guarantee about the **core API surface and server-side handling** — it
is not a promise about what a vertical chooses to embed in its own client
applications.

## Review criterion: synthetic-content provenance disclosure

Trellis records whether content is AI-generated on `Post.textSourceType`,
`PostMedia.declaredSourceType` and `MediaFile.embeddedSourceType`, and emits a
`provenance` object on every post and media response. Under **EU AI Act
Article 50** (applicable since 2 August 2026) that disclosure is a legal duty for
the party publishing the content, so extensions are a review criterion here too:

> An extension that generates or transforms user-visible content with an AI
> system **must** record provenance through the core provenance API, and **must
> not** write the provenance columns directly, suppress an existing value, or
> downgrade one. An extension that puts an AI system into service under the
> vertical's name makes that vertical a **provider** under Article 50(2), which
> carries a machine-readable marking duty for the system's output.

Two properties of the core design that an extension must not defeat:

- **Disclosure is monotonic.** A value may move toward more disclosure, never
  less. The author-facing edit path enforces this; downward correction is a
  staff-reviewed, audited action.
- **`UNKNOWN` is not "human".** It means no signal. Never present it as a
  positive claim of human authorship, and never derive one from the absence of a
  marking.

**This criterion is currently honour-system, not enforced in code.** `ScopedDb`
exposes `post` and `postMedia` with full write operations, so an extension *can*
write or lower a provenance column directly — monotonicity lives in the request
handlers, not at the data layer. Closing that gap (a field-level denylist on the
scoped surface, or routing provenance writes through a core call the scoped
surface does not expose) is open work. Until then: **extension review blocks on a
violation**, and reviewers should look for direct writes to these columns.
