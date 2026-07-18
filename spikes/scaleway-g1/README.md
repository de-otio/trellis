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

- **Presigned POST-policy support is empirically unknown** until `make
  test` runs against real infrastructure — this is *the* question
  `check-s3-presigned.ts` exists to answer; the provider/API docs consulted
  during scaffolding didn't state either way whether Scaleway Object
  Storage implements S3's POST-policy signing scheme (as opposed to
  presigned PUT/GET, which are standard SigV4 request signing and expected
  to work).
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

## Findings

Fill in after running `make test` against a real Scaleway project. One row
per G1 question; `Grade`/notes are for the human evaluating the spike, not
something the harness computes.

| Question | Result | Evidence | Notes |
|---|---|---|---|
| Presigned **POST**-policy upload support (Object Storage) | ⬜ pending | `check-s3-presigned.ts` output | Structural finding either way — if NO, confirm presigned PUT (below) is an acceptable substitute for every upload call site before treating this as a non-blocker |
| Presigned **PUT** upload (fallback path) | ⬜ pending | `check-s3-presigned.ts` output | |
| Presigned **GET** download | ⬜ pending | `check-s3-presigned.ts` output | |
| SQS compat — standard queue send/receive/delete | ⬜ pending | `check-sqs.ts` output | |
| SQS compat — FIFO queue per-group ordering | ⬜ pending | `check-sqs.ts` output | |
| SQS compat — FIFO content-based dedup | ⬜ pending | `check-sqs.ts` output | |
| PG17 + PostGIS (real spatial query, not just extension presence) | ⬜ pending | `check-postgres.ts` output | |
| PG17 + pg_trgm (Trellis uses it) | ⬜ pending | `check-postgres.ts` output | |
| Serverless Containers cold-start latency (first request) | ⬜ pending | `check-container.ts` output | |
| Serverless Containers warm latency | ⬜ pending | `check-container.ts` output | |
| Scale-to-zero actually scales to zero (`min_scale=0` works) | ⬜ pending | `check-container.ts` — indirect (latency delta is the signal) | |
| Agent-loop quality grade — AWS-familiar vs. Scaleway-provider first-pass quality | ⬜ pending — **human-filled, not harness-computed** | this spike's own build process | Per the plan's risk R6 (dot-notes `doc/topics/trellis-scaleway-portability/05-ai-agent-leverage-on-scaleway.md`, a separate repo from this one) — grade the agent-loop experience of building *this scaffold itself*: doc lookups needed, guessing vs. verified, correction cycles |

**Overall G1 verdict:** ⬜ pending (fill in once every row above is green
or the abort-criteria trigger fires on one of them).
