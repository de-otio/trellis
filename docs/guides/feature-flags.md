---
title: Feature Flags
description: How feature toggles are stored, seeded, and resolved in Trellis.
sidebar: Feature Flags
order: 20
---

# Feature Flags

Trellis has two related mechanisms:

- **Feature toggles** — named on/off rows stored in PostgreSQL (the
  `featureToggle` Prisma table), resolved at runtime by
  `FeatureToggleService`. Toggles can be **global** (one row per key) or
  **tenant-scoped** (a `[key, tenantId]` override row that wins over the global
  row for that tenant).
- **Region feature flags** — a structured, region-aware view
  (`FeatureFlags`: `posts`, `comments`, `entities`, `friends`, `sentiments`,
  `feeds`, `map`) assembled by `FeatureFlagsManager`, which consults the
  underlying toggles and falls back to safe defaults (all `false`).

There is **no DynamoDB-backed flag store** and **no in-process 5-minute TTL
cache of DynamoDB**. Toggle reads go to Postgres; the global read path uses the
foundation store's per-instance read cache.

## Storage

Toggles live in the `featureToggle` table (see `prisma/schema.prisma`). The
relevant columns are `key`, `enabled`, `tenantId` (nullable), `changedBy`,
`changedAt`, and `description`. A partial unique index guarantees at most one
global row (`tenant_id IS NULL`) and at most one row per `[key, tenantId]`.

## Seeding

Defaults are seeded from config into the database:

```bash
npm run seed:feature-toggles
```

This runs `apps/api/scripts/seed-feature-toggles.ts`, which reads the
`FEATURE_FLAGS` section of the environment config and upserts the rows. The
config file is the source of truth — seeding overwrites existing database
values to match it. Keys not present in config default to `false`.

`scripts/dev-setup.sh` runs this step automatically during first-time local
setup.

## Resolving a toggle in code

Toggles are resolved through `FeatureToggleService` (constructed with a Prisma
client), not a free `getFeatureFlag` function:

```typescript
import { FeatureToggleService } from "../lib/feature-toggle-service";

const toggles = new FeatureToggleService(db);

// Global resolution
const enabled = await toggles.isEnabled("some-flag");

// Tenant-scoped: resolves the tenant override first, then the global row,
// then false.
const enabledForTenant = await toggles.isEnabled("some-flag", tenantId);
```

Resolution is **fail-safe**: a missing toggle or a database error resolves to
`false`.

For the structured region view, use `FeatureFlagsManager.getFeatureFlags(tenantId?)`,
which threads tenant resolution through each flag and falls back to the coded
defaults when a toggle is absent.

## Changing a toggle

Toggle writes go through `FeatureToggleService.setToggle(...)` (exercised by the
admin routes), which upserts the global or tenant-scoped row and emits a
best-effort `feature_toggle.changed` audit event. Global writes are
SUPER_ADMIN-gated; a tenant-scoped write requires the caller to be scoped to
that tenant (or a SUPER_ADMIN). A toggle change takes effect on the next read
that misses the foundation store's per-instance cache — no redeploy required.

## Reading the public region view

The unauthenticated `GET /api/feature-flags` route
(`apps/api/src/lib/routes/feature-flags.ts`) returns the region-resolved
feature configuration for a request (region from the `region` query parameter
or detected from the request), falling back to the static region config if the
database is unavailable.

## Capability toggles: Open Social Web

Three capabilities ship **off by default** behind global toggles and are gated
at the route layer by `featureToggleMiddleware`
(`apps/api/src/lib/feature-gate-middleware.ts`). While a toggle is off, its
entire route set responds **404** — indistinguishable from a route that does
not exist, so no information leaks about the feature — and resolution **fails
closed** to disabled if the toggle cannot be read.

| Toggle key | Enables | Notes |
|---|---|---|
| `email_subscriptions_enabled` | Anonymous follow-by-email (`/api/subscriptions/email…`, owner subscriber counts) | **Also requires the two `EMAIL_SUB_*` secrets** (see the [Operations guide](../getting-started/for-operations.md)); with the toggle on but secrets absent, the subscribe path returns a generic 500 by design. |
| `collections_enabled` | Curated collections / lists (`/api/collections…`) | — |
| `year_in_review_enabled` | Year-in-review recap (`/api/recap/…`) | — |

Enable one per environment by setting it `true` in that environment's
`FEATURE_FLAGS` config (the seed source of truth) and re-running
`seed:feature-toggles`, or per tenant via a tenant-scoped `setToggle` override.
All three default to `false` in `apps/api/scripts/seed-feature-toggles.ts`, and
each also requires its schema migration to be applied.
