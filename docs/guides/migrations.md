---
title: Database Migrations
description: How to create, apply, and safely roll out schema migrations in Trellis.
sidebar: Migrations
order: 10
---

# Database Migrations

## Creating a migration

1. Edit `prisma/schema.prisma`
2. `npm run prisma:migrate:dev -- --name describe-your-change`
3. `npm run prisma:generate` to regenerate the Prisma client
4. Commit both the `prisma/migrations/` file and `schema.prisma`

## Zero-downtime: expand-contract pattern

For changes that could break a running API instance, apply migrations in stages across multiple deploys rather than in a single step:

| Step | Action | Deploy? |
|------|--------|---------|
| 1. Expand | Add new nullable column / table | Deploy |
| 2. Write dual | Code writes to old + new column | Deploy |
| 3. Backfill | Script populates new column from old | Deploy |
| 4. Switch reads | Code reads new column only | Deploy |
| 5. Contract | Remove old column in new migration | Deploy |

**Never in a single migration:**
- Rename a column
- Drop a column that code still reads
- Change a column from nullable to non-null without a backfill
