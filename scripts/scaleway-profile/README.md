# Scaleway-profile CI stack (WS-5)

`docker-compose.scaleway.yml` (repo root) boots the Scaleway-shaped
substitute infrastructure for local/CI e2e per 02-trellis-redesign §6:

| Capability | AWS-shaped CI (docker-compose.yml) | Scaleway profile (this stack) |
|---|---|---|
| App DB + KV | postgis + dynamodb-local | postgis only (`KV_PROVIDER=postgres`, kv_entries) |
| Identity | (none — Cognito unmocked) | Keycloak 26.6.3 + p2 magic-link JAR, digest-pinned |
| Email sink | LocalStack SES | Mailpit (`EMAIL_SERVICE=smtp`, host 127.0.0.1:1025; API :8025) |
| Realtime | — | none needed: core's PollTransport default is launch-sufficient (verified WS-5; see `apps/api/src/lib/realtime/README.md`) |

Run `./fetch-keycloak-provider.sh` once before `up` (verified JAR
download — sha256 + GPG pins from the G2 spike).

The scheduled workflow `.github/workflows/scaleway-profile-e2e.yml`
(weekly + manual dispatch, **not per-PR** — the 02 §6 CI-cost decision)
boots this stack and runs the Scaleway-relevant suites.

## Publish precondition (0.4.0)

Local development resolves `@de-otio/saas-foundation` /
`@de-otio/vestibulum` through uncommitted `file:` overrides pointing at
the sibling worktree — those cannot resolve in CI. Every CI job that
needs the WS-1/WS-5 foundation surface (`PostgresKvStore`,
`resolveScalewaySecret`, the identity port) is therefore **gated on the
coordinated `@de-otio/saas-foundation` + `@de-otio/vestibulum` 0.4.0
publish** (prepared changeset; release needs Richard's approval — see
EXECUTION-COORDINATION.md). The workflow carries an explicit
version-guard step that fails with this explanation instead of a
confusing compile error.

## Current CI scope (extend with WS-3.3/WS-4)

- prisma migrations against the profile Postgres (incl. kv_entries + PostGIS)
- scoped Scaleway-adapter unit suites (email TEM/SMTP, OTLP metrics, software HMAC)
- live Mailpit SMTP smoke (`test/integration/scaleway-profile-smtp.integration.test.ts`, env-gated)
- Keycloak boots health-checked with the verified provider JAR (stack pin proof)

TODO (next lanes): realm-as-code provisioning from the WS-4 identity
module + magic-link e2e against Keycloak (G2 harness productization),
and the full `test:e2e` shards against an API booted with the Scaleway
env profile once the worker/env wiring lands (WS-2 fence).
