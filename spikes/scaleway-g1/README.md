# G1 feasibility spike — AWS → Scaleway portability

This is the cheapest falsification test for the planned AWS-CDK →
Scaleway-OpenTofu migration. It stands up a small representative slice of
the target stack on Scaleway and answers the open questions gating **G1**
in the migration plan (dot-notes:
`doc/topics/trellis-scaleway-portability/big-bang-migration/01-scope-preconditions-gates.md`).

**Abort-criteria reminder:** if this spike reveals a *structural*
incompatibility (not a config tweak — e.g. Queues semantics that would
break the media pipeline, or presigned uploads that can't be made to work
at all), that is grounds to stop the migration program cheaply, per the
plan's decided abort criteria. Don't push through a structural finding by
brute force; report it and let G1 do its job.

Every resource and argument in `infra/` was verified against the live
OpenTofu Registry (provider `scaleway/scaleway` docs via `get-resource-docs`,
2026-07-18) before being written — see the comment block at the top of each
`.tf` file for the specific doc citations. `harness/` uses **plain AWS SDK
v3 clients and node-postgres, not Trellis code** — it tests Scaleway's API
compatibility surface, not our ports.

## Prerequisites

Console steps assumed already done (per the plan, these precede the spike):

- Scaleway Organization created.
- A Scaleway Project created for this spike (dev-tier is fine — this is
  disposable infrastructure).
- An IAM Application + Policy + API key pair scoped to that Project, with
  permissions to manage RDB, Object Storage, MNQ/Queues, and Serverless
  Containers.

Export before running anything:

```bash
export SCW_ACCESS_KEY=...
export SCW_SECRET_KEY=...
export SCW_DEFAULT_PROJECT_ID=...
export SCW_DEFAULT_ORGANIZATION_ID=...
```

`SCW_ACCESS_KEY` / `SCW_SECRET_KEY` are used twice: once by the OpenTofu
`scaleway` provider (implicitly, via env), and again directly by
`harness/check-s3-presigned.ts` (Object Storage's S3-compatible API is
authenticated with the same project-scoped IAM key pair — Scaleway doesn't
mint per-bucket S3 credentials). The SQS-side harness check
(`check-sqs.ts`) instead uses the MNQ-specific credentials minted by
`infra/queues.tf` (`scaleway_mnq_sqs_credentials`), read from `tofu output`,
not from these env vars.

Local tooling: OpenTofu >= 1.9 (`tofu version`; developed against 1.12.4),
Node >= 24, `make`.

## Run order

```bash
make init      # tofu init
make plan      # tofu plan — review before apply
make apply     # tofu apply — provisions everything below
make outputs   # writes infra/outputs.json (gitignored — contains secrets)
make test      # runs the full harness (npm install + run-all.ts)
make destroy   # tear down when done
```

`make clean` removes `.terraform/`, local state, `outputs.json`, and
`harness/node_modules` without talking to Scaleway.

You can also run a single harness check directly once `make apply && make
outputs` have run:

```bash
cd harness
G1_OUTPUTS_JSON=../infra/outputs.json npx tsx check-s3-presigned.ts
```

## What gets provisioned

All resources are named `spike-g1-*` and live in `fr-par` / `fr-par-1`.

| Resource | Purpose | Cost shape (order of magnitude — **not** verified against a live pricing page, see note below) |
|---|---|---|
| `scaleway_rdb_instance` (`db-play2-pico`, PostgreSQL-17, no HA, backups disabled) + `scaleway_rdb_database` + `scaleway_rdb_user` | PG17 + PostGIS/pg_trgm feasibility | Smallest managed-DB tier; publicly known to be roughly low-single-digit cents/hour |
| `scaleway_object_bucket` + `scaleway_object_bucket_acl` (private) | Presigned-upload feasibility | A handful of KB uploaded/downloaded; storage + request cost effectively $0 for a spike run |
| `scaleway_mnq_sqs` + `scaleway_mnq_sqs_credentials` + 2× `scaleway_mnq_sqs_queue` (standard + `.fifo`) | Queues (SQS) compat + FIFO ordering/dedup | Dozens of messages; well within Scaleway Queues' documented free tier |
| `scaleway_container_namespace` + `scaleway_container` (nginx, `min_scale=0`, `max_scale=1`, 128MB/70m vCPU) | Cold-start / scale-to-zero feasibility | Scale-to-zero means ~$0 while idle; a handful of warm requests during `make test` |

**Cost-estimate caveat:** I attempted to pull exact current per-unit prices
from `scaleway.com/en/pricing/` and the product-specific pricing pages
during this spike's build, but those pages are JS-rendered SPAs that
returned 404/empty content to a plain fetch. The figures above are
order-of-magnitude, from public knowledge, not a verified quote. **Confirm
actual pricing in the Scaleway console before leaving this stack up for
more than a test run** — for a spike lifecycle of init→apply→test→destroy
within an hour or two, total cost should be well under a euro regardless.

## Validation performed (this scaffold, no live Scaleway account yet)

Since Scaleway credentials didn't exist yet at scaffold-build time, `tofu
init`/`validate` were run against the **public OpenTofu provider registry
only** (no Scaleway API calls, no plan against real infrastructure):

- `tofu fmt -check` — clean.
- `tofu init -backend=false` — succeeded; installed `scaleway/scaleway`
  v2.79.0 and `hashicorp/random` v3.9.0 (both match the pins in
  `infra/versions.tf`).
- `tofu validate` — **Success! The configuration is valid.**
- `npx tsc --noEmit` in `harness/` — clean, no type errors.

Not validated (needs real credentials): `tofu plan`/`apply` against a live
Scaleway project, and therefore none of the harness checks have actually
run against real infrastructure yet. Run the full `make` sequence once the
project/API key from the console step above exist.

## Doc-vs-prompt discrepancies found

- **`scaleway_rdb_instance` / `scaleway_rdb_user` password handling.** The
  resource docs' own "Security Best Practice" note recommends the
  write-only `password_wo` argument (needs OpenTofu/Terraform **>= 1.11**)
  over the plain `password` argument, specifically to keep the password out
  of state. This spike pins `required_version >= 1.9` (per this task's
  brief) and uses `password` + `random_password`, which **does** write the
  password into local state — acceptable for a throwaway, gitignored-state
  spike, but flag this before reusing `database.tf` as a template for the
  real WS-0/WS-1 config, where `password_wo` should be used instead.
- No other discrepancies — every other resource/argument used matches its
  registry doc directly (see per-file comments for citations).

## Open questions the docs couldn't resolve

- ~~**Presigned POST-policy support is empirically unknown**~~ **RESOLVED
  2026-07-19: YES.** `check-s3-presigned.ts` ran against live Object Storage
  and a presigned POST-policy upload returned **HTTP 204** — Scaleway
  implements S3's POST-policy signing scheme, not just presigned PUT/GET. No
  PUT fallback is required; every upload call site can keep using POST.
- **True repeat cold-start latency** (container scaled back to zero *after*
  serving traffic, then hit again) isn't something `check-container.ts`
  measures automatically — it only captures "first request since apply"
  vs. "warm" latency in one run. Getting a second genuine cold-start sample
  means rerunning the check by hand after Scaleway's idle-scale-down
  window elapses (not documented as a fixed number in the resource docs
  consulted).
- **Exact per-unit pricing** for `db-play2-pico`, Serverless Containers
  vCPU/memory-seconds, and Object Storage requests — see the cost-estimate
  caveat above; the pricing pages didn't respond to a plain fetch during
  scaffolding.

## Live run findings (config corrections needed at apply/test time)

The scaffold validated offline but hit **four issues only surfaced by a live
apply/test** — each a real WS-0 lesson, each fixed in a single cycle by
grounding against the provider docs (`get-resource-docs`), none requiring a
guess-and-retry loop:

1. **`db-play2-pico` mandates block storage.** The default `lssd` (local)
   volume is rejected for the `play2` node line ("Volume type can't be a
   local volume for this node_type"). Fixed with `volume_type = "sbs_5k"` +
   `volume_size_in_gb = 10` (see `infra/database.tf`). **WS-0:** set
   volume_type/size explicitly for any play2/pro2 node type.
2. **A separate `rdb_user` needs an explicit `rdb_privilege`.** `is_admin =
   true` alone does **not** grant access to a database created via
   `scaleway_rdb_database` — the harness hit "permission denied for database
   spike_g1_db". Fixed by adding `scaleway_rdb_privilege` (`permission =
   "all"`). **WS-0:** grant a privilege per (user, database) pair.
3. **Outputs are committed to state only on a *successful* apply.** The
   partial applies that failed on the Object Storage 403 never wrote outputs;
   `bucket_region` was absent from `tofu output` until a clean no-op apply
   ran. **WS-0/CI:** don't consume `tofu output` after a failed apply.
4. **MNQ doesn't echo `MessageGroupId` on receive.** FIFO ordering + dedup
   work, but the SQS-compatible ReceiveMessage response omits the group
   attribute AWS SQS returns — so assert FIFO ordering on *delivery order*,
   not on the echoed attribute (harness `check-sqs.ts` adjusted).

Plus one non-code item: the spike API key's IAM policy initially lacked
Object Storage rights (403 on `CreateBucket`) — added `ObjectStorageFullAccess`
in the console. MNQ + Containers + RDB perms were already present.

The `password` vs `password_wo` discrepancy (above) still stands for WS-0.

## Findings

Live run: **De Otio org (temporary), `skybber-dev` project, `fr-par`,
2026-07-19.** All four harness checks PASS.

| Question | Result | Evidence |
|---|---|---|
| Presigned **POST**-policy upload (Object Storage) | ✅ **YES** | HTTP 204 on POST-policy upload — native support, no PUT fallback needed |
| Presigned **PUT** upload (fallback path) | ✅ YES | HTTP 200 |
| Presigned **GET** download | ✅ YES | HTTP 200, downloaded body matches upload |
| SQS — standard queue send/receive/delete | ✅ PASS | sent 1 / received 1 / body match |
| SQS — FIFO per-group ordering | ✅ PASS | A1 delivered before A2 (delivery order); asserted on delivery order (MNQ omits `MessageGroupId` attr) |
| SQS — FIFO content-based dedup | ✅ PASS | duplicate A1 deduped → delivered exactly once |
| PG17 + PostGIS (real spatial query) | ✅ PASS | PostgreSQL **17.10**, PostGIS **3.5.3**; `ST_DWithin` 150km=true / 50km=false |
| PG17 + pg_trgm | ✅ PASS | `similarity('trellis','trelis')` = 0.667 |
| Serverless Containers cold-start (first request) | ✅ 182ms | HTTP 200 first traffic since apply |
| Serverless Containers warm latency | ✅ ~124ms avg | 46–276ms across 3 warm requests |
| Scale-to-zero (`min_scale=0`) | ✅ applied | container served after `min_scale=0`; true repeat-cold-start still needs a post-idle rerun |
| Agent-loop quality grade (R6) — **human-filled** | 🟩 provisional: **good** (Richard to confirm) | 4 live corrections + 1 perms gap, each resolved in **one** doc-grounded cycle (`get-resource-docs`), no guess-loops; the only genuinely doc-unanswerable question (presigned-POST) is exactly what the spike existed to settle |

**Overall G1 verdict: ✅ PASS — proceed to G2.** Every functional question is
green on live Scaleway infra. No structural incompatibility surfaced; the
decided abort criterion (Queues semantics that would break the media
pipeline) did **not** trigger — FIFO ordering and content-based dedup both
work. The provider-coverage re-check (2026-07-19) confirms the pinned
`scaleway/scaleway` v2.79.0 is current. The four config corrections above are
WS-0 inputs, not blockers. Residual non-feasibility caveats: exact per-unit
pricing still unverified (see cost caveat), and a true repeat-cold-start
latency sample needs a post-idle rerun.
