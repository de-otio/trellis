# Gap: Coordinated-Inauthentic-Behavior Detection

**The biggest gap, and the new Postgres graph backend is the natural home
for it.**

## The signature

The avatar pattern
([01 §3](./01-threat-landscape.md#3-avatar-infiltration--ai-agent-driven-fake-accounts))
is a *graph* signature, not a content signature:

- a small cluster of accounts operated by one administrator,
- created in the same time window,
- with synchronized activity,
- fanning out social-engineering contact to strangers,
- with little or no organic history of their own.

Content moderation (which trellis has, via the OpenAI moderation integration)
cannot see this — each individual avatar's posts look unremarkable. Meta
needed exactly this kind of cluster analysis to find Cobwebs' 200 avatars.

## What exists

`PostgresGraphService` has the raw material but no anomaly logic:

- Interaction scoring: `recordInteraction`, `recomputeScores`, `applyDecay`
  (`apps/api/src/lib/graph/postgres/scoring.ts`)
- Relationship graph queries (`apps/api/src/lib/graph/postgres/postgres-graph-service.ts`)
- Discovery/recommendation traversals (`apps/api/src/lib/graph/postgres/discovery.ts`)

The ActivityPub abuse-prevention service has a custom abuse-detection hook
that is currently unimplemented
(`apps/api/src/lib/activitypub/services/abuse-prevention.ts`).

## Roadmap proposal

Graph-level signals computed periodically (or on write triggers) and
**surfaced to moderators** — not auto-enforcement:

1. **Synchronized follow cascades** — many accounts following the same
   targets within the same window. Cheap to compute from relationship
   creation timestamps already in the graph.
2. **Stranger-contact asymmetry** — accounts with high out-degree contact to
   non-connected users (DM requests, comments on strangers' posts) and
   near-zero organic history (age, posts, inbound follows). The interaction
   scoring engine already records the raw events.
3. **Correlated account clusters** — accounts created in the same time
   window whose activity timestamps correlate. Account-creation metadata +
   interaction timestamps suffice for a first heuristic.

Design notes:

- **Heuristics over ML to start.** Even simple thresholds surfaced to a
  moderator queue beat nothing. ML can come later if a vertical needs it.
- **Per-tenant sensitivity.** Multi-tenant means thresholds should be
  tenant-configurable — a B2B tenant with closed membership has near-zero
  tolerance for stranger-contact patterns; a consumer community expects
  some.
- **Output is a signal, not a verdict.** Feed the moderator-notification
  pipeline that link reports already use; pair with
  [account-level reporting](./04-account-reporting.md) so victim reports and
  graph signals corroborate each other.
- **No shadow-enforcement in the core.** Suspension stays an explicit
  moderator action through the existing deprovisioning path
  (`apps/api/src/lib/user-deprovisioning.ts`, reason `security`).
