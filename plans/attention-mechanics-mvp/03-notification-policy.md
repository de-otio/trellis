# 03 · S3 — Notification cadence as an explicit, tenant-configurable policy

## Goal

Make notification delivery rules (poll-only, quiet hours, preference gating,
batching) a single named policy with a documented "what it does / does not do"
contract — disclosable and tenant-configurable. **No behaviour change** by
default. Explicitly: *no re-engagement nudges* is a stated, tested invariant.

## Current state

- `apps/api/src/lib/notification-handler.ts` `createNotification()` (`:42-115`)
  already: checks `NotificationPreference` (bypassed for `SAFETY_ALERT` /
  `PARENTAL_LINK`), checks **quiet hours** (`:89-92`, same bypass), sets
  `deliveredAt = now | null` (null ⇒ queued during quiet hours).
- Delivery is **poll-based**; `getNotifications()` (`:120-163`) is cursor-paged
  DESC. There is **no push**, by design.
- `Notification.batchId` (`prisma/schema.prisma:1430-1451`) exists but **no
  batching logic** — the future-hook is already in the schema.
- `NotificationPreference` (`:1454-1466`): `dmEnabled`, `followEnabled`,
  `digestEnabled`, `systemEnabled`, `relationshipEnabled`.
- All queries are tenant-scoped (`tenantId` on `Notification`).
- `NotificationType` enum (`:1414-1427`): DIRECT_MESSAGE, SAFETY_ALERT,
  PARENTAL_LINK, FOLLOW, SENTIMENT_DIGEST, SYSTEM, RELATIONSHIP_*, TIER_CHANGED,
  ENTITY_RELATIONSHIP_*, CONNECTION_CODE_REDEEMED.

## Design

Introduce `apps/api/src/lib/notifications/notification-policy.ts` that owns the
gating decision as a pure function the handler calls:

```ts
export interface NotificationPolicy {
  readonly id: string;                  // "calm-poll-v1"
  readonly description: string;
  readonly delivery: "poll";            // single value — no push, by construction
  // returns the delivery decision for one notification
  decide(input: {
    type: NotificationType;
    prefs: NotificationPreference;
    now: Date;
    quietHours: QuietHoursConfig | null;
  }): { deliver: boolean; deferUntil: Date | null; batchKey: string | null };
  readonly criticalTypes: readonly NotificationType[]; // bypass prefs + quiet hours
}
```

- `CALM_POLL_POLICY` reproduces today's logic exactly: critical types
  (`SAFETY_ALERT`, `PARENTAL_LINK`) bypass; everything else honours prefs +
  quiet hours; `deferUntil` mirrors the current `deliveredAt = null` behaviour.
- `createNotification()` calls `policy.decide(...)` instead of the inline checks
  — the scattered `:89-92` logic moves into the policy.
- **Batching (activate the dormant `batchId`):** `decide()` returns an optional
  `batchKey`; a thin `batchKey → batchId` assignment groups same-key
  notifications in a window. MVP scope: digest-type notifications
  (`SENTIMENT_DIGEST`) get a daily `batchKey`; everything else `null` (unchanged).
  This is opt-in and behaviour-preserving for non-digest types.
- **Tenant config:** extend the `TenantPolicy` Zod schema from
  [`01`](01-ranking-policy-boundary.md) with a `notifications` sub-object
  (`{ policyId?, quietHoursDefault? }`); `getTenantPolicy` already merges over
  platform defaults. One registry, default `CALM_POLL_POLICY`.

### Verify before building

Confirm where **quiet hours** are configured today (User field vs
`NotificationPreference` vs hardcoded in `:89-92`) and thread that as the
`QuietHoursConfig` input — do not change its source, just pass it in.

## Changes

| File | Change |
|---|---|
| `apps/api/src/lib/notifications/notification-policy.ts` | **new** — interface + `CALM_POLL_POLICY` |
| `apps/api/src/lib/notification-handler.ts` | call `policy.decide()`; assign `batchId` from `batchKey` |
| `apps/api/src/lib/tenant/tenant-policy.ts` | add `notifications` sub-schema |

## Tests

- **Behaviour-parity:** for each `NotificationType` × {in/out of quiet hours} ×
  {pref on/off}, assert `deliver`/`deferUntil` matches current handler output.
- `SAFETY_ALERT` / `PARENTAL_LINK` always deliver immediately (bypass).
- **Invariant test:** no notification type is generated purely to re-engage an
  inactive user — assert the type set contains no "we miss you / X posted again"
  category, so a future addition of one fails the test loudly.
- Digest batching groups same-day digests under one `batchId`; non-digest types
  keep `batchId = null`.

## Effort / priority

Low. **Priority: medium.** Consolidation + activating the existing `batchId`
hook; the invariant test is the durable win.
