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
```

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

For zero-downtime schema changes, use expand-contract. See [migrations guide](local-setup.md).
