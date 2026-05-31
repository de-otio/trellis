# Timeout Configuration

## Current Timeout Settings

### Test Client (`test-auth.ts`)

```typescript
const REQUEST_TIMEOUT_MS = isCI ? 10000 : 8000; // 10s in CI, 8s locally
```

### Database Operation (`data-router.ts`)

```typescript
const testUserTimeoutMs = isCI ? 1500 : 800; // 1.5s in CI, 0.8s locally
const testUserRetryTimeoutMs = isCI ? 500 : 300; // 0.5s in CI, 0.3s locally
const testUserMaxRetries = isCI ? 1 : 0; // 1 retry in CI, 0 locally
```

### Worker Request Timeout (`worker-handler.ts`)

```typescript
private static readonly REQUEST_TIMEOUT_MS = 25000; // 25 seconds
```

### Database Connection Timeout (`database-connection-manager.ts`)

```typescript
private readonly DEFAULT_CONNECTION_TIMEOUT_MS = 1000; // 1 second
private readonly DEFAULT_STATEMENT_TIMEOUT_MS = 5000; // 5 seconds
```

## Timeout Hierarchy

The timeout hierarchy shows which timeout is being hit:

1. **Test Client Timeout (8-10s)** ← **FAILING HERE**
   - HTTP request from test runner to Cloudflare Worker
   - Aborts the fetch request if no response received

2. **Worker Request Timeout (25s)**
   - Worker-level timeout (not being hit - request fails before this)

3. **Database Connection Timeout (1s)**
   - Time to establish database connection

4. **Database Statement Timeout (5s)**
   - Time for individual database queries

5. **Database Operation Timeout (0.8-1.5s)**
   - Timeout for test user creation database operations

## Timeout Flow

```
Test Client (8-10s) ← FAILING
  ↓
Worker Handler (25s) - Not reached
  ↓
Database Connection (1s)
  ↓
Database Statement (5s)
  ↓
Database Operation (0.8-1.5s)
```

## Issues with Current Configuration

1. **Test Client Timeout (8-10s) is too short**
   - Doesn't account for connection pool contention
   - Doesn't allow for retries
   - Network latency can compound delays

2. **Connection Timeout (1s) is too aggressive**
   - Hyperdrive connections can take 100-500ms
   - Under load, may take longer
   - No buffer for connection establishment

3. **Database Operation Timeout (0.8-1.5s) is too short**
   - Database writes can take 500-2000ms under load
   - Retry logic adds additional time
   - No buffer for slow queries

---

**See also:**

- [Request Flow Analysis](./03-request-flow-analysis.md)
- [Root Cause Analysis](./04-root-cause-analysis.md)
- [Recommendations](./06-recommendations.md)
