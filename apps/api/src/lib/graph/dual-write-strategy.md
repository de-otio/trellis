# Dual-Write Consistency Strategy

How Postgres and the graph DB (AuraDB, or Docker Neo4j locally) are kept in sync.

---

## Principle

Postgres is the source of truth for all data. The graph DB holds a derived subset needed for graph traversals (circle resolution, discovery, scoring). If the graph DB were wiped, it could be rebuilt entirely from Postgres.

---

## Dual-Written Operations

| Trigger | Postgres Operation | Graph DB Sync Method | Critical? |
|---------|-------------------|---------------------|-----------|
| User created | `prisma.user.create` | `graphService.syncUser` | No |
| User updated (role) | `prisma.user.update` | `graphService.syncUser` | No |
| User deleted | `prisma.user.delete` | `graphService.removeUser` | Yes |
| Entity created | `prisma.entity.create` | `graphService.syncEntity` | No |
| Entity updated (name, breed, location) | `prisma.entity.update` | `graphService.syncEntity` | No |
| Entity deleted | `prisma.entity.delete` | `graphService.removeEntity` | Yes |
| Post created | `prisma.post.create` | `graphService.syncPost` | No |
| Post deleted | `prisma.post.delete` | `graphService.removePost` | No |
| PostSubject created/replaced | `prisma.postSubject.create` | `graphService.syncPostSubjects` | No |
| PostSubject deleted | `prisma.postSubject.delete` | `graphService.syncPostSubjects` | No |
| EntityOwnership created | `prisma.entityOwnership.create` | `graphService.syncOwnership` | Yes |
| EntityOwnership updated (role) | `prisma.entityOwnership.update` | `graphService.syncOwnership` | No |
| EntityOwnership deleted | `prisma.entityOwnership.delete` | `graphService.removeOwnership` | Yes |

**Critical** means the client should be told the operation failed if the graph DB write cannot succeed after retries. Non-critical means the client receives success as soon as Postgres commits.

---

## Write Ordering

Every dual-write follows the same sequence:

```
1. Write to Postgres (transaction commit)
2. Attempt graph DB sync (immediate, inline)
3a. Success → return response to client
3b. Failure → retry inline (up to 2 attempts, exponential backoff)
4a. Retry success → return response to client
4b. Retry failure (non-critical) → enqueue for async retry, return success
4c. Retry failure (critical) → return error to client, Postgres write stands
```

### Why Postgres first

- Postgres is the source of truth. If it fails, nothing is written anywhere.
- If the graph DB fails after Postgres succeeds, the data exists in Postgres and can be synced later.
- No distributed transaction needed. The graph is a derived projection.

### Why not graph-DB-first

- A graph-DB-first write with a subsequent Postgres failure would leave orphan graph state with no source-of-truth record to reconcile against.

---

## Failure Handling

### Inline Retry

When a graph DB sync call fails, the DualWriteService retries immediately:

- **Max retries**: 2 (total of 3 attempts including the initial one)
- **Backoff**: 100ms, then 300ms (exponential with jitter)
- **Retryable errors**: `GraphConnectionError`, `GraphQueryError` (transient), `GraphTimeoutError`
- **Non-retryable errors**: `GraphNotFoundError`, `GraphConflictError`, `GraphAuthorizationError`

### Async Retry Queue

If all inline retries fail for a non-critical operation:

1. The failed sync is serialized as a `DualWriteFailure` and sent to the `GRAPH_SYNC_QUEUE` (SQS with DLQ).
2. The handler returns success to the client (Postgres write is the source of truth).
3. A background worker (Lambda or ECS task) processes the queue:
   - Deserializes the `DualWriteFailure`
   - Calls the appropriate `GraphService` sync method
   - On success: message is deleted from the queue
   - On failure: SQS visibility timeout provides automatic retry with backoff
   - After max receives (5): message moves to the DLQ for manual inspection

### Critical Operation Failure

For critical operations (user deletion, entity deletion, ownership changes):

1. Inline retries are attempted (same as above).
2. If all retries fail, the handler returns an error to the client.
3. The Postgres write has already committed, so the data is in an inconsistent state.
4. The failed sync is still enqueued for async retry.
5. The response includes a warning that the operation partially succeeded.

In practice, this is extremely rare. The graph DB being down blocks only the graph sync, not the Postgres write. And if the graph DB is entirely down, the health check would have already flagged it, and the API can operate in degraded mode (graph features disabled).

### Tombstone Pattern for Deletions (GDPR Compliance)

When a user or entity is deleted from Postgres, the graph node must also be removed. If the graph DB deletion fails, the graph retains PII-adjacent data (relationships, entity names, locations) after the user has requested deletion. This is a GDPR compliance risk.

**Tombstone approach:**

1. On deletion, Postgres writes a `DeletionTombstone` record:
   ```
   DeletionTombstone {
     id, targetType (user|entity|post), targetId,
     deletedAt, graphSynced (boolean), graphSyncedAt
   }
   ```
2. The graph node is immediately marked with a `_deleted: true` property (soft-delete). All graph queries filter out `_deleted` nodes.
3. The DualWriteService attempts to hard-delete the graph node inline (with retries).
4. On success: `graphSynced = true`, tombstone can be cleaned up after 30 days.
5. On failure: tombstone remains with `graphSynced = false`.

**Daily reconciliation sweep:**

A scheduled job (daily, not weekly) runs:
1. Query all tombstones where `graphSynced = false` and `deletedAt > 24 hours ago`.
2. For each, attempt the graph deletion again.
3. If the graph node no longer exists (already cleaned up), mark as synced.
4. Alert on tombstones older than 48 hours that remain unsynced — these require manual investigation.

This ensures deletion propagates to the graph within 24-48 hours even in the worst case, satisfying GDPR's "without undue delay" requirement.

---

## Read Path

| Query Type | Database | Example |
|-----------|----------|---------|
| Graph traversals | graph DB | Circle member resolution, discovery, scoring |
| Content fetches | Postgres | Post body, comments, media, entity profiles |
| Visibility resolution | graph DB | "Which posts can this user see in tier N?" |
| Content delivery | Postgres | "Fetch these post IDs with full content" |
| Circle read state | Postgres | `CircleReadState` model (lastReadAt per tier) |
| Relationship CRUD | graph DB (primary) | Create/update/remove scored relationships |
| Entity relationship CRUD | graph DB (primary) | Create/confirm/reject entity-to-entity links |
| User/Entity profiles | Postgres | Profile data, metadata, settings |
| Auth, sessions, tokens | Postgres | Never touches the graph DB |
| Notifications, DMs | Postgres | Never touches the graph DB |

### Pattern: IDs from the graph DB, content from Postgres

The standard query pattern for circle views and discovery:

```
1. GraphService → graph DB: "give me post IDs visible to user X in tier Y"
   → returns string[]
2. Prisma → Postgres: "SELECT * FROM posts WHERE id IN (...)"
   → returns full post objects with content, media, author info
3. Merge and return to client
```

This keeps graph queries fast (they return only IDs and scores) and keeps all content in Postgres where it benefits from full-text search, relational joins, and transactional guarantees.

---

## Consistency Guarantees

The graph DB is **eventually consistent** with Postgres. The maximum staleness window depends on the failure mode:

| Scenario | Staleness | Impact |
|----------|-----------|--------|
| Graph DB sync succeeds inline | < 50ms | Imperceptible |
| First retry succeeds | 100-400ms | Imperceptible |
| All inline retries fail, async succeeds | 1-30 seconds | A new post may be invisible in circles for a few seconds |
| Async retry needed (queue processing) | 5-60 seconds | Slightly delayed circle visibility |
| Graph DB down, queue backlog | Minutes | Graph features degraded; content still accessible via Postgres |

### Why this is acceptable

- Circle views do not need real-time precision. A post appearing 2-3 seconds late is imperceptible.
- A new relationship taking a few seconds to affect visibility is fine. The user can still see their own content immediately (Postgres query).
- Discovery queries are inherently non-urgent. Stale graph data does not cause incorrect results, just slightly outdated recommendations.
- Scoring updates are already batched (background job), so they tolerate graph DB staleness naturally.

### Own-Posts Postgres Fallback

When post sync to the graph DB fails (non-critical), the post is invisible in other users' circle views until the async retry succeeds. To prevent the author from perceiving their own content as "lost":

1. **Own-posts always visible via Postgres**: The circle query handler merges graph-resolved post IDs with the author's own recent posts (fetched directly from Postgres by `authorId`). The author always sees their own posts regardless of graph sync state.
2. **`graphSynced` flag**: The API response includes a `graphSynced: boolean` field on each post. Posts where `graphSynced: false` are shown to the author with a subtle "syncing..." indicator.
3. **Auto-retry**: The DualWriteService schedules an automatic retry 5 minutes after the initial failure (in addition to the SQS queue retry). This handles transient graph DB blips without waiting for queue processing.

This ensures the author never experiences invisible content while maintaining eventual consistency for other viewers.

### What would NOT be acceptable

- User deletes an entity, but it still appears in other users' circles for minutes. This is why entity deletion is a critical operation with inline retries.
- Ownership change fails silently, leaving stale permissions in the graph. This is why ownership sync is critical.

---

## Reconciliation

A full reconciliation rebuilds all graph DB state from Postgres. It is used for:

1. **Initial bootstrap**: Populate the graph DB from an existing Postgres database.
2. **Disaster recovery**: Rebuild after graph DB data loss.
3. **Periodic consistency check**: Detect and fix drift (scheduled daily). Daily cadence ensures deletion tombstones are resolved within GDPR "without undue delay" timelines.
4. **Development**: Reset the local Neo4j database to match Postgres state.

### Reconciliation Process

The `DualWriteService.reconcile()` method:

```
1. Clear all graph DB data (optional, for full rebuild)
2. Stream all Users from Postgres → syncUser for each
3. Stream all Entities from Postgres → syncEntity for each
4. Stream all EntityOwnership records → syncOwnership for each
5. Stream all Posts (with radius) → syncPost for each
6. Stream all PostSubjects → syncPostSubjects for each (batched by postId)
7. Verify counts match between Postgres and the graph DB
```

Key design decisions:
- Uses cursor-based pagination to avoid loading all records into memory.
- Processes in dependency order (users before entities before posts).
- Batches graph DB writes (e.g., 100 nodes per batch) to avoid overwhelming the connection.
- Reports progress and errors without aborting on individual failures.
- Maximum iteration count per table (circuit breaker) to prevent infinite loops.

### Consistency Check (without full rebuild)

A lighter-weight check that compares counts and samples:

```
1. Compare user count in Postgres vs graph DB
2. Compare entity count in Postgres vs graph DB
3. Sample 100 random entities, verify graph properties match Postgres
4. Report mismatches for targeted repair
```

---

## DualWriteService Placement

The `DualWriteService` sits between handlers and both databases:

```
Handler
  │
  ├─→ Prisma (Postgres) ─── source of truth
  │
  └─→ DualWriteService
        │
        ├─→ GraphService (AuraDB / local Neo4j) ─── graph projection
        │
        └─→ SQS (GRAPH_SYNC_QUEUE) ─── async retry on failure
```

Handlers call `DualWriteService` methods instead of calling `GraphService.sync*` directly. The `DualWriteService` handles:

- Calling the right `GraphService` sync method
- Inline retry with backoff
- Async queue fallback on failure
- Logging sync outcomes
- Critical vs non-critical operation distinction

Handlers are responsible for the Postgres write (via Prisma). The `DualWriteService` only handles the graph DB side. This keeps the Prisma transaction boundary clean and avoids mixing concerns.

---

## Env Integration

The `DualWriteService` needs:

- `GraphService` instance (injected, same as what handlers use for reads)
- `GRAPH_SYNC_QUEUE` (SQS queue, added to `Env`)
- Logger instance
- Configuration: retry count, backoff, critical operation list

No new environment variables are needed beyond the graph connection config (already in `Env` from P0.7) and the SQS queue URL (follows the existing `sqsUrl()` pattern in `env.ts`).
