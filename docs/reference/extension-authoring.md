# Writing a Trellis extension

**Who this is for:** you are writing an extension against the published
contract, in **your own repository**. If you are working *inside* the Trellis
repository — changing core, fixing a test, cutting a release — read
[`AGENTS.md`](../../AGENTS.md) at the repo root instead.

> This page used to live at the repository root as `AGENTS.md`. It moved when
> `AGENTS.md` became the in-repo agent contract. The content is unchanged.

The full contract is [`extension-api.md`](extension-api.md); the
machine-readable form is
[`packages/extension-api/etc/public-api.snapshot.d.ts`](../../packages/extension-api/etc/public-api.snapshot.d.ts),
which CI holds equal to the code. Prefer either over anything you remember
about Trellis.

## The one rule that matters most

**If a field is not in the `TrellisExtension` table in the reference doc, core
does not call it.** Declare only fields from that table.

This is not a stylistic preference. Until `0.9.0` the contract declared seven
optional fields that core never invoked — five lifecycle `hooks`, `init`,
`taxonomySeed`, `relationshipSignalProvider`, `entityRelationshipTypes`,
`discoveryFacets`, `recommendationStrategy`. They type-checked, registered
without complaint, and did nothing. Two of them logged themselves at boot
(`[extensions] "x" registered discoveryFacets: ...`), which reads exactly like
confirmation and was not. They are gone as of `0.9.0`. If a tutorial, an older
answer, or your own prior of "platforms have lifecycle hooks" suggests
`onEntityCreated`, it does not exist — there is currently **no event-hook
mechanism at all**.

Corollary for writing tests: a test that calls your own hook function and
asserts it recorded something proves nothing about core. Exercise your
extension **through core** — boot it and make a request. See the test lanes
below.

## What core actually invokes

Required: `id`, `terminology`, `routes` (may be empty), `metadataSchema`.

Optional and genuinely wired: `extensionApiVersion`, `crossTenantRead`,
`jobs`, `extensionRoutes`, `configSchema`, `activityPub.enrichActor`,
`computeLifeStage`, `extendRecap`, `shutdown`.

That is the whole list. Check the reference doc for the current one rather
than trusting this paragraph if the two disagree — the doc is version-gated in
CI and this file is not.

## Traps, in the order they bite

1. **Use `extensionRoutes`, not `routes`.** Both mount. `extensionRoutes` are
   wrapped by core with authentication, CORS, CSRF, rate limiting, security
   headers, error shaping, and a scoped `ExtensionContext`. Raw `routes` get
   none of that — you are wiring a bare handler into the app and every one of
   those properties becomes your problem. `routes: []` plus `extensionRoutes`
   is the normal shape. Raw routes mount _before_ wrapped ones.

2. **Relative imports need the `.js` extension**, including from `.ts`
   sources: `import { x } from "./thing.js"`. The package is ESM
   (`"type": "module"`) and compiles under `NodeNext`. Omit the extension and
   TypeScript fails with `TS2835`.

3. **Import from the package root only.** `@de-otio/trellis-extension-api`
   declares an `exports` map exposing the root and `package.json`. A deep
   specifier such as `.../lib/index.js` raises
   `ERR_PACKAGE_PATH_NOT_EXPORTED`.

4. **A hand-written model map must declare all thirteen operations.** If you
   type your own models (`TrellisExtension<MyModels>`) and cannot import
   generated Prisma delegates — common, since a composed schema generates its
   client after your package builds — write each delegate as
   `interface X extends ScopedDelegate` and narrow only the operations you use.
   Declaring just the one operation you call satisfies nothing: `ScopedDelegate`
   is exactly the shape core's registry holds, so a partial delegate is rejected
   on the map, listing what is missing. Before `0.9.2` it was accepted there and
   failed at your `registerExtension(...)` call instead.

5. **Register before the server starts.** `registerExtension(ext)` must run
   before `startServer()`; core never imports an extension itself.
   Registering two extensions with the same `id` is rejected. `id` doubles as
   the entity type and the route mount prefix (`/api/ext/{id}/{path}`).

6. **Declare `extensionApiVersion: EXTENSION_API_VERSION`.** Core then
   compares versions at boot and **fails startup** on an incompatible pairing
   instead of serving traffic with a mismatched contract. While the API is
   `0.x`, a differing _minor_ is breaking. Omitting the field is legal but
   gives up that protection.

7. **A long job must observe its `signal`.** The runner cannot interrupt a
   running job body — it can only stop waiting on it. Check
   `jobCtx.signal.aborted` between batches and forward it to anything that
   accepts one, or a timed-out job keeps working unobserved.

8. **You cannot reach another tenant's data by accident, and should not try
   on purpose.** `ctx.db.tenant(tid)` is tenant-bound by construction.
   Cross-tenant reads go only through `ctx.db.discover(reason)`, restricted to
   the models you declared in `crossTenantRead`, with a visibility floor
   applied to every query and your `reason` recorded in core's audit trail. If
   you find yourself wanting a raw client, the design is wrong — say so rather
   than working around the seam.

9. **No third-party trackers, analytics SDKs, or ad-network integrations** in
   server-side request handling, and client metadata only through the
   sanctioned anonymized, retention-bound paths. Extension review blocks on a
   violation. See [`extension-api.md`](extension-api.md) and
   [`PRINCIPLES.md`](../../PRINCIPLES.md).

## Verifying your extension

**Install `@de-otio/trellis-extension-testkit` and run your extension.** It
boots a real Trellis server with your extension registered, against a local
docker stack, and tells you what is wrong with it:

```ts
import { startStandaloneServer } from "@de-otio/trellis-extension-testkit";

const server = await startStandaloneServer({ extensions: [myExtension] });
// …drive HTTP against server.url…
await server.stop();
```

Call it from your runner's **setup file, not a test file**: core's extension
registry is in-process state, and every mainstream runner executes test files
in workers with their own module graph.

That call also runs a conformance suite — `registration`, `api-version`,
`routes-mount`, `cross-tenant-read` — which is stricter than core's boot
validation on purpose. Core checks what would make *core* unsafe; these check
what makes an *extension* wrong, which is the category every defect found in
the first real vertical fell into.

The **reference extension** is
`@de-otio/trellis-extension-testkit/example`: a domain-free `widget` vertical
exercising every wired surface, and the thing to copy. `minimalExtension`
alongside it omits every optional field — including `extensionApiVersion`, so
it fails conformance by design.

In-repo lanes worth reading as models: a **contract lock test** asserting the
shape you declare still matches the published types, and the **standalone HTTP
lane**. Details:
[`doc/02-technical/development/testing/standalone.md`](../../doc/02-technical/development/testing/standalone.md),
[`packages/extension-testkit/README.md`](../../packages/extension-testkit/README.md).

## When the contract is wrong

If you need something the contract does not offer, the useful response is to
say so plainly rather than to fake it with a raw route or a cast. Adding a
genuinely-dispatched extension point is an additive, non-breaking change, and
the right moment to design one is when a real consumer exists. A workaround
that circumvents a seam is the more expensive outcome for everyone — which is
the lesson the seven removed fields were teaching.
