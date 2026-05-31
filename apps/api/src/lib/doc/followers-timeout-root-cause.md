# Root Cause Analysis: "timeout exceeded when trying to connect"

## Error Origin

The error **"timeout exceeded when trying to connect"** comes from the **`pg` library (node-postgres)**, not from our code.

### Error Flow

```
1. followers-handler.ts calls createPrismaForRegion()
   ↓
2. createClientSync() creates pg.Pool with connectionTimeoutMillis: 5000
   ↓
3. Pool constructor completes (synchronously) - NO connection yet
   ↓
4. First query executed: db.follow.findUnique()
   ↓
5. Prisma → PrismaPg adapter → pg.Pool.query()
   ↓
6. Pool tries to acquire/establish connection to Hyperdrive
   ↓
7. Connection attempt hangs or times out after 5 seconds
   ↓
8. pg library throws: "timeout exceeded when trying to connect"
   ↓
9. Error caught in followers-handler.ts, logged, re-thrown
   ↓
10. Error caught in routes/followers.ts, sanitized, returned as 500
```

## Critical Discovery

**The connection is NOT established when the pool is created.** The connection is established **lazily on the first query**. This means:

- Pool creation: Synchronous, fast, no connection attempt
- First query: **This is when the actual connection happens** - and where it times out

## Where the Timeout Occurs

The timeout happens at **step 6** - when `pg.Pool` tries to establish a connection to the Hyperdrive connection string. The pool's `connectionTimeoutMillis: 5000` (5 seconds) is exceeded.

## Root Cause Hypotheses

1. **Hyperdrive connection string is invalid/unreachable**
   - Hyperdrive binding may not be properly configured
   - Connection string format may be incorrect
   - Hyperdrive service endpoint may be down

2. **Network connectivity issues**
   - Cloudflare Worker cannot reach Hyperdrive endpoint
   - DNS resolution failing
   - Firewall/security group blocking connection

3. **Hyperdrive service issues**
   - Hyperdrive service overloaded
   - Hyperdrive service down
   - Region-specific Hyperdrive issues

4. **Connection pool state**
   - Stale pool connections
   - Pool in bad state from previous failed attempts

## Enhanced Logging Added

To identify the exact root cause, I've added INFO-level logging that will show:

1. **Pool Creation**:
   - Whether Hyperdrive binding is available
   - Connection string source (HYPERDRIVE_BINDING vs DATABASE_URL)
   - Connection string prefix (sanitized)
   - Pool creation duration

2. **First Query (Connection Trigger)**:
   - Explicit log: "Executing FIRST database query (triggers connection)"
   - Operation details (findUnique, table: follow)
   - Success/failure with timing

3. **Connection Events**:
   - Pool 'connect' event (when connection succeeds)
   - Pool 'error' event (connection failures)
   - Pool 'acquire' event (when pool tries to get connection)

4. **Error Details**:
   - Full error message, code, name, stack trace
   - Whether it's a timeout vs connection error
   - Exact duration when timeout occurs

## Next Steps

1. **Deploy enhanced logging** (done - ready to deploy)
2. **Run test again** to capture detailed logs
3. **Check Cloudflare Dashboard** for Hyperdrive status
4. **Verify Hyperdrive binding** in wrangler.toml
5. **Review logs** to identify:
   - Is Hyperdrive binding available?
   - What connection string is being used?
   - Does pool creation succeed?
   - At what exact point does connection fail?
   - What's the exact error from pg library?

## Expected Log Output

With enhanced logging, we should see:

```
[INFO] [DatabaseConnectionManager] Pool creation starting
  - hasHyperdrive: true/false
  - connectionStringSource: HYPERDRIVE_BINDING or DATABASE_URL
  - connectionStringPrefix: postgresql://...

[INFO] [DatabaseConnectionManager] Pool constructor completed successfully
  - duration: <100ms (pool creation is fast)

[INFO] [DatabaseConnectionManager] Pool created - connection will be established on first query

[INFO] [FollowersHandler] Executing FIRST database query (triggers connection)
  - operation: findUnique
  - table: follow

[ERROR] [FollowersHandler] FIRST QUERY FAILED - Connection timeout likely occurred here
  - error: "timeout exceeded when trying to connect"
  - duration: ~5000ms (connection timeout)
  - isTimeout: true
```

This will definitively show where and why the timeout occurs.
