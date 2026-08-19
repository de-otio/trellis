# CI/CD Test Integration

## Two pipelines, one boundary

Trellis is a **generic core published to npm**. It does not deploy itself.
A consuming vertical depends on `@de-otio/trellis`, owns the live AWS
environment, and runs the deploy pipeline. That split shapes where tests run:

```
┌─ THIS REPO (Trellis core) ──────────────────────────────────────┐
│  Push / PR to main ──► ci.yml ──► lint-and-test + consumer smoke │
│  Tag v* / extension-api-v* ──► publish.yml ──► npm publish        │
└──────────────────────────────────────────────────────────────────┘
                                  │  (npm dependency bump)
                                  ▼
┌─ CONSUMING VERTICAL (owns AWS) ─────────────────────────────────┐
│  Its deploy pipeline ──► deploy ──► E2E + post-deployment        │
│  (runs against its deployed Cognito / RDS / ECS / CloudFront)    │
└──────────────────────────────────────────────────────────────────┘
```

The E2E and post-deployment **test code lives in this repo** (under
`apps/api/test/e2e` and `apps/api/test/integration/postdeployment`), but it
targets a *deployed* environment. In this repo those suites are **not part of
the CI gate** — they run either against a deployed environment you point them
at, or (preferably) against the local dummy target described in
[standalone.md](standalone.md).

> **If you are looking for a deploy pipeline in this repo, there isn't one.**
> Earlier revisions of these docs described a `deploy.yml`, a
> `@de-otio/trellis-infra` workspace, ECR/ECS build-and-push jobs, and a
> `test-infra` gate. Those belong to the **consuming vertical**, not Trellis
> core. This document describes what Trellis core actually runs.

## CI Workflow (`.github/workflows/ci.yml`)

Triggers on push to `main`, PRs targeting `main`, and `workflow_dispatch`.
Three parallel jobs: `lint-and-test`, `standalone`, and `graph`.

### `lint-and-test`

| Step | What runs |
|------|-----------|
| Services | PostgreSQL 16 + DynamoDB Local (GitHub Actions service containers) |
| Prisma | `prisma:generate` + `prisma:migrate:deploy` against the service Postgres |
| Build | `npm run build -w @de-otio/trellis` |
| Lint | `npm run lint -w @de-otio/trellis` (`tsc --build`) |
| Test | `npm test -w @de-otio/trellis` (unit + pre-deploy integration) |
| Consumer smoke | `bash apps/api/scripts/smoke-pack.sh` — packs the tarball, installs it `--omit=dev` into a fresh project, requires every published entry point |

The consumer-install smoke is the one piece of CI that verifies Trellis the
way a vertical consumes it: it catches runtime imports of devDependencies and
unshipped relative imports that the in-repo suite (full source tree + devDeps)
cannot see.

### `standalone`

Boots the real server in-process with the dummy-target extension and drives
the full HTTP path — no AWS account, no consuming vertical. Services:
PostgreSQL 16 (PostGIS) + DynamoDB Local. Runs `prisma:migrate:deploy` then
`npm run test:standalone -w @de-otio/trellis`. See [standalone.md](standalone.md).

### `graph`

Runs the graph integration lane (`npm run test:graph`) against a real
PostGIS-enabled Postgres (`postgis/postgis:16-3.4`). The graph layer runs in
Postgres — edge tables + recursive CTEs — since the graph-db revisit
(2026-06); there is no separate graph database. This lane exercises the SQL
that mocked unit tests cannot verify: the recursive discovery CTE and the
dual-gated visibility query (a privacy control). The schema is materialized
with `prisma db push` (the graph edge tables ship without migration files),
with `STAGE=test` keeping the prod-refusal and wipe guards satisfied.

### What CI does **not** do here

- No CDK / infrastructure tests (no `infra/` workspace in this repo).
- No Docker image build / ECR push (the consuming vertical builds the image).
- No deploy, no post-deploy verification (no deployed environment to verify).

## Dependency updates (`.github/workflows/dependabot-auto-merge.yml`)

Dependabot PRs auto-merge once the required CI checks pass — no manual
review, no semver distinction (patch, minor, and major bumps are all
eligible). As of 2026-07-02, `lint-and-test` includes a repo-wide coverage
gate (`npm run test:coverage -w @de-otio/trellis`, thresholds in
`apps/api/vitest.config.ts`: branches ≥78%, lines/functions/statements
≥80%) in addition to the pre-existing scoped Phase-0 gate, so a dependency
bump that silently regresses coverage anywhere in the suite — not just the
3 allowlisted files — now fails the merge-gating check. This makes
green-CI-only auto-merge a reasonably safe default, but it does not catch
everything: mocked SDK tests (e.g. `aws-sdk-client-mock` on `@aws-sdk/*`
clients) don't catch upstream wire-format drift, and a major-version bump
that changes behavior in a way existing tests don't exercise can still land
silently.

## Publish Workflow (`.github/workflows/publish.yml`)

Tag-triggered npm publish (Trusted Publishing / OIDC). Two flows:

| Tag pattern | Publishes |
|-------------|-----------|
| `v<x.y.z>` | `@de-otio/trellis` (the api package) |
| `extension-api-v<x.y.z>` | `@de-otio/trellis-extension-api` |

See the **Release Checklist** in [`CLAUDE.md`](../../../../CLAUDE.md) for the
pre-tag gate (versions match, lint+tests pass on `main`, lockfile updated).

### Node 22 (`ci.yml`) vs Node 24 (`publish.yml`) — why, and when to reconsider

`ci.yml`'s 7 jobs run Node 22 (matching `.nvmrc` and root `engines: >=22`);
`publish.yml` runs Node 24. This is deliberate, not drift: npm Trusted
Publishing requires npm ≥ 11.5.1, which Node 24 ships (npm 11) and Node 22
does not (npm 10) — Node 22 fails the OIDC publish with a misleading "404 Not
Found" on the registry `PUT`, immediately after provenance is signed.

**Two dependencies already declare `engines.node >= 24`**:
`@de-otio/vestibulum` and `@de-otio/saas-foundation`. Verified 2026-08-16: on
Node 22 (npm 10.9.8, matching `ci.yml`), `npm ci` prints `EBADENGINE` for
both and installs anyway — advisory only, not a failure, today.

**The sharp edge, verified 2026-08-16 (not merely relayed from the prior
session's notes):**

| | Node 22 / npm 10 (`ci.yml`) | Node 24 / npm 11 (`publish.yml`) |
|---|---|---|
| `npm ci` (scripts enabled) | Silent — no such warning exists on npm 10 | Prints `npm warn allow-scripts`: 4 packages (`@prisma/engines`, `esbuild`, `fsevents`, `prisma`) have install scripts "not yet covered by allowScripts" |
| `npm ci --ignore-scripts` | No install scripts run; nothing to warn about | Same — no `allow-scripts` warning either, because nothing is uncovered when nothing runs |

npm 11's `allow-scripts` check currently only **warns**; it still runs the
scripts. If a future npm makes that gate **blocking**, `npm run
prisma:generate` in a plain `npm ci` (scripts enabled) would fail wherever
npm ≥ 11 runs it — today that is `publish.yml` only. Node 22/npm 10 has no
such gate at all, so `ci.yml` would stay green through that change and never
surface it — the two lanes install with genuinely different npm behavior,
not just a different Node major.

**This interacts directly with the `--ignore-scripts` fix in `publish.yml`
(HIGH-1, 2026-08 security review, see the workflow's own comments): the
`build` job's `npm ci` now runs with `--ignore-scripts` unconditionally,
which was verified above to suppress the `allow-scripts` warning entirely
(nothing runs, nothing is "uncovered"). Combined with `prisma:generate`
already working correctly under `--ignore-scripts` on both npm 10 and npm 11
(verified the same session), the publish lane no longer depends on any
dependency's install script succeeding at all — so the specific failure mode
above (`prisma:generate` breaking in the publish lane when npm's gate flips
to blocking) is now closed for `publish.yml`, independent of when or whether
npm makes that change.**

**Recommendation: do not bump `ci.yml` to Node 24 preemptively.** The
forcing functions that *would* justify it, in order of likelihood:

1. `@de-otio/vestibulum` / `@de-otio/saas-foundation` (or a future dependency)
   tighten `engines.node >= 24` from advisory (`EBADENGINE` warning) to a
   hard requirement the package won't run under at all.
2. npm's `allow-scripts` gate goes from warn to block, **and** by then
   `ci.yml`'s plain `npm ci` (scripts enabled, no `--ignore-scripts`) still
   depends on one of the 4 flagged packages' install script actually running
   for something CI needs (today: Prisma's engine, obtained via the explicit
   `prisma:generate` step regardless of whether the postinstall ran — see
   above; esbuild's/fsevents' postinstalls fetch native binaries `tsc`-based
   builds in this repo don't currently need). If CI ever starts depending on
   one of those scripts, re-verify this cell of the table on the npm version
   in use before assuming it still holds.
3. A hard requirement to unify tooling versions across every workflow for its
   own sake — not present today.

None of the three currently apply. **Do not regenerate `package-lock.json`
under Node 24/npm 11** as part of resolving this later without re-reading the
existing note on npm-version lockfile skew (npm 10 vs npm 11 write different
`"peer": true` annotations for platform-specific optional deps like
`@esbuild/*`, producing tens of lines of unrelated diff) — regenerate on
whichever npm version `ci.yml` will actually run, the same way the
`@types/sharp` removal in this repo's history was done deliberately on Node
22/npm 10 to keep the diff to the real change.

## Test Configs by Runner

| npm script | Vitest config | What it includes | Runs in this repo's CI? |
|------------|---------------|------------------|--------------------------|
| `test` | `vitest.config.ts` | Unit + pre-deploy integration (excludes e2e, postdeployment, graph, schema, live-infra integration) | ✅ yes |
| `test:integration` | `vitest.integration.config.ts` | Pre-deployment integration (needs Docker Compose) | run locally / standalone |
| `test:graph` | `vitest.graph.config.ts` | Postgres graph integration (needs PostGIS Postgres) | ✅ yes (`graph` job) |
| `test:schema` | `vitest.schema.config.ts` | Prisma schema-shape checks (needs local Postgres) | run locally |
| `test:e2e` (+ shards) | `vitest.e2e*.config.ts` | E2E against a deployed API (or the dummy target) | consumer pipeline / standalone |
| `test:postdeployment` (+ shards) | `vitest.postdeployment*.config.ts` | Post-deploy validation against deployed infra | consumer pipeline |
| `test:agents` | `vitest.agents.config.ts` | Bedrock AgentCore smoke tests | manual (needs AWS) |
| `test:coverage` | `vitest.config.ts` + coverage | Unit + integration with coverage report | manual |

## Environment Variables for Test Runners

### Unit / Integration (CI or local)

| Variable | Source | Required |
|----------|--------|----------|
| `DATABASE_URL` | Docker Compose or CI service | Yes |
| `DYNAMODB_ENDPOINT` | Docker Compose or CI service | Yes |
| `DYNAMODB_TABLE` | Hardcoded (`test-trellis`) | Yes |
| `SESSION_SECRET` | Test constant or CI secret (≥32 chars) | Yes |
| `STAGE` | `test` | Yes |
| `NODE_ENV` | `test` | Yes |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Dummy values for SDK clients | Yes |

(These match the `env:` block of the `Run tests` step in
[`ci.yml`](../../../../.github/workflows/ci.yml).)

### E2E / Post-deployment (against a deployed environment)

These run in the **consuming vertical's** pipeline, or locally when you point
them at a deployed environment. Configuration is resolved by `TestConfig`
(`test/utils/test-config.ts`) from a `config.yaml` keyed on `TEST_ENV`, plus
AWS credentials for Cognito / SSM / S3. To run them **without** any deployed
environment, use the local dummy-target lane in [standalone.md](standalone.md).

## Production Safety

E2E tests that modify data are gated:

- `isProduction()` (`test/e2e/utils/test-environment-guard.ts`) classifies the
  target environment.
- `requireDevEnvironment()` throws if a write test runs against prod.
- Write suites use `describe.skipIf(isProduction())`; read-only tests
  (smoke, health) run in all environments.
