# Magic Link Tests (Maildummy)

## What is Maildummy?

Maildummy is an email capture system for testing. It uses SES inbound receiving to store emails in an S3 bucket, allowing tests to verify email delivery and extract magic link tokens.

## How It Works

1. Test creates a Cognito user with email `test-{timestamp}@{maildummy-domain}`
2. Test initiates `CUSTOM_AUTH` flow → Cognito triggers `CreateAuthChallenge` Lambda
3. Lambda sends magic link email via SES to the maildummy address
4. SES receipt rule routes the email to the maildummy S3 bucket (`raw/` prefix)
5. Test polls the S3 bucket for the email using `maildummy-helper.ts`
6. Test extracts the magic link URL and token from the email body
7. Test calls `RespondToAuthChallenge` with the token to complete sign-in

## Configuration

Maildummy config is in SSM:

| SSM Parameter | Description |
|---------------|-------------|
| `/trellis/dev/maildummy/domain` | Email domain (e.g., `maildummy.dev.example.com`) |
| `/trellis/dev/maildummy/bucket/name` | S3 bucket storing captured emails |

## Running Magic Link Tests

```bash
eval "$(AWS_PROFILE=dot-dev aws configure export-credentials --format env)"
API_URL=https://api.dev.example.com npx vitest run --config vitest.e2e.config.ts test/e2e/magic-link-auth.test.ts
```

Requires AWS credentials (for Cognito API, S3 bucket access, SSM parameters).

## Helper (`test/e2e/utils/maildummy-helper.ts`)

```typescript
getMagicLinkFromS3(config, emailAddress, maxWaitSeconds)
// Polls S3 for emails matching recipient, parses with mailparser, extracts magic link URL

parseMagicLink(url)
// Extracts { token, email } from magic link URL query parameters
```

## Test File (`test/e2e/magic-link-auth.test.ts`)

| Test | What it verifies |
|------|-----------------|
| Sends magic link email | `InitiateAuth(CUSTOM_AUTH)` → email arrives in maildummy → contains valid link |
| Completes sign-in | `RespondToAuthChallenge` with extracted token → JWT returned |
| JWT grants API access | Bearer token works for `GET /api/user/profile` |
| Rejects invalid token | Fake token → authentication fails |
| Rejects reused token | Same token used twice → second attempt fails (one-time use) |

## Magic Link URL Format

```
https://dev.example.com/auth/verify?token={base64url-token}&email={encoded-email}
```

- Token: 32 bytes, cryptographically random, base64url-encoded
- Stored in DynamoDB with 5-minute TTL
- Deleted after successful verification (one-time use)
