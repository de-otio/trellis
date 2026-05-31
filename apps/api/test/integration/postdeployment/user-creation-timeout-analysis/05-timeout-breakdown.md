# Timeout Breakdown (Worst Case)

## Scenario: Connection Pool Exhaustion + Retry

### Step-by-Step Timing

1. **Test Client Request Start:** 0ms
2. **Network Latency:** 100-500ms
3. **Worker Processing:** 10-50ms
4. **Route Handler:** 5-20ms
5. **DataRouter Processing:** 10-50ms
6. **Connection Pool Acquisition (WAIT):** 0-1000ms (connection timeout)
7. **Hyperdrive Connection:** 100-500ms
8. **Database Query (CREATE):** 200-2000ms
9. **Query Timeout (if slow):** +800ms (testUserTimeoutMs)
10. **Retry Delay:** 300-500ms
11. **Retry Connection:** 100-500ms
12. **Retry Query:** 200-2000ms
13. **Response Serialization:** 10-50ms
14. **Network Latency (Response):** 100-500ms

### Total Worst Case

**Base Case:** 2,435ms - 7,520ms

**With Connection Pool Contention:**

- If connection not available: +1000ms (connection timeout)
- Retry connection: +500ms
- **Total:** 3,935ms - 9,020ms

**With Multiple Retries:**

- Each retry adds 1,000-2,000ms
- **Total:** Can easily exceed 8-10 seconds

## Timing Breakdown Table

| Step                     | Normal          | With Contention   | With Retry        |
| ------------------------ | --------------- | ----------------- | ----------------- |
| Network (request)        | 50-200ms        | 100-500ms         | 100-500ms         |
| Worker Processing        | 10-50ms         | 10-50ms           | 10-50ms           |
| Route Handler            | 5-20ms          | 5-20ms            | 5-20ms            |
| DataRouter               | 10-50ms         | 10-50ms           | 10-50ms           |
| **Connection Pool Wait** | **0ms**         | **0-1000ms**      | **0-1000ms**      |
| Hyperdrive Connection    | 100-500ms       | 100-500ms         | 100-500ms         |
| Database Query           | 200-2000ms      | 200-2000ms        | 200-2000ms        |
| Query Timeout            | 0ms             | +800ms            | +800ms            |
| **Retry Delay**          | **0ms**         | **0ms**           | **300-500ms**     |
| **Retry Connection**     | **0ms**         | **0ms**           | **100-500ms**     |
| **Retry Query**          | **0ms**         | **0ms**           | **200-2000ms**    |
| Response Serialization   | 10-50ms         | 10-50ms           | 10-50ms           |
| Network (response)       | 50-200ms        | 100-500ms         | 100-500ms         |
| **TOTAL**                | **435-3,070ms** | **1,435-5,420ms** | **2,435-7,520ms** |

## Critical Path Analysis

The critical path (longest path) is:

1. **Connection Pool Acquisition** - Can block for up to 1s
2. **Database Query** - Can take 200-2000ms
3. **Retry Logic** - Adds 300-500ms delay + retry time

**Without fixes:**

- Normal: 435ms - 3,070ms ✅ (within 8-10s)
- With contention: 1,435ms - 5,420ms ✅ (within 8-10s)
- With retry: 2,435ms - 7,520ms ⚠️ (close to 8s limit)
- **Worst case: 9,020ms** ❌ (exceeds 8s limit)

**With fixes (proposed):**

- Better logging: Clear visibility into Hyperdrive connection failures
- Increased timeouts: Allows for slower operations
- **Expected: 435ms - 3,070ms** ✅ (well within limits, with better diagnostics)

## Timeout Failure Scenarios

### Scenario 1: Connection Pool Exhaustion

```
Test File 1: Acquires connection (0ms)
Test File 2: Waits for connection (1000ms timeout) ← FAILS
Test File 3: Waits for connection (1000ms timeout) ← FAILS
```

**Result:** 2 test files fail during setup

### Scenario 2: Slow Database Query + Retry

```
Initial Query: 800ms (times out at 800ms)
Retry Delay: 500ms
Retry Query: 1000ms
Total: 2,300ms (just for database)
+ Connection: 500ms
+ Network: 500ms
+ Other: 200ms
Total: 3,500ms ✅ (within 8s)
```

**But if query is slower:**

```
Initial Query: 2000ms (times out at 800ms)
Retry Delay: 500ms
Retry Query: 2000ms
Total: 4,500ms (just for database)
+ Connection: 500ms
+ Network: 500ms
+ Other: 200ms
Total: 5,700ms ✅ (within 8s, but close)
```

### Scenario 3: Multiple Retries

```
Attempt 1: Timeout at 800ms
Retry 1: Timeout at 800ms
Retry 2: Timeout at 800ms
Total: 2,400ms (just retries)
+ Query time: 2,000ms
+ Connection: 500ms
+ Network: 500ms
Total: 5,400ms ✅ (within 8s)
```

**But with connection issues:**

```
Attempt 1: Connection timeout (1000ms) + Query timeout (800ms)
Retry 1: Connection timeout (1000ms) + Query timeout (800ms)
Total: 3,600ms (just retries)
+ Query time: 2,000ms
+ Network: 500ms
Total: 6,100ms ✅ (within 8s, but very close)
```

---

**See also:**

- [Root Cause Analysis](./04-root-cause-analysis.md)
- [Recommendations](./06-recommendations.md)
- [Test Plan](./08-test-plan.md)
