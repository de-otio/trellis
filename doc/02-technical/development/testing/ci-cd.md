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
One job, `lint-and-test`:

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

### What CI does **not** do here

- No CDK / infrastructure tests (no `infra/` workspace in this repo).
- No Docker image build / ECR push (the consuming vertical builds the image).
- No deploy, no post-deploy verification (no deployed environment to verify).

## Publish Workflow (`.github/workflows/publish.yml`)

Tag-triggered npm publish (Trusted Publishing / OIDC). Two flows:

| Tag pattern | Publishes |
|-------------|-----------|
| `v<x.y.z>` | `@de-otio/trellis` (the api package) |
| `extension-api-v<x.y.z>` | `@de-otio/trellis-extension-api` |

See the **Release Checklist** in [`CLAUDE.md`](../../../../CLAUDE.md) for the
pre-tag gate (versions match, lint+tests pass on `main`, lockfile updated).

## Test Configs by Runner

| npm script | Vitest config | What it includes | Runs in this repo's CI? |
|------------|---------------|------------------|--------------------------|
| `test` | `vitest.config.ts` | Unit + pre-deploy integration (excludes e2e, postdeployment, graph, schema, live-infra integration) | ✅ yes |
| `test:integration` | `vitest.integration.config.ts` | Pre-deployment integration (needs Docker Compose) | run locally / standalone |
| `test:graph` | `vitest.graph.config.ts` | Neo4j graph integration (needs local Neo4j) | run locally |
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
