# Test Mock Strategy Guidelines

## Problem: Mocks Hiding Real Code Paths

When mocks always succeed, they can hide bugs in the actual code paths. The `getEntityProfile` bug is a perfect example - the mock for `createRequestContext` always returned success, so the test never caught the bug where `undefined` was passed instead of a `Request` object.

## Best Practices

### 1. Test Real Code Paths

**❌ BAD: Mock always succeeds**

```typescript
vi.mock("../../src/lib/request-context", () => ({
  createRequestContext: vi.fn().mockResolvedValue({
    region: "US",
  }),
}));
```

**✅ GOOD: Test actual function calls**

```typescript
// Verify the function is called with correct parameters
expect(mockDetectRegion).toHaveBeenCalledWith(
  request,
  mockEnv,
  expect.any(Object),
  expect.any(Object),
);
```

### 2. Test Both Success and Failure Scenarios

**✅ GOOD: Test failure cases**

```typescript
it("should handle region detection failure gracefully", async () => {
  mockDetectRegion.mockResolvedValue(null); // Simulate failure
  // ... test fallback behavior
});
```

### 3. Verify Function Calls, Not Just Mock Returns

**❌ BAD: Only check mock return value**

```typescript
const result = await someFunction();
expect(result).toBe(expected);
```

**✅ GOOD: Verify actual function calls**

```typescript
const result = await someFunction();
expect(result).toBe(expected);
// Also verify the function was called correctly
expect(mockDependency).toHaveBeenCalledWith(expectedParam1, expectedParam2);
```

### 4. Use Integration Tests for Critical Paths

For critical code paths (like region detection, database routing), use integration tests that:

- Don't mock away critical dependencies
- Test the full flow from route → handler → database
- Use real Request objects

### 5. Test Optional Parameters

When functions have optional parameters (like `request?: Request`), test:

- With the parameter provided
- Without the parameter (undefined/null)
- With invalid parameter values

## Example: Entity Handler Tests

### Request Parameter Handling

```typescript
describe("getEntityProfile", () => {
  it("should work with request parameter", async () => {
    const request = new Request("http://test.com/api/entities/123");
    // ... test with request
    expect(mockDetectRegion).toHaveBeenCalledWith(
      request,
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("should work without request parameter", async () => {
    // ... test without request
    expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
      "US", // Default region
      expect.any(Object),
      undefined, // No request
      "user-123",
    );
  });
});
```

### Region Detection

```typescript
it("should handle region detection failure gracefully", async () => {
  mockDetectRegion.mockResolvedValue(null);
  // ... verify fallback to default region
});

it("should handle region detection error gracefully", async () => {
  mockDetectRegion.mockRejectedValue(new Error("Detection failed"));
  // ... verify fallback to default region
});
```

## Checklist for New Handler Methods

When adding tests for a new handler method:

- [ ] Test with request parameter provided
- [ ] Test without request parameter (if optional)
- [ ] Verify region detection is called with correct parameters
- [ ] Test region detection failure scenarios
- [ ] Verify `getDatabaseForRegion` receives request when available
- [ ] Test error handling for database operations
- [ ] Add integration test for full flow (if critical path)

## Red Flags in Tests

Watch out for these patterns that might hide bugs:

1. **Mock always succeeds** - If a mock never fails, you're not testing error paths
2. **No parameter verification** - If you don't verify function calls, you might miss parameter bugs
3. **Mocking away the bug** - If you mock `createRequestContext` to always work, you won't catch bugs where `undefined` is passed
4. **No integration tests** - Unit tests with heavy mocking might miss integration issues

## Summary

The key principle: **Test the actual code paths, not just the happy path through mocks**. Verify that functions are called with correct parameters, test failure scenarios, and use integration tests for critical paths.
