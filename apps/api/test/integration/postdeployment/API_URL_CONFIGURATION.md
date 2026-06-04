# API URL Configuration for Post-Deployment Tests

Post-deployment tests require a deployed API to test against. This guide explains how to configure the API URL for both local testing and CI/CD.

## Quick Start

### Local Testing

Set the `API_URL` environment variable before running tests:

```bash
export API_URL="https://api.rkm1.de"
npm run test:postdeployment
```

Or use one of the alternative environment variables:

```bash
# Option 1: Direct API URL
export API_URL="https://api.rkm1.de"

# Option 2: Deployed API URL
export DEPLOYED_API_URL="https://api.rkm1.de"

# Option 3: API Domain (will be prefixed with https://)
export API_DOMAIN="api.rkm1.de"

# Option 4: App Domain
export APP_DOMAIN="https://api.rkm1.de"
```

### CI/CD

The GitHub Actions workflow automatically sets `API_URL` from `config.yaml`:

1. The workflow reads `API_DOMAIN` from `environments/{env}/config.yaml`
2. Sets `API_URL="https://${API_DOMAIN}"`
3. Passes it to the test step via `env.API_URL`

**No manual configuration needed in CI/CD** - it's handled automatically.

## Configuration Priority

The `getApiUrl()` function checks in this order:

1. ✅ `API_URL` - Explicit override (highest priority)
2. ✅ `DEPLOYED_API_URL` - Alternative explicit URL
3. ✅ `API_DOMAIN` - Domain name (prefixed with `https://`)
4. ✅ `APP_DOMAIN` - Full app domain URL
5. ✅ `config.yaml` - For postdeployment tests, reads from `environments/{env}/config.yaml`
6. ❌ **Fails** - For postdeployment tests, throws error if none found
7. ⚠️ `localhost:8787` - Default fallback (only for non-postdeployment tests)

## Error Messages

### If API URL Cannot Be Determined

When running postdeployment tests without an API URL configured, you'll see:

```
❌ ERROR: Cannot determine API URL for postdeployment tests.

Postdeployment tests require a deployed API to test against. Please set one of:
  - API_URL environment variable (e.g., export API_URL="https://api.rkm1.de")
  - DEPLOYED_API_URL environment variable
  - API_DOMAIN environment variable (will be prefixed with https://)
  - APP_DOMAIN environment variable
  - Ensure config.yaml exists at: environments/dev/config.yaml
```

**Solution:** Set one of the environment variables listed above.

## Examples

### Example 1: Local Testing Against Dev API

```bash
export API_URL="https://api.rkm1.de"
export ENVIRONMENT="dev"
npm run test:postdeployment
```

### Example 2: Local Testing Against Prod API

```bash
export API_URL="https://api.example.com"
export ENVIRONMENT="prod"
npm run test:postdeployment
```

### Example 3: Using API_DOMAIN

```bash
export API_DOMAIN="api.rkm1.de"
npm run test:postdeployment
# Automatically uses: https://api.rkm1.de
```

### Example 4: CI/CD (Automatic)

The workflow automatically:

1. Reads `API_DOMAIN` from `environments/dev/config.yaml`
2. Sets `API_URL="https://api.rkm1.de"`
3. Tests run against the deployed API

## Troubleshooting

### Issue: "Cannot determine API URL for postdeployment tests"

**Cause:** No API URL environment variable is set, and `config.yaml` cannot be read.

**Solution:**

```bash
export API_URL="https://api.rkm1.de"
```

### Issue: Tests connect to localhost:8787 instead of deployed API

**Cause:** `API_URL` is not set, and the test is not detected as a postdeployment test.

**Solution:**

1. Ensure you're running `npm run test:postdeployment` (not `npm test`)
2. Set `API_URL` environment variable explicitly

### Issue: CI/CD tests fail with connection errors

**Cause:** The workflow may not be setting `API_URL` correctly.

**Solution:**

1. Check that `environments/{env}/config.yaml` contains `API_DOMAIN`
2. Verify the workflow step "Load secrets from AWS SSM" sets `API_URL`
3. Check workflow logs for: `✓ Set API_URL to https://...`

## Verification

To verify your API URL configuration:

```bash
# Check what API URL will be used
node -e "require('./test/utils/test-config.ts').getApiUrl()"
```

Or check the test output - it will log:

```
[test-config] Using API_URL from environment: https://api.rkm1.de
```

## Related Files

- `apps/api/test/utils/test-config.ts` - API URL configuration logic
- `.github/workflows/postdeployment-tests.yml` - CI/CD workflow
- `environments/{env}/config.yaml` - Environment configuration
