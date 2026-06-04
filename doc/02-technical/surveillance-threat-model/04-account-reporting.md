# Gap: Account-Level Reporting

## The gap

Only **link** reports exist (`apps/api/src/lib/routes/link-reports.ts`):
users can report malicious/suspicious URLs in posts and comments, which feeds
domain-reputation scoring, auto-block thresholds, and moderator
notification.

The avatar threat
([01 §3](./01-threat-landscape.md#3-avatar-infiltration--ai-agent-driven-fake-accounts))
is **accounts, not links**. A user targeted by avatar social engineering — a
plausible stranger building rapport — has nothing to link-report. The 48,000
users compromised in the Cobwebs case were compromised by accounts, through
conversation.

## Proposal

A "report this account" path (impersonation, fake account, harassment,
suspected coordinated activity) that generalizes the existing link-report
machinery from domains to accounts:

| Link reports (exists) | Account reports (proposed) |
|---|---|
| Report URL + reason | Report user ID + reason |
| Per-user rate limit (10/h) | Same — reporting is itself abusable |
| `DomainReputationService` negative signal | Account-reputation negative signal |
| Auto-block domain at threshold | **No auto-suspend** — queue for moderator at threshold |
| Moderator webhook/email notification | Same pipeline |

Differences that matter:

- **No automatic enforcement.** Auto-blocking a domain is low-collateral;
  auto-suspending an account is not, and mass-reporting is a known
  harassment vector (and, per the threat model, a tool the same avatar
  networks could turn against legitimate users). Thresholds escalate to a
  moderator queue, never directly to suspension.
- **Corroboration with graph signals.** An account report carries far more
  weight when the reported account also trips
  [coordinated-behavior signals](./03-coordinated-inauthentic-behavior.md).
  The moderator view should show both.
- **Suspension reuses the existing path** —
  `apps/api/src/lib/user-deprovisioning.ts` already supports `manual` /
  `security` reasons, immediate claim-cache invalidation, and restoration.

## Scope note

Report categories and any vertical-specific reasons belong to the vertical
(extension terminology); the report entity, rate limiting, reputation
signal, and moderator pipeline belong to the core.
