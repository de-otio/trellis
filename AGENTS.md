# AGENTS.md — writing a Trellis extension

**Which file do you want?**

- **Working inside this repository** (changing core, fixing a test, cutting a
  release)? Read [`CLAUDE.md`](CLAUDE.md). It has the architecture, the
  authoritative typecheck, the test lanes, and the release checklist.
- **Writing an extension against the published contract**, in your own
  repository? This file. It is the short list of things that are true about
  the extension surface and are easy to get wrong.

The full contract is
[`docs/reference/extension-api.md`](docs/reference/extension-api.md); the
machine-readable form is
[`packages/extension-api/etc/public-api.snapshot.d.ts`](packages/extension-api/etc/public-api.snapshot.d.ts),
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

4. **Register before the server starts.** `registerExtension(ext)` must run
   before `startServer()`; core never imports an extension itself.
   Registering two extensions with the same `id` is rejected. `id` doubles as
   the entity type and the route mount prefix (`/api/ext/{id}/{path}`).

5. **Declare `extensionApiVersion: EXTENSION_API_VERSION`.** Core then
   compares versions at boot and **fails startup** on an incompatible pairing
   instead of serving traffic with a mismatched contract. While the API is
   `0.x`, a differing _minor_ is breaking. Omitting the field is legal but
   gives up that protection.

6. **A long job must observe its `signal`.** The runner cannot interrupt a
   running job body — it can only stop waiting on it. Check
   `jobCtx.signal.aborted` between batches and forward it to anything that
   accepts one, or a timed-out job keeps working unobserved.

7. **You cannot reach another tenant's data by accident, and should not try
   on purpose.** `ctx.db.tenant(tid)` is tenant-bound by construction.
   Cross-tenant reads go only through `ctx.db.discover(reason)`, restricted to
   the models you declared in `crossTenantRead`, with a visibility floor
   applied to every query and your `reason` recorded in core's audit trail. If
   you find yourself wanting a raw client, the design is wrong — say so rather
   than working around the seam.

8. **No third-party trackers, analytics SDKs, or ad-network integrations** in
   server-side request handling, and client metadata only through the
   sanctioned anonymized, retention-bound paths. Extension review blocks on a
   violation. See
   [`docs/reference/extension-api.md`](docs/reference/extension-api.md) and
   [`PRINCIPLES.md`](PRINCIPLES.md).

## Verifying your extension

Three lanes exist in this repository and are the model to copy:

- a **contract lock test** asserting the shape you declare still matches the
  published types;
- a **standalone HTTP lane** that boots a real server with an extension
  registered and makes requests against it;
- the **reference extension** at
  `apps/api/test/fixtures/example-extension/`, a domain-free `widget` vertical
  that exercises every wired surface. It is the closest thing to a worked
  example. It lives under `test/` and is deliberately excluded from the
  published tarball, so read it here rather than expecting it in your
  `node_modules`.

Lane details:
[`doc/02-technical/development/testing/standalone.md`](doc/02-technical/development/testing/standalone.md).

## When the contract is wrong

If you need something the contract does not offer, the useful response is to
say so plainly rather than to fake it with a raw route or a cast. Adding a
genuinely-dispatched extension point is an additive, non-breaking change, and
the right moment to design one is when a real consumer exists. A workaround
that circumvents a seam is the more expensive outcome for everyone — which is
the lesson the seven removed fields were teaching.
