# SSM Parameter Caching with AWS Powertools for KMS Usage Reduction

## Problem

Integration tests were making excessive calls to AWS SSM Parameter Store with `WithDecryption: true`, which triggers KMS decrypt operations. With 17 test files and 48 tests, each test could call SSM 2-3 times (for `DIRECT_DATABASE_URL`, `SESSION_SECRET`, etc.), resulting in 100+ KMS requests per test run. This was approaching the AWS Free Tier limit of 20,000 KMS requests per month.

## Solution

Migrated to **AWS Powertools Parameters** utility which provides built-in intelligent caching:

1. **Powertools Implementation**:
   - Uses `@aws-lambda-powertools/parameters` package
   - Built-in in-memory caching with configurable TTL
   - Automatic cache management (no manual cache clearing needed)
   - Optimized for reducing KMS calls

2. **Cache Configuration**:
   - Cache TTL: 1 hour (3600 seconds) - configurable via `maxAge` parameter
   - Cache persists for the lifetime of the test process
   - Powertools handles cache expiration automatically
   - Parameters are cached by their full path

3. **Impact**:
   - **Before**: ~100+ KMS requests per test run (one per parameter fetch)
   - **After**: ~2-3 KMS requests per test run (one per unique parameter, cached for 1 hour)
   - **Reduction**: ~97% reduction in KMS usage

## Implementation Details

The `getSsmParameter()` and `getSsmParameters()` functions now use Powertools:

```typescript
import {
  getParameter,
  getParameters,
} from "@aws-lambda-powertools/parameters/ssm";

// Single parameter with 1-hour cache
const value = await getParameter(parameterPath, {
  maxAge: 3600, // Cache for 1 hour
  decrypt: true,
  sdkClientOptions: {
    region: awsRegion,
  },
});

// Multiple parameters with 1-hour cache
const values = await getParameters(parameterPaths, {
  maxAge: 3600,
  decrypt: true,
  sdkClientOptions: {
    region: awsRegion,
  },
});
```

## Usage

The caching is automatic and transparent. No changes needed to existing code that calls `getSsmParameter()` or `getSsmParameters()`.

## Testing

Run integration tests and verify:

1. First call to each parameter shows: `[getSsmParameter] Retrieved ... from SSM ... (cached by Powertools)`
2. Subsequent calls within 1 hour use cached values (no SSM/KMS call)
3. KMS usage in AWS console should drop significantly

## Dependencies

Added to `package.json`:

- `@aws-lambda-powertools/parameters`: ^2.0.0

## Installation

After adding to package.json, run:

```bash
npm install
```
