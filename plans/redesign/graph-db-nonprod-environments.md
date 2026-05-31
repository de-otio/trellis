# Non-Prod Graph DB Strategy

**Date:** 2026-04-12 (final)
**Supersedes:** earlier drafts that proposed Fargate+EFS and EC2+Docker approaches.

> **Scope:** the graph DB *hosting* and CI/E2E environment choices below are
> deployment concerns owned by the consuming application (Trellis is not deployed
> standalone). The trellis core only sees the bolt URI + credentials via env vars
> at runtime. Account aliases, hostnames, AWS profiles, and SSM prefixes are
> illustrative; substitute the deployment's own values.

## Final Design

| Environment | Graph DB | Cost |
|---|---|---|
| Local dev | Docker `neo4j:5-community` (already wired) | $0 |
| Unit + integration tests | Docker Neo4j (already wired) | $0 |
| Dev + CI E2E | **AuraDB Free** on a separate Neo4j account | **$0** |
| Staging (if added later) | AuraDB Free, same or another account | $0 |
| Prod | AuraDB Professional (primary Neo4j account) | $65/mo |
| **Total** | | **$65/mo** |

No CDK stack required for any non-prod graph DB.

## Why separate Aura account for dev

- AuraDB Free = 1 instance per Neo4j account. Creating a second account (e.g. a `dev@<deployment-domain>` alias) for non-prod environments is legitimate; prod uses a separate paid account.
- Prod dialect, versioning, and tooling match dev exactly — no surprises on promotion.
- Auto-pauses after 3 days of inactivity. First query wakes it up (~30–60s). Acceptable for CI cadence; matches the cold-start cost we were planning for auto-shutdown EC2 anyway.
- Limits: 200k nodes / 400k relationships / 1 GB. Trivially exceeds dev/E2E data volumes if fixtures are pruned between runs.

## Constraints to verify before committing

1. **Aura ToS** — skim to confirm multi-account-for-environments is permitted (it's the standard pattern, should be fine).
2. **Aura Frankfurt region** — ensure eu-central-1 is available for Free tier; matches the deployment's prod region.
3. **VPC egress for dev API → Aura** — dev ECS needs NAT Gateway or IPv4 egress to reach `*.databases.neo4j.io:7687` over TLS. Almost certainly exists already for other outbound traffic; verify.
4. **Free tier connection/rate limits** — Aura Free caps concurrent connections (historically ~50). Well above CI single-run E2E needs.

## Configuration wiring

### Secrets Manager / SSM layout

> **Superseded by [`graph-db-bootstrap-runbook.md`](./graph-db-bootstrap-runbook.md).** The earlier two-parameter scheme (`neo4j-bolt-uri` + `neo4j-password-secret-arn`) was consolidated into a single SSM SecureString JSON blob at `/{appName}/{stage}/neo4j/auradb/credentials` to match what `createGraphServiceFromEnv()` actually reads. See the runbook for the canonical layout, IAM, and rotation procedure.

## E2E Test Data Hygiene

Prefix-based pattern (unchanged from earlier draft):

- Each E2E run sets `E2E_RUN_ID` (GitHub `run_id`)
- Fixtures create nodes with properties like `testRunId: $RUN_ID` or ID prefixes `e2e_${RUN_ID}_*`
- Cleanup at end of suite: `MATCH (n {testRunId: $runId}) DETACH DELETE n`
- Concurrent CI runs don't collide
- Periodic full wipe via CI cron if stale test data accumulates

Aura Free's cap (200k nodes) is forgiving enough that accumulating a run's worth of fixtures between cleanup jobs won't be a problem.

## GitHub Actions E2E sketch

```yaml
name: E2E
on:
  pull_request:
  workflow_dispatch:

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::...:role/github-e2e-role
          aws-region: eu-central-1

      - name: Wake dev Aura (first query resumes if paused)
        env:
          NEO4J_URI: ${{ secrets.DEV_NEO4J_URI }}
          NEO4J_PASSWORD: ${{ secrets.DEV_NEO4J_PASSWORD }}
        run: node scripts/wake-aura.mjs  # single RETURN 1 query, retries on cold-start timeout

      - name: Run E2E against deployed dev API
        env:
          E2E_RUN_ID: ${{ github.run_id }}
          E2E_API_URL: https://dev.api.example.com
        run: npm run test:e2e

      - name: Cleanup graph fixtures
        if: always()
        env:
          NEO4J_URI: ${{ secrets.DEV_NEO4J_URI }}
          NEO4J_PASSWORD: ${{ secrets.DEV_NEO4J_PASSWORD }}
        run: node scripts/cleanup-graph.mjs $E2E_RUN_ID
```

`wake-aura.mjs` and `cleanup-graph.mjs` are tiny scripts using the `neo4j-driver` npm package — connect directly to Aura from the runner for housekeeping. The API itself always connects via its ECS env; the CI scripts are separate so fixture cleanup doesn't require an admin endpoint on the API.

## Security

- Aura endpoints use `bolt+s://` (TLS) — traffic is encrypted on the public internet.
- Passwords stored in AWS Secrets Manager for API access and in GitHub Actions repo secrets for CI housekeeping.
- No public dev Neo4j exposed by us — only Aura's managed endpoint, authenticated by Aura's bolt password.
- Rotate dev password periodically; rotation is manual in Aura console (minor friction, acceptable for dev).

## Alternatives Considered (and Rejected)

- **Neptune Serverless for prod:** $130/mo floor, no pause, Cypher dialect subset. Rejected.
- **ECS Fargate + EFS for dev:** ~$10/mo, complex CDK, NFS performance concerns, no parity benefit. Rejected.
- **EC2 + Docker + auto-shutdown for dev:** ~$3.40/mo effective, custom CDK + EventBridge scheduler + userdata. Rejected — Aura Free is free and zero-ops.

## Next Steps

1. Create a second Neo4j account (e.g. a `dev@<deployment-domain>` alias) and provision an Aura Free instance in Frankfurt.
2. Store dev bolt URI + password in SSM + Secrets Manager under `/{appName}/dev/*`.
3. Sign up for AuraDB Professional on the primary account; provision prod instance.
4. Store prod bolt URI + password in SSM + Secrets Manager under `/{appName}/prod/*`.
5. Update CDK `api-stack.ts` (or equivalent) to inject the secrets + env vars into the ECS task.
6. Verify latency from dev ECS Fargate to Aura (eu-central-1 → Aura Frankfurt should be < 5ms).
7. Add `wake-aura.mjs` and `cleanup-graph.mjs` scripts for CI.
8. Update GitHub Actions E2E workflow.
9. (Optional) Delete `graph-db-self-hosted-neo4j/` subfolder since it's no longer relevant — keep the parent `graph-db-hosting-decision.md` and `graph-db-managed-analysis.md` as historical record of analysis.
