# Debugging Strategy: Followers Count Update Not Persisting

**Date:** 2025-01-XX  
**Status:** 🔍 Active Investigation  
**Issue:** Count updates execute within transaction but revert after commit

---

## Executive Summary

The followers count update executes successfully within a Prisma transaction (`rowsAffected: 1`, `updateMatches: true`), but reverts to the old value immediately after commit. This occurs specifically on the second follow operation (1→2), while the first (0→1) persists correctly.

**Key Pattern:**

- First transaction: 0 → 1 ✅ (persists)
- Second transaction: 1 → 2 ❌ (reverts to 1)

---

## Root Cause Hypotheses

Based on analysis of Hyperdrive, Prisma ORM, and Supabase documentation, here are the most likely causes:

### Hypothesis 1: Hyperdrive Connection Pooling Issue (HIGH PROBABILITY)

**Theory:** Hyperdrive maintains a global connection pool, and the raw SQL UPDATE might be executing on a different connection than the Prisma transaction, causing the update to be lost.

**Evidence:**

- Hyperdrive handles connection pooling globally
- Workers create fresh Pool instances per invocation
- Prisma uses `PrismaPg` adapter with `pg.Pool`
- The update executes (`rowsAffected: 1`) but doesn't persist

**Testing Strategy:**

1. Verify that `tx.$executeRaw` uses the same connection as the transaction
2. Add connection ID logging to track which connection executes the UPDATE
3. Check if Hyperdrive is routing the raw SQL to a different connection

### Hypothesis 2: Prisma Transaction Isolation with Raw SQL (MEDIUM PROBABILITY)

**Theory:** Prisma's `$executeRaw` within transactions may not properly participate in the transaction context when using driver adapters with Hyperdrive.

**Evidence:**

- Raw SQL executes successfully
- Update is visible within transaction
- Update reverts after commit
- Web search indicates known issues with `$executeRaw` in transactions on Cloudflare Workers

**Testing Strategy:**

1. Try using Prisma's `update` with explicit value instead of raw SQL
2. Verify transaction isolation level is actually applied
3. Check if `$executeRaw` requires special handling in Prisma transactions

### Hypothesis 3: Database Connection Lifecycle Issue (MEDIUM PROBABILITY)

**Theory:** The connection used for the transaction is being closed or reset before the commit completes, causing the update to be lost.

**Evidence:**

- `DatabaseConnectionManager` creates fresh clients per request
- Cleanup happens after query completion
- Post-commit read uses a different connection (via `executeQueryWithRetry`)

**Testing Strategy:**

1. Verify connection lifecycle: when is the connection closed?
2. Check if post-commit read uses the same connection as the transaction
3. Add connection ID tracking to verify connection reuse

### Hypothesis 4: Race Condition with Concurrent Operations (LOW PROBABILITY)

**Theory:** Another operation (unfollow, cleanup, etc.) is overwriting the count between commit and post-commit read.

**Evidence:**

- Test runs multiple operations in sequence
- Unfollow operations fail (suggesting data inconsistency)
- Multiple users in test might cause race conditions

**Testing Strategy:**

1. Add locking around count updates
2. Check for concurrent operations in logs
3. Verify no other code path updates `followersCount`

### Hypothesis 5: Supabase/PostgreSQL Transaction Behavior (LOW PROBABILITY)

**Theory:** Supabase's connection pooling or PostgreSQL configuration is causing transaction isolation issues.

**Evidence:**

- Using Supabase as database provider
- `ReadCommitted` isolation might have different behavior on Supabase
- Connection pooling at multiple levels (Hyperdrive + Supabase)

**Testing Strategy:**

1. Check Supabase connection pooler settings
2. Verify transaction isolation level is actually `Serializable`
3. Test with direct database connection (bypass Hyperdrive)

---

## Debugging Strategy

### Phase 1: Connection Tracking (HIGH PRIORITY)

**Goal:** Verify that the raw SQL UPDATE uses the same connection as the Prisma transaction.

**Implementation:**

1. Add connection ID logging to track which connection executes each operation
2. Log connection ID before transaction, during raw SQL, and after commit
3. Verify all operations use the same connection

**Code Changes:**

```typescript
// In transaction, before raw SQL:
const connectionId = await tx.$queryRaw`SELECT pg_backend_pid() as pid`;
logger.info("[FollowersHandler] Connection ID before raw SQL", {
  connectionId,
});

// After raw SQL:
const connectionIdAfter = await tx.$queryRaw`SELECT pg_backend_pid() as pid`;
logger.info("[FollowersHandler] Connection ID after raw SQL", {
  connectionIdAfter,
});

// Post-commit:
const postCommitConnectionId =
  await db.$queryRaw`SELECT pg_backend_pid() as pid`;
logger.info("[FollowersHandler] Post-commit connection ID", {
  postCommitConnectionId,
});
```

**Expected Outcome:**

- If connection IDs match: Connection is correct, investigate transaction isolation
- If connection IDs differ: Connection mismatch is the issue

### Phase 2: Transaction Isolation Verification (HIGH PRIORITY)

**Goal:** Verify that `Serializable` isolation is actually being applied and working correctly.

**Implementation:**

1. Query current transaction isolation level within transaction
2. Add explicit `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` before operations
3. Check for serialization failures in logs

**Code Changes:**

```typescript
await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
const isolationLevel = await tx.$queryRaw`SHOW transaction_isolation`;
logger.info("[FollowersHandler] Transaction isolation level", {
  isolationLevel,
});
```

**Expected Outcome:**

- If isolation level is `Serializable`: Isolation is correct, investigate other causes
- If isolation level is different: Prisma isn't applying the isolation level correctly

### Phase 3: Alternative Update Methods (MEDIUM PRIORITY)

**Goal:** Test if using Prisma's `update` with explicit value works better than raw SQL.

**Implementation:**

1. Read current count
2. Use Prisma `update` with explicit `followersCount: newValue` instead of raw SQL
3. Compare behavior

**Code Changes:**

```typescript
// Instead of raw SQL:
const currentUser = await tx.user.findUnique({
  where: { id: targetId },
  select: { followersCount: true },
});
await tx.user.update({
  where: { id: targetId },
  data: { followersCount: (currentUser?.followersCount || 0) + 1 },
});
```

**Expected Outcome:**

- If Prisma update works: Raw SQL has issues with transactions
- If Prisma update fails: Issue is with transaction itself, not raw SQL

### Phase 4: Connection Lifecycle Analysis (MEDIUM PRIORITY)

**Goal:** Verify when connections are created, used, and closed.

**Implementation:**

1. Add logging to `DatabaseConnectionManager.acquireClient()` and `cleanup()`
2. Track connection creation time and cleanup time
3. Verify connection is still open during post-commit read

**Code Changes:**

```typescript
// In database-connection-manager.ts
logger.info("[DatabaseConnectionManager] Client acquired", {
  region,
  timestamp: Date.now(),
  connectionString: connectionString.substring(0, 50) + "...",
});

// In cleanup:
logger.info("[DatabaseConnectionManager] Client cleanup starting", {
  region,
  timestamp: Date.now(),
});
```

**Expected Outcome:**

- If connection closes before commit: Connection lifecycle issue
- If connection stays open: Investigate other causes

### Phase 5: Direct Database Verification (LOW PRIORITY)

**Goal:** Verify what's actually in the database, bypassing all connection layers.

**Implementation:**

1. Connect directly to Supabase (bypass Hyperdrive)
2. Query `followers_count` immediately after transaction
3. Compare with Hyperdrive results

**Code Changes:**

```typescript
// Use DIRECT_DATABASE_URL to bypass Hyperdrive
const directClient = new Client({ connectionString: env.DIRECT_DATABASE_URL });
await directClient.connect();
const result = await directClient.query(
  "SELECT followers_count FROM users WHERE id = $1",
  [targetId],
);
logger.info("[FollowersHandler] Direct database query result", {
  followersCount: result.rows[0]?.followers_count,
});
```

**Expected Outcome:**

- If direct query shows correct value: Hyperdrive connection issue
- If direct query shows wrong value: Database/transaction issue

### Phase 6: Lock-Based Update (FALLBACK)

**Goal:** Use explicit row-level locking to prevent lost updates.

**Implementation:**

1. Use `SELECT ... FOR UPDATE` to lock the row
2. Update the count
3. Release lock on commit

**Code Changes:**

```typescript
// Lock the row first
await tx.$executeRaw`
  SELECT followers_count FROM users WHERE id = ${targetId} FOR UPDATE
`;

// Then update
await tx.$executeRaw`
  UPDATE users 
  SET followers_count = followers_count + 1 
  WHERE id = ${targetId}
`;
```

**Expected Outcome:**

- If locking fixes it: Confirms lost update issue
- If locking doesn't help: Issue is elsewhere

---

## Implementation Priority

1. **Phase 1: Connection Tracking** - Most likely to reveal the issue
2. **Phase 2: Transaction Isolation Verification** - Critical for understanding transaction behavior
3. **Phase 3: Alternative Update Methods** - Quick test to rule out raw SQL issues
4. **Phase 4: Connection Lifecycle Analysis** - Important for understanding cleanup timing
5. **Phase 5: Direct Database Verification** - Useful for isolating Hyperdrive vs database issues
6. **Phase 6: Lock-Based Update** - Fallback if all else fails

---

## Monitoring and Logging Requirements

### Required Logs

1. **Connection Tracking:**
   - Connection ID (pg_backend_pid) at transaction start
   - Connection ID during raw SQL execution
   - Connection ID at transaction commit
   - Connection ID during post-commit read

2. **Transaction State:**
   - Transaction isolation level (actual, not just configured)
   - Transaction start time
   - Transaction commit time
   - Any serialization failures

3. **Update Verification:**
   - Count before update (within transaction)
   - Count after update (within transaction)
   - Count immediately after commit (same connection)
   - Count after 100ms delay (post-commit read)

4. **Connection Lifecycle:**
   - Client acquisition time
   - Client cleanup time
   - Connection pool status

### Success Criteria

- All operations use the same connection ID
- Transaction isolation level is `Serializable`
- Count persists after commit
- No connection lifecycle issues

---

## Known Issues and Limitations

### Prisma + Hyperdrive + Transactions

- **Issue:** Prisma's `$executeRaw` in transactions may have connection consistency issues
- **Reference:** GitHub issues suggest problems with raw SQL in transactions on Cloudflare Workers
- **Workaround:** Use Prisma's `update` instead of raw SQL when possible

### Hyperdrive Connection Pooling

- **Issue:** Hyperdrive maintains global pool, but Worker creates fresh Pool per invocation
- **Impact:** Connection used for transaction might differ from connection used for post-commit read
- **Mitigation:** Verify connection reuse or use same connection for post-commit verification

### Transaction Isolation Levels

- **Issue:** `ReadCommitted` allows lost updates in concurrent scenarios
- **Fix Applied:** Changed to `Serializable` isolation
- **Risk:** Higher chance of serialization failures requiring retries

---

## Next Steps

1. ✅ **COMPLETED:** Changed isolation level to `Serializable`
2. **IMMEDIATE:** Implement Phase 1 (Connection Tracking)
3. **IMMEDIATE:** Implement Phase 2 (Transaction Isolation Verification)
4. **SHORT TERM:** Run test with new logging and analyze results
5. **MEDIUM TERM:** Implement Phase 3 if connection tracking doesn't reveal issue
6. **FALLBACK:** Implement Phase 6 (Lock-Based Update) if all else fails

---

## References

- [Prisma Driver Adapters Documentation](https://www.prisma.io/docs/orm/overview/databases/driver-adapters)
- [Cloudflare Hyperdrive + Prisma](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/prisma-orm/)
- [Prisma Raw SQL in Transactions](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries)
- [PostgreSQL Transaction Isolation Levels](https://www.postgresql.org/docs/current/transaction-iso.html)
- [Hyperdrive Connection Lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/)
