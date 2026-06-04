# SESSION_SECRET Explained

## What is SESSION_SECRET?

`SESSION_SECRET` is a cryptographic secret key used to **encrypt and decrypt session cookies** in the Trellis API. It's a critical security component that ensures session data cannot be tampered with or read by unauthorized parties.

## Purpose

The `SESSION_SECRET` is used to:

1. **Encrypt session data** when creating authenticated sessions (login)
2. **Decrypt session data** when validating requests (authentication check)
3. **Ensure session integrity** - prevents tampering with session cookies

## How It Works

### Encryption Process (When Creating a Session)

```
User Login → Session Created → Encrypted with SESSION_SECRET → Cookie Set
```

1. User authenticates (via magic link, SSO, etc.)
2. API creates a session object containing:
   - `userId` (UUID)
   - `email`
   - `role` (e.g., END_USER, SUPER_ADMIN)
   - `expiresAt` (timestamp)
   - `sessionType` (user, sso, dashboard)
3. Session is encrypted using `SESSION_SECRET`:
   - **PBKDF2** key derivation (100,000 iterations) for key stretching
   - **AES-256-GCM** encryption (authenticated encryption)
   - Random IV (initialization vector) for each encryption
4. Encrypted session is stored in cookie: `trellis_session=<encrypted-data>`

### Decryption Process (When Validating a Request)

```
Request with Cookie → Extract Encrypted Data → Decrypt with SESSION_SECRET → Validate Session
```

1. API receives request with `trellis_session` cookie
2. Extracts encrypted session data from cookie
3. Decrypts using `SESSION_SECRET`:
   - Derives same key using PBKDF2
   - Decrypts with AES-256-GCM
   - Validates authentication tag (prevents tampering)
4. Validates session:
   - Checks expiration
   - Verifies user exists in database
   - Returns user info for authorization

## Security Features

### 1. Key Derivation (PBKDF2)

- **Purpose**: Converts human-readable secret into cryptographic key
- **Algorithm**: PBKDF2 with SHA-256
- **Iterations**: 100,000 (key stretching for security)
- **Salt**: `trellis-session-salt-v1` (default) or `SESSION_SALT` env var
- **Output**: 256-bit key for AES-256

### 2. Encryption (AES-256-GCM)

- **Algorithm**: AES-256 in GCM mode
- **Benefits**:
  - **Confidentiality**: Data cannot be read without secret
  - **Integrity**: Tampering is detected (authentication tag)
  - **Authenticity**: Ensures data came from API

### 3. Random IV (Initialization Vector)

- **Size**: 12 bytes
- **Purpose**: Ensures same data encrypts differently each time
- **Storage**: Included in encrypted payload

## Where SESSION_SECRET is Stored

### Production/Dev Environments

- **Location**: AWS SSM Parameter Store
- **Path**: `/trellis/[environment]/session/secret`
  - Dev: `/trellis/dev/session/secret`
  - Prod: `/trellis/prod/session/secret`
- **Type**: SecureString (encrypted at rest)
- **Access**: Via AWS credentials (OIDC in CI/CD, AWS credentials locally)

### Local Development

- **Environment Variable**: `SESSION_SECRET`
- **Fallback**: Test default (for unit tests only)

## Requirements

### Minimum Length

- **Minimum**: 32 bytes (32 characters)
- **Recommended**: 32-64 characters
- **Why**: AES-256 requires 256-bit (32-byte) key

### Generation

Use the provided script:

```bash
./scripts/generate-session-secret.sh
```

Or manually:

```bash
# Using OpenSSL
openssl rand -base64 32

# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Why Tests Need the Same Secret

**Critical**: Tests must use the **same** `SESSION_SECRET` as the API to create valid sessions.

### The Problem

If tests use a different secret:

1. Test creates session with secret A → Encrypts session
2. API receives request with encrypted session
3. API tries to decrypt with secret B → **FAILS** → Returns 401 Unauthorized

### The Solution

Tests must:

1. **Fetch from AWS SSM** (same source as API)
2. **Or use environment variable** (if API also uses env var)
3. **Never use a different secret** than the API

## Test Implementation

### Current Test Flow

```typescript
// 1. Test fetches SESSION_SECRET
const secret =
  (await getSsmParameter("SESSION_SECRET")) ||
  process.env.SESSION_SECRET ||
  "test-secret-key-32-characters-long!!";

// 2. Test creates session with same secret
const sessionToken = await createAuthenticatedSession(
  userId,
  email,
  role,
  secret, // Must match API's secret!
);

// 3. Test makes request with encrypted session
const response = await authenticatedFetch(url, sessionToken);
```

### Why Tests Are Failing

The test failures (401 Unauthorized) indicate:

- ✅ Tests are creating sessions correctly
- ✅ Tests are sending cookies correctly
- ❌ **API cannot decrypt the session** → Secret mismatch!

**Likely causes**:

1. Test is using default test secret, but API uses SSM secret
2. Test cannot access SSM (AWS credentials not configured)
3. API's secret changed but test hasn't updated

## How to Fix Test Failures

### Option 1: Use Same Secret as API (Recommended)

```bash
# Fetch secret from SSM (same as API)
export SESSION_SECRET=$(aws ssm get-parameter \
  --name /trellis/dev/session/secret \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text)

# Run tests
ENVIRONMENT=dev npm run test:postdeployment
```

### Option 2: Set Environment Variable

```bash
# If API also uses SESSION_SECRET env var
export SESSION_SECRET="your-actual-secret-from-ssm"
ENVIRONMENT=dev npm run test:postdeployment
```

### Option 3: Ensure AWS Credentials Are Configured

Tests automatically fetch from SSM if:

- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set
- `AWS_SESSION_TOKEN` is set (for temporary credentials)
- AWS credentials have permission to read SSM parameters

## Security Best Practices

### ✅ Do

- Store in AWS SSM Parameter Store (encrypted at rest)
- Use different secrets for dev/prod
- Rotate secrets periodically
- Use strong random secrets (32+ bytes)
- Never commit secrets to git

### ❌ Don't

- Use weak secrets (short, predictable)
- Share secrets between environments
- Hardcode secrets in code
- Log secrets in error messages
- Use same secret for dev and prod

## Related Files

- `apps/api/src/lib/session-manager.ts` - Session encryption/decryption
- `apps/api/test/utils/test-auth.ts` - Test session creation
- `apps/api/test/utils/aws-ssm.ts` - SSM secret fetching
- `scripts/generate-session-secret.sh` - Secret generation script
- `doc/02-technical/development/development-notes/secrets_management.md` - Secrets management docs

## Summary

**SESSION_SECRET** is the cryptographic key that:

- Encrypts session cookies when users log in
- Decrypts session cookies when validating requests
- Must be **identical** between tests and API for tests to work
- Is stored securely in AWS SSM Parameter Store
- Uses industry-standard encryption (PBKDF2 + AES-256-GCM)

**For tests to pass**: Ensure tests use the **same** `SESSION_SECRET` as the deployed API!
