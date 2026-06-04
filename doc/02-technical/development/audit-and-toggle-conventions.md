# Audit and Toggle Conventions

This document defines:

1. The **feature-toggle naming convention** (prefix classes, new key rules).
2. The **audit action convention** for research, experiment, and platform-control events.
3. The **security-sensitive reads rule** — which reads MUST produce an audit trail.

---

## 1. Feature-Toggle Naming Convention

### Key format

All toggle keys follow the `FeatureToggleKeySchema` regex:

```
^[a-z0-9_]+$   (no dots, no leading/trailing underscores, no double underscores)
```

### Prefix classes

Use the prefix to distinguish treatment-eligible toggles from infrastructure controls:

| Prefix  | Class              | Meaning                                                                 | Experiment-eligible |
|---------|--------------------|-------------------------------------------------------------------------|---------------------|
| `ux_`   | User Experience    | User-visible features, UI variants, feed ranking, copy experiments      | **Yes**             |
| `infra_`| Infrastructure     | Database drivers, connection pool tuning, caching layers, async workers | No                  |
| `ops_`  | Operations         | Maintenance mode, circuit breakers, rate-limit overrides, kill switches | No                  |

> **Reserved sub-namespace — `ux_feed_ranking_*`:** This prefix is reserved for
> future per-tenant ranking-strategy selection (see the ranked-surface
> pre-commitment in the internal design note
> `enshittification-resistance/05-tenant-policy-floor`).
> **No key under `ux_feed_ranking_*` may be created until all four constraints
> in that pre-commitment are satisfied** — versioned, auditable, per-tenant
> opt-in, and diversity-constrained. No dispatch code for this namespace exists
> or is being built now.

> **Why the experiment registry filters on `ux_`:** The future treatment allow-list
> (experiment assignment + holdout logic) gates only over `ux_*` keys.
> Infrastructure and ops toggles must not become part of a user treatment
> because flipping them during an experiment could cause confounded results
> or service instability.

### Applying the convention to new keys

All **new** keys must carry a prefix. Examples:

```
ux_reactions_v2_enabled
ux_activity_feed_enabled
infra_neptune_read_fallback_enabled
infra_dynamo_cache_v2_enabled
ops_signup_rate_limit_strict
ops_maintenance_mode
```

### Existing keys — classification mapping

Existing persisted keys pre-date the prefix convention and **must NOT be renamed**
(renaming requires a data migration and is a breaking change for the deployed
toggle store). The table below classifies them for documentation purposes only:

| Existing key                         | Class  | Notes                                      |
|--------------------------------------|--------|--------------------------------------------|
| `posts_enabled`                      | `ux`   | User-visible content type                  |
| `comments_enabled`                   | `ux`   | User-visible content type                  |
| `global_public_posting_enabled`      | `ux`   | Changes user-visible post creation flow    |
| `content_moderation_enabled`         | `ops`  | Platform safety control                    |
| `user_signup_mode`                   | `ops`  | Platform-level registration control        |
| `activitypub_standalone_mode_enabled`| `infra`| Federation protocol switch                 |

---

## 2. Audit Action Convention

### Dotted-lowercase naming

All audit action constants follow the pattern `domain.verb` or
`domain.sub_domain.verb`, using lowercase letters, digits, and underscores.
The pattern is validated by `audit-actions.test.ts`:

```
^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$
```

### Research / experiment / platform-control actions

| Constant                   | String value                | Use                                           |
|----------------------------|-----------------------------|-----------------------------------------------|
| `RESEARCH_QUERY`           | `research.query`            | A research/analytics query was executed       |
| `RESEARCH_EXTRACT`         | `research.extract`          | A data extraction (export) for research       |
| `EXPERIMENT_ASSIGN`        | `experiment.assign`         | A user was assigned to an experiment variant  |
| `FEATURE_TOGGLE_CHANGED`   | `feature_toggle.changed`    | A feature toggle was created or updated       |
| `CONSENT_CHANGED`          | `consent.changed`           | A user's consent preferences were modified    |

### `research.query` PII rule — NO raw query text in metadata

`research.query` audit events **MUST NEVER** store the raw query string in
metadata. User-supplied query text may contain names, email addresses, or
other PII. Store a **hash** or a **parameterised template** with values
redacted.

```typescript
// BAD — raw query text stored
await auditLogger.logSystemAction(RESEARCH_QUERY, {
  resource: "feed",
  userId: session.userId,
  region,
  success: true,
  metadata: {
    query: userQuery, // NEVER do this — may contain PII
  },
}, env);

// GOOD — hash + template
import { createHash } from "crypto";
const queryHash = createHash("sha256").update(userQuery).digest("hex").slice(0, 16);
await auditLogger.logSystemAction(RESEARCH_QUERY, {
  resource: "feed",
  userId: session.userId,
  region,
  success: true,
  metadata: {
    queryHash,
    queryTemplate: "feed:user_id=? AND created_after=?",
    resultCount: rows.length,
  },
}, env);
```

---

## 3. Security-Sensitive Reads — Must Emit Audit Events

**An audit trail cannot be backfilled.** If a read is not recorded when it
occurs, it is permanently invisible to compliance reviews.

### What requires an audit event NOW

| Category                | Example                                          | Action to emit  |
|-------------------------|--------------------------------------------------|-----------------|
| Bulk read of user data  | Admin fetches all users matching a filter        | `DATA_READ`     |
| Cross-user data access  | Admin reads another user's private posts         | `DATA_READ`     |
| Data export             | GDPR export endpoint                             | `DATA_READ`     |
| Research query          | Research platform executes a feed analytics job  | `RESEARCH_QUERY`|
| Research extract        | Experiment data extract to external system       | `RESEARCH_EXTRACT` |
| Experiment assignment   | User assigned to A/B variant                     | `EXPERIMENT_ASSIGN` |

### What is deferred (single-user self-reads)

Individual reads of one's own data (e.g., `GET /api/posts/my-feed`) are
deferred — the compliance benefit is low relative to the emit overhead.

### Worked example — admin bulk user-export

```typescript
import {
  TrellisAuditLogger,
  type TrellisAuditLoggerEnv,
} from "../audit-composer.js";
import { DATA_READ } from "../audit-actions.js";

async function handleUserExport(
  request: Request,
  session: Session,
  env: TrellisAuditLoggerEnv,
  region: Region,
): Promise<Response> {
  const db = createPrisma(env);
  const users = await db.user.findMany({ /* filter */ });

  // Emit BEFORE returning results so the audit record exists even if
  // the response is cut short by a timeout.
  const auditLogger = new TrellisAuditLogger();
  await auditLogger.logDataAccess(
    {
      action: DATA_READ,
      resource: "user",
      resourceId: `bulk:${users.length}`,
      userId: session.userId,       // admin's user ID
      region,
      success: true,
      metadata: {
        targetType: "user_export",
        reason: "compliance_request",
      },
    },
    env,
  );

  return new Response(JSON.stringify(users), {
    headers: { "content-type": "application/json" },
  });
}
```

---

## 4. Feature-Toggle Audit Events

`FeatureToggleService.setToggle` emits `feature_toggle.changed` automatically
when an `auditCtx` is passed by the caller. The emitted metadata is:

```typescript
{
  key:        "my_toggle_key",   // toggle key (system identifier, no PII)
  oldEnabled: false,             // enabled value BEFORE the write (null → false for new toggles)
  newEnabled: true,              // enabled value AFTER the write
  changedBy:  "user-id-abc123",  // admin's USER ID — never email address
}
```

> **Why user ID, not email?** Email addresses are PII and would be rejected
> by the allowlist in `pii-filter.ts`. User IDs are opaque identifiers that
> comply with the allowlist and are sufficient for compliance lookups.

### Call site pattern

```typescript
const toggle = await toggleService.setToggle(
  key,
  enabled,
  user.email,   // stored in FeatureToggle.changedBy DB column (unchanged)
  description,
  {
    userId: session.userId,          // audit metadata changedBy
    env,                             // for audit DB client
    region: detectRegionSync(request, env),
  },
);
```

---

## 5. Audit Failure Observability

Audit failures are always best-effort — they never block the in-flight
request. When an audit write fails, the following happens:

1. A structured `console.error` line is emitted to stderr with
   `"auditEmitFailure": true` — this is a compliance recovery signal and
   can be grepped from CloudWatch Logs.
2. `logger.error` emits a structured app-log entry.

Example stderr line:

```json
{
  "auditEmitFailure": true,
  "action": "feature_toggle.changed",
  "resource": "feature_toggle",
  "userId": "user-id-123",
  "error": "Connection refused"
}
```

> **Deferred follow-up:** Full durable (SQS at-least-once) audit delivery is
> not yet implemented. The current Postgres best-effort write is the floor;
> SQS fan-out is the ceiling. Until SQS is wired in, treat the `auditEmitFailure`
> stderr lines as the compliance fallback.
