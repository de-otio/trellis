# Trellis Stages — v0.7 release

These 9 stage files describe the trellis-side work to ship multi-tenancy + IdP federation + agent-friendly surface as the **trellis v0.7 release**. The consuming application consumes the release per its own consumer-side stage plan.

## Working directory

All work happens in `~/repos/dot/trellis/`.

## Stage list

| # | File | Recommended model | Effort | Blocks |
|---|---|---|---|---|
| T1 | [01-schema-migration.md](./01-schema-migration.md) | **Opus** | ~4d | EVERYTHING |
| T2 | [02-cognito-triggers.md](./02-cognito-triggers.md) | **Opus** | ~4d | T3+, S2+ |
| T3 | [03-tenant-crud.md](./03-tenant-crud.md) | Sonnet | ~6d | T4–T8, S3+ |
| T4 | [04-domain-verification.md](./04-domain-verification.md) | Sonnet | ~3d | T5 partial |
| T5 | [05-idp-crud.md](./05-idp-crud.md) | **Opus** | ~5d | S4, S7 |
| T6 | [06-members-roles.md](./06-members-roles.md) | Sonnet | ~4d | none on critical path |
| T7 | [07-audit-log.md](./07-audit-log.md) | Sonnet | ~3d | T9b, S6 |
| T8 | [08-signin-routing.md](./08-signin-routing.md) | Sonnet | ~2d | publish gate |
| T9b | [09-agent-surface.md](./09-agent-surface.md) | Sonnet/**Opus** mix | ~5d | publish gate, S5 |

Total: ~36 days of agent-time. With parallelism (per the consuming application's orchestration plan), wall-clock ~5 weeks.

## Common patterns

Every stage follows these conventions:

### Branching

`feat/T{N}-{slug}` branches off `feat/identity-federation-v0.7`. PR back to that integration branch. The integration branch lands to `main` after gate G4.

### Schema is single-master

Only T1 modifies `prisma/schema.prisma`. T2+ stages consume the schema as-is. If a stage finds the schema lacks something needed, **do not** start a parallel migration — surface to the T1 owner. Per the consuming application's orchestration plan (concurrency-safety rules).

### Test-first invariant

New code lands with tests in the same PR. CI rejects if coverage falls below the stage's floor (per the consuming application's quality plan).

### Cross-tenant isolation tests

Every tenant-scoped endpoint added in T3–T8 includes the standard cross-tenant denial test (per the consuming application's quality plan — cross-tenant-isolation test fixture).

### Capability checks

Every mutation route in T3+ uses `requireCapability(...)` from the catalog defined in T6. Direct `if (auth.role !== ...)` checks are forbidden — they bypass the audit log.

### Audit logging

After T7 lands, every admin action emits a structured audit event. Stages T3–T6 *write* their actions but use a placeholder `auditEmitter` that becomes real in T7.

> **Cross-stage "S*" references.** Stages below note where they unblock consumer-side stages labelled `S2`, `S3`, … These are the **consuming application's** responsibilities (its client UI, CDK stacks, extension wiring) and are tracked in that application's own plan, not here.

### Pull request shape

- Title: `feat(T{N}): <one line>`
- Body: link to the stage file, list of files added/changed, test coverage report, any deviations from the stage spec (with rationale)
- Reviewer: human at gate, automated via security-reviewer subagent for security-critical stages (T1, T2, T5)

## Common dependencies (every stage)

- Node 22 LTS, npm 10
- Postgres 16 (via Docker Compose)
- DynamoDB Local (via Docker Compose)
- AWS SDK v3 (`@aws-sdk/client-cognito-identity-provider`, `@aws-sdk/client-secrets-manager`, `@aws-sdk/lib-dynamodb`)
- Prisma 5
- vitest, @aws-sdk/client-mock

## Out-of-band setup (Stage 0 prerequisites)

Before T1 starts:

- [ ] AWS Cognito `UserFederation` quota raised to 100 RPS in dev region.
- [ ] AWS Cognito quota of identity-providers-per-pool stays at default 300 (sufficient for MVP).
- [ ] Test Entra tenant available for dev.
- [ ] Postgres + DynamoDB local Docker Compose verified working.

## Reference design

The canonical design lives at [`doc/02-technical/identity-federation/`](../../doc/02-technical/identity-federation/). Each stage file includes a "Design reference" section pointing to the relevant design doc(s).

## Done definition (rolls up to gate G4)

- [ ] All 9 stages have their checklists complete.
- [ ] CI green on the integration branch.
- [ ] Cross-tenant isolation tests pass.
- [ ] Load tests pass per the consuming application's quality plan (load-testing requirement, gate G4).
- [ ] Security-reviewer subagent run on the integration branch — no high-severity findings unaddressed.
- [ ] Trellis README + CLAUDE.md updated to declare v0.7's new capabilities (this is part of T9b).
- [ ] Tag `v0.7.0` published to npm via OIDC workflow.
