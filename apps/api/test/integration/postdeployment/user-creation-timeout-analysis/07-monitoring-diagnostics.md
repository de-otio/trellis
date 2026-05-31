# Monitoring and Diagnostics

## Key Metrics to Track

### 1. User Creation Duration

**Location:** `admin.ts:144-155` (already logging)

```typescript
const userCreationStartTime = Date.now();
const createdUser = await DataRouter.createUser(...);
const userCreationDuration = Date.now() - userCreationStartTime;
logger.debug('[UserCreation] User creation completed', {
  duration: userCreationDuration,
  userId: createdUser.id,
  region,
  isTestUser,
});
```

**Track:**

- p50, p95, p99 percentiles
- Average duration
- Max duration

**Alert:** If p95 > 5 seconds

---

### 2. Database Write Duration

**Location:** `data-router.ts:383-478` (already logging)

```typescript
const dbWriteStartTime = Date.now();
const user = await sharedDatabaseConnectionManager.executeWithRetry(...);
const dbWriteDuration = Date.now() - dbWriteStartTime;
logger.debug('[UserCreation] Database write completed', {
  duration: dbWriteDuration,
  userId: user.id,
  region,
  isTestUser,
});
```

**Track:**

- p50, p95, p99 percentiles
- Average duration
- Max duration

**Alert:** If p95 > 2 seconds

---

### 3. Connection Pool Statistics

**Location:** `database-connection-manager.ts:75-134` (already logging)

```typescript
private logPoolStats(region: string, pool: Pool): void {
  const stats = {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: this.POOL_MAX_CONNECTIONS,
  };
  // Log and record metrics
}
```

**Track:**

- Waiting connections count
- Pool exhaustion events
- Total connections
- Idle connections

**Alert:** If waiting connections > 0

---

### 4. Connection Acquisition Time

**Location:** `database-connection-manager.ts:410-424` (already logging)

```typescript
const clientAcquisitionStartTime = Date.now();
const { client, cleanup } = this.acquireClient(region, env);
const clientAcquisitionTime = Date.now() - clientAcquisitionStartTime;

if (clientAcquisitionTime > 50) {
  this.logger.debug("[DatabaseConnectionManager] Client acquisition time", {
    region,
    durationMs: clientAcquisitionTime,
    ...context,
  });
}
```

**Track:**

- p50, p95, p99 percentiles
- Average duration
- Max duration

**Alert:** If p95 > 500ms

---

### 5. Test Client Timeout Failures

**Location:** `test-auth.ts:598-603` (error thrown)

```typescript
if (error.name === "AbortError") {
  throw new Error(
    `Test user creation timed out after ${REQUEST_TIMEOUT_MS}ms. ` +
      `This indicates a performance issue with user creation. ` +
      `Check API logs and database connectivity.`,
  );
}
```

**Track:**

- Failure rate
- Failure patterns
- Timeout duration distribution

**Alert:** If failure rate > 1%

---

## Diagnostic Queries

### Check Connection Pool Status

```typescript
const poolStatus = databaseConnectionManager.getPoolStatus();
console.log("Pool Status:", poolStatus);
```

**Output:**

```json
[
  {
    "key": "EU",
    "totalCount": 1,
    "idleCount": 0,
    "waitingCount": 2,
    "age": 5000,
    "errorCount": 0
  }
]
```

**Interpretation:**

- `waitingCount > 0`: Pool is exhausted
- `idleCount === 0 && totalCount === max`: All connections in use
- `errorCount > 0`: Connection errors occurring

---

### Check Database Performance

```sql
-- Check slow queries
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
WHERE query LIKE '%user%'
ORDER BY mean_exec_time DESC
LIMIT 10;
```

**Output:**

```
query                                    | mean_exec_time | calls
-----------------------------------------+----------------+-------
INSERT INTO "User" (...)                 | 1234.56        | 100
SELECT * FROM "User" WHERE id = $1      | 45.67          | 1000
```

**Interpretation:**

- `mean_exec_time > 1000`: Query is slow
- High `calls` with slow `mean_exec_time`: Performance issue
- Look for queries related to user creation

---

### Check Connection Counts

```sql
-- Check active connections
SELECT count(*) as active_connections
FROM pg_stat_activity
WHERE state = 'active';
```

**Output:**

```
active_connections
------------------
5
```

**Interpretation:**

- High connection count: May indicate connection pool issues
- Compare with `POOL_MAX_CONNECTIONS` setting
- Check for connection leaks

---

### Check Database Locks

```sql
-- Check for blocking queries
SELECT
  blocked_locks.pid AS blocked_pid,
  blocking_locks.pid AS blocking_pid,
  blocked_activity.query AS blocked_query,
  blocking_activity.query AS blocking_query
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

**Interpretation:**

- Blocking queries: May cause timeouts
- Long-running queries: May indicate performance issues

---

## Monitoring Dashboard

### Key Metrics to Display

1. **User Creation Success Rate**
   - Target: >99%
   - Alert: <99%

2. **Average User Creation Time**
   - Target: <2 seconds
   - Alert: >3 seconds

3. **P95 User Creation Time**
   - Target: <5 seconds
   - Alert: >7 seconds

4. **P99 User Creation Time**
   - Target: <8 seconds
   - Alert: >10 seconds

5. **Connection Pool Exhaustion Events**
   - Target: 0
   - Alert: >0

6. **Timeout Failure Rate**
   - Target: <1%
   - Alert: >1%

---

## Log Analysis

### Key Log Patterns to Search For

1. **Timeout Errors:**

   ```
   "Test user creation timed out after"
   ```

2. **Connection Pool Exhaustion:**

   ```
   "Pool exhausted - all connections in use"
   ```

3. **Connection Errors:**

   ```
   "Connection error in runAttempt"
   ```

4. **Slow Queries:**

   ```
   "Slow query detected"
   ```

5. **Retry Success:**
   ```
   "Retry succeeded"
   ```

---

## Performance Baselines

### Before Fixes

- Average user creation time: 1-3 seconds
- P95 user creation time: 5-8 seconds
- P99 user creation time: 8-12 seconds
- Timeout failure rate: 5-10%

### After Fixes (Expected)

- Average user creation time: <2 seconds
- P95 user creation time: <5 seconds
- P99 user creation time: <8 seconds
- Timeout failure rate: <1%

---

**See also:**

- [Test Plan](./08-test-plan.md)
- [Recommendations](./06-recommendations.md)
- [Conclusion](./09-conclusion.md)
