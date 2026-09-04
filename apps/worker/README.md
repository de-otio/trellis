# @de-otio/trellis-worker — provider-neutral worker runtime (WS-2)

Long-running container that replaces the 11 per-queue/cron Lambda
deployments on the **Scaleway profile** (AWS keeps EventBridge + Lambda; the
extracted cores in `apps/api/src/lib/workers/*` are shared by both). Polls
the SQS-compatible queues (AWS SQS / LocalStack / Scaleway MNQ-SQS by
endpoint config) with the finding-3 dispatch semantics (ack only on an
explicit returned disposition; ANY throw = no-ack), and runs the six cron
cadences in-process with single-fire via WS-1's
`KvStore.putIfAbsent({ overwriteExpired: true })` (`cron` namespace).

## Env contract (WS-4 `workers` module inputs)

### Core

| Var | Required | Notes |
|---|---|---|
| `STAGE` | yes | queue-name prefix (`{stage}-{queue}`) |
| `AWS_REGION` | yes | SDK region (MNQ accepts any; endpoint decides) |
| `SQS_ENDPOINT` | scaleway/CI | MNQ-SQS or LocalStack endpoint; unset = AWS SQS |
| `AWS_ACCOUNT_ID` | scaleway/CI | queue-URL account segment (`000000000000` on LocalStack/MNQ) |
| `KV_PROVIDER` | scaleway | `postgres` selects the Scaleway profile (PostgresKvStore + the `kv-entries-cleanup` cron); unset/`dynamodb` = AWS-shaped wiring for CI. Selects **both** KV ports — see [`doc/02-technical/operations/kv-provider.md`](../../doc/02-technical/operations/kv-provider.md) |
| `KV_DATABASE_URL` / `DATABASE_URL` | scaleway | shared KV pool for `KV_PROVIDER=postgres` |
| DB credential (one of) | yes | **Fail-closed startup gate.** Resolution mirrors the request path (`env.ts`): `DATABASE_URL` (explicit) → `DB_SECRET_ARN` (AWS Secrets Manager, with rotation self-heal) → decomposed `DB_SECRET_USERNAME`/`DB_SECRET_PASSWORD`/`DB_SECRET_HOST`[`/DB_SECRET_PORT`]`+DB_NAME` (the Scaleway shape — external-secrets injects the password). Missing all three ⇒ `exit(1)`. |
| `MEDIA_BUCKET_NAME` | yes | staging-object cleanup + nightly GC purge |
| `REPORT_PSEUDONYM_SECRET` / `REPORT_PSEUDONYM_SECRET_PARAM` | yes (one) | GDPR tombstone HMAC key. **Startup refuses an empty/unresolvable key (finding 2)** |
| `ACTIVITYPUB_ENABLED` | no | federation-outbox two-mode flag (default off) |
| `WORKER_DISABLED_CRONS` | no | comma-separated cron names to OMIT (e.g. `nightly` to park the scheduled GDPR-deletion job until its identity + email ports are wired). Queue consumers are unaffected. Empty/unset = all crons scheduled. |
| `WORKER_HEALTH_HOST` / `WORKER_HEALTH_PORT` | no | default `127.0.0.1:8081` — **never attach to a public LB/ingress (finding 10)** |
| `WORKER_DRAIN_TIMEOUT_MS` | no | default 25000; keep **below** the orchestrator grace period |

### Media env-var note (resolves the inventory §4.3 drift)

The Skybber `workers-stack.ts` exports **both** `MEDIA_TRANSCRIBE_OUTPUT_KMS_KEY_ID`
and a deliberately-duplicated drifted name `MEDIA_TRANSCRIBE_KMS_KEY_ID`.
Trellis code reads **neither** (they are consumed by Skybber's own media
adapter wiring). **Resolution: the worker container's env contract carries
only `MEDIA_TRANSCRIBE_OUTPUT_KMS_KEY_ID`; the drifted duplicate is dropped
and must not be carried into the WS-4 module.** (Skybber-side removal of the
duplicate is a one-line cleanup at its next deploy; nothing in trellis or
this container depends on it.)

## Per-queue configuration (WS-4 queue-module inputs)

Visibility timeouts must exceed the longest handler runtime (§2 invariant 1);
concurrency caps are compiled defaults in `main.ts` (override story arrives
with WS-4 if needed):

| Queue | Concurrency | Min visibility | Rationale |
|---|---|---|---|
| `delete-account` | 2 | ≥ 180s | Lambda ran with 120s timeout; headroom |
| `media-processing` | 2 | ≥ 360s | transcode up to 300s (Lambda timeout) |
| `media-completion` | 2 | ≥ 120s | provider re-fetch + promote copy |
| `link-check` | 1 | ≥ 60s | fail-closed stub (throw → DLQ → page) |
| `followers-events` | 1 | ≥ 60s | fail-closed stub |
| `federation-outbox` | 1 | ≥ 60s | feature-gated stub |

DLQ behavior is a queue property (MNQ-SQS redrive policy, WS-4 `queues`
module) — the container only guarantees correct ack/no-ack so the receive
count advances.

## Secret blast radius (finding 4) — WS-4 IAM inputs

1. **Per-queue MNQ credential sets**: issue distinct MNQ credentials scoped
   per queue where MNQ IAM allows, so a compromise of the media path cannot
   drain/produce the delete-account or export queues.
2. GDPR/identity capabilities (pseudonym key, identity admin) exist ONLY in
   the delete-account/nightly wiring, as lazy at-use providers — enforced at
   dispatch-table construction (`workers.ts` throws on a media bag carrying
   them).
3. **Process isolation option (§3.1a-3)**: run the media workers as a second
   container so an ffmpeg RCE is confined to media secrets. Preferred if the
   second container's cost is justifiable at launch scale; this image
   supports it by env-scoping which pollers start (WS-4 decision).
4. The health endpoint carries no diagnostics (fixed bodies) and binds
   loopback/pod-internal only; WS-4 must verify it is not internet-routable.

## Media deps injection

Like the Lambda profile, the consuming deployment injects the concrete media
adapters at startup: `setMediaProcessingDeps(...)` (processing) and a
`CompletionDeps` bag (completion). Un-wired media workers FAIL CLOSED
(throw → no-ack → redeliver), never silently drop.

## Build

`docker build -f apps/worker/Dockerfile .` from the repo root — see the
Dockerfile header for the saas-foundation publish precondition (the local-dev
`file:` overrides cannot resolve inside a build context). Compile-only check:
`npm run typecheck` / `npx tsc -p tsconfig.build.json` in `apps/worker`.

Tests live in `apps/api/test/unit/worker-runtime/` (the api vitest lane owns
the installed toolchain); the LocalStack contract lane is opt-in via
`WORKER_SQS_CONTRACT_ENDPOINT`.
