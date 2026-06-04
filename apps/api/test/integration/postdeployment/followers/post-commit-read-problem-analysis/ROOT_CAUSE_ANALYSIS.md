# Root Cause Analysis: Followers Count Update Not Persisting

**Date:** 2025-01-XX  
**Status:** ✅ **ROOT CAUSE IDENTIFIED**  
**Issue:** Count updates correctly within transaction but reverts after commit

---

## Executive Summary

After systematic debugging through 3 phases, the root cause has been identified:

**The count is CORRECT (2) immediately before the transaction returns, but reverts to 1 AFTER the transaction commits.**

This occurs between:

- Transaction callback returning (count = 2 ✅)
- Post-commit read (100ms delay, count = 1 ❌)

**Timeline:**

1. Transaction updates count: 1 → 2 ✅
2. Count verified within transaction: 2 ✅
3. **Count verified IMMEDIATELY before transaction return: 2 ✅**
4. Transaction commits successfully ✅
5. **Post-commit read (100ms delay): count = 1 ❌**

---

## Debugging Process

### Phase 1: Connection Tracking ✅ COMPLETE

**Hypothesis:** Different connections used for transaction vs post-commit read

**Findings:**

- ✅ All operations use the same connection ID (`1550918`)
- ✅ `connectionIdMatches: true` at all checkpoints
- ✅ Connection mismatch is NOT the issue

**Conclusion:** Connection consistency is correct.

### Phase 2: Transaction Isolation Verification ✅ COMPLETE

**Hypothesis:** Transaction isolation level not being applied correctly

**Findings:**

- ✅ Transaction isolation level: `"serializable"` (correct)
- ✅ Isolation level is being applied correctly
- ✅ Isolation level is NOT the issue

**Conclusion:** Transaction isolation is correctly configured.

### Phase 3: Alternative Update Methods ✅ COMPLETE

**Hypothesis:** Raw SQL has issues with Prisma transactions

**Findings:**

- ✅ Tested both raw SQL UPDATE and Prisma `update` method
- ✅ Both methods show the same behavior
- ✅ Count updates correctly within transaction
- ✅ Count reverts after commit (both methods)
- ✅ Update method is NOT the issue

**Conclusion:** The issue is not specific to raw SQL or Prisma update.

### Phase 4: Count Verification Before Transaction Return ✅ COMPLETE

**Hypothesis:** Count reverts during transaction commit

**Critical Finding:**

- ✅ Count is CORRECT (2) immediately before transaction returns
- ✅ `countBeforeReturn: 2, expectedCount: 2, countStillCorrect: true`
- ✅ Both Prisma and raw SQL show count = 2 before return
- ❌ Count reverts to 1 AFTER transaction commits (post-commit read)

**Conclusion:** The count reverts AFTER the transaction commits, not during.

---

## Root Cause: Post-Commit Count Reversion

### Technical Context

**Database Stack:**

- **Database:** PostgreSQL (via Supabase)
- **Connection Layer:** Cloudflare Hyperdrive (connection pooling/acceleration)
- **ORM:** Prisma with Driver Adapters (`@prisma/adapter-pg`)
- **Transaction Isolation:** `Serializable` (highest level)
- **Connection Pooling:** Hyperdrive global pool (shared across Worker invocations)
- **Environment:** Cloudflare Workers (serverless, stateless)

**Transaction Flow:**

1. Transaction starts with `Serializable` isolation
2. Count update executed (Prisma `update` or raw SQL)
3. Count verified within transaction (correct)
4. Transaction commits successfully
5. Post-commit read creates NEW Prisma client via `executeQueryWithRetry`
6. Post-commit read shows old value (reverted)

**Code Flow:**

```typescript
// Inside transaction
await db.$transaction(async (tx) => {
  // 1. Update count
  await tx.user.update({
    where: { id: targetId },
    data: { followersCount: expectedNewCount },
  });

  // 2. Verify count (correct: 2)
  const user = await tx.user.findUnique({...});
  // user.followersCount === 2 ✅

  // 3. Verify immediately before return (correct: 2)
  const countBeforeReturn = await tx.user.findUnique({...});
  // countBeforeReturn === 2 ✅

  return follow;
}, { isolationLevel: 'Serializable' });

// 4. Transaction commits ✅

// 5. Post-commit read (NEW client)
const postCommitCount = await this.executeQueryWithRetry(
  region, env,
  async (db) => {
    const user = await db.user.findUnique({...});
    // user.followersCount === 1 ❌ (should be 2!)
  }
);
```

### Evidence

**Second Transaction (The Failing One) - Complete Timeline:**

1. **Transaction Start:**
   - Initial count: `followersCount: 1` ✅
   - Connection ID: `1550918`
   - Isolation level: `"serializable"` ✅

2. **Count Update:**
   - Prisma update: `newCount: 2, updateMatches: true` ✅
   - Count verification passed: `count: 2` ✅

3. **IMMEDIATELY Before Transaction Return:**

   ```
   prismaCount: 2 ✅
   rawSqlCount: 2 ✅
   expectedCount: 2 ✅
   countsMatch: true ✅
   expectedMatches: true ✅
   ```

4. **Transaction About to Return:**

   ```
   countBeforeReturn: 2 ✅
   expectedCount: 2 ✅
   countStillCorrect: true ✅
   ```

5. **Transaction Commits:**
   - `Transaction committed successfully` ✅

6. **Post-Commit Read (100ms delay):**
   ```
   prismaCount: 1 ❌ (should be 2!)
   rawSqlCount: 1 ❌ (should be 2!)
   postCommitCount: 1, expectedCount: 2, countMatches: false ❌
   ```

### Key Insight

**The count is CORRECT (2) at the moment the transaction is about to commit, but reverts to 1 AFTER commit completes.**

This means:

- ✅ The transaction update is working correctly
- ✅ The count is persisted during transaction
- ❌ **Something between transaction commit and post-commit read is resetting the count**

---

## Possible Causes

### Hypothesis 1: Database Trigger or Constraint ✅ RULED OUT

**Theory:** A database trigger or constraint is resetting `followersCount` after the transaction commits.

**Investigation:**

- ✅ Checked database setup script (`setup-database-with-constraints.ts`)
- ✅ Only trigger found: `validate_follow_target_trigger` (validates target exists, does NOT modify count)
- ✅ No constraints found that modify `followers_count`
- ✅ No functions found that reset the count

**Conclusion:** Database triggers/constraints are NOT the cause.

### Hypothesis 2: Concurrent Operation Overwriting Count (MEDIUM PROBABILITY)

**Theory:** Another operation (unfollow, cleanup, test cleanup, etc.) is overwriting the count between commit and post-commit read.

**Evidence:**

- Test runs multiple operations in sequence
- Unfollow operations fail (suggesting data inconsistency)
- 109ms window between commit and post-commit read
- First transaction (0→1) persists correctly
- Second transaction (1→2) reverts to 1 (suggesting something resets it to 1)

**Detailed Analysis:**

**Pattern Observed:**

- First follow: 0 → 1 ✅ (persists)
- Second follow: 1 → 2 → **reverts to 1** ❌

This suggests:

- Something is resetting the count to 1 after the second transaction
- Could be test cleanup code
- Could be an unfollow operation running concurrently
- Could be a database constraint/trigger that wasn't found

**Testing Strategy:**

1. Check logs for concurrent operations on the same user between timestamps:
   - `1765692481445` (commit) to `1765692481558` (post-commit read)
2. Add explicit row locking (`SELECT ... FOR UPDATE`) around count updates
3. Remove delay completely (already done) to minimize window
4. Add logging to track all operations on the target user
5. Check test cleanup code for operations that might reset counts

### Hypothesis 3: Prisma Transaction Snapshot Issue (MEDIUM PROBABILITY)

**Theory:** The post-commit read uses a different transaction snapshot, even though it's the same connection.

**Evidence:**

- Post-commit read uses NEW `executeQueryWithRetry` call (new Prisma client)
- Even though connection ID matches (`1550918`), it might be a different transaction context
- PostgreSQL `Serializable` isolation uses snapshot isolation
- New Prisma client might start a new transaction with a different snapshot

**PostgreSQL Serializable Isolation Behavior:**

With `Serializable` isolation:

- Each transaction sees a consistent snapshot of the database
- Changes are visible only after commit
- However, if a new transaction starts immediately after commit, it should see the committed changes
- **Exception:** If there's a serialization conflict, PostgreSQL might roll back one transaction

**Prisma Client Behavior:**

- Each `executeQueryWithRetry` call creates a NEW Prisma client instance
- New client = new connection from pool = potentially new transaction context
- Even with same connection ID, the transaction snapshot might differ

**Testing Strategy:**

1. Use the same Prisma client instance for post-commit read (don't create new client)
   - Problem: Transaction client is scoped to transaction callback
   - Solution: Store client reference outside transaction, reuse for post-commit read
2. Read count immediately after commit without delay (already done)
3. Check if using `db.$transaction` for post-commit read helps (creates new transaction, might have same issue)
4. Try reading count using raw SQL with explicit transaction:
   ```sql
   BEGIN;
   SELECT followers_count FROM users WHERE id = $1;
   COMMIT;
   ```
5. Check PostgreSQL transaction logs for serialization failures

### Hypothesis 4: Hyperdrive Connection Pooling/Caching (MEDIUM PROBABILITY)

**Theory:** Hyperdrive's connection pooling is causing the post-commit read to use a different database snapshot or read from a cached/stale connection.

**Evidence:**

- Hyperdrive maintains global connection pool
- Post-commit read creates new Prisma client
- Connection ID matches (`1550918`), but Hyperdrive might be:
  - Routing to a different underlying connection
  - Using a cached query result (returning stale SELECT results)
  - Using connection multiplexing (same connection, different transaction context)
  - Using a connection with a different transaction context

**Hyperdrive Behavior:**

- Hyperdrive acts as a proxy between Cloudflare Workers and PostgreSQL
- It maintains a connection pool and may route queries to different connections
- Even if `pg_backend_pid()` shows the same ID, Hyperdrive might be:
  - Using connection multiplexing (multiple transactions on same connection)
  - Caching query results (returning stale SELECT results)
  - Routing queries to different underlying connections in the pool

**Testing Strategy:**

1. Bypass Hyperdrive for post-commit read (use direct connection via `DIRECT_DATABASE_URL`)
2. Verify if direct connection shows correct value
3. Add explicit `SELECT ... FOR UPDATE` to force write connection and prevent caching
4. Check if Hyperdrive has query caching enabled that might return stale results
5. Compare connection strings: Hyperdrive vs Direct
6. Check Hyperdrive logs/metrics for query routing and caching behavior

---

## Additional Technical Details

### PostgreSQL Transaction Behavior

**Serializable Isolation Level:**

- Uses snapshot isolation
- Each transaction sees a consistent snapshot
- Changes visible only after commit
- Prevents phantom reads, non-repeatable reads, and lost updates
- **However:** If two transactions conflict, one may be rolled back with `SerializationFailure`

**Transaction Commit Process:**

1. All changes written to WAL (Write-Ahead Log)
2. Transaction marked as committed
3. Changes become visible to other transactions
4. **Timing:** Commit is atomic, but visibility might have slight delay

**Possible Issue:**

- If post-commit read starts a new transaction immediately after commit
- The new transaction might use a snapshot from before the commit
- This is unlikely with `Serializable` but possible with connection pooling

### Prisma Transaction Behavior

**Transaction Lifecycle:**

1. `db.$transaction()` starts transaction
2. All operations within callback use same transaction context
3. Transaction commits when callback completes successfully
4. Transaction client is scoped to callback (cannot reuse outside)

**Post-Commit Read:**

- Creates NEW Prisma client via `executeQueryWithRetry`
- New client = new connection from pool
- New connection = potentially new transaction context
- Even with same connection ID, transaction snapshot might differ

### Hyperdrive Considerations

**Connection Pooling:**

- Hyperdrive maintains global connection pool
- Connections are reused across Worker invocations
- Query routing might differ between write and read operations
- **Note:** No read replicas configured, so all queries go to primary database

**Possible Issues:**

1. **Query Caching:** Hyperdrive might cache query results, returning stale data (HIGHEST PROBABILITY)
2. **Connection Multiplexing:** Same connection ID might represent different underlying connections or transaction contexts
3. **Transaction Context:** New connection might have different transaction isolation settings
4. **Connection Pool Routing:** Hyperdrive might route read queries differently than write queries

### Test Environment Considerations

**Test Execution:**

- Tests run sequentially but may have overlapping cleanup
- Test cleanup might run concurrently with post-commit read
- Multiple test users might cause interference
- Database state might be modified by other test operations

**Observed Pattern:**

- First transaction (0→1): ✅ Persists
- Second transaction (1→2): ❌ Reverts to 1

This suggests:

- Something resets count to 1 after second transaction
- Could be test cleanup
- Could be unfollow operation
- Could be database constraint/trigger (ruled out)

## Next Steps

### Immediate Actions

1. ✅ **COMPLETED**: Checked for Database Triggers - None found that modify count
2. ✅ **COMPLETED**: Removed 100ms delay before post-commit read
3. ✅ **COMPLETED**: Added count verification before transaction return (confirms count is correct)
4. **TODO**: Add explicit row locking (`SELECT ... FOR UPDATE`) during count update
5. **TODO**: Check for concurrent operations (unfollow, cleanup) that might overwrite count
6. **TODO**: Try reading count using direct database connection (bypass Hyperdrive)
7. ✅ **RULED OUT**: Read replica lag (no read replicas configured)
8. **TODO**: Add logging to track all operations on target user between commit and post-commit read
9. **TODO**: Check PostgreSQL logs for serialization failures or transaction rollbacks
10. **TODO**: Verify if using same Prisma client instance (outside transaction) helps

### Recommended Fix

**Option 1: Use Same Client for Post-Commit Read (RECOMMENDED)**

Instead of creating a new Prisma client via `executeQueryWithRetry`, read the count using the same client that was used for the transaction:

```typescript
// After transaction commits, but before creating new client
const postCommitCount = await db.user.findUnique({
  where: { id: targetId },
  select: { followersCount: true },
});
```

**Option 2: Remove Delay and Read Immediately**

Remove the 100ms delay and read immediately after transaction:

```typescript
// Remove delay
// await new Promise((resolve) => setTimeout(resolve, 100));

// Read immediately
const postCommitCount = await this.executeQueryWithRetry(...);
```

**Option 3: Add Explicit Row Locking**

Lock the row during update to prevent concurrent modifications:

```typescript
// Lock row first
await tx.$executeRaw`
  SELECT followers_count FROM users WHERE id = ${targetId} FOR UPDATE
`;

// Then update
await tx.user.update({
  where: { id: targetId },
  data: { followersCount: expectedNewCount },
});
```

---

## Summary

**Root Cause:** Count reverts AFTER transaction commits, between transaction return and post-commit read.

**Timeline:**

- Before transaction return: count = 2 ✅
- After transaction commit: count = 1 ❌
- Time window: 109ms between commit and post-commit read

**Key Evidence:**

1. ✅ Count is correct (2) immediately before transaction returns
2. ✅ Transaction commits successfully
3. ✅ Same connection ID used throughout (`1550918`)
4. ✅ Serializable isolation applied correctly
5. ❌ Post-commit read shows old value (1) via both Prisma and raw SQL
6. ❌ Count reverts within 109ms after commit

**ROOT CAUSE IDENTIFIED:** ✅ **Hypothesis 3 - Transaction Snapshot Issue**

**Evidence from Latest Test Run (with Row Locking):**

**Second Transaction (1→2) with Row Locking:**

- Row locked with `SELECT FOR UPDATE` ✅
- Count updated: `newCount: 2` ✅
- Count before return: `2` ✅
- Transaction committed ✅
- **Post-commit read: `prismaCount: 1, rawSqlCount: 1` ❌ (should be 2!)**
- **Connection ID mismatch: `connectionId: 1551928` vs `transactionConnectionId: 1551929`** ❌
- **`recentFollowsCount: 1`** - only shows first follow, second follow not visible ❌

**Root Cause Confirmed:**

**Each `executeQueryWithRetry` call creates a NEW Prisma client with a NEW connection from Hyperdrive's pool. Even though the transaction committed successfully, the new connection uses a different transaction snapshot that doesn't see the committed changes yet.**

**Why This Happens:**

1. Transaction uses connection `1551929` and commits successfully
2. Post-commit read creates NEW Prisma client via `executeQueryWithRetry`
3. New client gets connection `1551928` from Hyperdrive pool
4. New connection starts a new transaction with a snapshot that was taken before the commit was fully visible
5. Even with `ReadCommitted` isolation, there's a brief window where the new transaction snapshot doesn't include the just-committed changes

**Why Row Locking Didn't Fix It:**

- Row locking prevents concurrent modifications DURING the transaction
- But it doesn't help with read-after-write consistency AFTER the transaction commits
- The issue is that the NEW connection's transaction snapshot doesn't see the committed changes

**Why `recentFollows` Only Shows 1 Follow:**

- The `recentFollows` query runs on the new connection (1551928)
- This connection's transaction snapshot doesn't see the second follow that was just committed
- This confirms it's a transaction snapshot issue, not a count update issue

4. **Hyperdrive connection multiplexing** (LOW PROBABILITY)
   - Same connection ID but different transaction contexts
   - Hyperdrive routing queries to different underlying connections
   - Less likely but possible with connection pooling

**Recommended Fix:** ✅ **IMPLEMENTED AND VERIFIED**

**Solution: Use Transaction for Post-Commit Read**

**Implementation:**

```typescript
// Read using a transaction to ensure we see committed changes
const postCommitCount = await this.executeQueryWithRetry(
  region,
  env,
  async (db) => {
    return await db.$transaction(
      async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: targetId },
          select: { followersCount: true },
        });
        const rawResult = await tx.$queryRaw<
          Array<{ followers_count: number }>
        >`SELECT followers_count FROM users WHERE id = ${targetId}`;
        return rawResult[0]?.followers_count ?? user?.followersCount;
      },
      {
        isolationLevel: "ReadCommitted", // Read committed data (should see the committed transaction)
        timeout: 5000,
      },
    );
  },
);
```

**Why This Works:**

- Uses proper transaction context for the read
- `ReadCommitted` isolation ensures we see all committed changes
- No artificial delays required
- Eliminates transaction snapshot visibility issues

**Verification Results:**

✅ **FIX VERIFIED - All tests passing!**

**Second Transaction (1→2) Results:**

- `recentFollowsCount: 2` ✅ (both follows visible)
- `prismaCount: 2, rawSqlCount: 2` ✅ (count correct)
- `postCommitCount: 2, expectedCount: 2, countMatches: true` ✅
- `connectionIdMatches: true` ✅ (same connection)
- `method: "hyperdrive_transaction"` ✅

**Comparison:**

- **Before:** Count reverted to 1, different connections, second follow not visible
- **After:** Count persists correctly, same connection, both follows visible

**Status:** ✅ **ROOT CAUSE FIXED - Transaction-based read solves the issue!**
