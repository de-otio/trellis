# Memory Usage Fix: Node.js Test Processes

## Problem

Node.js processes during tests were using more than 4GB of RAM each. This was caused by:

1. **Database Connection Pool Accumulation**: The `DatabaseConnectionManager` caches connection pools, and they weren't being cleaned up between test runs
2. **Prisma Client Accumulation**: Prisma clients were being created but not always disconnected, causing memory leaks
3. **Multiple Vitest Workers**: By default, Vitest uses multiple worker threads, multiplying memory usage (each worker can accumulate its own pools and clients)

## Root Causes

### 1. No Global Teardown

- Tests created Prisma clients and database pools but had no global cleanup
- Each test worker accumulated resources over time
- Memory wasn't freed between test runs

### 2. Pool Caching Without Cleanup

- `DatabaseConnectionManager` caches pools for reuse (good for performance)
- But pools weren't cleared after tests completed
- Each worker thread maintained its own cached pools

### 3. Too Many Workers

- Vitest defaults to using multiple worker threads (often CPU count)
- Each worker can use 4GB+ with Prisma clients and connection pools
- With 4+ workers, total memory usage exceeded 16GB

## Solution

### 1. Added Global Teardown (`test/teardown.ts`)

- Clears all database connection pools after all tests complete
- Runs once per test worker to free accumulated resources
- Includes garbage collection hint (if `--expose-gc` flag is used)

### 2. Limited Vitest Workers

- Reduced `maxThreads` to 2 in all Vitest configs
- Prevents excessive memory multiplication
- Still allows parallel test execution for performance

### 3. Configuration Changes

- Added `globalTeardown` to all Vitest configs:
  - `vitest.config.ts`
  - `vitest.postdeployment.config.ts`
  - `vitest.e2e.config.ts`

## Expected Results

- **Before**: Each worker process using 4GB+ RAM
- **After**: Each worker process using <1GB RAM (with proper cleanup)
- **Total Memory**: Reduced from 16GB+ to 2-4GB total

## Additional Recommendations

### Run Tests with Garbage Collection

For even better memory management, run tests with Node's garbage collection exposed:

```bash
node --expose-gc node_modules/.bin/vitest run
```

Or add to `package.json`:

```json
{
  "scripts": {
    "test:gc": "node --expose-gc node_modules/.bin/vitest run"
  }
}
```

### Monitor Memory Usage

To monitor memory usage during tests:

```bash
# On macOS/Linux
ps aux | grep node

# Or use Node's built-in memory reporting
NODE_OPTIONS="--max-old-space-size=4096" npm test
```

### Further Optimization (if needed)

If memory issues persist:

1. **Reduce workers further**: Set `maxThreads: 1` for sequential execution
2. **Increase pool cleanup frequency**: Add cleanup in `afterEach` hooks (may impact performance)
3. **Disable coverage during development**: Coverage collection adds memory overhead

## Files Changed

- `test/setup.ts` - Added comment about teardown
- `test/teardown.ts` - **NEW** - Global teardown function
- `vitest.config.ts` - Added worker limits and globalTeardown
- `vitest.postdeployment.config.ts` - Added worker limits and globalTeardown
- `vitest.e2e.config.ts` - Added worker limits and globalTeardown

## Testing the Fix

After these changes, monitor memory usage:

```bash
# Run tests and monitor memory
npm test

# Check process memory (in another terminal)
ps aux | grep -E "node|vitest" | grep -v grep
```

You should see:

- Fewer worker processes (max 2)
- Lower memory per process (<1GB each)
- Memory freed after tests complete
