# Test Plan

## Verification Steps

### 1. Apply Immediate Fixes

**Changes to make:**

- [ ] Add clear logging when Hyperdrive cannot provide a connection
  - File: `database-connection-manager.ts:290-308`
  - Add: Error handler for pool connection failures
  - Add: Explicit logging in `executeWithRetry` for connection acquisition failures

- [ ] Increase `DEFAULT_CONNECTION_TIMEOUT_MS` to 3000
  - File: `database-connection-manager.ts:41`
  - Change: `private readonly DEFAULT_CONNECTION_TIMEOUT_MS = 3000;`

- [ ] Increase `REQUEST_TIMEOUT_MS` to 12s/15s
  - File: `test-auth.ts:555`
  - Change: `const REQUEST_TIMEOUT_MS = isCI ? 15000 : 12000;`

- [ ] Increase `testUserTimeoutMs` to 2s/3s
  - File: `data-router.ts:375-376`
  - Change: `const testUserTimeoutMs = isCI ? 3000 : 2000;`
  - Change: `const testUserRetryTimeoutMs = isCI ? 1000 : 500;`

---

### 2. Run Test Suite

**Commands:**

```bash
# Run postdeployment tests 10 times
for i in {1..10}; do
  echo "Run $i/10"
  ENVIRONMENT=dev npm run -w @de-otio/trellis test:postdeployment
done
```

**Metrics to collect:**

- User creation success rate
- Timeout failure count
- Average user creation time
- P95 user creation time
- P99 user creation time

---

### 3. Monitor Metrics

**Check connection pool statistics:**

```typescript
// Add to test setup
const poolStatus = databaseConnectionManager.getPoolStatus();
console.log("Pool Status:", poolStatus);
```

**Check database write durations:**

- Review logs for `[UserCreation] Database write completed`
- Calculate p50, p95, p99 percentiles

**Track timeout failure patterns:**

- Count timeout errors
- Identify which test files fail
- Check for patterns (specific times, conditions)

---

### 4. Verify Improvements

**Success Criteria:**

- ✅ User creation timeout failures: <1%
- ✅ User creation success rate: >99%
- ✅ Average user creation time: <2 seconds
- ✅ P95 user creation time: <5 seconds
- ✅ P99 user creation time: <8 seconds

**Comparison:**

| Metric               | Before | After (Target) | Actual |
| -------------------- | ------ | -------------- | ------ |
| Timeout Failure Rate | 5-10%  | <1%            | ?      |
| Success Rate         | 90-95% | >99%           | ?      |
| Avg Creation Time    | 1-3s   | <2s            | ?      |
| P95 Creation Time    | 5-8s   | <5s            | ?      |
| P99 Creation Time    | 8-12s  | <8s            | ?      |

---

## Test Scenarios

### Scenario 1: Normal Operation

**Setup:**

- Single test file running
- No other load

**Expected:**

- User creation succeeds
- Time: <2 seconds
- No timeouts

---

### Scenario 2: Parallel Test Execution

**Setup:**

- 3 test files running in parallel (maxThreads: 3)
- All creating users simultaneously

**Expected:**

- All user creations succeed
- Time: <3 seconds (may be slower due to contention)
- No connection pool exhaustion

---

### Scenario 3: High Load

**Setup:**

- Multiple test runs in quick succession
- Database under load

**Expected:**

- User creation succeeds (may be slower)
- Time: <5 seconds (P95)
- No timeout failures

---

### Scenario 4: Connection Issues

**Setup:**

- Simulate slow Hyperdrive connection
- Network latency

**Expected:**

- User creation succeeds (with retry)
- Time: <8 seconds (P99)
- Retry logic handles transient failures

---

## Regression Testing

### Before Deploying

1. Run full test suite
2. Verify no regressions
3. Check performance metrics
4. Review logs for errors

### After Deploying

1. Run full test suite 10 times
2. Compare metrics with baseline
3. Verify improvements
4. Document results

---

## Rollback Plan

If fixes cause issues:

1. **Immediate Rollback:**
   - Revert timeout changes
   - Revert pool size change
   - Deploy previous version

2. **Investigation:**
   - Review logs
   - Check metrics
   - Identify root cause

3. **Alternative Fix:**
   - Try smaller pool size increase (3 instead of 5)
   - Try smaller timeout increases
   - Implement fixes incrementally

---

## Success Metrics

### Primary Metrics

- **User Creation Success Rate:** >99%
- **Timeout Failure Rate:** <1%
- **Average Creation Time:** <2 seconds

### Secondary Metrics

- **P95 Creation Time:** <5 seconds
- **P99 Creation Time:** <8 seconds
- **Connection Pool Exhaustion:** 0 events
- **Retry Rate:** <5%

---

## Documentation

### Test Results Document

Create a document with:

1. **Before/After Comparison:**
   - Metrics table
   - Charts/graphs
   - Analysis

2. **Test Execution Logs:**
   - 10 test runs
   - Success/failure counts
   - Timing data

3. **Performance Analysis:**
   - Improvement percentage
   - Remaining issues
   - Recommendations

---

**See also:**

- [Recommendations](./06-recommendations.md)
- [Monitoring and Diagnostics](./07-monitoring-diagnostics.md)
- [Conclusion](./09-conclusion.md)
