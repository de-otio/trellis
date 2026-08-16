/**
 * What `startStandaloneServer()` claims to have done.
 *
 * The lane's globalSetup already proves it does not throw. These assert the
 * things a silent partial success would leave broken — a server that is up but
 * unmigrated, or up with the feature toggles still off, looks fine and then
 * fails inside the author's own tests with an error that points at their
 * extension.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { coreSchemaPath, startStandaloneServer, type StandaloneServer } from "../src/index.js";
import { EXAMPLE_EXTENSION_ENV, exampleExtension } from "../src/example/index.js";
import { REPO_SCHEMA_PATH } from "./harness.js";

let API_URL: string;
let server: StandaloneServer;

beforeAll(async () => {
  // Only the conformant fixture, and the conformance default LEFT ON. This is
  // the shape an author's setup file has, and it means the default is proven
  // by this lane booting at all — a default that refuses a conformant
  // extension would fail here rather than in someone else's repo.
  server = await startStandaloneServer({
    extensions: [exampleExtension],
    port: 3300,
    dynamoTable: "trellis-testkit-lane",
    extra: EXAMPLE_EXTENSION_ENV,
    schemaPath: REPO_SCHEMA_PATH,
  });
  API_URL = server.url;
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

describe("startStandaloneServer", () => {
  it("serves a healthy server on the port it was given", async () => {
    expect(API_URL).toContain(":3300");
    const res = await fetch(`${API_URL}/health`);
    expect(res.status).toBe(200);
  });

  it("mounts the registered extension's public route end to end", async () => {
    // The full request path — core's router, the wrapper, the handler — not
    // just "the process is listening".
    const res = await fetch(`${API_URL}/api/ext/${exampleExtension.id}/ping`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ pong: true });
  });

  it("honours the declared auth level rather than serving everything", async () => {
    const res = await fetch(`${API_URL}/api/ext/${exampleExtension.id}/whoami`);
    expect(res.status).toBe(401);
  });

  it("applied core's migrations", async () => {
    // Asserted against the database, not against the exit code of the
    // migrate step: "the command succeeded" and "the schema is there" are
    // different claims, and only the second one matters to the author.
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const res = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL",
      );
      expect(Number(res.rows[0]!.count)).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });

  it("enabled the global feature toggles core's handlers gate on", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const res = await client.query<{ key: string; enabled: boolean }>(
        "SELECT key, enabled FROM feature_toggles WHERE tenant_id IS NULL AND key = ANY($1)",
        [["entity_profiles_enabled", "global_public_posting_enabled"]],
      );
      expect(res.rows).toHaveLength(2);
      expect(res.rows.every((r) => r.enabled)).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("says what to do when core is a checkout rather than a tarball", () => {
    // In this workspace `@de-otio/trellis` is a symlink to apps/api, whose
    // `prisma/` directory is created by `prepack` and so is absent — exactly
    // the situation an author hits when they develop against a checkout of
    // core. The failure has to be the actionable one, naming the option, and
    // not a bare ENOENT from prisma several steps later.
    //
    // The tarball case — where the path resolves — is covered by
    // scripts/smoke-pack.sh, which is the only place a real tarball exists.
    expect(() => coreSchemaPath()).toThrow(/schemaPath/);
  });
});
