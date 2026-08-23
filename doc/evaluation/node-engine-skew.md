# The Node 22/24 skew (plan 030, task B4)

**Measured 2026-08-23.** B4 was carried into plan 030 as "pre-existing,
unowned, and directly on this lane's build path". It surfaced on its own, from
`npm install` warnings, before anyone went looking. This records what it
actually is, because it is worse than "two images disagree".

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
finding survives it** and needs its own ticket.

## The resolution, and why it is not mine to apply

The evidence points one way — everything moves to Node 24:

1. `apps/api/Dockerfile`: `node:22-alpine` → `node:24-alpine` (both stages).
2. `engines.node`: `>= 22` → `>= 24` in the root and in `apps/api`.

Step 2 is the reason this is written up rather than done. **`@de-otio/trellis` is
a published package.** Raising its `engines.node` changes the contract every
consumer sees, and skybber's API container is a consumer — its image would need
the same bump, in the other repo, in step. That is a cross-repo,
consumer-visible change, and the honest thing is to put it to the owner rather
than fold it into an evaluation branch.

**The alternative** — pin `@de-otio/saas-foundation` and `@de-otio/vestibulum`
back to versions that still support Node 22 — is worth naming so the choice is
real, but it means holding two shared libraries back across every consumer to
keep one image on an older runtime. Node 22 goes end-of-life before that stops
being a cost.

**Recommendation: bump to Node 24 everywhere, as its own change, before the
next `@de-otio/trellis` release** — so the engines change and the image change
land together rather than a consumer discovering the mismatch at runtime.

## One unrelated defect found while type-checking

`apps/worker`'s typecheck does not pass on this lane's base branch, and it is
not Hatchet's doing — it reproduces with every file from this lane removed:

```
apps/api/src/lib/threat-intel-service.ts(205,13):
  error TS2322: Type 'unknown' is not assignable to type 'SafeBrowsingResponse'.
```

Recorded here so the next person to run that typecheck does not spend time
attributing it to the evaluation.
