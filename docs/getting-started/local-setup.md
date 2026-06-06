---
title: Local Development Setup
description: How to run Trellis services locally with Docker Compose, including the database, API server, and tests.
sidebar: Local Setup
order: 20
---

# Local Development Setup

## Services

`docker compose up -d` starts:

| Service | Port | Purpose |
|---------|------|---------|
| PostgreSQL 16 | 5432 | Primary database |
| DynamoDB Local | 8000 | KV cache, rate limiting, feature flags |
| LocalStack | 4566 | S3, SQS, SES emulation |

## API dev server

```bash
npm run dev   # starts with tsx watch, auto-restarts on file changes
```

`http://localhost:3000` — health check at `GET /health`

## Database

```bash
npm run prisma:migrate:dev     # apply pending migrations
npm run prisma:generate        # regenerate client after schema change
npm run seed:feature-toggles   # seed feature toggle defaults
```

## Running tests

Tests require Docker Compose running. Vitest automatically uses local endpoints when `NODE_ENV=test`:

```bash
docker compose up -d
npm test                          # all tests
npm test -- path/to/file.test.ts  # single file
npm run test:watch                # watch mode
npm run test:coverage             # with coverage report
```

> **Max 2 Vitest worker threads** — each can use 4GB+ RAM. Never run in background.

## Local DynamoDB table

`./scripts/dev-setup.sh` creates the local DynamoDB table automatically. The table name matches the `DYNAMODB_TABLE` value in your `.env` file (see [Developer Guide](for-developers.md#local-environment-variables)).
