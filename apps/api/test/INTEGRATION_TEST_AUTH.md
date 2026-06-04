# Non-Interactive Integration Tests with Authentication

## Overview

This guide explains how to write non-interactive integration tests for authenticated API endpoints.

## The Problem

Your API requires authentication, but integration tests need to run automatically without user interaction. You need a way to:

1. Create test users in the database
2. Generate valid authentication tokens
3. Make authenticated requests
4. Clean up test data

## The Solution

We've created test utilities that handle all of this automatically:

### Key Components

1. **`test/utils/test-auth.ts`** - Authentication utilities
   - `createTestUser()` - Creates a test user in the database
   - `createAuthenticatedSession()` - Generates a valid session token
   - `createTestUserWithSession()` - Does both in one call
   - `cleanupTestUser()` - Removes test user from database
   - `authenticatedFetch()` - Helper for making authenticated requests

2. **`test/integration/example-authenticated.test.ts`** - Complete example

## Quick Start

### Basic Example

```typescript
import {
  createTestUserWithSession,
  cleanupTestUser,
  authenticatedFetch,
} from "../utils/test-auth";
import { getApiUrl } from "../utils/test-config";

const API_URL = getApiUrl();

describe("My Authenticated Tests", () => {
  let testUser;
  let sessionToken;

  beforeEach(async () => {
    // Create test user and get session token
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

## How It Works

### 1. Test User Creation

Test users are created directly in your database using Prisma:

```typescript
const testUser = await createTestUser({
  email: "test@example.com",
  role: "END_USER",
  region: "US",
});
```

- Users are created with unique IDs (UUIDs)
- Email addresses are auto-generated if not provided
- Users are created in your actual test database

### 2. Session Token Generation

Session tokens are encrypted using the same `SessionManager` that your API uses:

```typescript
const sessionToken = await createAuthenticatedSession(
  testUser.id,
  testUser.email,
  testUser.role,
);
```

- Uses the same encryption as production
- Valid for 1 hour (configurable)
- Can be used in `Cookie` headers

### 3. Making Authenticated Requests

Use the `authenticatedFetch` helper or manually set the cookie:

```typescript
// Option 1: Use helper
const response = await authenticatedFetch(url, sessionToken, {
  method: "POST",
  body: JSON.stringify({ data: "value" }),
});

// Option 2: Manual
const response = await fetch(url, {
  headers: {
    Cookie: `trellis_session=${sessionToken}`,
  },
});
```

### 4. Cleanup

Always clean up test users in `afterEach`:

```typescript
afterEach(async () => {
  await cleanupTestUser(testUser.id);
});
```

## Configuration

### Database URLs and Secrets

The test utilities automatically fetch database URLs and session secrets from **AWS SSM Parameter Store**:

- **Database URLs**:
  - `/trellis/[environment]/supabase/database/url` (DIRECT_DATABASE_URL)
  - `/trellis/[environment]/database/hyperdrive/url` (DATABASE_URL, fallback)
- **Session Secret**:
  - `/trellis/[environment]/session/secret`

Where `[environment]` is `dev` or `prod` (from `ENVIRONMENT` or `DEPLOY_ENV` env var).

### Fallback Behavior

The utilities use a fallback strategy:

1. **Environment Variables** (for local development):
   - `DIRECT_DATABASE_URL` or `DATABASE_URL`
   - `SESSION_SECRET`
2. **AWS SSM Parameter Store** (for CI/CD):
   - Automatically fetches from SSM if environment variables are not set
   - Requires AWS credentials to be configured

### AWS Credentials

For SSM access, configure AWS credentials using one of:

#### CI/CD Pipeline (OIDC)

The CI/CD pipeline automatically authenticates using OIDC (OpenID Connect) via GitHub Actions. No manual configuration needed - the `aws-actions/configure-aws-credentials` action sets up temporary credentials automatically.

#### Local Development

For local development, you need to authenticate to AWS and set credentials:

**Option 1: Temporary Credentials (Recommended for Local Dev)**

```bash
# After authenticating to AWS (e.g., via AWS SSO or assume-role)
export AWS_ACCESS_KEY_ID=your-key
export AWS_SECRET_ACCESS_KEY=your-secret
export AWS_SESSION_TOKEN=your-session-token  # Required for temporary credentials
export AWS_REGION=eu-central-1
export ENVIRONMENT=dev  # or prod
```

**Option 2: Permanent Credentials**

```bash
export AWS_ACCESS_KEY_ID=your-key
export AWS_SECRET_ACCESS_KEY=your-secret
export AWS_REGION=eu-central-1
export ENVIRONMENT=dev  # or prod
```

**Option 3: AWS Profile**

```bash
export AWS_PROFILE=your-profile
export AWS_REGION=eu-central-1
export ENVIRONMENT=dev  # or prod
```

**Note**: If you're using temporary credentials (e.g., from `aws sso login` or `aws assume-role`), you **must** set `AWS_SESSION_TOKEN` in addition to `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

### Local Development

For local development, you can either:

1. **Use environment variables** (recommended):

   ```bash
   export DIRECT_DATABASE_URL="postgresql://user:pass@host:5432/db"
   export SESSION_SECRET="your-secret-key"
   ```

2. **Use AWS SSM** (if you have AWS access):
   ```bash
   export ENVIRONMENT=dev  # or prod
   # AWS credentials will be used automatically
   ```

### Database Setup

The utilities use `DIRECT_DATABASE_URL` if available (for direct connections), otherwise fall back to `DATABASE_URL`.

For Supabase connections, SSL is automatically enabled.

## Best Practices

### 1. Test Isolation

Each test should create its own test user:

```typescript
it("should handle user-specific data", async () => {
  const { testUser, sessionToken } = await createTestUserWithSession();

  try {
    // Your test here
  } finally {
    await cleanupTestUser(testUser.id);
  }
});
```

### 2. Multiple Users

You can create multiple test users for testing interactions:

```typescript
it("should handle user-to-user interactions", async () => {
  const user1 = await createTestUserWithSession();
  const user2 = await createTestUserWithSession();

  try {
    // Test interactions between users
  } finally {
    await cleanupTestUser(user1.testUser.id);
    await cleanupTestUser(user2.testUser.id);
  }
});
```

### 3. Different Roles

Test different user roles:

```typescript
it("should handle admin-only endpoints", async () => {
  const { testUser, sessionToken } = await createTestUserWithSession({
    role: "SUPER_ADMIN",
  });

  try {
    // Test admin functionality
  } finally {
    await cleanupTestUser(testUser.id);
  }
});
```

### 4. Error Handling

Always use try/finally for cleanup:

```typescript
it("should handle errors gracefully", async () => {
  const { testUser, sessionToken } = await createTestUserWithSession();

  try {
    // Test that might throw
    await someOperation();
  } catch (error) {
    // Handle error
  } finally {
    // Always cleanup
    await cleanupTestUser(testUser.id);
  }
});
```

## Common Patterns

### Testing Authorization

```typescript
it("should reject unauthorized users", async () => {
  const regularUser = await createTestUserWithSession({ role: "END_USER" });
  const adminUser = await createTestUserWithSession({ role: "SUPER_ADMIN" });

  try {
    // Regular user should be rejected
    const response1 = await authenticatedFetch(
      `${API_URL}/admin/endpoint`,
      regularUser.sessionToken,
    );
    expect(response1.status).toBe(403);

    // Admin should succeed
    const response2 = await authenticatedFetch(
      `${API_URL}/admin/endpoint`,
      adminUser.sessionToken,
    );
    expect(response2.status).toBe(200);
  } finally {
    await cleanupTestUser(regularUser.testUser.id);
    await cleanupTestUser(adminUser.testUser.id);
  }
});
```

### Testing User-Specific Data

```typescript
it("should return only user's own data", async () => {
  const user1 = await createTestUserWithSession();
  const user2 = await createTestUserWithSession();

  try {
    // Create data for user1
    await authenticatedFetch(`${API_URL}/api/data`, user1.sessionToken, {
      method: "POST",
      body: JSON.stringify({ value: "user1-data" }),
    });

    // user2 should not see user1's data
    const response = await authenticatedFetch(
      `${API_URL}/api/data`,
      user2.sessionToken,
    );
    const data = await response.json();
    expect(data).not.toContainEqual({ value: "user1-data" });
  } finally {
    await cleanupTestUser(user1.testUser.id);
    await cleanupTestUser(user2.testUser.id);
  }
});
```

## Troubleshooting

### "DATABASE_URL not set" Error

The utilities need either:

1. Environment variables set, OR
2. AWS credentials configured to fetch from SSM

**Option 1: Use Environment Variables** (Local Development)

```bash
export DIRECT_DATABASE_URL="postgresql://user:pass@host:5432/db"
export SESSION_SECRET="your-secret-key"
```

**Option 2: Configure AWS Credentials** (CI/CD)

```bash
export AWS_ACCESS_KEY_ID=your-key
export AWS_SECRET_ACCESS_KEY=your-secret
export AWS_REGION=eu-central-1
export ENVIRONMENT=dev  # or prod
```

### "AWS credentials not configured" Error

If you see this error, either:

1. Set the environment variables directly (see above), OR
2. Configure AWS credentials:

   **For temporary credentials (e.g., AWS SSO):**

   ```bash
   export AWS_ACCESS_KEY_ID=...
   export AWS_SECRET_ACCESS_KEY=...
   export AWS_SESSION_TOKEN=...  # Required for temporary credentials
   export AWS_REGION=eu-central-1
   ```

   **For permanent credentials:**

   ```bash
   export AWS_ACCESS_KEY_ID=...
   export AWS_SECRET_ACCESS_KEY=...
   export AWS_REGION=eu-central-1
   ```

   **Or use AWS profile:**

   ```bash
   export AWS_PROFILE=your-profile
   export AWS_REGION=eu-central-1
   ```

### "Access denied to SSM parameter" Error

Your AWS credentials don't have permission to read SSM parameters. Either:

1. Grant `ssm:GetParameter` permission to your IAM user/role, OR
2. Use environment variables instead (for local development)

### "User already exists" Error

This usually means a previous test didn't clean up. The utilities generate unique emails, but if you're providing custom emails, make sure they're unique.

### Session Token Not Working

1. Check that `SESSION_SECRET` matches your API's secret
2. Verify the session hasn't expired (default is 1 hour)
3. Make sure you're using the correct cookie name: `trellis_session`

### Database Connection Issues

- For Supabase, SSL is automatically enabled
- Make sure your database is accessible from your test environment
- Check firewall rules if testing against a remote database

## See Also

- `test/integration/example-authenticated.test.ts` - Complete working example
- `test/utils/test-auth.ts` - Source code for utilities
- `test/README.md` - General testing documentation
