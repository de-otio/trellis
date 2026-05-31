# SSM Parameter Caching Fix for KMS Usage

## Problem

Integration tests were making excessive calls to AWS SSM Parameter Store with `WithDecryption: true`, which triggers KMS decrypt operations. With 17 test files and 48 tests, each test could call SSM 2-3 times (for `DIRECT_DATABASE_URL`, `SESSION_SECRET`, etc.), resulting in 100+ KMS requests per test run. This was approaching the AWS Free Tier limit of 20,000 KMS requests per month.

## Solution

Added in-memory caching to `getSsmParameter()` and `getSsmParameters()` functions:

1. **Cache Implementation**:
   - Parameters are cached by their full path (including region)
   - Cache TTL: 1 hour (secrets rarely change)
   - Cache persists for the lifetime of the test process
   - Even null values are cached to avoid repeated failed lookups

2. **Cache Behavior**:
   - First call to a parameter fetches from SSM and caches the result
   - Subsequent calls return the cached value (no SSM/KMS call)
   - Cache expires after 1 hour
   - Cache can be manually cleared via `clearParameterCache()` if needed

3. **Impact**:
   - **Before**: ~100+ KMS requests per test run (one per parameter fetch)
   - **After**: ~2-3 KMS requests per test run (one per unique parameter)
   - **Reduction**: ~97% reduction in KMS usage

## Usage

The caching is automatic and transparent. No changes needed to existing code.

To manually clear the cache (e.g., after secret rotation):

```typescript
import { clearParameterCache } from "./aws-ssm";

clearParameterCache();
```

## Testing

Run integration tests and verify:

1. First call to each parameter shows: `[getSsmParameter] Retrieved ... from SSM ... (cached)`
2. Subsequent calls show: `[getSsmParameter] Using cached value for ... (age: Xs)`
3. KMS usage in AWS console should drop significantly
