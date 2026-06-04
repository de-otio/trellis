# Current Posture

What trellis already does that holds up against the
[threat landscape](./01-threat-landscape.md) — and which of those facts
should be promoted from "happens to be true" to **stated platform
guarantees** that extension review enforces.

## Strong today

### No third-party trackers or analytics SDKs in the core

The API core embeds no analytics SDKs and no ad-network trackers. External
calls are limited to opt-in, feature-gated services (OpenAI moderation,
optional IP geolocation). Per-age-tier analytics opt-out exists
(`apps/api/src/lib/privacy-defaults.ts`) and is mandatory for the CHILD tier.

Given that ADINT is a catalog item in surveillance products
([01 §2](./01-threat-landscape.md#2-adint--purchased-adtracker-data)), this
is a real differentiator — there is simply no tracker data stream from the
core to purchase.

### IP anonymization + tiered audit retention

Audit events pass through a PII allowlist and IP anonymization before
reaching the foundation audit log (`apps/api/src/lib/audit-composer.ts`,
`apps/api/src/lib/audit/pii-filter.ts`). Retention is tiered and locked:
info 30d / warning 90d / error 365d.

### Age-tier pagination caps

Feed pagination is capped by age tier (`apps/api/src/lib/feed-pagination.ts`):
CHILD 5 pages × 10, TEEN 20 × 15, ADULT uncapped. Sort is locked to
`createdAt`. This is child-safety machinery, but it doubles as a mild
scraping brake for the protected tiers.

### Privacy-preserving rate-limit keys

Rate-limit key derivation prefers user ID over session ID over email over IP
(`apps/api/src/lib/rate-limit.ts`) — identification for abuse control without
making IP the primary key.

### Age-tier privacy defaults with parental locks

Profile visibility and DM access default conservatively by age tier and can
be locked against loosening (`apps/api/src/lib/privacy-defaults.ts`): CHILD
defaults to PRIVATE profile / NOBODY DMs, locked.

## Promote to stated guarantees

The tracker-free core is currently an implementation fact, not a documented
commitment. It should become an explicit **platform guarantee** in the
extension documentation:

> Extensions must not introduce third-party trackers, analytics SDKs, or
> ad-network integrations into server-side request handling. Client-side
> analytics in a vertical's frontend are the vertical's responsibility, but
> the trellis API surface stays tracker-free.

Rationale: the guarantee is only as strong as its weakest extension. Making
it an extension review criterion keeps a vertical from silently breaking a
property that at-risk users may be relying on. This pairs with the existing
data-minimization stance in the identity-federation design
(claim names logged, never claim values).
