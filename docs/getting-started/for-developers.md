---
title: Developer Guide
description: Prerequisites, first-time setup, daily workflow, and testing for Trellis contributors.
sidebar: For Developers
order: 10
---

# Developer Guide

## Prerequisites

- Node.js 22+
- Docker + Docker Compose

## First-time setup

```bash
git clone <repo> && cd trellis
npm install
./scripts/dev-setup.sh   # starts local services, runs migrations, seeds data
```

## Daily workflow

```bash
docker compose up -d    # ensure local services are running
npm run dev             # start API in watch mode (port 3000)
```

## Local environment variables

Create `.env` in the repo root (gitignored):

```env
DATABASE_URL=postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev
DIRECT_DATABASE_URL=postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev
DYNAMODB_ENDPOINT=http://localhost:8000
DYNAMODB_TABLE=dev-trellis
SQS_ENDPOINT=http://localhost:4566
S3_ENDPOINT=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
STAGE=dev
NODE_ENV=development
SESSION_SECRET=local-dev-secret-32-bytes-minimum-here

# Follow-by-email — only needed if you enable email_subscriptions_enabled.
# Both are required when that feature is on and never fall back to SESSION_SECRET.
EMAIL_SUB_HMAC_SECRET=local-dev-email-sub-hmac-secret-at-least-32-chars
EMAIL_SUB_ENC_KEY=      # 32-byte base64; generate with: openssl rand -base64 32
```

### Optional switches

None of these is needed for local development; each defaults to the safe
setting. They are listed because their absence changes behaviour in ways that
surprise people reading the code. All are read in `apps/api/src/env.ts` unless
noted.

| Variable | Default | Meaning |
|---|---|---|
| `ENABLE_TEST_ROUTES` | unset (off) | Opts the `/api/admin/test/*` test-user seam on. The seam is also on when `STAGE=dev` is genuinely set (not defaulted) or the process runs in CI; `STAGE=prod`/`production` can never enable it. Even when on, the routes require an authenticated `SUPER_ADMIN` session plus CSRF — there is deliberately no bootstrap header or bypass. |
| `SESSION_BLOCKLIST_REQUIRED` | unset | Set to `true` to make the session-revocation check fail closed when no `SESSION_BLOCKLIST_KV` is bound: every session is denied instead of the check being skipped. Local dev and the unit tests bind no KV, so leave it unset here (`apps/api/src/lib/session-cookie.ts`). |
| `TENANT_SCOPE_MODE` | `off` | `off` \| `shadow` \| `enforce`; anything else reads as `off`. `shadow` logs scoped queries that lack a tenant filter; `enforce` injects a tenant predicate (a partial defence — read `apps/api/src/lib/tenant-scope.ts` before enabling it anywhere). Only a non-`off` mode establishes the per-request ambient tenant context, which extension `ctx.events.emit(…)` and the extension graph circle reads require — under `off` both throw. See the [Extension API](../reference/extension-api.md#live-since-0100). |
| `AGENT_SURFACE_LLMS_TXT` | unset | Full body served verbatim at `GET /llms.txt`. Unset = Trellis's generic default. |
| `AGENT_SURFACE_SECURITY_TXT` | unset | Full RFC 9116 body served verbatim at `GET /security.txt`. Unset = `404` and one `[agent-surface]` warning at boot; there is deliberately no placeholder contact. |

`HATCHET_ENABLED` and `HATCHET_CLIENT_TOKEN` are read by the **worker**
container only (`apps/worker`), not by the API — see
[`apps/worker/README.md`](https://github.com/de-otio/trellis/blob/main/apps/worker/README.md).

## Running tests

```bash
npm test                              # all tests (requires Docker Compose)
npm test -- apps/api/test/foo.test.ts # single file
npm run test:coverage                 # with coverage report
```

> **Never run tests in the background** — each Vitest worker process can use 4GB+ RAM. Always foreground, Ctrl+C to stop.

## Database workflow

```bash
# After editing prisma/schema.prisma:
npm run prisma:migrate:dev -- --name describe-your-change
npm run prisma:generate
```

For zero-downtime schema changes, use expand-contract. See the [migrations guide](../guides/migrations.md).

## Enabling opt-in features locally

The Open Social Web capabilities — follow-by-email, collections, and
year-in-review — are **off by default** (their toggles seed to `false`) and
return 404 until enabled. To turn them on in your local database:

```bash
# All three, globally (tenant_id NULL):
docker exec trellis-postgres-1 psql -U trellis -d trellis_dev -c \
  "INSERT INTO feature_toggles (id, key, enabled, tenant_id, last_changed, created_at)
   VALUES ('osw-email-sub','email_subscriptions_enabled',true,NULL,now(),now()),
          ('osw-collections','collections_enabled',true,NULL,now(),now()),
          ('osw-year-review','year_in_review_enabled',true,NULL,now(),now())
   ON CONFLICT (id) DO UPDATE SET enabled = true;"
```

Follow-by-email also needs `EMAIL_SUB_HMAC_SECRET` and `EMAIL_SUB_ENC_KEY` in
your `.env` (see above). See the [Feature Flags guide](../guides/feature-flags.md)
for the toggle model and the [Operations guide](for-operations.md) for the
per-environment enablement + secret contract.
