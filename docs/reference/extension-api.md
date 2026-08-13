---
title: Extension API
description: The TrellisExtension contract — how a vertical registers an extension and the surface it can implement.
sidebar: Extension API
order: 40
---

# Extension API

Trellis is a generic multi-tenant social-network platform core. A **vertical**
application builds on it by registering a `TrellisExtension` at startup to add
domain-specific routes, metadata schemas, terminology, scheduled jobs, and
display enrichment. The extension contract is published as the
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
opaque `TenantId` brand, the route types, the structural DTOs, and the
`EXTENSION_API_VERSION` constant. An extension may read
`EXTENSION_API_VERSION` at startup to verify it is running against the
expected contract version.

Import from the **package root**. The package declares an `exports` map that
exposes the root only, so deep specifiers into `lib/` do not resolve.

> **Current version: `0.9.1`.** This line is checked against the
> `EXTENSION_API_VERSION` constant in CI, so it cannot drift.
>
> `0.9.0 → 0.9.1` is **additive**. Every contract type that carries the scoped
> database gained an optional `TModels` parameter, defaulted so that omitting
> it changes nothing. Declaring it replaces `unknown` args and results on your
> own models with your generated Prisma types — see
> [Typing your own models](#typing-your-own-models).
>
> `0.8.1 → 0.9.0` is **breaking**. It removed seven declared extension points
> that core never invoked — `hooks` (all five), `init`, `taxonomySeed`,
> `relationshipSignalProvider`, `entityRelationshipTypes`, `discoveryFacets`,
> `recommendationStrategy` — along with the types serving them. If your
> extension declares any of them, delete the declaration: it was never
> running. The same bump made `ExtensionJobContext.signal` public, moved the
> package to `NodeNext` resolution, and added the root-only `exports` map.
>
> Earlier: `0.7.0 → 0.8.0` added the optional
> `TrellisExtension.extensionApiVersion` field described below; `0.5.0 →
0.6.0` added the scoped `ExtensionDb.tenant(tid)` surface and the `jobs` /
> `ExtensionJobDecl` / `ExtensionJobContext` surface.

Rather than reading `EXTENSION_API_VERSION` yourself and comparing it by
hand, the sanctioned path is to **declare** the version you built against
and let core do the comparison at startup — see
[`extensionApiVersion`](#extensionapiversion) below.

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

| Field                 | Required | Purpose                                                                                                                                                            |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | yes      | Unique extension identifier. Lowercase alphanumeric, 2–32 characters, and not a reserved word. Used as the entity type and as the route mount prefix.              |
| `extensionApiVersion` | no       | The `@de-otio/trellis-extension-api` semver this extension was built against. Core checks it at startup — see [`extensionApiVersion`](#extensionapiversion) below. |
| `terminology`         | yes      | Display naming: `{ entity, entityPlural }` (for example `{ entity: "dog", entityPlural: "dogs" }`).                                                                |
| `routes`              | yes      | An array of raw `Route` definitions. May be empty when only `extensionRoutes` are used. Routes cannot use reserved prefixes.                                       |
| `metadataSchema`      | yes      | A Zod schema validating `Entity.metadata` when an entity's type matches this extension's `id`.                                                                     |
| `crossTenantRead`     | no       | Models this extension may read cross-tenant via `ctx.db.discover(reason)`. Validated at registration; an undeclarable model fails startup.                         |
| `jobs`                | no       | Scheduled work the extension declares, run in-process in the API container (see [Scheduled jobs](#scheduled-jobs)).                                                |
| `extensionRoutes`     | no       | Core-wrapped route definitions — **preferred over raw `routes`**.                                                                                                  |
| `configSchema`        | no       | A Zod schema declaring the env-var keys this extension requires. Validated against the extension's scoped config values only.                                      |
| `activityPub`         | no       | Display-only ActivityPub Actor enrichment (`enrichActor`).                                                                                                         |
| `computeLifeStage`    | no       | Compute a life-stage (or equivalent) value from entity metadata; the result is persisted as `Entity.lifeStage`.                                                    |
| `extendRecap`         | no       | Attach own-table aggregates to a year-in-review recap; merged under `payload.extension`.                                                                           |
| `shutdown`            | no       | Called on server shutdown (SIGTERM/SIGINT).                                                                                                                        |

**This table is the whole contract.** Every field listed is invoked by core.
If you are looking for a lifecycle hook, an entity-relationship-type
registration, a discovery facet, a scoring signal, a taxonomy seed, a
recommendation strategy or an `init` callback, they were removed in `0.9.0`:
they were declared but never called, so code written against them ran only in
its author's imagination. See the [`0.9.0` note](#the-package) above.

### `id`

Must be lowercase alphanumeric, 2–32 characters, and not a reserved word. The
`id` doubles as the entity type (used to match `metadataSchema`) and as the
route mount prefix for `extensionRoutes` (`/api/ext/{id}/{path}`).

### `extensionApiVersion`

```ts
import { EXTENSION_API_VERSION } from "@de-otio/trellis-extension-api";

export const dogExtension: TrellisExtension = {
  id: "dog",
  extensionApiVersion: EXTENSION_API_VERSION,
  // …
};
```

Declare the `@de-otio/trellis-extension-api` version this extension was
**built against** — normally just `EXTENSION_API_VERSION` re-exported from
this package, so a rebuild keeps the declaration truthful automatically.
Core checks it against its own `EXTENSION_API_VERSION` at startup, before
serving:

- **Absent** — one warning logged at boot, never fatal. Declaring it is
  strongly recommended (an undeclared extension gets no protection against
  a silently incompatible core), but omitting it never breaks an existing
  extension.
- **Declared and incompatible** — core **fails startup**, naming both
  versions. A differing major is always incompatible; while this package is
  still `0.x`, a differing minor is incompatible too (0.x minors carry
  breaking changes).
- **Declared and merely drifted** (same compatibility window, different
  patch) — logged only; rebuild at your convenience.
- **Declared but unparseable** — core fails startup with a validation error
  naming the offending value, never a deep throw.

Format: `<major>.<minor>.<patch>`, each part 1–4 digits, with an optional
`-`/`+` suffix ignored for comparison (e.g. `"0.8.0"` or `"0.8.0-alpha.1"`).
Values over 64 characters are rejected outright.

### `terminology`

```ts
terminology: {
  entity: string; // "dog"
  entityPlural: string; // "dogs"
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

Every handler and enrichment callback receives an `ExtensionContext` — a
deliberately restricted runtime environment. Core secrets are never exposed.
(Scheduled jobs receive the narrower `ExtensionJobContext` instead — see
[Scheduled jobs](#scheduled-jobs).)

```ts
interface ExtensionContext {
  db: ExtensionDb; // scoped Prisma access
  graphService?: ExtensionGraphService; // read-only graph access
  appDomain: string; // e.g. "example.com"
  appUrl: string; // e.g. "https://api.example.com"
  stage: string; // "dev", "prod"
  config: Record<string, string>; // this extension's validated config
}
```

### `db` — scoped database access

`ExtensionDb` has two members, and there is no raw delegate bag:

```ts
interface ExtensionDb {
  tenant(tenantId: TenantId): ScopedDb;
  discover(reason: string): DiscoverDb;
}
```

`tenant()` is the tenant-bound write-and-read surface. `discover()` is the
audited, read-only, cross-tenant surface described under
[`crossTenantRead`](#the-trellisextension-contract) — it is restricted to the
models the extension declared, applies a non-overridable visibility floor to
every query, and runs inside core's audit with the reason you pass.

`tenant(tenantId)` returns a `ScopedDb` whose every operation is bound to that
tenant **by construction**. `TenantId` is an opaque branded string with no
exported constructor in this package — an extension receives one (from the
session-bound `ExtensionContext.db` or from `ExtensionJobContext.tenant`, see
below) and cannot forge one from a user-supplied string.

`ScopedDb` exposes the tenant-carrying core delegates (`entity`, `post`,
`postMedia`, the taxonomy tables — `taxonomyTaxon`, `taxonomyCategory`,
`taxonomyDimension` — and `productTaxonomyTag`) by name, plus the extension's
own composed (`ext_*`) models via an index signature — or, better, via the
model map described in [Typing your own models](#typing-your-own-models).
Security-sensitive
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

### Typing your own models

By default `ScopedDb` reaches your own models through an index signature, so
their arguments and results are `unknown` and a misspelled model name compiles
and fails at runtime. Since `0.9.1` you can close both gaps by declaring a
model map, using `ScopedOf<T>` to narrow each generated Prisma delegate to the
scoped operation set:

```ts
import type { Prisma } from "@prisma/client";
import type { ScopedOf, TrellisExtension } from "@de-otio/trellis-extension-api";

type DogModels = {
  extDogProfile: ScopedOf<Prisma.ExtDogProfileDelegate>;
  extDogWalk: ScopedOf<Prisma.ExtDogWalkDelegate>;
};

export const dogExtension: TrellisExtension<DogModels> = {/* … */};
```

The parameter threads through `ExtensionContext`, `ExtensionDb`,
`ExtensionJobContext`, `ExtensionRouteDefinition` and `ExtensionJobDecl`, so
inside a route handler or a job body:

```ts
const rows = await ctx.db.tenant(tid).extDogProfile.findMany({
  where: { breed: "collie" }, // typed against your schema
});
rows[0].breed; // string, not unknown

ctx.db.tenant(tid).extDogProfiles; // compile error — no such model
```

`ScopedOf<T>` keeps exactly the thirteen scoped operations that `T` has and
drops everything else, `$queryRaw` included, so the raw-SQL escape hatch stays
structurally absent even when you hand it a full Prisma delegate. Operations
your Prisma version does not have are simply absent rather than an error.

Two notes on the design, both deliberate:

- **The default stays open.** Omitting `TModels` gives you the previous
  behaviour, index signature and all. This keeps `0.9.1` additive, but it also
  means an extension that does not declare a map keeps the misspelling
  hazard. Declaring one is cheap; do it.
- **`handle` and `extendRecap` are declared as methods**, not as function-typed
  properties. Under `strictFunctionTypes` a function-typed property compares
  parameters contravariantly, and a route taking `ExtensionContext<DogModels>`
  would then not be assignable to the `ExtensionContext` core's registry holds
  — which would make the feature unusable for any extension with routes.
  Method parameters compare bivariantly, which is what lets a typed extension
  register with untyped core. The property is asserted in
  `packages/extension-api/type-tests/generic-scoped-db.test-d.ts`.

### `graphService` — read-only graph access

When present, `ExtensionGraphService` lets an extension query relationships,
circles, entity relationships, and discovery. It is **read-only**: graph
mutations (sync, remove, score writes, relationship creation) are reserved for
the core and are not exposed.

## Lifecycle

`shutdown()` is the only lifecycle callback core invokes. There is **no
event-hook mechanism**: an extension cannot currently be notified that a post
was created, an entity was deleted, or scores were recomputed.

Versions before `0.9.0` declared five such hooks (`onPostCreated`,
`onEntityCreated`, `onRelationshipCreated`, `onScoreRecompute`,
`onEntityDeleted`) and an `init` callback. Core never dispatched any of them —
the dispatcher existed but its only caller was its own unit test — so they
were removed rather than left to mislead. If you need to react to a core
event, say so: adding a genuinely-dispatched hook is an additive change, and
the right time to design one is when there is a consumer for it.

To do work at startup, do it in your own module before calling
`registerExtension`.

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
  /** Aborts when the runner's job timeout fires. */
  readonly signal: AbortSignal;
}
```

**Long jobs must observe `signal`.** The runner cannot interrupt a running job
body — it can only stop waiting on it. A job that scans in batches should check
`signal.aborted` between them (and forward `signal` to anything that accepts
one), or a timed-out job keeps working unobserved. `signal` became part of this
type in `0.9.0`; core supplied it before that, but reaching it required a cast.

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

## Enrichment interfaces

These optional fields let a vertical contribute domain-specific _display and
derived data_. All three are invoked by core.

- **`activityPub.enrichActor(entity)`** — returns display-only `ActorEnrichment`
  (`summary`, `icon`, `attachment`, custom `properties`). The core owns and
  blocks overriding identity-bearing Actor fields: `id`, `publicKey`, `inbox`,
  `outbox`, `endpoints`, `@context`, and `preferredUsername`.
- **`computeLifeStage(metadata, manualOverride, existingLifeStage)`** — computes
  a life-stage value persisted as `Entity.lifeStage`; return `null` when not
  applicable.
- **`extendRecap(payload, subject, ctx)`** — computes aggregates from the
  extension's **own** tables for a recap subject and window; core merges the
  result under `payload.extension`. Display-only, no writes.

There is no injection point for relationship scoring, discovery faceting, or
recommendations. `relationshipSignalProvider`, `discoveryFacets` and
`recommendationStrategy` were declared until `0.9.0` but never consumed — the
scoring engine has no extension input, and discovery does not read facets from
extensions.

## Taxonomy

Extensions do not seed taxonomy through the contract. `taxonomySeed` was
declared until `0.9.0` and never read; a vertical that needs seed data applies
it through its own migration or startup routine, against the taxonomy tables
exposed on `ScopedDb`.

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

**This criterion is enforced in code, not by review alone.** `ScopedDb` exposes
`post` and `postMedia` with full write operations, and monotonicity lives in the
request handlers — which the scoped surface bypasses. So the provenance columns
are now a **protected-field set** on the scoped surface: `create`, `createMany`,
`update`, `updateMany` and `upsert` are **rejected** when the payload so much as
mentions `textSourceType`, `textBasis`, `declaredSourceType`, `declaredBasis`,
`embeddedSourceType` or `provenanceExamined`. You will get a `ScopedDbError`
naming the field.

Three things worth knowing about how that guard behaves:

- **It rejects on presence, not on value.** `{ textSourceType: undefined }` is
  refused even though Prisma would treat it as "omit". The guard exists to make
  the _intent_ fail loudly.
- **It is a total ban, not a monotonicity check.** The scoped planner is a pure
  function with no database access, so it cannot compare your value against the
  stored one. A raise is refused along with a downgrade — set provenance by
  calling the core post/comment API, which mints `basis` server-side. An extension
  able to write `basis` could forge `PLATFORM_GENERATED`, the platform's own
  strongest attestation.
- **Reads are untouched.** You may select, filter and render provenance freely.
  Hiding a disclosure from the code that renders it would defeat the point.

Extension review still blocks on a violation — the guard covers the data layer,
not an extension that ships its own client-side AI feature.
