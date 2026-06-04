# Graph backend — hosting & provisioning template

A generic, reusable guide for a **consuming deployment** that embeds the
trellis core and needs to choose and provision a graph backend. Trellis is
not deployed standalone, so hosting is the deployment's concern — this
template gives the decision framework and the credential-wiring pattern;
substitute your own values for the `{appName}` / `{stage}` / `<region>` /
`<aws-profile>` placeholders.

> The trellis core only consumes the abstract surface in
> [`graph-backend-contract.md`](graph-backend-contract.md). Everything here
> is replaceable per deployment. A deployment's *concrete* decision (which
> backend, what it costs, the actual ARNs) belongs in that deployment's own
> repo, not here.

## 1. Choosing a backend

Score candidates on these axes (see the contract for the capability
profile — the workload is shallow, ≤2-hop, so most candidates qualify on
capability and the decision turns on cost + ops):

| Axis | Question |
|---|---|
| Capability fit | Does it cover ≤2-hop traversal + anti-joins? (Almost all do.) |
| New infrastructure | Does it add a service to run, or reuse one you already operate? |
| Hosting cost | Real `$/mo` at idle and at projected scale — **verify against current published prices, not memory** (see the cautionary note below). |
| Ops burden | Patching, backups, HA, on-call — and how much AI-assisted ops offsets it. |
| HA | Single point of failure? Managed multi-AZ vs self-managed. |
| Second-store tax | If it's a *separate* graph DB, you pay dual-write + reconciliation complexity. A backend that reuses your primary store avoids this entirely. |
| Reversibility | How hard to migrate off later? |

Candidate families, generically:

- **Reuse the primary relational DB** (e.g. Postgres recursive CTEs, or an
  in-DB openCypher extension) — zero new infra, no second-store tax. Strong
  default for a shallow workload.
- **Managed graph DB** (cloud-native serverless or vendor-managed) — no ops,
  HA included, at a hosting premium; you still pay the second-store tax.
- **Self-hosted graph DB** — cheapest hosting, you own the ops; AI-assisted
  operations narrow but don't erase the ops cost.

> **Cautionary note (learned the hard way):** a prior version of this
> analysis priced a serverless graph engine at ~1/15th of its real rate and
> recommended it as "cheapest" when it was in fact the most expensive
> option. **Always confirm per-unit pricing against the provider's current
> price list for your region, and sanity-check it against a real bill before
> committing.** Put the hosting/cost analysis in the repo that pays the bill
> so it gets checked against actual spend.

## 2. Credential & connection wiring (managed/self-hosted backends)

When the backend is a separate service reached over the network, wire it
like this (pattern proven for a Bolt-based backend; adapt the key names):

- **One SSM SecureString per stage** holds the full credentials blob as JSON
  at `/{appName}/{stage}/<backend>/credentials`. Use your application-scoped
  SSM prefix — the graph DB is a deployment-owned resource, not a
  trellis-core one.
- The deployment's CDK sets a single env var on the API task —
  `GRAPH_DB_CREDENTIALS_SSM_PARAM = /{appName}/{stage}/<backend>/credentials`
  (the parameter **name**, not the value).
- At startup, `createGraphServiceFromEnv()`
  (`apps/api/src/lib/graph/graph-factory.ts`) calls `ssm:GetParameter` with
  decryption, parses the JSON, and passes the fields straight to the driver.
  The raw blob never enters `process.env`, so child processes / core dumps /
  `env`-in-shell cannot leak it.
- **IAM:** grant the API task role `ssm:GetParameter` on exactly
  `arn:aws:ssm:<region>:<account>:parameter/{appName}/{stage}/<backend>/credentials`
  (and KMS decrypt if a CMK encrypts it). Nothing broader.
- **Rotation:** update the SSM parameter, then force a new deployment
  (`aws ecs update-service --cluster {appName}-<stage> --force-new-deployment
  --profile <aws-profile> --region <region>`) so tasks re-read it.

A **Postgres-native** backend skips all of the above — it reuses the
existing database connection; there is no separate credential to provision.

## 3. Non-prod environments

- Use the cheapest viable tier for dev/CI/E2E; it need not match prod's
  engine class, only its query semantics.
- Env-scope every physical name and SSM path by `{stage}` so dev and prod
  never collide.
- For managed backends with a free tier, a separate non-prod account/alias
  is legitimate; store its credentials under `/{appName}/dev/*`, prod under
  `/{appName}/prod/*`.
- If the backend is a separate, always-on service, give dev a **stop-when-idle**
  story (or tear-down/recreate) so an idle dev instance doesn't accrue a
  24/7 floor cost.

## 4. Provisioning checklist (per stage)

1. Provision the backend instance in `<region>`.
2. Store credentials in SSM at `/{appName}/<stage>/<backend>/credentials`.
3. Point the API task's `GRAPH_DB_CREDENTIALS_SSM_PARAM` at that name; grant
   the scoped IAM read.
4. Deploy; confirm `healthCheck()` passes via the `/health` endpoint.
5. Add any CI secrets the E2E suite needs to the deployment's repo.
