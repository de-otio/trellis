# DB Connection Management — Parallel Implementation Checklist

Operational companion to [`db-connection-management-plan.md`](./db-connection-management-plan.md). The plan defines *what* changes; this file defines *how to dispatch the work* across parallel agents.

## Phasing model

| Phase | Parallelism | Gate to next phase |
|---|---|---|
| 1 | 4 agents in parallel | All 4 complete, typecheck clean |
| 2 | 2 agents in parallel | Both complete, infra typecheck clean |
| 3 | 1 agent | Core typecheck clean |
| 4 | 1 agent | Validation report passes |
| 5 | Manual (operator) | Deploy ready |

Dependencies are real: Phase 2 reads types created in Phase 1; Phase 3 depends on Phase 1 error sanitization; Phase 4 depends on everything. Within a phase, agents touch non-overlapping files — no merge conflicts by construction.

## Model selection

- **Sonnet** (default): tasks that require reading existing code, matching local conventions, or navigating the trellis core and the consuming deployment's infra simultaneously. Covers ~90% of the work.
- **Haiku**: pure transcription from a fully-specified snippet to a new file, no existing-code context needed. Used for the probe script only.
- **Opus**: not used. The plan is fully specified; no design decisions remain. Using Opus here would waste tokens with no benefit.

---

## Phase 1 — 4 parallel agents

All four can dispatch simultaneously. No file overlap between them.

### T1 — Trellis core: graph-lib field rename + factory plumbing

- **Model:** Sonnet
- **Repo:** trellis (this repo)
- **Plan sections:** A1, A2, A3, A4, A6
- **Files (may edit):** `apps/api/src/lib/graph/types.ts`, `apps/api/src/lib/graph/graph-factory.ts`, `apps/api/src/lib/graph/neo4j-graph-service.ts`
- **Files (must not touch):** `apps/api/src/lib/graph/errors.ts` (T2 owns), any handler files (T3 owns)
- **Acceptance:**
  - `GraphPoolConfig` matches the 4-field driver-aligned spec in plan §A1.
  - `GraphServiceEnvConfig` uses new field names; old names (`maxSize`, `maxPoolSize`, `acquireTimeoutMs`, `idleTimeoutMs`) removed.
  - `intEnv` implemented exactly per plan §A3 (radix 10, positive-int check, trailing-garbage rejection, throws on invalid).
  - `Neo4jGraphService.connect` passes all 4 driver options; `connectionLivenessCheckTimeout` only set when defined.
  - Lambda clamp (§A6): `maxConnectionPoolSize = 1` when `AWS_LAMBDA_FUNCTION_NAME` is set.
  - `npx tsc --noEmit 2>&1 | grep -v TS2835 | head` shows no new errors (TS2835 is pre-existing ESM noise).
  - `grep -rE 'idleTimeoutMs|acquireTimeoutMs|maxSize' apps/api/src/lib/graph/` returns zero hits (confirms rename is complete).

**Prompt template:**
```
Implement plan items A1, A2, A3, A4, A6 from
plans/redesign/db-connection-management-plan.md.
Read that file first — it contains complete code snippets for each item.

Work in the trellis core. Edit only:
  - apps/api/src/lib/graph/types.ts
  - apps/api/src/lib/graph/graph-factory.ts
  - apps/api/src/lib/graph/neo4j-graph-service.ts

Do NOT touch errors.ts (another agent owns it) or any handler file.

After editing, run: npx tsc --noEmit 2>&1 | grep -v TS2835 | head
Report that output. Then confirm: grep -rE 'idleTimeoutMs|acquireTimeoutMs|maxSize' apps/api/src/lib/graph/
should return zero hits. Report any residual hits as a problem.

Do NOT commit.
```

### T2 — Trellis core: error message sanitization

- **Model:** Sonnet
- **Repo:** trellis (this repo)
- **Plan section:** A7
- **Files (may edit):** `apps/api/src/lib/graph/errors.ts`
- **Files (must not touch):** everything else
- **Acceptance:**
  - `GraphError` base class runs `sanitize()` on the message before calling `super()`.
  - Regexes match the plan §A7 spec exactly: Bolt URI, Aura host, password tokens.
  - No public API change to subclasses (constructor signatures identical, `code` field preserved).
  - Typecheck clean: `npx tsc --noEmit apps/api/src/lib/graph/errors.ts` has no errors attributable to this change.
  - Add a small unit test `apps/api/test/unit/graph/errors-sanitize.test.ts` covering: Bolt URI redaction, Aura host redaction, password token redaction, pass-through of safe messages. Vitest. Should pass in isolation.

**Prompt template:**
```
Implement plan item A7 from
plans/redesign/db-connection-management-plan.md.
The plan has the full sanitize() function and regex spec — copy them verbatim.

Work in the trellis core. Edit only:
  - apps/api/src/lib/graph/errors.ts
Create: apps/api/test/unit/graph/errors-sanitize.test.ts

Do NOT touch graph-factory.ts, types.ts, neo4j-graph-service.ts, or any handler file.

Write the unit test covering all three redaction patterns plus a pass-through case.
Run: npx vitest run apps/api/test/unit/graph/errors-sanitize.test.ts
Report that all tests pass. Do NOT commit.
```

### S1 — Consuming deployment: CDK config structures

> Deployment-side task. Trellis is not deployed standalone; the consuming
> application (e.g. via its own CDK) owns the infra config below. Paths are
> illustrative of a typical CDK layout.

- **Model:** Sonnet
- **Repo:** the consuming deployment's infra repo
- **Plan sections:** B1, B2, B3; also the `WafConfig.graphRateLimit` field addition from §E1 (dev: 200, prod: 500)
- **Files (may edit):** `infra/lib/config/index.ts`, `infra/lib/config/dev.ts`, `infra/lib/config/prod.ts`
- **Files (must not touch):** any `infra/lib/stacks/*.ts` (S2/S3 own those)
- **Acceptance:**
  - `GraphDbConfig` interface matches §B1 exactly (5 fields, `maxConnectionPoolSize: number | undefined`).
  - `WafConfig` has new `graphRateLimit: number` field.
  - Base defaults in `getConfig` include `graphDb` (dev values) and `waf.graphRateLimit: 500`.
  - `dev.ts` sets `graphDb` per §B2 dev block; `waf.graphRateLimit: 200`.
  - `prod.ts` sets `graphDb` with `maxConnectionPoolSize: undefined`; `waf.graphRateLimit: 500`.
  - `getConfig()` throws when `stage === "prod" && graphDb.maxConnectionPoolSize === undefined`.
  - `npx tsc --noEmit -p infra/tsconfig.json` clean.
  - Calling `getConfig('prod')` (inline node / test script) throws the expected error.

**Prompt template:**
```
Implement plan items B1, B2, B3 and the WafConfig.graphRateLimit addition
(dev: 200, prod: 500) from
plans/redesign/db-connection-management-plan.md.

Work in the consuming deployment's infra repo. Edit only:
  - infra/lib/config/index.ts
  - infra/lib/config/dev.ts
  - infra/lib/config/prod.ts

Do NOT touch any file under infra/lib/stacks/.

After editing, run:
  npx tsc --noEmit -p infra/tsconfig.json
Must be clean. Then verify the fail-closed synth guard throws for prod by any means
(inline node, calling getConfig('prod') from a test script — don't commit the script).

Do NOT commit.
```

### O1 — Ops: empirical probe script

> Deployment-side task. The probe runs against the deployment's own AuraDB
> instance using its own credentials store; paths are illustrative.

- **Model:** Haiku
- **Repo:** the consuming deployment's infra/ops repo
- **Plan section:** Validation §1 (script inline)
- **Files (may edit):** new file `scripts/ops/aura-connection-ceiling-probe.mjs`
- **Acceptance:**
  - File created, contents match the plan's ~60-line skeleton verbatim (shebang, imports, stdin read, loop, output JSON, cleanup).
  - File is executable (`chmod +x`).
  - `node --check scripts/ops/aura-connection-ceiling-probe.mjs` passes (syntax check, no runtime).

**Prompt template:**
```
Create a new file at
scripts/ops/aura-connection-ceiling-probe.mjs
in the consuming deployment's repo by copying the ~60-line JavaScript skeleton
from Validation §1 of
plans/redesign/db-connection-management-plan.md
verbatim.

Then: chmod +x the file, and run:
  node --check scripts/ops/aura-connection-ceiling-probe.mjs
Confirm no syntax errors. Do NOT commit. Do NOT run the script against a real
database — this is a file-creation task only.
```

---

## Phase 2 — 2 parallel agents

Deployment-side. Requires Phase 1 T1 and S1 complete (S2 needs the new `GraphDbConfig`; S3 needs `WafConfig.graphRateLimit`).

### S2 — Consuming deployment: api-stack.ts (env vars + alarms)

- **Model:** Sonnet
- **Plan sections:** C1, D1, D2
- **Files (may edit):** `infra/lib/stacks/api-stack.ts`
- **Acceptance:**
  - New env vars wired per §C1 with the conditional inclusion of `GRAPH_DB_POOL_MAX_SIZE`.
  - Alarms D1 + D2 placed immediately after the log group construction, using the CDK code in §D1/D2 verbatim.
  - Imports added: `cloudwatch`, `cloudwatch_actions`, `sns`.
  - Infra typecheck clean.
  - `npm run infra:synth -- --context stage=dev` (if the npm flag works; otherwise `npx cdk synth`) completes without error.

### S3 — Consuming deployment: network-stack.ts WAF rule

- **Model:** Sonnet
- **Plan section:** E1
- **Files (may edit):** `infra/lib/stacks/network-stack.ts`
- **Acceptance:**
  - New `GraphPathRateLimit` rule with priority 0 inserted into `wafRules` before existing `RateLimit` rule.
  - `rateBasedStatement` uses `config.waf.graphRateLimit` (must exist from Phase 1 S1).
  - `scopeDownStatement` contains `orStatement` with two `byteMatchStatement`s for `/api/circles/` and `/api/discovery/` prefixes.
  - Infra typecheck clean.

---

## Phase 3 — 1 agent

Requires Phase 1 T2 complete (sanitization is in place before handler-side uniformity work).

### T3 — Trellis core: uniform 503 body + timing jitter

- **Model:** Sonnet
- **Plan sections:** E2, E3
- **Files (may edit):** the 4 handler files with `GraphConnectionError` checks (`apps/api/src/lib/circle-handler.ts:266`, `discovery-handler.ts:193`, `entity-relationship-handler.ts:302`, `relationship-handler.ts:282`) and optionally `dual-write-service.ts`.
- **Acceptance:**
  - All 4 handlers return `{"error":"service_unavailable"}` with `Retry-After: 1` header for graph-unavailable paths (pool exhaustion, connection error, unreachable).
  - Before returning a 503 for pool-acquire timeout, the handler `await`s a randomized delay `50 + Math.random() * 100` ms. Only pool-acquire-timeout path; other errors pass through untouched.
  - Log line on pool-acquire-timeout includes the literal token `graph_pool_acquire_timeout` (matches §D2 filter).
  - Log line on auth error surfaces the Neo4j error `code` (not `message`) and contains `Neo.ClientError.Security.Unauthorized` when applicable (matches §D1 filter).
  - Existing unit tests for these handlers still pass. Add one test per handler that forces a `GraphConnectionError` and asserts the 503 body is the generic string — no URI / username leakage.

---

## Phase 4 — 1 agent

### V1 — Cross-repo validation

Spans the trellis core (graph tests + typecheck) and the consuming deployment's
infra (synth guards). Deployment commands are illustrative of a typical CDK setup.

- **Model:** Sonnet
- **Acceptance:**
  - (core) `npx vitest run apps/api/test/integration/graph` — all 94 existing + any new tests pass (requires Docker Neo4j running via `docker-compose up -d neo4j`).
  - (core) `npx vitest run apps/api/test/unit/graph` — passes (includes new `errors-sanitize.test.ts`).
  - (core) `npx tsc --noEmit 2>&1 | grep -v TS2835 | head` — clean.
  - (deployment) `npx tsc --noEmit -p infra/tsconfig.json` — clean.
  - (deployment) `npx cdk synth --context stage=dev` — completes; diff reviewable.
  - (deployment) `npx cdk synth --context stage=prod` — **fails** with the fail-closed synth-guard message (expected).
  - Report any residual `neptune` / `idleTimeoutMs` / `maxSize` references anywhere.

**Prompt template:**
```
Run the validation suite for the DB connection management changes. See Phase 4 of
plans/redesign/db-connection-management-implementation-checklist.md
for the full acceptance criteria.

Execute every command. For each, report:
  - command
  - one-line result summary (pass / fail)
  - if fail: the failing error's first 5 lines

Do not attempt fixes — just report. The `cdk synth --context stage=prod` failure is
EXPECTED (verifies the fail-closed guard).
```

---

## Phase 5 — Manual operator steps

Not agent work — operator runs these in order. Each takes minutes, not hours.
Steps 4–7 are deployment-side and run in the consuming application's
environment (Trellis is not deployed standalone).

1. **Review all Phase 1–4 output, commit each repo.** Separate commits per repo; keep scope clean (trellis core graph changes / deployment infra changes / new checklist).
2. **Bump and publish the trellis core package** (`@de-otio/trellis`) to `0.2.0` per plan Order of operations §6.
3. **Update the consuming deployment's `apps/api/package.json`** to `@de-otio/trellis: ^0.2.0`, run `npm install`, commit.
4. **Empirical Aura ceiling probe (dev)** using the committed script + the deployment's dev AWS profile, run from AWS CloudShell. Record measured `opened` count in a comment next to the `graphDb` block in `dev.ts`; commit the comment.
5. **Deploy dev:** the deployment's `cdk deploy --context stage=dev` (or equivalent npm script).
6. **Run Validation §§2–12** from the plan. Any failure → stop, investigate.
7. **Prod path (separate session):** run the prod ceiling probe from inside the VPC, rotate Aura password, populate `prod.ts`, deploy prod.

---

## Dispatch instructions

Launch Phase 1 as a single message with 4 concurrent `Agent` tool calls. Do **not** run them sequentially — there is no ordering dependency inside a phase.

Between phases, wait for completion notifications before launching the next phase. Phase transitions are the natural points to review aggregate progress.

Token-efficiency notes:
- Each Phase 1 agent is scoped to a single file or small cluster; prompts are short; no agent needs to read the whole codebase.
- Haiku for O1 saves ~5× cost vs Sonnet and produces identical output for pure transcription.
- Phase 4 validation runs commands + reports; no editing. Sonnet would be wasted here if Haiku existed for tool-use; keeping Sonnet because the report format requires judgement on what's actionable.
