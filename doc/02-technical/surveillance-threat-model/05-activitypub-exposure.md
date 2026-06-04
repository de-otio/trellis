# Gap: ActivityPub as the Scraping Front Door

## The gap

For the fusion platforms in
[01 §1](./01-threat-landscape.md#1-scraping--osint-harvesting), public
ActivityPub collections are free OSINT — the social graph of a dissident is
precisely what gets fused with mobile-network data. Today:

- `GET /users/:username/followers` and `/following` are **public, unauthenticated,
  paginated collections** (`apps/api/src/lib/activitypub/listeners/actor.ts`).
- There is **no authorized-fetch mode** — HTTP signatures are verified on
  inbound POSTs (`apps/api/src/lib/activitypub/listeners/http-signatures.ts`)
  but GETs on actor/collection endpoints are open.
- There is **no instance deny/allow-list** — no defederation capability.
- The per-actor inbound rate limit (60/min) exists but the custom
  abuse-detection hook is unimplemented
  (`apps/api/src/lib/activitypub/services/abuse-prevention.ts`), and the
  rate-limit window is in-memory per-process, not distributed.

## Why this is cheap to fix now

ActivityPub is **feature-flagged off by default**
(`config.features.activityPub`). No vertical has it enabled in production.
That means the fix is not a migration — it's a set of **enablement
preconditions** written down before anyone flips the flag.

## Proposed enablement preconditions

Before any vertical enables `features.activityPub`, the following must be in
place. This list should be copied into
[`architecture/07-activitypub.md`](../architecture/07-activitypub.md) as
enablement criteria.

1. **Authorized fetch** (a.k.a. secure mode): require valid HTTP signatures
   on GETs to actor documents and collections, not only on inbox POSTs.
   Fedify supports this. Effect: scraping requires a real, identifiable
   federated actor — revocable and blockable — instead of anonymous HTTP.
2. **Follower/following-list visibility setting**: per-user control over
   whether the followers/following collections enumerate members or return
   only `totalItems`. Mainstream fediverse servers (Mastodon) offer this;
   it's the single highest-value control for the graph-harvesting threat.
3. **Instance deny/allow-list**: per-environment (and eventually per-tenant)
   defederation. The abuse-prevention service's unimplemented hook is the
   natural seam.
4. **Distributed rate limiting** for federation endpoints: move the
   per-actor window from in-memory to the existing DynamoDB token-bucket
   infrastructure (`apps/api/src/lib/rate-limit.ts`) so limits hold across
   Fargate tasks.

## Residual exposure

Federation is, by design, data sharing with servers trellis doesn't control;
authorized fetch and visibility settings reduce bulk harvesting but cannot
prevent a hostile federated server from retaining what it legitimately
receives. That residual risk belongs in any vertical's decision to enable
federation at all — which is exactly why it's a flag, not a default.
