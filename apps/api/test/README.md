# Test Suite for Milestone B

This directory contains unit and integration tests for Milestone B: Authentication and Dog Profiles.

## Structure

```
test/
├── setup.ts                    # Global test setup
├── utils/                       # Test utilities and mocks
│   ├── mock-env.ts             # Mock Cloudflare Workers environment
│   ├── mock-atproto.ts          # Mock AT Protocol/Bluesky agent
│   ├── mock-oauth.ts           # Mock OAuth components (PKCE, DPoP)
│   ├── test-helpers.ts         # Common test utilities
│   └── test-auth.ts            # Authentication utilities for integration tests
├── unit/                        # Unit tests
│   ├── validation.test.ts      # Zod schema validation
│   ├── session.test.ts         # Session management
│   ├── oauth.test.ts           # OAuth components (PKCE, DPoP)
│   ├── error-handling.test.ts  # Error sanitization
│   └── file-upload.test.ts     # File upload validation
└── integration/                 # Integration tests
    ├── auth.test.ts            # OAuth authentication endpoints
    └── dogs.test.ts            # Dog profile endpoints
```

## Running Tests

### All Tests

```bash
npm test
```

### Unit Tests Only

```bash
npm run test:unit
```

### Integration Tests Only

```bash
npm run test:integration
```

### Watch Mode

```bash
npm run test:watch
```

### Coverage

```bash
npm run test:coverage
```

## Test Utilities

### Mock Environment

```typescript
import { createMockEnv, MockKV } from "../utils/mock-env";

const env = createMockEnv({
  SESSION_SECRET: "custom-secret",
});
```

### Mock AT Protocol Agent

```typescript
import { createMockBskyAgent } from "../utils/mock-atproto";

const mockAgent = createMockBskyAgent();
```

### Mock OAuth Components

```typescript
import { generateMockPKCE, generateMockState } from "../utils/mock-oauth";

const { codeVerifier, codeChallenge } = generateMockPKCE();
const state = generateMockState();
```

### Test Helpers

```typescript
import { createMockRequest, parseSetCookie } from "../utils/test-helpers";

const request = createMockRequest("https://example.com/api/dogs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Test" }),
});
```

## Integration Test Requirements

Integration tests require:

1. **Running API**: The API worker must be running (via `npm run dev` or deployed)
2. **Database & Secrets** (one of the following):
   - **Option A - Environment Variables** (local development):
     - `DIRECT_DATABASE_URL` or `DATABASE_URL` - Database connection string
     - `SESSION_SECRET` - Session encryption secret (optional, defaults to test secret)
   - **Option B - AWS SSM Parameter Store** (CI/CD or Local with AWS access):
     - **CI/CD**: Automatically authenticated via OIDC (no configuration needed)
     - **Local Dev**: AWS credentials configured:
       - `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (required)
       - `AWS_SESSION_TOKEN` (required for temporary credentials, e.g., from AWS SSO)
       - `AWS_REGION` (defaults to `eu-central-1`)
       - `ENVIRONMENT` or `DEPLOY_ENV` - Environment name (`dev` or `prod`)
     - Automatically fetches from SSM: `/trellis/[environment]/supabase/database/url` and `/trellis/[environment]/session/secret`
3. **Environment Variables**:
   - `API_DOMAIN` - URL of the API (default: `http://localhost:8787`)
   - `TEST_BLUESKY_HANDLE` - Test Bluesky handle for OAuth testing
   - `TEST_BLUESKY_DID` - Test Bluesky DID (optional)

For OAuth testing, you may need to mock the authorization server or use test credentials.

### Authenticated Integration Tests

For testing authenticated endpoints, use the test authentication utilities:

```typescript
import {
  createTestUserWithSession,
  cleanupTestUser,
  authenticatedFetch,
} from "../utils/test-auth";

describe("Authenticated API Tests", () => {
  let testUser;
  let sessionToken;

  beforeEach(async () => {
    // Create test user and session
    const { testUser: user, sessionToken: token } =
      await createTestUserWithSession();
    testUser = user;
    sessionToken = token;
  });

  afterEach(async () => {
    // Clean up test user
    await cleanupTestUser(testUser.id);
  });

  it("should handle authenticated request", async () => {
    const response = await authenticatedFetch(
      `${API_URL}/api/endpoint`,
      sessionToken,
    );
    expect(response.status).toBe(200);
  });
});
```

See `test/integration/example-authenticated.test.ts` for a complete example.

## Writing New Tests

### Unit Test Example

```typescript
import { describe, it, expect } from "vitest";

describe("Feature Name", () => {
  it("should do something", () => {
    expect(true).toBe(true);
  });
});
```

### Integration Test Example

```typescript
import { describe, it, expect } from "vitest";

const API_URL = process.env.API_DOMAIN || "http://localhost:8787";

describe("Feature Integration", () => {
  it("should handle API request", async () => {
    const response = await fetch(`${API_URL}/endpoint`);
    expect(response.status).toBe(200);
  });
});
```

## Best Practices

1. **Isolation**: Each test should be independent
2. **Cleanup**: Clean up test data after each test
3. **Mocks**: Use mocks for external dependencies
4. **Assertions**: Make assertions specific and meaningful
5. **Naming**: Use descriptive test names
6. **Coverage**: Aim for high coverage of critical paths
