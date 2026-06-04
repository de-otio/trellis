# Discovery Exposure Metrics

Defines the derived metrics used to evaluate distributional fairness of the
discovery-recommendation surface. The underlying counters are written by
`apps/api/src/lib/discovery-exposure.ts`.

## Counter schema

Each served recommendation increments an atomic DynamoDB counter:

| Field | Value |
|-------|-------|
| `pk`  | `discexposure:{yyyy-mm}:{entityId}` |
| `sk`  | `v` |
| `count` | Running total of times this entity appeared on a served recommendations page during the month |

One increment per entity per served page (not per viewer). Monthly buckets
provide time-resolution without an unbounded keyspace.

## Derived metrics (computed offline)

These metrics are computed offline from a DynamoDB scan of the month's
`discexposure:` partition. No new infrastructure is required.

### Concentration share

For a given calendar month:

1. Scan all items with `pk` matching `discexposure:{yyyy-mm}:*`.
2. Sum all `count` values → `total_served`.
3. Sort entities by `count` descending.
4. `top-1% share` = sum of `count` for the top 1% of entities / `total_served`.
5. `top-10% share` = sum of `count` for the top 10% of entities / `total_served`.

A healthy, non-concentrated surface has a top-1% share well below 1% and a
top-10% share well below 10%. Significant over-representation indicates hub
entities (e.g. entities with many active owners) are dominating
recommendations — the same dynamic the per-owner diversity cap (item 1) is
designed to counteract.

### Gini coefficient (optional)

Compute the Gini coefficient over the month's `count` distribution. A Gini of
0 means perfectly equal exposure; 1 means one entity receives all impressions.
Track the Gini time-series to detect creeping concentration as the platform
grows.

## Invariant: aggregate-only instrumentation

**This module records aggregate counters only. Per-viewer impression logs are
refused, not deferred.**

Rationale:

- Per-viewer logs would expose a fine-grained social graph (who saw what, when)
  that is not necessary for detecting norm misperception and is incompatible
  with the data-minimization commitment in
  [`analysis/enshittification-resistance/04-data-minimization.md`](../../../../../analysis/enshittification-resistance/04-data-minimization.md).
- The aggregate counters carry sufficient statistical power to detect
  concentration effects at the population level (see
  [`analysis/algorithmic-norm-misperception/02-prelaunch-actions.md §3`](../../../../../analysis/algorithmic-norm-misperception/02-prelaunch-actions.md)).
- Any future proposal to add viewer identity to these records requires a full
  data-minimization RFC and explicit consent architecture before implementation.

## Why the baseline must predate launch

The exposure counters cannot be backfilled retroactively. Once recommendations
have been served without recording, any concentration that occurred during that
period is permanently invisible to the metrics. The counters must be live
before the first recommendation page is served to any real user, so that
month-zero data is available as the launch baseline against which future months
are compared.

This parallels the audit-trail principle documented in
`apps/api/src/lib/audit-composer.ts`: "An audit trail cannot be backfilled —
if the read is not recorded at the time it occurs, it is permanently invisible
to compliance reviews."

## Keeping the metrics meaningful

- Do not add viewer identity, session ids, or tenant ids to the counter key or
  item. Entity id alone is the design.
- Do not set TTL on these items. Monthly buckets are the time-resolution
  mechanism; historical months should be retained for trend analysis.
- When comparing months, normalise by `total_served` (not raw counts), because
  recommendation volume will grow as the user base grows.
