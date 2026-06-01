#!/usr/bin/env node
/**
 * Wait for Neo4j Bolt to accept authenticated queries.
 *
 * The GitHub Actions service-container health-check probes Neo4j's HTTP
 * endpoint (7474), which turns green *before* the Bolt endpoint (7687) is
 * ready to authenticate and serve queries. Running the graph lane against a
 * not-yet-ready Bolt port produces intermittent first-connection failures on
 * cold runners. This gate polls `RETURN 1` over Bolt until it succeeds (or a
 * deadline elapses), so the test step starts only once the DB is truly ready.
 *
 * Reads the same env vars the graph tests use:
 *   NEO4J_TEST_URI       e.g. bolt://localhost:7687
 *   NEO4J_TEST_USER      e.g. neo4j
 *   NEO4J_TEST_PASSWORD  e.g. trellis_dev_password
 */

import neo4j from "neo4j-driver";

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;

if (!uri || !user || !password) {
  console.error(
    "wait-for-neo4j: NEO4J_TEST_URI, NEO4J_TEST_USER and NEO4J_TEST_PASSWORD must all be set.",
  );
  process.exit(1);
}

const DEADLINE_MS = 90_000;
const INTERVAL_MS = 2_000;
const start = Date.now();

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
  disableLosslessIntegers: true,
  connectionAcquisitionTimeout: 5_000,
});

let attempt = 0;
// eslint-disable-next-line no-constant-condition
while (true) {
  attempt += 1;
  const session = driver.session();
  try {
    await session.run("RETURN 1 AS ok");
    await session.close();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`wait-for-neo4j: ready after ${elapsed}s (${attempt} attempt(s)).`);
    await driver.close();
    process.exit(0);
  } catch (err) {
    await session.close().catch(() => {});
    const elapsed = Date.now() - start;
    if (elapsed >= DEADLINE_MS) {
      console.error(
        `wait-for-neo4j: gave up after ${(elapsed / 1000).toFixed(1)}s ` +
          `(${attempt} attempts). Last error: ${err?.message ?? err}`,
      );
      await driver.close();
      process.exit(1);
    }
    console.log(
      `wait-for-neo4j: not ready yet (attempt ${attempt}, ${(elapsed / 1000).toFixed(1)}s) — ` +
        `retrying in ${INTERVAL_MS / 1000}s...`,
    );
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}
