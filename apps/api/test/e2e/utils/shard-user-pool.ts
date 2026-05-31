/**
 * Shard User Pool — provides pre-created test users to test files.
 *
 * Users are created once by global-setup.ts before any test files run.
 * Test files call getShardUser(index) to get an authenticated user.
 */

interface PoolEntry {
  email: string;
  jwt: string;
  userId: string;
}

let pool: PoolEntry[] | null = null;

function loadPool(): PoolEntry[] {
  if (pool) return pool;
  const raw = process.env.__E2E_USER_POOL;
  if (!raw) {
    throw new Error(
      "E2E user pool not initialized. Ensure globalSetup is configured in vitest config " +
      "and E2E_USER_COUNT is set. For tests that don't need auth, use getShardUser with a try/catch.",
    );
  }
  pool = JSON.parse(raw);
  return pool!;
}

/**
 * Get the Nth user from the shard's pre-created pool.
 *
 * @param index - 0-based index into the user pool
 * @returns Object with authFetch function, userId, and email
 */
export function getShardUser(index: number) {
  const entries = loadPool();
  if (index >= entries.length) {
    throw new Error(
      `Requested user index ${index} but pool only has ${entries.length} user(s). ` +
      `Set E2E_USER_COUNT=${index + 1} or higher in the shard's npm script.`,
    );
  }

  const entry = entries[index];

  // Track cookies for CSRF support
  const cookies: Record<string, string> = {};

  const authFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    const headers: Record<string, string> = {
      Authorization: `Bearer ${entry.jwt}`,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(init.headers as Record<string, string> || {}),
    };

    const res = await fetch(url, { ...init, headers });

    // Track cookies from response
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const cookie of setCookie) {
      const match = cookie.match(/^([^=]+)=([^;]*)/);
      if (match) cookies[match[1]] = match[2];
    }

    return res;
  };

  return {
    userId: entry.userId,
    email: entry.email,
    authFetch,
  };
}
