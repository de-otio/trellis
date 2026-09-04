# Hatchet TypeScript SDK — CJS-from-ESM interop (plan 030, task B2)

**Measured 2026-08-23** against `@hatchet-dev/typescript-sdk@1.28.2`, Node
v22.23.2, TypeScript 5.9.3 with `module`/`moduleResolution: NodeNext` — the
same settings `apps/worker/tsconfig.json` uses. `apps/worker` is
`"type": "module"`, so every finding here applies to it directly.

B2 asked: *the SDK ships CJS-only with no `exports` field — confirm named
imports resolve under the ESM worker and record any quirk.* They do. The quirks
are what matter.

## What the package actually is

Read from the published tarball, not the packument:

| Field | Value |
|---|---|
| `type` | **absent** → CJS |
| `main` | **absent** → Node falls back to `index.js` at package root |
| `module` | absent |
| `exports` | **absent** → no subpath map, legacy resolution |
| `types` | `dist/index.d.ts` — **this file does not exist in the tarball** |

`dist/` contains exactly one file, `version-check.js`. The real declarations are
`index.d.ts` at the package root, and `index.js` is the real CJS entry. So the
package's own `types` pointer is broken, and both entry points work only via
resolver fallback.

## The three results

**1. Named imports resolve. ✅**

```js
import { Hatchet } from '@hatchet-dev/typescript-sdk';   // typeof → function
```

79 named exports are visible. `index.js` re-exports through `__exportStar(require(...))`,
which is the pattern that often defeats Node's `cjs-module-lexer` and produces
`SyntaxError: Named export not found` — here it does not. This was the risk B2
was written about, and it is not real at this version. **It is version-dependent
by nature**: re-check it on any SDK bump rather than assuming it holds.

**2. The default import is a trap. ⚠**

```js
import Hatchet from '@hatchet-dev/typescript-sdk';       // typeof → OBJECT, not function
import { Hatchet } from '@hatchet-dev/typescript-sdk';   // typeof → function ✅
```

The default import yields the whole CJS `module.exports` object, not the client
class — even though `index.js` sets `exports.default = HatchetClient`. It looks
like it worked and then fails at `new Hatchet()`. **Always use the named import.**

**3. Subpath imports need an explicit `/index.js`. ⚠**

```js
import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';           // ❌ throws
import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js';  // ✅
```

```
Error [ERR_UNSUPPORTED_DIR_IMPORT]: Directory import '.../typescript-sdk/v1'
is not supported resolving ES modules
```

A direct consequence of the missing `exports` field: subpaths fall back to
legacy resolution, and ESM does not do directory imports. Every subpath import
in worker code must name the file.

## Import the `/v1` subpath, not the root

Not style — the root import is noisy on **stderr** and the subpath is silent.
Verified with the streams separated:

| Import | stdout | stderr |
|---|---|---|
| `@hatchet-dev/typescript-sdk` (root) | clean | **3 lines** |
| `@hatchet-dev/typescript-sdk/v1/index.js` | clean | **empty** |

The three lines, emitted on **mere import**, before any client is constructed:

```
(node:NNN) [HATCHET_V0_REMOVED] DeprecationWarning: The v0 SDK, including the step module, ...
(node:NNN) [HATCHET_V0_REMOVED] DeprecationWarning: The v0 SDK, including the workflow module, ...
ConcurrencyLimitStrategy and StickyStrategy have been moved to @hatchet-dev/typescript-sdk/v1.
```

The root `index.js` `__exportStar`s the removed v0 `step` and `workflow` modules
unconditionally, and they warn at load. The third line is not a Node warning at
all — it is the package writing a **bare, non-JSON line to stderr**, which is a
log stream the worker also writes to. In a structured-logging worker that is a
line no parser will accept, on every start, forever.

Importing `@hatchet-dev/typescript-sdk/v1/index.js` avoids all three, because it
never loads the v0 modules.

## TypeScript resolves correctly anyway

Despite `types` pointing at a file that does not exist, `tsc` under NodeNext
resolves both the root and the `/v1/index.js` form and exits **0**. It falls
back to the root `index.d.ts`.

**Controlled, not assumed** — a clean `tsc` run is also what you get when a
module silently resolves to `any`, so the negative control was run:

```ts
const bad: number = HatchetClient;
// probe.ts(3,7): error TS2322: Type 'typeof HatchetClient' is not assignable to type 'number'.
```

Real types, not `any`.

## Peer dependencies — the B3 picture is better than expected

`peerDependenciesMeta` marks **every** peer optional except `zod`:

| Peer | Optional | Estate |
|---|---|---|
| `zod` | **no — required** | `^4.4.3`, satisfies the SDK's `^3.25.0 \|\| ^4.0.0` ✅ |
| `@opentelemetry/api` | yes | |
| `@opentelemetry/core` | yes | family deduped at 2.10.0, satisfies `^2.0.0` |
| `@opentelemetry/sdk-trace-base` | yes | satisfies `^2.0.0` |
| `@opentelemetry/exporter-trace-otlp-grpc` | yes | SDK wants `^0.221.0` |
| `@opentelemetry/instrumentation` | yes | SDK wants `^0.221.0` |
| `@grpc/grpc-js`, `prom-client` | yes | |
| `@anthropic-ai/claude-agent-sdk`, `@openai/agents`, `@modelcontextprotocol/sdk` | yes | not wanted here |

Two consequences for **B3**:

1. **There is no install-time peer conflict to resolve.** The optional marking
   means npm will not fail or warn on the estate's pinned OTel versions. B3 is
   therefore a *runtime* question — does the engine collector interfere with the
   existing pipeline — not a resolution question, which is how it was framed.
2. The SDK would pull three AI-agent SDKs as peers if they were required. They
   are not. Nothing should install them.

## Bottom line for B1

```ts
import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js';
```

Named import, `/v1` subpath, explicit `/index.js`. Anything else is either noisy
or wrong.
