/**
 * Vitest globalSetup for running the E2E shards against the in-process
 * standalone server (no deployed API, no Cognito, no AWS account).
 *
 * Composes the standalone lane's server boot (Postgres/DynamoDB/Neo4j on the
 * local docker-compose stack) with an E2E user pool minted via the test-only
 * `/api/admin/test/users` endpoint. Each pooled user carries the server-minted
 * `trellis_session` cookie, so `getShardUser().authFetch` authenticates by
 * cookie instead of a Cognito JWT.
 *
 * Selected by `vitest.e2e.standalone.config.ts`. The deployed E2E path
 * (Cognito + maildummy via `e2e-test-user.ts`) is unchanged.
 */

import {
  setup as standaloneSetup,
  teardown as standaloneTeardown,
} from "../../standalone/global-setup.js";
import { STANDALONE_API_URL } from "../../standalone/standalone-env.js";

interface CookiePoolEntry {
  email: string;
  jwt: string;
  userId: string;
  sessionCookie: string;
}

/** Create one user via the in-process server and capture its session cookie. */
async function createCookieUser(suffix: string): Promise<CookiePoolEntry> {
  const id = crypto.randomUUID();
  const email = `e2e-std-${suffix}-${id.slice(0, 8)}@test.example.com`;

  const res = await fetch(`${STANDALONE_API_URL}/api/admin/test/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id,
      email,
      role: "END_USER",
      region: "US",
      dataRegion: "US",
    }),
  });

  if (!res.ok) {
    throw new Error(
      `[e2e-standalone] failed to create test user: ${res.status} ${await res.text()}`,
    );
  }

  const body = (await res.json()) as {
    success?: boolean;
    user?: { id: string; email: string; role: string };
  };
  if (!body.user) {
    throw new Error(
      `[e2e-standalone] unexpected create-user response: ${JSON.stringify(body)}`,
    );
  }

  // Prefer the server-minted cookie; fall back to local minting if the route
  // doesn't set one (older server shapes).
  let sessionCookie = "";
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const m = c.match(/trellis_session=([^;]+)/);
    if (m) sessionCookie = m[1];
  }
  if (!sessionCookie) {
    const { createAuthenticatedSession } = await import(
      "../../utils/test-auth.js"
    );
    sessionCookie = await createAuthenticatedSession(
      body.user.id,
      body.user.email,
      body.user.role as never,
    );
  }

  return { email: body.user.email, userId: body.user.id, jwt: "", sessionCookie };
}

export async function setup(): Promise<void> {
  // Boot the in-process server on the standalone stack + seed feature toggles.
  await standaloneSetup();

  const count = parseInt(process.env.E2E_USER_COUNT || "2", 10);
  const pool: CookiePoolEntry[] = [];
  for (let i = 0; i < count; i++) {
    pool.push(await createCookieUser(`u${i}`));
  }
  process.env.__E2E_USER_POOL = JSON.stringify(pool);
  // eslint-disable-next-line no-console
  console.log(
    `[e2e-standalone] booted at ${STANDALONE_API_URL}; created ${pool.length} cookie user(s)`,
  );
}

export async function teardown(): Promise<void> {
  await standaloneTeardown();
}
