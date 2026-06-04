# scripts/

Helper scripts for local development.

| Script | What it does |
| --- | --- |
| `dev-setup.sh` | One-time local dev setup: brings up `docker compose` services, runs migrations, seeds data |
| `e2e-parallel.sh` | Runs all e2e shards in parallel against a given `API_URL` (works against any URL — local docker, ngrok, Trellis dev, etc.) |
| `link-foundation.sh` | Links the locally-developed `@de-otio/saas-foundation` + `@de-otio/vestibulum` into this repo for co-development. Re-run after any `npm install` (it clobbers the symlinks). `--status` / `--unlink` supported. CI and publish intentionally use the registry versions. |

## Note

Trellis is consumed by downstream vertical applications as an npm dependency and is not deployed standalone (see `../CLAUDE.md`, "Deployment Status"). The previous `deploy.sh` / `fast-deploy.sh` / `post-deploy-test.sh` / `ops/*` / `incident/*` scripts were dormant scaffolding for a `Trellis-*` AWS environment that never existed; they were removed alongside the `infra/` workspace. If Trellis is deployed standalone in the future, see git history at the parent of the deletion commit for the previous shape.
