# @de-otio/trellis-extension-testkit

Boot a real Trellis server against your extension, and check that it conforms.

Until this package existed you could typecheck an extension and do nothing
else: the server boot, the docker stack and the migrations all lived in core's
test tree, which is excluded from the published tarball. So the one thing that
would let you — or your coding agent — verify your own work was the one thing
not shipped.

```bash
npm i -D @de-otio/trellis-extension-testkit
```

`@de-otio/trellis` is a **peer** dependency: the testkit runs your extension
against the core you already depend on, never against one of its own.

## Boot a server

```ts
// test/setup.ts — your runner's setup file, NOT a test file. See below.
import { startStandaloneServer } from "@de-otio/trellis-extension-testkit";
import { myExtension } from "../src/index.js";

const server = await startStandaloneServer({
  extensions: [myExtension],
  extra: { MY_EXTENSION_API_KEY: "test" }, // whatever your configSchema requires
});

console.log(server.url); // http://localhost:3100
// …run your tests…
await server.stop();
```

That call applies the environment core needs, runs core's migrations, creates
the DynamoDB table, registers your extension, starts the server, waits for
`/health`, enables the feature toggles core's own handlers gate on, and runs
the conformance checks. If any of it fails, it throws — which is the answer you
want from a test lane.

You need Postgres and DynamoDB-local. A compose file ships with the package:

```bash
docker compose -f node_modules/@de-otio/trellis-extension-testkit/fixtures/docker-compose.yml up -d
```

Already running a Trellis stack? Skip the file and pass `databaseUrl` /
`dynamoEndpoint`. Two lanes can share one stack as long as they use a different
`port` and `dynamoTable`.

### Where to call it from

**A setup file, not a test file.** Every mainstream runner — vitest, jest,
node:test — executes test files in workers with their own module graph, and
core's extension registry is in-process state. Boot in a worker and the tests
in _other_ files talk to a server whose registry they cannot see; boot in a
runner-level `globalSetup` and the checks run in a process where nothing is
registered. The rule that covers both: **boot and check in the same process**,
and drive HTTP from wherever you like.

## Check conformance

`startStandaloneServer` runs these at boot by default. Call them directly when
you want the findings rather than a throw:

```ts
import { checkExtensionConformance } from "@de-otio/trellis-extension-testkit";

const result = await checkExtensionConformance({
  extension: myExtension,
  apiUrl: server.url,
});
// { ok: boolean, findings: [{ check, severity, message, fix }] }
```

| check               | what it catches                                                                  |
| ------------------- | -------------------------------------------------------------------------------- |
| `registration`      | registered under an id you did not expect, or two copies of the extension loaded |
| `api-version`       | `extensionApiVersion` absent, unparseable, or from another compatibility window  |
| `routes-mount`      | a declared `extensionRoutes` entry that answers 404                              |
| `cross-tenant-read` | a `crossTenantRead` grant nothing you ship can reach                             |

These are **stricter than core on purpose.** Core validates what would make
_core_ unsafe and is deliberately permissive about what merely makes an
extension wrong — an undeclared `extensionApiVersion` is one line in a log
nobody reads. Every defect found in the first real Trellis vertical was of that
second kind, which is what this table is a list of.

Adopting the testkit into a lane that already has findings:

```ts
await startStandaloneServer({
  extensions: [myExtension],
  conformance: "warn", // report, do not fail
  // or, per finding, once you have decided one is acceptable:
  acceptConformance: ["api-version"],
});
```

`accept` downgrades a finding to a warning and **keeps it in the report**.
Silencing one entirely is how it stops being reconsidered.

### What `cross-tenant-read` does not check

Whether each declared model is actually _read_. An extension with routes that
declares five models and reads one passes — and that is the exact shape of the
over-broad declaration this suite was written after. Catching it needs core to
record which models `discover()` touched during a run, and that instrumentation
does not exist yet. Said plainly because a check that implied it covered this
would be worse than no check at all.

## The reference extension

```ts
import { exampleExtension, minimalExtension } from "@de-otio/trellis-extension-testkit/example";
```

`exampleExtension` populates every optional surface core actually dispatches
and is the thing to copy. `minimalExtension` omits every optional field,
including `extensionApiVersion` — it is the standing proof that the optional
fields really are optional, so it fails conformance by design.

Both are core's own dummy target: core's contract tests and standalone lane
import these objects. A reference extension nothing exercises rots into a lie
about the contract.

## Pieces, if you want them separately

`startStandaloneServer` is the whole product; everything else is what it is
made of, exported because a lane that manages its own database will want the
toggles but not the migrations, or the reverse.

- `standaloneEnv(opts)` — apply core's required environment. **Call before
  importing `@de-otio/trellis`**: several core modules read `process.env` when
  they load.
- `applyCoreMigrations({ databaseUrl, schemaPath })` — `prisma migrate deploy`
  against core's shipped migrations.
- `coreSchemaPath()` — where core's `schema.prisma` is, resolved through the
  installed package. Throws with instructions when core is a git checkout
  rather than a tarball, because `prisma/` is assembled at pack time.
- `seedGlobalFeatureToggles(keys)` — enable global toggles. Core's handlers
  gate on these and they default to off, so skipping this produces 403s and
  404s that look like bugs in your extension.
- `ensureDynamoTable({ table, endpoint })`, `waitForHealth(url)`.

## Versioning

The testkit is published from the same repository as core and
`@de-otio/trellis-extension-api`, on its own tag series
(`extension-testkit-v<version>`). Its dependency on the contract package is
checked in lockstep with core's in CI.

## Licence

MIT.
