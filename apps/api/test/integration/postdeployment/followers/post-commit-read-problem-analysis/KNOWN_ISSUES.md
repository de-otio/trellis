# Known Issues with Followers Post-Deployment Tests

## Issue: Unfollow findUnique Query Fails After Follow Creation

### Symptoms

- Follow is created successfully (returns 200 with `followId`)
- Follow is visible in the following list query (`getFollowing` works)
- Unfollow operation returns 404 "Resource not found"
- Status endpoint returns `isFollowing: false` immediately after follow creation

### Root Cause Analysis

The issue appears to be a database consistency problem where:

1. `getFollowing` uses `findMany` and successfully finds the follow
2. `unfollow` uses `findUnique` with composite key `followerId_targetType_targetId` and cannot find the same follow
3. `getStatus` uses `findUnique` with the same composite key and also cannot find it

### Possible Causes

1. **Database Index Issue**: The unique constraint index might not be properly synchronized
2. **Prisma Schema Mismatch**: The composite key definition might not match the database schema
3. **Region/Connection Issue**: Different database connections might be used for different queries
4. **Transaction Isolation**: Read-after-write consistency issue with database transactions

### Workarounds

- Tests currently use retry logic with exponential backoff (up to 15 attempts)
- Tests verify follow exists via `getFollowing` before attempting unfollow
- Added delays (5+ seconds) to allow for database consistency

### Recommended Fixes

1. **Short-term**: Make `unfollow` use `findFirst` instead of `findUnique` as a fallback
2. **Medium-term**: Add retry logic inside `unfollow` method itself
3. **Long-term**: Investigate database index and Prisma schema alignment
4. **Alternative**: Use `followId` directly if available instead of composite key lookup

### Test Status

- ✅ Follow creation test passes
- ✅ Following list test passes
- ❌ Unfollow test fails (404 after successful follow)
- ❌ Status test fails (`isFollowing: false` after successful follow)

### Related Files

- `apps/api/src/lib/followers-handler.ts` - `unfollow()` method (line 620)
- `apps/api/src/lib/followers-handler.ts` - `isFollowing()` method (line 986)
- `apps/api/src/lib/followers-handler.ts` - `getFollowing()` method (line 721)
- `apps/api/test/integration/postdeployment/followers/unfollow.test.ts`
- `apps/api/test/integration/postdeployment/followers/status.test.ts`
