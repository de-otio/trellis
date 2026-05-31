# Post-Deployment Test Architecture

**Hard constraint:** The full post-deployment verification must complete in under 5 minutes, regardless of how many tests exist.

## Current State

| Suite | Config | Tests | Files | Runtime |
|---|---|---|---|---|
| E2E smoke | `vitest.e2e.config.ts` | 134 | 29 | ~46s |
| Postdeployment | `vitest.postdeployment.config.ts` | 186 | 25 | ~22 min |

Both run single-threaded (`fileParallelism: false`, `maxThreads: 1`), sequentially (e2e first, then postdeployment). Every test file creates its own users from scratch, fetches SSM secrets independently, and cleans up by trying DELETE across all regions.

### Why It's Slow

| Bottleneck | Cost | Scales with |
|---|---|---|
| Sequential file execution | ~14 min | Number of files (linear) |
| Per-file user creation (1-3s each, ~42 calls) | ~1-2 min | Number of files |
| Sequential suite execution (e2e then postdeployment) | ~1 min | Constant |
| SSM parameter re-fetching per file | ~30s | Number of files |
| 4-region cleanup per user | ~30s | Number of files |

Everything except "sequential suite execution" grows linearly with test count. At 500 tests this architecture would take over an hour.

## Target Architecture

```
deploy job completes
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│  GitHub Actions: post-deploy-verify                       │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ smoke-tests │  │ api-tests    │  │ followers-tests  │ │
│  │ (1 job)     │  │ (1 job)      │  │ (1 job)          │ │
│  │             │  │              │  │                  │ │
│  │ e2e smoke   │  │ entities     │  │ follow/unfollow  │ │
│  │ health      │  │ feed         │  │ count            │ │
│  │ deployment  │  │ reactions    │  │ status           │ │
│  │ auth        │  │ posts        │  │ followers list   │ │
│  │ CRUD        │  │ media        │  │ following list   │ │
│  │ access ctrl │  │ toggles      │  │ auth             │ │
│  │             │  │ moderation   │  │                  │ │
│  │ ~45s        │  │ ~2-3 min     │  │ ~2-3 min         │ │
│  └─────────────┘  └──────────────┘  └──────────────────┘ │
│         │                  │                   │          │
│         └──────────────────┴───────────────────┘          │
│                        all pass                           │
│                           │                               │
│                     deploy passes                         │
└───────────────────────────────────────────────────────────┘
```

All three jobs run in parallel. Each job runs its test files in parallel (4 threads). Total wall time is bounded by the slowest job (~3 min), not the sum of all tests.

## Design Principles

### 1. Wall time is bounded by the slowest shard, not the total test count

Adding 100 new feed tests should not increase runtime. It only increases the feed shard's runtime, and if that shard gets too slow, split it into two shards.

### 2. Test isolation is at the user level, not the process level

Each test file gets its own pre-created users from a global pool. Files never share users. This means any number of files can run in parallel safely.

### 3. Setup cost is paid once, not per-file

User creation, SSM secret fetching, and CSRF token acquisition happen once in a global setup, not in every test file's `beforeAll`.

### 4. Tests must not sleep

No fixed `setTimeout` delays for "consistency". PostgreSQL on RDS is synchronous — a successful 200 response means the data is committed and readable. If a read fails, retry immediately with a short backoff (200ms, max 5 attempts). Never pre-sleep before a read.

## Implementation Plan

### Layer 1: GitHub Actions Sharding

**File:** `.github/workflows/deploy.yml`

Split the current monolithic post-deploy steps into parallel jobs. Each job checks out the repo, installs deps, and runs a vitest config that targets a subset of test files via `include` globs.

```yaml
  post-deploy-smoke:
    needs: [deploy]
    runs-on: ubuntu-latest
    steps:
      - # checkout, setup node, install
      - run: npm run test:e2e -w @de-otio/trellis
        env:
          API_URL: ${{ needs.deploy.outputs.api_url }}

  post-deploy-api:
    needs: [deploy]
    runs-on: ubuntu-latest
    steps:
      - # checkout, setup node, install
      - run: npm run test:postdeployment:api -w @de-otio/trellis
        env:
          API_URL: ${{ needs.deploy.outputs.api_url }}

  post-deploy-followers:
    needs: [deploy]
    runs-on: ubuntu-latest
    steps:
      - # checkout, setup node, install
      - run: npm run test:postdeployment:followers -w @de-otio/trellis
        env:
          API_URL: ${{ needs.deploy.outputs.api_url }}

  post-deploy-gate:
    needs: [post-deploy-smoke, post-deploy-api, post-deploy-followers]
    runs-on: ubuntu-latest
    if: always()
    steps:
      - run: |
          if [ "${{ needs.post-deploy-smoke.result }}" != "success" ] ||
             [ "${{ needs.post-deploy-api.result }}" != "success" ] ||
             [ "${{ needs.post-deploy-followers.result }}" != "success" ]; then
            echo "Post-deployment verification failed"
            exit 1
          fi
```

Each shard gets its own vitest config (or the base config with a different `include` glob). As test count grows, add more shards — the wall time stays flat.

**Sharding strategy for new test domains:** When a new feature area is added (e.g., messaging, notifications), it gets its own shard from day one. A shard should contain 20-60 tests. If a shard exceeds 3 minutes, split it.

### Layer 2: Intra-Shard File Parallelism

**Status: Not viable with current API infrastructure.**

The API runs on a single Fargate task with a small database connection pool (~5-10 connections). Even 2 parallel test files cause 500 errors from connection pool exhaustion. Tests that normally complete in 3s take 15s+ under contention, and user creation times out at 3s.

**Current config:** Both vitest configs use `maxThreads: 1` and `fileParallelism: false`. This is the only stable configuration until the API's connection pool is scaled up.

**To enable in the future:** Increase the Fargate task's database connection pool (via `database_pool_size` in CDK config) or scale to 2+ tasks. Then set `maxThreads: 2` and `fileParallelism: true`. Test with `scripts/post-deploy-test.sh` and monitor for 500s.

**The real parallelism lever is Layer 1** (GitHub Actions sharding). Each shard gets its own runner, so 3 shards = 3 sequential test processes each hitting the API one-at-a-time, but all 3 shards running simultaneously on separate GitHub Actions runners.

### Layer 3: Global Test User Pool

**New file:** `apps/api/test/integration/postdeployment/global-setup.ts`

A vitest `globalSetup` script that runs once before all test files in a shard:

1. Fetch `SESSION_SECRET` and `SESSION_SALT` from SSM (once) and export as env vars
2. Create a pool of shared test users:
   - 8 `END_USER` accounts (2 per thread, gives each file a pair)
   - 2 `SUPER_ADMIN` accounts
   - Each user gets a pre-created session token
3. Write the pool to a temp JSON file that test files read via a shared import
4. On teardown, delete all pool users (EU region only since that's where they're created)

Test files check out users from the pool instead of creating their own:

```typescript
// In a test file
import { getUserPair } from "../test-user-pool";

describe("Feed API", () => {
  const { user1, user2, session1, session2 } = getUserPair("feed");
  // user1 and user2 are unique to this file (keyed by the string "feed")
  // No beforeAll/beforeEach user creation needed
});
```

Wire into vitest config:
```typescript
globalSetup: ["test/integration/postdeployment/global-setup.ts"],
```

### Layer 4: Per-File Optimizations

#### CSRF Token Caching

Create a `CachedSession` helper that wraps a session token and caches its CSRF token. Refreshes only on 403.

```typescript
class CachedSession {
  private csrfToken: string | null = null;

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (!this.csrfToken) await this.refreshCsrf();
    const res = await authenticatedFetch(url, this.token, {
      ...init,
      headers: { ...init.headers, "X-CSRF-Token": this.csrfToken },
    });
    if (res.status === 403) {
      await this.refreshCsrf();
      return authenticatedFetch(url, this.token, {
        ...init,
        headers: { ...init.headers, "X-CSRF-Token": this.csrfToken },
      });
    }
    return res;
  }
}
```

#### Reduced Timeouts

```typescript
testTimeout: 15000,  // down from 30000
hookTimeout: 30000,  // keep for setup/teardown
```

A test hitting a live API should get a response in <1s. 15s is generous for failure detection. Keep hookTimeout at 30s for user creation retries.

#### Intra-File Concurrency (Largest Files)

For files with many independent tests, use `describe.concurrent`:

```typescript
describe.concurrent("Feature Toggles", () => {
  // Each test is independent and read-only (or uses its own user)
  it("should return 401 for unauthenticated requests", async () => { ... });
  it("should return 403 for non-super-admin users", async () => { ... });
});
```

Candidates: `feature-toggles.test.ts` (20 tests), `feed.test.ts` (18 tests), `upload-sessions.test.ts` (18 tests), `followers/index.test.ts` (25 tests).

### Layer 5: Local Script Parallelism

**File:** `scripts/post-deploy-test.sh`

For local runs (not in CI), run the e2e and postdeployment suites as parallel background processes:

```bash
npm run test:e2e -w @de-otio/trellis &
E2E_PID=$!

npm run test:postdeployment -w @de-otio/trellis &
PD_PID=$!

E2E_EXIT=0; PD_EXIT=0
wait $E2E_PID || E2E_EXIT=$?
wait $PD_PID || PD_EXIT=$?

if [ $E2E_EXIT -ne 0 ] || [ $PD_EXIT -ne 0 ]; then
  echo "Tests failed (e2e=$E2E_EXIT, postdeployment=$PD_EXIT)"
  exit 1
fi
```

## Shard Management

### When to split a shard

A shard should be split when it consistently exceeds 3 minutes. Monitor via CI job durations.

### How to add a new shard

1. Create a new vitest config (or add an `include` pattern to an existing one):
   ```typescript
   include: ["test/integration/postdeployment/messaging/**/*.test.ts"]
   ```
2. Add the corresponding npm script to `package.json`:
   ```json
   "test:postdeployment:messaging": "vitest run --config vitest.postdeployment.messaging.config.ts"
   ```
3. Add a new parallel job in `.github/workflows/deploy.yml`
4. Add the new job to the `post-deploy-gate` `needs` list

### Shard naming convention

```
test:postdeployment:<domain>
```

Current shards:
- `test:e2e` — smoke tests, auth, CRUD, access control
- `test:postdeployment:api` — entities, feed, reactions, posts, media, toggles, moderation
- `test:postdeployment:followers` — follow, unfollow, count, status, followers list, following list, auth

Future shards (as test count grows):
- `test:postdeployment:media` — media upload, processing, collection, variants
- `test:postdeployment:messaging` — DMs, notifications
- `test:postdeployment:admin` — feature toggles, moderation tools, user management

## Implementation Sequence

### Step 1 (biggest win)

1. Enable `fileParallelism: true` and `maxThreads: 4` in `vitest.postdeployment.config.ts`
2. Enable `fileParallelism: true` and `maxThreads: 3` in `vitest.e2e.config.ts`
3. Update `scripts/post-deploy-test.sh` to run both suites in parallel

### Step 2

4. Create `global-setup.ts` with user pool and SSM caching
5. Create shard-specific vitest configs (`postdeployment.api`, `postdeployment.followers`)
6. Add corresponding npm scripts
7. Refactor test files to use the global user pool

### Step 3

8. Split deploy.yml post-deploy steps into parallel jobs
9. Add `post-deploy-gate` aggregation job
10. Export `api_url` as a job output from the deploy job

### Step 4 (polish)

11. Add CSRF token caching helper
12. Reduce `testTimeout` to 15s
13. Add `describe.concurrent` to the largest test files
14. Streamline cleanup (EU-only DELETE for pool users)

## Expected Results

| Optimization | Savings |
|---|---|
| GitHub Actions sharding (3 parallel jobs) | Wall time = max(shard) not sum(shards) |
| Intra-shard file parallelism (4 threads) | 3-4x speedup within each shard |
| Global user pool | Eliminates ~1-2 min of per-file user creation |
| Parallel local script | Halves local run time |
| CSRF caching + reduced timeouts | ~30s-1 min |
| **Projected wall time at 200 tests** | **~2-3 min** |
| **Projected wall time at 500 tests** | **~3-5 min** (add shards as needed) |

The key insight: wall time grows with the *slowest shard*, not the total test count. As long as each shard stays under 3 minutes, the overall suite stays under 5 minutes regardless of total test count.

## Key Files

| File | Change |
|---|---|
| `.github/workflows/deploy.yml` | Split post-deploy into parallel jobs with gate |
| `apps/api/vitest.postdeployment.config.ts` | Enable file parallelism, add globalSetup |
| `apps/api/vitest.e2e.config.ts` | Enable file parallelism |
| `apps/api/test/integration/postdeployment/global-setup.ts` | New: user pool + SSM caching |
| `apps/api/test/utils/test-user-pool.ts` | New: pool checkout API for test files |
| `apps/api/test/utils/test-auth.ts` | SSM caching, pool integration |
| `scripts/post-deploy-test.sh` | Run suites in parallel |
| `apps/api/package.json` | Add shard-specific npm scripts |
