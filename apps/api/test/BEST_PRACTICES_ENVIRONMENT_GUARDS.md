# Best Practices: Preventing Tests from Running in Production

## Overview

This document outlines best practices for ensuring certain tests never run against production environments. This is critical for tests that:

- Create or modify data
- Create test users
- Perform destructive operations
- Use test-specific data

## Multi-Layer Defense Strategy

Use multiple layers of protection (defense in depth) to ensure tests never run in production:

### Layer 1: Test Suite Configuration (Primary)

**Use `describe.skipIf()` at the suite level** - This is the primary and most effective mechanism.

```typescript
import { skipIfNotDev } from "../../utils/test-environment-guard";

// Tests won't even load if in production
describe.skipIf(skipIfNotDev())("My Test Suite", () => {
  // ... tests
});
```

**Advantages:**

- Tests are completely skipped (not loaded) in production
- Clear and explicit in test output
- Works at the suite level (all tests in suite are protected)
- No performance overhead (tests don't run at all)

### Layer 2: BeforeAll Hook (Defense in Depth)

**Use `requireDevEnvironment()` in `beforeAll` hooks** - Provides a second safety check.

```typescript
import { requireDevEnvironment } from "../../utils/test-environment-guard";

describe("My Test Suite", () => {
  beforeAll(() => {
    requireDevEnvironment(); // Throws error if not in dev
  });

  // ... tests
});
```

**Advantages:**

- Catches cases where skipIf might be bypassed
- Fails fast with clear error message
- Provides explicit safety check

### Layer 3: Module-Level Check (Early Abort)

**Check environment at module load time** - Prevents module from even loading.

```typescript
import { isProduction } from "../../utils/test-environment-guard";

// Abort immediately if in production
if (isProduction()) {
  throw new Error("This test must never run in production");
}
```

**Advantages:**

- Fails before any test code runs
- Prevents accidental execution
- Works even if test framework has bugs

**Note:** This is less elegant than `skipIf` but provides maximum safety.

### Layer 4: CI/CD Pipeline Guards

**Add environment checks in CI/CD workflows** - Prevent tests from being invoked in production.

```yaml
# .github/workflows/postdeployment-tests.yml
- name: Verify environment
  run: |
    if [ "${{ inputs.environment }}" = "prod" ]; then
      echo "::error::Production tests are not allowed"
      exit 1
    fi
```

**Advantages:**

- Prevents tests from being invoked at the pipeline level
- Can be enforced by repository policies
- Provides audit trail

## Recommended Approach

For maximum safety, use **Layer 1 + Layer 2**:

```typescript
import {
  skipIfNotDev,
  requireDevEnvironment,
} from "../../utils/test-environment-guard";

// Primary protection: Skip entire suite if not in dev
describe.skipIf(skipIfNotDev())(
  "Post-Deployment: Feature Toggles Admin API",
  () => {
    // Secondary protection: Fail fast if somehow bypassed
    beforeAll(() => {
      requireDevEnvironment();
    });

    // ... your tests
  },
);
```

## Available Utilities

The `test/utils/test-environment-guard.ts` module provides:

### Functions

- `getEnvironment()` - Get current environment (dev/prod)
- `isProduction()` - Check if running in production
- `isDevelopment()` - Check if running in development
- `requireDevEnvironment()` - Throw error if not in dev
- `requireEnvironment(allowedEnvironments)` - Require specific environments
- `skipInProduction()` - Return true if in production (for skipIf)
- `skipIfNotDev()` - Return true if not in dev (for skipIf)

### Usage Examples

#### Example 1: Skip Suite in Production

```typescript
import { skipIfNotDev } from "../../utils/test-environment-guard";

describe.skipIf(skipIfNotDev())("Data Modification Tests", () => {
  it("should create test user", async () => {
    // This test will never run in production
  });
});
```

#### Example 2: Require Dev Environment

```typescript
import { requireDevEnvironment } from "../../utils/test-environment-guard";

describe("Admin API Tests", () => {
  beforeAll(() => {
    requireDevEnvironment(); // Throws if not dev
  });

  it("should modify feature toggles", async () => {
    // Test code
  });
});
```

#### Example 3: Require Specific Environments

```typescript
import { requireEnvironment } from "../../utils/test-environment-guard";

describe("Staging Tests", () => {
  beforeAll(() => {
    requireEnvironment(["dev", "staging"]); // Only allow dev or staging
  });

  it("should test staging features", async () => {
    // Test code
  });
});
```

#### Example 4: Skip Individual Tests

```typescript
import { skipInProduction } from "../../utils/test-environment-guard";

describe("API Tests", () => {
  it.skipIf(skipInProduction())("should create test data", async () => {
    // This test won't run in production
  });

  it("should read data", async () => {
    // This test runs in all environments
  });
});
```

## Environment Detection

The utilities detect environment from:

1. `process.env.ENVIRONMENT` (preferred)
2. `process.env.DEPLOY_ENV` (fallback)
3. Defaults to `'dev'` if neither is set

**Important:** Always set `ENVIRONMENT` or `DEPLOY_ENV` in your CI/CD pipelines.

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Run postdeployment tests
  env:
    ENVIRONMENT: ${{ inputs.environment }}
  run: |
    if [ "$ENVIRONMENT" = "prod" ]; then
      echo "::error::Production tests are disabled for safety"
      exit 1
    fi
    npm run test:postdeployment
```

### Environment-Specific Test Commands

Consider creating separate test commands:

```json
{
  "scripts": {
    "test:postdeployment": "vitest run --config vitest.postdeployment.config.ts",
    "test:postdeployment:dev": "ENVIRONMENT=dev npm run test:postdeployment",
    "test:postdeployment:prod": "echo 'Production tests disabled for safety' && exit 1"
  }
}
```

## Testing Your Guards

You can test that your guards work:

```typescript
// test-environment-guard.test.ts
import { describe, it, expect, vi } from "vitest";
import { isProduction, requireDevEnvironment } from "./test-environment-guard";

describe("test-environment-guard", () => {
  it("should detect production environment", () => {
    const originalEnv = process.env.ENVIRONMENT;
    process.env.ENVIRONMENT = "prod";
    expect(isProduction()).toBe(true);
    process.env.ENVIRONMENT = originalEnv;
  });

  it("should throw if not in dev", () => {
    const originalEnv = process.env.ENVIRONMENT;
    process.env.ENVIRONMENT = "prod";
    expect(() => requireDevEnvironment()).toThrow();
    process.env.ENVIRONMENT = originalEnv;
  });
});
```

## Common Patterns

### Pattern 1: Data Modification Tests

```typescript
import {
  skipIfNotDev,
  requireDevEnvironment,
} from "../../utils/test-environment-guard";

describe.skipIf(skipIfNotDev())("Data Modification Tests", () => {
  beforeAll(() => {
    requireDevEnvironment();
  });

  // Tests that create/modify data
});
```

### Pattern 2: Test User Creation

```typescript
import { skipIfNotDev } from "../../utils/test-environment-guard";

describe.skipIf(skipIfNotDev())("Authenticated API Tests", () => {
  // Tests that create test users
});
```

### Pattern 3: Destructive Operations

```typescript
import { requireDevEnvironment } from "../../utils/test-environment-guard";

describe("Admin Operations", () => {
  beforeAll(() => {
    requireDevEnvironment(); // Extra safety for destructive ops
  });

  it("should delete test data", async () => {
    // Destructive test
  });
});
```

## Best Practices Summary

1. ✅ **Use `describe.skipIf(skipIfNotDev())`** - Primary protection
2. ✅ **Add `requireDevEnvironment()` in beforeAll** - Defense in depth
3. ✅ **Set `ENVIRONMENT` in CI/CD** - Ensure proper detection
4. ✅ **Add CI/CD pipeline guards** - Prevent invocation
5. ✅ **Use separate test configs** - Organize by environment
6. ✅ **Document in test comments** - Explain why tests are dev-only
7. ✅ **Test your guards** - Verify they work correctly

## Anti-Patterns to Avoid

❌ **Don't rely on a single check** - Use multiple layers
❌ **Don't use warnings** - Use hard failures (throw errors)
❌ **Don't skip silently** - Make it clear why tests are skipped
❌ **Don't check environment in test body** - Use suite-level guards
❌ **Don't assume environment is set** - Provide defaults and clear errors

## Related Files

- `test/utils/test-environment-guard.ts` - Environment guard utilities
- `vitest.postdeployment.config.ts` - Postdeployment test configuration
- `.github/workflows/postdeployment-tests.yml` - CI/CD workflow
