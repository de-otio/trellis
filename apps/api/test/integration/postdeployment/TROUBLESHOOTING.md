# Troubleshooting Postdeployment Tests

## Secret Synchronization Test

**New!** A dedicated test validates that Cloudflare Workers secrets match AWS SSM:

```bash
ENVIRONMENT=dev npm run -w @de-otio/trellis test -- --config vitest.postdeployment.config.ts test/integration/postdeployment/secret-sync-validation.test.ts
```

This test will:

- ✅ Detect if `SESSION_SECRET` in Cloudflare Workers doesn't match SSM
- ✅ Validate secret format and availability
- ✅ Provide clear error messages with solutions
- ✅ Report which secrets are available in SSM

**If the test fails**, it means secrets are out of sync. Run:

```bash
./scripts/sync-env.sh sync -e dev
```

## Common Issues

### Issue: Tests Getting 401 Unauthorized

**Symptoms:**

- Tests create sessions successfully
- API returns 401 Unauthorized for authenticated requests
- Debug test shows session can be decrypted with SSM secret

**Root Cause:**
The test is using `SESSION_SECRET` from AWS SSM, but the deployed API is using `SESSION_SECRET` from Cloudflare Workers secrets. These may be out of sync.

**Solution:**

1. **Sync secrets from SSM to Cloudflare Workers:**

   ```bash
   ./scripts/sync-env.sh sync -e dev
   ```

2. **Verify secrets are synced:**

   ```bash
   # Check SSM secret
   aws ssm get-parameter \
     --name /trellis/dev/session/secret \
     --with-decryption \
     --query 'Parameter.Value' \
     --output text

   # Check Cloudflare Workers secret (requires wrangler and credentials)
   cd apps/api
   wrangler secret list --env dev
   ```

3. **Re-run tests:**
   ```bash
   ENVIRONMENT=dev npm run test:postdeployment
   ```

**Why This Happens:**

- Secrets are synced from AWS SSM → Cloudflare Workers via `sync-env.sh`
- If sync hasn't been run after SSM secret was updated, they'll be different
- Tests use SSM (source of truth), API uses Cloudflare Workers secret

### Issue: Environment Not Set

**Symptoms:**

- Tests are skipped
- Error: "This test must NEVER run on production"

**Solution:**

```bash
export ENVIRONMENT=dev
# or
export DEPLOY_ENV=dev
```

### Issue: Database Connection Failed

**Symptoms:**

- Error: "DATABASE_URL or DIRECT_DATABASE_URL must be set"
- Error: "Failed to connect to database"

**Solution:**

1. **Set environment variable:**

   ```bash
   export DIRECT_DATABASE_URL="postgresql://user:pass@host:5432/db"
   ```

2. **Or ensure AWS credentials are configured for SSM:**
   ```bash
   export AWS_ACCESS_KEY_ID=...
   export AWS_SECRET_ACCESS_KEY=...
   export AWS_SESSION_TOKEN=...  # If using temporary credentials
   export AWS_REGION=eu-central-1
   export ENVIRONMENT=dev
   ```

### Issue: AWS SSM Access Denied

**Symptoms:**

- Error: "Access denied to SSM parameter"
- Error: "AWS credentials not configured"

**Solution:**

1. **Configure AWS credentials:**

   ```bash
   aws configure
   # or
   export AWS_ACCESS_KEY_ID=...
   export AWS_SECRET_ACCESS_KEY=...
   export AWS_SESSION_TOKEN=...  # For temporary credentials
   ```

2. **Verify permissions:**

   ```bash
   aws ssm get-parameter \
     --name /trellis/dev/session/secret \
     --with-decryption
   ```

3. **If using AWS SSO:**
   ```bash
   aws sso login --profile your-profile
   export AWS_PROFILE=your-profile
   ```

## Debugging Steps

### 1. Verify Session Secret Source

Check what secret the test is using:

```bash
ENVIRONMENT=dev npm run -w @de-otio/trellis test -- --config vitest.postdeployment.config.ts test/integration/postdeployment/feature-toggles.test.ts 2>&1 | grep "DEBUG.*SESSION_SECRET"
```

Should show: `[DEBUG] Using SESSION_SECRET from AWS SSM`

### 2. Verify API is Accessible

```bash
curl https://api.rkm1.de/auth/me
```

Should return: `{"authenticated":false}`

### 3. Verify Session Token Format

The debug test "should verify session can be decrypted with same secret" should pass. If it fails, there's an encryption issue.

### 4. Check Secret Sync Status

```bash
# Check if secrets are synced
./scripts/sync-env.sh status -e dev
```

## Quick Fixes

### Force Secret Sync

```bash
# Sync all secrets from SSM to Cloudflare Workers
./scripts/sync-env.sh sync -e dev
```

### Use Environment Variable (Temporary)

If you know the API's secret, you can set it directly:

```bash
export SESSION_SECRET="the-actual-secret-from-cloudflare"
ENVIRONMENT=dev npm run test:postdeployment
```

**Note:** This is a workaround. The proper solution is to sync secrets.

## Prevention

To prevent secret mismatches:

1. **Always sync secrets after updating SSM:**

   ```bash
   ./scripts/sync-env.sh sync -e dev
   ```

2. **Run sync as part of deployment:**
   - Secrets are synced in GitHub Actions workflows
   - Manual deployments should also sync secrets

3. **Verify sync in CI/CD:**
   - Add a check to ensure secrets match
   - Fail deployment if secrets are out of sync

## Related Documentation

- `test/docs/SESSION_SECRET_EXPLAINED.md` - Detailed SESSION_SECRET explanation
- `test/BEST_PRACTICES_ENVIRONMENT_GUARDS.md` - Environment guard best practices
- `doc/02-technical/development/development-notes/secrets_management.md` - Secrets management overview
