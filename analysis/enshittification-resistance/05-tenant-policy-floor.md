# 05 — Tenant policy is a floor, not a dial

> **Leverage: medium–high.** This is Doctorow's **stage 2** — "shift value from
> users to business customers" — and in a multi-tenant core the business
> customers are the *tenants*.

## The gap

The [ranking-policy-boundary plan](../../plans/attention-mechanics-mvp/01-ranking-policy-boundary.md)
introduces a cross-cutting tenant policy: a `policy Json?` column on `Tenant`
(`prisma/schema.prisma:1515`), loaded by `getTenantPolicy(...)` in
`apps/api/src/lib/tenant/tenant-policy.ts` (planned) and **merged over platform
defaults**. The safer-social work asserts that "safe defaults live in core."

But "merge over defaults" is symmetric: today it is used to make a tenant
*stricter* (a calm preset), yet the same mechanism can make a tenant *looser*.
Notification cadence, feed finiteness, minor protections, quiet hours — all are
in principle dialable in either direction by whoever writes a tenant's policy
JSON. That is precisely stage 2: a business customer (tenant) tuning the product
to be worse for *its* users in exchange for some tenant-side benefit (growth,
engagement, ad inventory).

## Design change: the merge enforces a floor

Make the asymmetry structural. The platform defines a **safety floor**; tenant
policy may only move *away from* harm, never *toward* it:

- Notification cadence: a tenant may make it **quieter**, never noisier than the
  floor.
- Feeds: a tenant may make them **more finite**, never add infinite scroll.
- Minor protections / quiet hours: a tenant may make them **stricter**, never
  weaker.
- Ranking: a tenant may pick any **registered** policy (all of which already
  satisfy doc 03's guard), and nothing else.

Implementation shape:

- `getTenantPolicy` does not do a naive deep-merge. Each floor-governed field
  has a **clamp direction**; the loader applies `max`/`min`/`stricter-of`
  against the floor rather than letting the tenant value win.
- A tenant policy that tries to loosen a floor value is **clamped and logged**,
  not honoured (and surfaced to the tenant as "below platform floor — ignored").

## Tests (this is where the invariant lives)

- For each floor-governed field: a tenant policy *stricter* than the floor is
  honoured; a tenant policy *looser* than the floor is clamped to the floor.
- A tenant `policyId` not in `RANKING_POLICIES` falls back to default + logs
  (already specified in the S1 plan — extend it to assert no loosening).
- Property test: for random tenant policies, the *effective* policy is always
  ≤ floor on every harm axis. This is the machine-checked statement of
  "tenants can be kinder than the platform, never crueller."

## Why this matters for enshittification specifically

Without the floor, the multi-tenant architecture is a ready-made stage-2
delivery mechanism: the operator never has to enshittify the core: it just lets
(or pressures) tenants to do it per-vertical, and points at "tenant
configurability" as the alibi. The floor removes the alibi by making
user-hostile configuration *unrepresentable*.
