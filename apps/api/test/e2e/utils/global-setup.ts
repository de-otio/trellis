/**
 * Vitest globalSetup for e2e test shards.
 *
 * Creates a pool of E2eTestUser instances once before all test files in the shard.
 * Test files access pre-created users via shard-user-pool.ts.
 *
 * Configuration via environment variables:
 *   E2E_SHARD       — shard name (used in user email prefix)
 *   E2E_USER_COUNT  — number of users to create (default: 0)
 */

import { E2eTestUser } from "./e2e-test-user.js";

let users: E2eTestUser[] = [];

export async function setup() {
  const shardName = process.env.E2E_SHARD || "default";
  const userCount = parseInt(process.env.E2E_USER_COUNT || "0", 10);

  if (userCount === 0) {
    console.log(`[global-setup] Shard "${shardName}": no users requested`);
    process.env.__E2E_USER_POOL = "[]";
    return;
  }

  console.log(`[global-setup] Shard "${shardName}": creating ${userCount} test user(s)...`);

  // Create users in parallel (independent Cognito flows)
  const promises = Array.from({ length: userCount }, (_, i) =>
    E2eTestUser.create({ suiteName: `${shardName}-u${i}` })
  );

  try {
    users = await Promise.all(promises);
  } catch (err) {
    console.error(`[global-setup] Failed to create test users:`, err);
    // Clean up any users that were created before the failure
    await Promise.allSettled(users.map(u => u.destroy()));
    throw err;
  }

  // Serialize pool for test files to read
  const pool = users.map(u => ({
    email: u.email,
    jwt: u.jwt,
    userId: u.userId,
  }));
  process.env.__E2E_USER_POOL = JSON.stringify(pool);

  console.log(`[global-setup] Created ${users.length} user(s): ${users.map(u => u.email).join(", ")}`);
}

export async function teardown() {
  if (users.length === 0) return;

  console.log(`[global-setup] Destroying ${users.length} test user(s)...`);
  const results = await Promise.allSettled(users.map(u => u.destroy()));

  const failed = results.filter(r => r.status === "rejected");
  if (failed.length > 0) {
    console.warn(`[global-setup] ${failed.length} user(s) failed to destroy (sweeper will clean up)`);
  }
}
