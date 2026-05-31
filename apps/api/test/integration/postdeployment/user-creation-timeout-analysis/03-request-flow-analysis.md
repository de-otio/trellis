# Request Flow Analysis

## Complete Request Path

```
Test Runner (Node.js)
  ↓ HTTP POST /api/admin/test/users
  ↓ [8-10s timeout]
Cloudflare Worker (worker-handler.ts)
  ↓ Route Handler (admin.ts)
  ↓ DataRouter.createUser()
  ↓ DatabaseConnectionManager.executeWithRetry()
  ↓ Hyperdrive Connection Pool
  ↓ PostgreSQL Database
```

## Detailed Flow Breakdown

### 1. Test Client Request (`test-auth.ts:530-607`)

```typescript
const response = await fetch(`${API_URL}/api/admin/test/users`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id, email, role, region, dataRegion }),
  signal: controller.signal, // AbortController with 8-10s timeout
});
```

**Potential Delays:**

- Network latency to Cloudflare Worker (varies by location)
- DNS resolution for API URL
- TLS handshake (if HTTPS)
- Request serialization

**Estimated Time:** 50-200ms (normal), 500ms-2s (high latency)

### 2. Worker Request Handler (`worker-handler.ts:36-339`)

```typescript
static async handleFetch(request, env, ctx): Promise<Response> {
  // Request-level timeout: 25 seconds
  // Budget guard check
  // Circuit breaker check
  // Route matching
  // Handler execution
}
```

**Potential Delays:**

- Budget guard check (SSM parameter lookup if needed)
- Circuit breaker evaluation
- Route matching (minimal)
- Handler initialization

**Estimated Time:** 10-50ms (normal), 100-500ms (if SSM lookup needed)

### 3. Admin Route Handler (`admin.ts:45-186`)

```typescript
handler: async (request, env) => {
  // Environment check (dev/test only)
  // Request body parsing
  // Test user detection
  // Region assignment (fast path for test users)
  // DataRouter.createUser()
};
```

**Potential Delays:**

- JSON parsing (minimal)
- Test user detection (string matching - minimal)
- Region assignment (uses DEFAULT_REGION for test users - minimal)

**Estimated Time:** 5-20ms

### 4. DataRouter.createUser (`data-router.ts:340-527`)

```typescript
static async createUser(userData, region, env, request?, requestId?) {
  // Region validation
  // Test user detection
  // Database write with retry
  // Data region verification
  // Audit logging (fire-and-forget)
}
```

**Potential Delays:**

- Region validation (minimal)
- Database write operation (see below)
- Data region verification (database read - minimal)

**Estimated Time:** 100-2000ms (depends on database write)

### 5. Database Write Operation (`data-router.ts:384-471`)

```typescript
const user = await sharedDatabaseConnectionManager.executeWithRetry(
  region,
  env,
  async (db) => {
    if (isTestUser) {
      try {
        return await db.user.create({ ... }); // Fast path
      } catch (createError) {
        if (createError.code === 'P2002') {
          // Fall back to upsert
        }
      }
    }
    return await db.user.upsert({ ... });
  },
  {
    timeoutMs: isTestUser ? testUserTimeoutMs : 3000,
    retryTimeoutMs: isTestUser ? testUserRetryTimeoutMs : 1000,
    maxRetries: isTestUser ? testUserMaxRetries : 1,
  }
);
```

**Potential Delays:**

- Connection pool acquisition
- Hyperdrive connection establishment
- Database query execution
- Transaction commit
- Retry logic (if needed)

**Estimated Time:** 200-1500ms (normal), 2000-8000ms (under load/retry)

### 6. Database Connection Manager (`database-connection-manager.ts:258-759`)

```typescript
acquireClient(region, env): ManagedClient {
  // Resolve connection strings
  // Create connection pool (1 connection max)
  // Create Prisma client with adapter
}

executeWithRetry(region, env, queryFn, options) {
  // Acquire client (creates new pool each time)
  // Execute query with timeout
  // Retry on connection errors
  // Cleanup pool
}
```

**Potential Delays:**

- Connection string resolution (minimal)
- Pool creation (50-200ms)
- Hyperdrive connection (100-500ms)
- Query execution (100-1000ms)
- Pool cleanup (10-50ms)

**Estimated Time:** 260-1750ms (normal), 2000-5000ms (connection issues)

## Total Time Estimate

**Normal Case:**

- Network: 50-200ms
- Worker: 10-50ms
- Route: 5-20ms
- DataRouter: 100-2000ms
- Database: 260-1750ms
- **Total: 425ms - 3,970ms**

**Worst Case (with contention):**

- Network: 500ms-2s
- Worker: 100-500ms
- Route: 5-20ms
- DataRouter: 100-2000ms
- Database: 2000-5000ms (connection issues)
- **Total: 2,705ms - 9,520ms** ← **Exceeds 8-10s timeout**

---

**See also:**

- [Root Cause Analysis](./04-root-cause-analysis.md)
- [Timeout Breakdown](./05-timeout-breakdown.md)
- [Recommendations](./06-recommendations.md)
