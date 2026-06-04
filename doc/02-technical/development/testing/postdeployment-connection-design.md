# Post-Deployment Test Connection Design

> **Scope note.** This describes the post-deployment suite, which runs against
> a *deployed* environment owned by the **consuming vertical**. The connection
> behaviour analysed here is that of the deployed API (single Fargate task,
> small DB pool); the helper designs (global user pool, `CachedSession`) are
> pipeline-agnostic. See [post-deploy-speed.md](post-deploy-speed.md) and the
> local lane in [standalone.md](standalone.md).

## Problem

Post-deployment API tests fail with `Database query timeout after 2000ms` because every test file independently creates users, fetches CSRF tokens, and cleans up — each operation opening a new database connection pool through the API. With 17 test files running sequentially, the pattern is:

```
File 1: beforeAll → 2 user creations (2 HTTP → 2 DB connections)
         test 1  → CSRF fetch + operation (2 HTTP → 2 DB connections)
         test 2  → CSRF fetch + operation (2 HTTP → 2 DB connections)
         ...
         afterAll → cleanup 3 regions × 2 users (6 HTTP → 6 DB connections)

File 2: same pattern from scratch...
```

**Per file with N tests: `2N + 5` HTTP requests**, each creating a fresh connection pool (`max: 1` per pool, 500ms idle timeout). The API's single Fargate task handles 5-10 concurrent DB connections. When requests queue up (user creation takes 1-2s, cleanup 3-5s), the 2000ms application-level timeout fires before the query executes.

### Connection timeline for a typical test file (7 tests)

```
0s     beforeAll: create user1 (1s) → create user2 (1s)     = 2 connections
2s     test1:     CSRF (200ms) + POST (300ms)                = 2 connections
2.5s   test2:     CSRF (200ms) + GET (200ms)                 = 2 connections
       ...
8s     test7:     CSRF (200ms) + DELETE (300ms)              = 2 connections
8.5s   afterAll:  3× DELETE user1 + 3× DELETE user2          = 6 connections (parallel!)
       ─────────────────────────────────────────────────────
       Total: 22 connection pools created, 6 concurrent during cleanup
```

The 6 concurrent cleanup connections saturate the pool. Subsequent files start their `beforeAll` user creation against an API whose DB connections are still draining from the previous file's cleanup.

## Root Causes

1. **No connection reuse across requests.** Every HTTP request to the API creates a new `Pool(max: 1)` + `PrismaClient`, executes one query, and tears down. This is correct for production (Hyperdrive pools externally) but expensive for sequential test traffic.

2. **No shared state across test files.** Each file creates its own users in `beforeAll` and destroys them in `afterAll`. 17 files × 2 users = 34 user creations + 34 cleanups = 68 HTTP requests just for setup/teardown.

3. **CSRF tokens are not cached.** Every mutation calls `getCsrfToken()`, which is another HTTP round-trip (and DB connection) per test.

4. **Cleanup hits all regions in parallel.** `cleanupTestUser()` fires 3 DELETE requests simultaneously (US, EU, CN). With 2 users, that's 6 concurrent requests — enough to exhaust the connection pool.

5. **No warm-up gap between files.** Vitest runs `afterAll` of file N, then immediately `beforeAll` of file N+1. If cleanup connections haven't drained (500ms idle timeout), the new file's user creation competes for the same pool.

## Design

Implements Layers 3-4 from `post-deploy-speed.md`.

### Layer 3: Global Test User Pool

A vitest `globalSetup` that runs once before all test files in a shard.

**File:** `apps/api/test/integration/postdeployment/global-setup.ts`

```typescript
import type { GlobalSetupContext } from "vitest/node";

const POOL_SIZE = 10; // 8 END_USER + 2 SUPER_ADMIN
const POOL_FILE = join(tmpdir(), "trellis-test-user-pool.json");

export async function setup(ctx: GlobalSetupContext) {
  const API_URL = getApiUrl();

  // 1. Fetch SSM secrets once (SESSION_SECRET, SESSION_SALT)
  //    Export as env vars so test files don't re-fetch
  const sessionSecret = await fetchSsmOnce("/trellis/dev/session/secret");
  const sessionSalt = await fetchSsmOnce("/trellis/dev/session/salt");
  process.env.SESSION_SECRET = sessionSecret;
  process.env.SESSION_SALT = sessionSalt;

  // 2. Create user pool sequentially (not parallel — protect the DB)
  const users: PoolUser[] = [];
  for (let i = 0; i < 8; i++) {
    const user = await createTestUserWithSession({
      email: `pool-user-${i}-${Date.now()}@test.example.com`,
      role: "END_USER",
      region: "EU",
      dataRegion: "EU",
    });
    users.push({ ...user, assignedTo: null });
  }
  for (let i = 0; i < 2; i++) {
    const user = await createTestUserWithSession({
      email: `pool-admin-${i}-${Date.now()}@test.example.com`,
      role: "SUPER_ADMIN",
      region: "EU",
      dataRegion: "EU",
    });
    users.push({ ...user, assignedTo: null });
  }

  // 3. Write pool to temp file for test files to read
  writeFileSync(POOL_FILE, JSON.stringify(users));

  // 4. Provide to vitest context
  ctx.provide("userPoolFile", POOL_FILE);
}

export async function teardown() {
  // Delete all pool users — EU only (that's where they were created)
  const users = JSON.parse(readFileSync(POOL_FILE, "utf-8"));
  for (const user of users) {
    await cleanupTestUser(user.testUser.id, { regionsToClean: ["EU"] });
    // Sequential — don't overwhelm the DB during teardown
    await sleep(200);
  }
  unlinkSync(POOL_FILE);
}
```

**File:** `apps/api/test/utils/test-user-pool.ts`

```typescript
interface PoolUser {
  testUser: TestUser;
  sessionToken: string;
  assignedTo: string | null;
}

const assigned = new Set<string>();

/**
 * Check out a pair of users from the global pool.
 * Each caller gets a unique pair keyed by `fileKey`.
 * Users are never shared across files.
 */
export function getUserPair(fileKey: string): {
  user1: TestUser;
  user2: TestUser;
  session1: string;
  session2: string;
} {
  const pool = loadPool();
  const endUsers = pool.filter(
    (u) => u.testUser.role === "END_USER" && !assigned.has(u.testUser.id),
  );

  if (endUsers.length < 2) {
    throw new Error(
      `User pool exhausted: need 2 END_USER, have ${endUsers.length}. ` +
      `Increase POOL_SIZE in global-setup.ts or reduce concurrent test files.`,
    );
  }

  const [a, b] = endUsers.slice(0, 2);
  assigned.add(a.testUser.id);
  assigned.add(b.testUser.id);

  return {
    user1: a.testUser,
    user2: b.testUser,
    session1: a.sessionToken,
    session2: b.sessionToken,
  };
}

export function getAdminUser(): { user: TestUser; session: string } {
  const pool = loadPool();
  const admins = pool.filter(
    (u) => u.testUser.role === "SUPER_ADMIN" && !assigned.has(u.testUser.id),
  );
  if (admins.length === 0) throw new Error("No admin users left in pool");
  assigned.add(admins[0].testUser.id);
  return { user: admins[0].testUser, session: admins[0].sessionToken };
}
```

### Layer 4: CSRF Token Caching

**File:** `apps/api/test/utils/cached-session.ts`

```typescript
/**
 * Wraps a session token with a cached CSRF token.
 * Fetches CSRF once, reuses until 403, then refreshes.
 */
export class CachedSession {
  private csrfToken: string | null = null;
  private currentSessionToken: string;

  constructor(
    private readonly initialSessionToken: string,
    private readonly apiUrl: string,
  ) {
    this.currentSessionToken = initialSessionToken;
  }

  get sessionToken(): string {
    return this.currentSessionToken;
  }

  /**
   * Make an authenticated request with automatic CSRF handling.
   * Caches the CSRF token and refreshes on 403.
   */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.csrfToken) await this.refreshCsrf();

    const res = await authenticatedFetch(
      `${this.apiUrl}${path}`,
      this.currentSessionToken,
      {
        ...init,
        headers: {
          ...init.headers,
          "X-CSRF-Token": this.csrfToken!,
        },
      },
    );

    // CSRF token expired — refresh and retry once
    if (res.status === 403) {
      await this.refreshCsrf();
      return authenticatedFetch(
        `${this.apiUrl}${path}`,
        this.currentSessionToken,
        {
          ...init,
          headers: {
            ...init.headers,
            "X-CSRF-Token": this.csrfToken!,
          },
        },
      );
    }

    // Track updated session token from response
    const updated = extractSessionFromResponse(res);
    if (updated) this.currentSessionToken = updated;

    return res;
  }

  private async refreshCsrf(): Promise<void> {
    const res = await authenticatedFetch(
      `${this.apiUrl}/api/csrf-token`,
      this.currentSessionToken,
    );
    const body = await res.json();
    this.csrfToken = body.token;
    const updated = extractSessionFromResponse(res);
    if (updated) this.currentSessionToken = updated;
  }
}
```

### Vitest Config Changes

```typescript
// vitest.postdeployment.api.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/integration/postdeployment/*.test.ts"],
    setupFiles: ["test/e2e/setup.ts"],
    globalSetup: ["test/integration/postdeployment/global-setup.ts"],
    testTimeout: 15000,   // down from 30000
    hookTimeout: 30000,   // keep for globalSetup
    pool: "threads",
    poolOptions: {
      threads: { minThreads: 1, maxThreads: 1 },
    },
    fileParallelism: false,
  },
});
```

### Test File Migration Pattern

**Before (current):**

```typescript
describe("Reactions API", () => {
  let testUser1: TestUser;
  let sessionToken1: string;

  beforeAll(async () => {
    requireDevEnvironment();
    const user1 = await createTestUserWithSession({ ... });  // 1-2s, new DB conn
    testUser1 = user1.testUser;
    sessionToken1 = user1.sessionToken;
  });

  it("should add reaction", async () => {
    const { token } = await getCsrfToken(sessionToken1);     // 200ms, new DB conn
    const res = await authenticatedFetch(url, sessionToken1, {
      headers: { "X-CSRF-Token": token },                    // 300ms, new DB conn
    });
  });

  afterAll(async () => {
    await cleanupTestUser(testUser1.id);  // 3 regions × 2s = 6s, 3 concurrent DB conns
  });
});
```

**After:**

```typescript
import { getUserPair } from "../../utils/test-user-pool";
import { CachedSession } from "../../utils/cached-session";

describe("Reactions API", () => {
  const { user1, user2, session1, session2 } = getUserPair("reactions");
  const s1 = new CachedSession(session1, API_URL);
  const s2 = new CachedSession(session2, API_URL);

  // No beforeAll user creation — users come from the global pool
  // No afterAll cleanup — globalSetup teardown handles it

  it("should add reaction", async () => {
    const res = await s1.fetch("/api/posts/123/reactions", {
      method: "POST",
      body: JSON.stringify({ type: "LOVE" }),
    });
    // CSRF token is cached — no extra HTTP round-trip
  });
});
```

## Connection Budget Comparison

### Before (17 files, ~120 tests)

| Phase | Connections | Frequency |
|-------|------------|-----------|
| User creation | 2 per file | 17 files = 34 |
| CSRF fetch | 1 per mutation test | ~80 tests = 80 |
| Test operations | 1 per test | ~120 tests = 120 |
| Cleanup | 6 per file (3 regions × 2 users) | 17 files = 102 |
| **Total** | | **~336 connection pools** |
| **Peak concurrent** | | **6 (during cleanup)** |

### After

| Phase | Connections | Frequency |
|-------|------------|-----------|
| User creation (globalSetup) | 1 per user, sequential | 10 users = 10 |
| CSRF fetch (cached) | 1 per file (first mutation) | 17 files = 17 |
| Test operations | 1 per test | ~120 tests = 120 |
| Cleanup (globalSetup teardown) | 1 per user, sequential, EU only | 10 users = 10 |
| **Total** | | **~157 connection pools** |
| **Peak concurrent** | | **1 (everything sequential)** |

**53% fewer connections, peak concurrent drops from 6 to 1.**

## Implementation Sequence

1. Create `test/utils/cached-session.ts` — CSRF caching helper
2. Create `test/utils/test-user-pool.ts` — pool checkout API
3. Create `test/integration/postdeployment/global-setup.ts` — pool lifecycle
4. Update `vitest.postdeployment.api.config.ts` — add `globalSetup`, reduce timeout
5. Update `vitest.postdeployment.followers.config.ts` — same
6. Migrate test files one at a time (each is independent):
   - Remove `beforeAll` user creation
   - Remove `afterAll` cleanup
   - Import `getUserPair` / `getAdminUser`
   - Wrap session tokens in `CachedSession`
7. Delete SSM fetching from individual test files (globalSetup handles it)

## Files to Create/Modify

| File | Action |
|------|--------|
| `apps/api/test/utils/cached-session.ts` | Create |
| `apps/api/test/utils/test-user-pool.ts` | Create |
| `apps/api/test/integration/postdeployment/global-setup.ts` | Create |
| `apps/api/vitest.postdeployment.api.config.ts` | Add globalSetup |
| `apps/api/vitest.postdeployment.followers.config.ts` | Add globalSetup |
| `apps/api/test/integration/postdeployment/*.test.ts` (17 files) | Migrate to pool |
| `apps/api/test/integration/postdeployment/followers/*.test.ts` | Migrate to pool |
