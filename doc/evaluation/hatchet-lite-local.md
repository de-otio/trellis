# Running the local Hatchet engine (plan 030, Phase 0.1)

Lanes B and C develop against a local engine so neither is blocked on Lane A
building the real cluster. This is what that engine is, how to bring it up, and
the two traps that cost time on 2026-08-23.

**⚠ Evaluation scaffolding.** Plan 030 decides *run the evaluation*, not *adopt
Hatchet*. If the kill criteria fire, this file and `docker-compose.hatchet.yml`
go with the rest of it.

## Bring-up

```bash
docker compose -f docker-compose.hatchet.yml up -d
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8888/api/ready   # 200
```

Dashboard on <http://localhost:8888>, gRPC on `localhost:7077`. Verified ready
on the first poll — if it is not ready within a few seconds, read the logs
rather than waiting.

## ⚠ Trap 1 — pin a CURRENT version, and beware the tag listing

**The image is pinned to `v0.104.7`. Do not "simplify" it to `:latest`, and do
not trust a quick tag listing to tell you what the newest version is.**

GHCR's `/tags/list` **paginates at 100**. Asking for the tags and sorting the
result looks authoritative and is not:

```bash
# WRONG — returns the first 100 tags. Newest looks like v0.34.4.
curl -H "Authorization: Bearer $TOKEN" \
  https://ghcr.io/v2/hatchet-dev/hatchet/hatchet-lite/tags/list | jq -r '.tags[]'

# RIGHT — follow the Link header. 3427 tags. Newest is v0.104.7.
```

That is a two-year version gap, and it produced a real failure that looked like
a code problem: the SDK's worker registration died with

```
HatchetError: Could not register workflow:
  /v1.AdminService/PutWorkflow UNIMPLEMENTED: unknown service v1.AdminService
```

The v1 SDK (`@hatchet-dev/typescript-sdk@1.28.2`) requires a v1-capable engine.
`v0.34.4` predates it and does not serve `v1.AdminService` at all.

This is plan 028 §0's failure shape again — *an incomplete result read as a
complete one*. A truncated page is not "the list", exactly as an empty `scw`
response is not "no results".

## ⚠ Trap 2 — the msgqueue, and a correction to a correction

**Plan 030 task 0.1 says "Postgres msgqueue". That is CORRECT at v0.104.7** —
verified by grepping the engine logs for `amqp|rabbit`: **zero matches**.

It was recorded here earlier that the plan was wrong and hatchet-lite embeds
RabbitMQ. That claim was true *of v0.34.4* and false of the version we run. The
old line is not carried forward because it would send the next reader chasing a
broker that is not there. What is worth keeping is what v0.34.4 did when its
broker credentials were unset, because the *shape* of the failure recurs:

> the container started, published both ports, reported **`Up`** in
> `docker compose ps`, and then looped forever on `PLAIN login refused` while
> `/api/ready` never answered. It never exited, so every check short of reading
> the logs said the engine was fine.

`Up` is not `ready`. Check the endpoint, not the container state.

## ⚠ `/health` is NOT a health check — do not probe it

Verified on **v0.104.7**: the engine serves the dashboard SPA from a
**catch-all** route. `/health` and `/definitely-not-a-route-xyz` return byte-for
byte the same thing — `200`, `text/html`, the SPA. A Kubernetes readiness or
liveness probe pointed at `/health` passes unconditionally, including while the
engine is wedged.

| Path | Status | Content-Type | Verdict |
|---|---|---|---|
| `/api/ready` | 200 | *(empty)* | **the real readiness check** |
| `/api/live` | 200 | *(empty)* | **the real liveness check** |
| `/api/v1/meta` | 200 | `application/json` | useful as a deeper probe |
| `/health` | 200 | `text/html` | **the catch-all — meaningless as a probe** |
| any nonsense path | 200 | `text/html` | identical to `/health`, which is the proof |

**Lane A: use `/api/ready` and `/api/live`.** This is the estate's recurring
failure — a check that passes because it cannot fail.

## Getting an API token — never printed, never committed

`hatchet-lite` ships a default tenant (`707d0855-80ab-4e1f-a156-f1c4546cbf52`).
Mint straight into a file outside every repo; never let the value reach a
terminal, a config file in the tree, or a commit:

```bash
mkdir -p ~/.hatchet-local && chmod 700 ~/.hatchet-local
docker compose -f docker-compose.hatchet.yml exec -T hatchet-lite \
  /hatchet-admin token create --config /config \
  --tenant-id 707d0855-80ab-4e1f-a156-f1c4546cbf52 \
  > ~/.hatchet-local/token.raw
chmod 600 ~/.hatchet-local/token.raw
```

It is a JWT and it is a credential. Local-only and low-stakes, but the habit is
the point. The SDK reads it from the environment:

```bash
export HATCHET_CLIENT_TOKEN="$(cat ~/.hatchet-local/token.raw)"
export HATCHET_CLIENT_TLS_STRATEGY=none   # the local engine is SERVER_GRPC_INSECURE
```

**The token is bound to the engine's config volume.** `down -v` drops it, and
the old token then fails against the new instance. Re-mint after any `down -v`.

## Verified end to end (2026-08-23)

With `HATCHET_ENABLED=true` and the token exported, the worker in
`apps/worker/src/hatchet.ts` registers, connects, runs a task, and drains:

```
INFO  hatchet evaluation host started { worker: 'trellis-eval-worker', slots: 1 }
[INFO/ActionListener] Connection established using LISTEN_STRATEGY_V2
TRIGGER input:  {"message":"round-trip-4339"}
[INFO/Worker] Task run starting...   trellis-echo/…
[INFO/Worker] Task run completed     trellis-echo/…
RESULT output:  {"trellis-echo":{"echoed":"round-trip-4339","workerReceivedAt":"…"}}
ROUND TRIP OK
[INFO/Worker] Gracefully exiting hatchet worker, running tasks will attempt to finish...
```

Note the **result envelope**: `runWorkflow(...).result()` returns output **keyed
by task name**, not the bare task output. A caller reading `output.echoed`
gets `undefined` and no error.

## Teardown

```bash
docker compose -f docker-compose.hatchet.yml down -v   # -v also drops volumes AND the token
```
