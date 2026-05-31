# Aura Bootstrap Runbook

One-time manual steps the **consuming deployment** follows to provision AuraDB
instances and wire their credentials into AWS so its CDK deploys succeed.
Trellis is not deployed standalone — this runbook describes the procedure for
the application that embeds the trellis core. Paths, profiles, and account IDs
below are illustrative; substitute the deployment's own values.

## Layout (consolidated SSM SecureString)

Per stage, a **single** SSM SecureString parameter holds the full AuraDB credentials blob as JSON. The deployment's CDK sets `GRAPH_DB_CREDENTIALS_SSM_PARAM` on the ECS task environment to the parameter name (not the value). At startup, `createGraphServiceFromEnv()` in the trellis core (`apps/api/src/lib/graph/graph-factory.ts`) calls `ssm:GetParameter` with decryption, parses the JSON, and passes `NEO4J_URI` / `NEO4J_USERNAME` / `NEO4J_PASSWORD` directly to the Neo4j driver — the raw JSON never enters `process.env`, so child processes, core dumps, and `env`-in-shell-exec cannot leak it.

For local dev and integration tests the factory falls back to reading `GRAPH_DB_URI` / `GRAPH_DB_USER` / `GRAPH_DB_PASSWORD` directly from the environment (no SSM call), so docker-compose / integration tests stay fully offline.

**SSM path convention:** `/{appName}/{stage}/neo4j/auradb/credentials`

Note: the graph credentials live under the deployment's own application-scoped SSM prefix (the Aura instance is a deployment-owned resource, not a trellis-core one).

**Expected JSON shape** (matches what AuraDB's credentials download file provides):

```json
{
  "NEO4J_URI": "neo4j+s://xxxxxxxx.databases.neo4j.io",
  "NEO4J_USERNAME": "neo4j",
  "NEO4J_PASSWORD": "...",
  "NEO4J_DATABASE": "neo4j",
  "AURA_INSTANCEID": "xxxxxxxx",
  "AURA_INSTANCENAME": "..."
}
```

Only `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` are required; additional fields are preserved but not used at runtime.

---

## Per-environment bootstrap

Repeat for each stage (`dev`, `prod`). Dev uses **AuraDB Free** on a separate Neo4j account; prod uses **AuraDB Professional** on the primary account.

### 1. Provision Aura instance

- https://console.neo4j.io → log in with the account for this stage (separate account for dev Free)
- Create instance:
  - **Dev:** "Free" tier, Neo4j 5, region `Frankfurt (europe-west3)` — closest to eu-central-1
  - **Prod:** "Professional" tier, 1 GB, Neo4j 5, region `Frankfurt`
- Download the credentials file (shown once). It contains the JSON fields above.

### 2. Store credentials JSON in SSM SecureString

**Option A — using the downloaded credentials file directly.** The file is in `.env` format; you'll need to convert to JSON first (or use a one-liner):

```bash
# Convert .env-style credentials file to JSON, write to SSM, clean up.
python3 -c "
import sys, json
vals = {}
for line in open(sys.argv[1]):
  line = line.strip()
  if not line or line.startswith('#'): continue
  k, _, v = line.partition('=')
  vals[k] = v
print(json.dumps(vals))
" ~/Downloads/Neo4j-XXXX-Created-YYYY-MM-DD.txt > /tmp/neo4j-creds.json
chmod 600 /tmp/neo4j-creds.json

aws ssm put-parameter \
  --name "/{appName}/<STAGE>/neo4j/auradb/credentials" \
  --type SecureString \
  --value "file:///tmp/neo4j-creds.json" \
  --overwrite \
  --profile <aws-profile> \
  --region <region>

rm /tmp/neo4j-creds.json
```

**Option B — paste JSON directly.** Same effect, manually craft the JSON:

```bash
aws ssm put-parameter \
  --name "/{appName}/<STAGE>/neo4j/auradb/credentials" \
  --type SecureString \
  --value '{"NEO4J_URI":"neo4j+s://xxxx.databases.neo4j.io","NEO4J_USERNAME":"neo4j","NEO4J_PASSWORD":"..."}' \
  --overwrite \
  --profile <aws-profile> \
  --region <region>
```

### 3. Wire the ECS task and deploy CDK

In the deployment's API stack (e.g. `infra/lib/stacks/api-stack.ts`), the API container needs:

- **Environment variable:** `GRAPH_DB_CREDENTIALS_SSM_PARAM = /{appName}/{stage}/neo4j/auradb/credentials`
- **Task role policy:**
  - `ssm:GetParameter` on `arn:aws:ssm:{region}:{account}:parameter/{appName}/{stage}/neo4j/auradb/credentials`
  - `kms:Decrypt` on the KMS key used to encrypt the SecureString (the default `alias/aws/ssm` key, or a CMK if one is configured)

Do **not** use `ecs.Secret.fromSsmParameter` — that would inject the raw JSON into `process.env`, defeating the in-memory-only credential handling in `createGraphServiceFromEnv()`. Pass only the parameter **name** through `environment:`, not the value.

```bash
# From the consuming deployment's repo:
npm run infra:deploy -- --context stage=<STAGE>   # or: npx cdk deploy --context stage=<STAGE>
```

### 4. Verify

After the ECS service stabilizes:

```bash
./scripts/ops/logs.sh api 5
```

Expect a successful graph-service startup log entry (bolt connection established to Aura).

---

## CI secrets (GitHub Actions)

For the E2E workflow's `wake-neo4j` gate and fixture cleanup, add these **repository secrets** to the consuming deployment's repo (Settings → Secrets and variables → Actions → New repository secret):

- `DEV_NEO4J_URI` — dev Aura bolt URI (same as `NEO4J_URI` in the downloaded file)
- `DEV_NEO4J_USERNAME` — dev Aura username (almost always `neo4j`; copy from the credentials file in case AuraDB ever changes this)
- `DEV_NEO4J_PASSWORD` — dev Aura password

The workflow's `wake-neo4j` job passes these to `scripts/ci/wake-aura.mjs`. The script accepts either `NEO4J_USER` or `NEO4J_USERNAME` as the username env var.

### When `wake-aura.mjs` is not enough

`wake-aura.mjs` works for *shallow* pauses — instances that paused recently (a few days) and still have a live DNS record at the bolt host. In that state, the first bolt connection triggers a resume (~30–60s) and subsequent attempts succeed.

For *deep* pauses (observed after ~13 days of idle on Aura Free, 2026-04-25), Neo4j **withdraws the bolt host's DNS record entirely**. `dig +short <hash>.databases.neo4j.io` returns empty, and any bolt-driver client — including `wake-aura.mjs` — fails routing-table discovery before it can send a query. The script's retry loop cannot recover from this.

Symptom: `Could not perform discovery. No routing servers available. Known routing table: RoutingTable[database=default database, expirationTime=0, ...]` for every retry, plus a DNS lookup of the bolt host returning nothing.

Resolution: log into the Neo4j Aura console, **manually resume the instance**. DNS comes back within seconds and bolt connections succeed normally. After that the SSM credentials still work — no need to re-store them.

This means CI cannot self-recover from a deep pause. If `wake-neo4j` keeps failing on a CI run, manual console intervention is required before retrying.

---

## Password rotation (later, low priority)

1. Log in to Neo4j console, rotate the password.
2. Re-run step 2 above with the new credentials file (produces updated JSON).
3. Force ECS task restart so new credentials take effect:
   ```bash
   aws ecs update-service \
     --cluster {appName}-<STAGE> \
     --service api \
     --force-new-deployment \
     --profile <aws-profile> \
     --region <region>
   ```
4. Update GitHub Actions `DEV_NEO4J_PASSWORD` repo secret if rotating dev.

---

## Destroy (if ever needed)

```bash
# Delete Aura instance via Neo4j console first.

aws ssm delete-parameter \
  --name "/{appName}/<STAGE>/neo4j/auradb/credentials" \
  --profile <aws-profile> \
  --region <region>
```

---

## Order of operations for first deploy

1. Provision **dev** Aura Free; store credentials in SSM at `/{appName}/dev/neo4j/auradb/credentials`.
2. Provision **prod** Aura Professional; store credentials at `/{appName}/prod/neo4j/auradb/credentials`.
3. CDK deploy dev → verify API health.
4. CDK deploy prod.
5. Add GitHub Actions secrets for dev CI.
6. Trigger an E2E run to verify the `wake-neo4j` gate works end-to-end.
