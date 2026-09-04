# The Node 22/24 skew (plan 030, task B4)

**Measured 2026-08-23.** B4 was carried into plan 030 as "pre-existing,
unowned, and directly on this lane's build path". It surfaced on its own, from
`npm install` warnings, before anyone went looking.

> ## ⚠ Correction — "unowned" was wrong
>
> This document originally presented the skew as an undiscovered, unowned
> problem. **It is not.** `doc/02-technical/development/testing/ci-cd.md` carries
> a verified analysis dated **2026-08-16** — "Node 22 (`ci.yml`) vs Node 24
> (`publish.yml`) — why, and when to reconsider" — which reaches the opposite
> conclusion on the CI lane: **"do not bump `ci.yml` to Node 24 preemptively"**,
> with three named forcing functions, none of which has fired. It also warns
> against regenerating `package-lock.json` under Node 24 / npm 11, because npm 10
> and npm 11 write different `"peer": true` annotations for platform-specific
> optional deps and the diff would swamp the real change. **Read that section
> before acting on this one.**
>
> What survives the correction is a **different axis** that analysis does not
> cover: it is written entirely about the **CI and publish lanes**. No document
> in this repo mentioned `node:22-alpine` at all before this one. The lane that
> *ships* — the runtime image — was not part of that decision.

## What is declared where

| Thing | Declares | Source |
|---|---|---|
| `trellis-monorepo` (root) | `engines.node >= 22` | `package.json` |
| `@de-otio/trellis` | `engines.node >= 22` | `apps/api/package.json` |
| **`@de-otio/saas-foundation@0.4.3`** | **`engines.node >= 24`** | installed dependency |
| **`@de-otio/vestibulum@0.5.0`** | **`engines.node >= 24`** | installed dependency |
| `apps/api` image | **`node:22-alpine`** | `apps/api/Dockerfile` |
| `apps/worker` image | `node:24-slim` | `apps/worker/Dockerfile` |

## The actual finding

**`apps/api` runs on `node:22-alpine` and depends on two packages that require
Node ≥ 24.** Both are direct dependencies of `apps/api`, not transitive, and
both are imported on the hot path — `server.ts`, `env.ts`, `tenant-scope.ts`,
`cost-accumulator.ts`, `openai-budget.ts`, the Cognito lambdas, and more.

So the framing "the worker is ahead of the API" is wrong. The worker is on 24
**because its dependencies require 24**. The API has the same dependencies and
is on 22. The API image is the one that does not meet its own dependencies'
declared floor, and the repo's declared `>= 22` floor is a claim the tree does
not support.

Every `npm install` on a Node 22 machine says so:

```
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@de-otio/saas-foundation@0.4.3',
npm warn EBADENGINE   required: { node: '>=24.0.0' },
npm warn EBADENGINE   current: { node: 'v22.23.2', npm: '10.9.8' }
```

`EBADENGINE` is a **warning**, not an error, unless `engine-strict` is set. So
this ships. Whether it actually breaks depends on whether those two packages use
Node-24-only APIs — which is exactly the property nobody is checking, and the
reason this fails *late* rather than at build.

## Why this is not a Hatchet problem

Nothing above involves Hatchet. The evaluation is what surfaced it, and B4 is
the right place to record it, but the risk exists today, on `main`, in
production images, with or without plan 030. **If plan 030 is killed, this
finding survives it.**

## What was decided, 2026-08-23

**The runtime images move to Node 24. The CI lane does not.**

That split is deliberate. The 2026-08-16 analysis owns the CI-lane question and
answered it *no*; nothing has changed to fire any of its three forcing
functions, so `ci.yml` stays on Node 22, `.nvmrc` stays `22`, `engines.node`
stays `>= 22`, and **no lockfile is regenerated** — exactly as that section
instructs. The runtime image was never part of that decision, and it is the one
place where the packages declaring `>= 24` actually execute.

**Verified by building it, not by reasoning about it:**

| Check | Result |
|---|---|
| `docker build --platform linux/arm64 -f apps/api/Dockerfile` | succeeds |
| `node --version` in the image | **v24.19.0** |
| `npm --version` in the image | **11.17.0** |
| `EBADENGINE` warnings during the build | **0** |

The dependency audit that gated this covered **every** package in both repos
declaring an `engines.node` field — 327 in trellis, 290 in skybber. Exactly one
declares a range excluding Node 24: `@img/sharp-win32-ia32` (`^20.9.0`), which
is `optional: true`, `os: ["win32"]`, `cpu: ["ia32"]` and never installs on
linux/arm64 or macOS. Every ABI-sensitive package supports 24 — `sharp`
`>=20.9.0`, Prisma 7.9.1 `^20.19 || ^22.12 || >=24.0`, `@grpc/grpc-js`
`>=12.10.0`.

Corroborating evidence rather than mere absence of blockers: **skybber's CI
already runs Node 24** and is green, so the shared tree demonstrably works
there — while skybber shipped its API on 22, the same mismatch, in the same
direction. Its image moves too.

### What is deliberately still inconsistent

Both repos still test on a different Node major than something else they do —
trellis tests on 22 and publishes on 24; skybber tests on 24 and now ships on
24. Chasing full uniformity was forcing function #3 in the 2026-08-16 analysis
("a hard requirement to unify tooling versions for its own sake"), and it
correctly called that *not present*. It still is not.

## Why the full bump was not taken

Raising `engines.node` on `@de-otio/trellis` changes a **published,
consumer-visible contract**, and skybber's package would need the same bump in
step. That is a real cost, and the 2026-08-16 analysis already weighed the
equivalent question for CI and said wait. Nothing in the audit above overturns
its reasoning — the audit establishes that Node 24 *works*, not that the CI lane
*must* move, and those are different claims.

**The alternative worth naming** so the choice is real: pin
`@de-otio/saas-foundation` and `@de-otio/vestibulum` back to versions still
supporting Node 22. That means holding two shared libraries back across every
consumer to keep one image on an older runtime, and Node 22 reaches end of life
before that stops costing.

**Revisit the full bump** when forcing function #1 fires — those two packages
going from an advisory `EBADENGINE` warning to a hard requirement the package
will not run under at all.

## One unrelated defect found while type-checking

`apps/worker`'s typecheck failed on this lane's original base branch with

```
apps/api/src/lib/threat-intel-service.ts(205,13):
  error TS2322: Type 'unknown' is not assignable to type 'SafeBrowsingResponse'.
```

**Already fixed on `main`** — it was resolved in the eleven commits this lane's
base was behind, and merging `main` in cleared it. `tsc --noEmit -p
apps/worker/tsconfig.json` is clean. Kept only so the earlier note claiming it
as an open defect is not read as current.
