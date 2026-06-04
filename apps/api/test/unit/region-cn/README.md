# CN Region Unit Tests

This directory contains unit tests for the CN-region / multi-region features.

## Test Files

- **data-router.test.ts** - Tests data residency enforcement and region validation
- **region-detection.test.ts** - Tests region detection priority (user preference first)
- **region-config.test.ts** - Tests region-specific configuration and feature flags
- **user-routes.test.ts** - Tests region preference API endpoint
- **feature-flags.test.ts** - Tests feature flags API endpoint

## Running Tests

```bash
# Run all CN-region tests
npm run test -- test/unit/region-cn

# Run specific test file
npm run test -- test/unit/region-cn/data-router.test.ts

# Run with coverage
npm run test:coverage -- test/unit/region-cn
```

## Test Coverage

These tests cover:

- ✅ Data residency enforcement (`dataRegion` validation)
- ✅ Cross-region access prevention
- ✅ Region detection priority (user preference → IP → language → default)
- ✅ Region-specific feature flags
- ✅ Region preference API endpoint
- ✅ Feature flags API endpoint

## Mocking

Tests use Vitest mocks for:

- Database connections (`createPrismaForRegion`)
- Session management (`SessionManager`)
- Security headers (`SecurityHeaders`)
- Region detection (`detectRegionSync`, `isValidRegion`)
- Region configuration (`getRegionConfig`)

## Notes

- Tests are isolated and don't require a running database
- All external dependencies are mocked
- Tests verify both success and error cases
- Security violations are tested (cross-region access attempts)
