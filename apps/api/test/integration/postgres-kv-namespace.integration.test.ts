/**
 * Integration Test: `PostgresKv` against a REAL Postgres.
 *
 * The unit suite pins the parameters the adapter binds. This pins what only the
 * database can answer: that the upsert actually replaces and bumps `version`,
 * that expired rows disappear from reads without any sweep having run, that
 * pagination orders and resumes correctly, and — the one that matters most —
 * that the string port and the typed `PostgresKvStore` do not collide on the
 * `invitations` namespace they both use.
 *
 * Opt-in: set KV_TEST_DATABASE_URL to a Postgres with the trellis schema
 * migrated (e.g. the local docker dev DB). Skipped otherwise.
 *
 *   KV_TEST_DATABASE_URL=postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev \
 *     npm run test:integration -- test/integration/postgres-kv-namespace.integration.test.ts
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresKvStore, type SqlExecutor } from "@de-otio/saas-foundation/kv/postgres";
import { PostgresKv } from "../../src/lib/kv/postgres-kv-namespace.js";

const TEST_DB_URL = process.env.KV_TEST_DATABASE_URL;
const suite = TEST_DB_URL ? describe : describe.skip;

/** Namespace used by both KV ports — the collision case this test exists for. */
const NAMESPACE = "invitations";

const NOW = new Date("2026-03-01T02:00:00.000Z").getTime();

suite("PostgresKv (real Postgres)", () => {
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 4 });
  const executor: SqlExecutor = {
    query: <R = Record<string, unknown>>(text: string, params: readonly unknown[]) =>
      pool.query(text, params as unknown[]) as unknown as Promise<{ rows: R[] }>,
  };

  const kv = (now: () => number = () => NOW) =>
    new PostgresKv(executor, { namespace: NAMESPACE, now });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Both ports' rows for this namespace, so a failed run cannot leak state
    // into the next one.
    await pool.query(`DELETE FROM kv_entries WHERE namespace IN ($1, $2)`, [
      `str:${NAMESPACE}`,
      NAMESPACE,
    ]);
  });

  describe("round trip", () => {
    it("stores and reads back a value", async () => {
      const store = kv();
      await store.put("invitation-session:ABC", "token-1");

      await expect(store.get("invitation-session:ABC")).resolves.toBe("token-1");
    });

    it("reads an absent key as null", async () => {
      await expect(kv().get("nope")).resolves.toBeNull();
    });

    it("round-trips metadata", async () => {
      const store = kv();
      await store.put("k", "v", { metadata: { email: "invited@example.com" } });

      await expect(store.getWithMetadata("k")).resolves.toEqual({
        value: "v",
        metadata: { email: "invited@example.com" },
      });
    });

    it("deletes", async () => {
      const store = kv();
      await store.put("k", "v");
      await store.delete("k");

      await expect(store.get("k")).resolves.toBeNull();
    });

    it("makes delete of an absent key a no-op", async () => {
      await expect(kv().delete("never-written")).resolves.toBeUndefined();
    });
  });

  describe("upsert", () => {
    it("overwrites on a second put", async () => {
      const store = kv();
      await store.put("k", "first");
      await store.put("k", "second");

      await expect(store.get("k")).resolves.toBe("second");
    });

    it("bumps version rather than inserting a second row", async () => {
      const store = kv();
      await store.put("k", "first");
      await store.put("k", "second");

      const { rows } = await pool.query<{ version: string }>(
        `SELECT version FROM kv_entries WHERE namespace = $1 AND key = $2`,
        [`str:${NAMESPACE}`, "k"],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.version)).toBe(2);
    });

    it("clears a previous expiry when re-put without one", async () => {
      // Otherwise a refreshed session token would inherit the old TTL and
      // vanish early — the kind of bug that only shows up under load.
      const store = kv();
      await store.put("k", "v", { expirationTtl: 60 });
      await store.put("k", "v2");

      const late = new PostgresKv(executor, {
        namespace: NAMESPACE,
        now: () => NOW + 3600 * 1000,
      });
      await expect(late.get("k")).resolves.toBe("v2");
    });
  });

  describe("expiry", () => {
    it("hides a row past its TTL with no sweep having run", async () => {
      const store = kv();
      await store.put("k", "v", { expirationTtl: 60 });

      const late = new PostgresKv(executor, {
        namespace: NAMESPACE,
        now: () => NOW + 61 * 1000,
      });
      await expect(late.get("k")).resolves.toBeNull();
    });

    it("still returns a row one second before expiry", async () => {
      const store = kv();
      await store.put("k", "v", { expirationTtl: 60 });

      const justBefore = new PostgresKv(executor, {
        namespace: NAMESPACE,
        now: () => NOW + 59 * 1000,
      });
      await expect(justBefore.get("k")).resolves.toBe("v");
    });

    it("leaves the expired row physically present for the cleanup cron", async () => {
      // Correctness must not depend on the sweep; this documents that the row
      // does linger, which is exactly why every read carries the predicate.
      const store = kv();
      await store.put("k", "v", { expirationTtl: 60 });

      const { rows } = await pool.query(
        `SELECT 1 FROM kv_entries WHERE namespace = $1 AND key = $2`,
        [`str:${NAMESPACE}`, "k"],
      );
      expect(rows).toHaveLength(1);
    });

    it("hides expired rows from getWithMetadata and list too", async () => {
      const store = kv();
      await store.put("k", "v", { expirationTtl: 60, metadata: { a: 1 } });

      const late = new PostgresKv(executor, {
        namespace: NAMESPACE,
        now: () => NOW + 61 * 1000,
      });
      await expect(late.getWithMetadata("k")).resolves.toEqual({
        value: null,
        metadata: null,
      });
      await expect(late.list()).resolves.toMatchObject({ keys: [] });
    });

    it("keeps a row with no expiry forever", async () => {
      const store = kv();
      await store.put("durable", "v");

      const muchLater = new PostgresKv(executor, {
        namespace: NAMESPACE,
        now: () => NOW + 365 * 24 * 3600 * 1000,
      });
      await expect(muchLater.get("durable")).resolves.toBe("v");
    });
  });

  describe("list", () => {
    it("returns keys in order, filtered by prefix", async () => {
      const store = kv();
      await store.put("session:b", "2");
      await store.put("session:a", "1");
      await store.put("other:c", "3");

      const result = await store.list({ prefix: "session:" });
      expect(result.keys.map((k) => k.name)).toEqual(["session:a", "session:b"]);
      expect(result.list_complete).toBe(true);
    });

    it("paginates through the cursor without repeating or dropping a key", async () => {
      const store = kv();
      for (const k of ["a", "b", "c", "d", "e"]) await store.put(k, k);

      const seen: string[] = [];
      let cursor: string | undefined;
      let complete = false;
      // Bounded: 5 keys at 2 per page is 3 pages; 10 caps a cursor that never
      // advances rather than spinning forever.
      for (let i = 0; i < 10 && !complete; i++) {
        const page = await store.list({ limit: 2, cursor });
        seen.push(...page.keys.map((k) => k.name));
        cursor = page.cursor;
        complete = page.list_complete;
      }

      expect(complete).toBe(true);
      expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("surfaces expiry as epoch seconds", async () => {
      const store = kv();
      await store.put("k", "v", { expiration: 1_800_000_000 });

      const result = await store.list();
      expect(result.keys[0]).toEqual({ name: "k", expiration: 1_800_000_000 });
    });

    it("does not treat a prefix's % as a wildcard", async () => {
      const store = kv();
      await store.put("100%off", "yes");
      await store.put("100NOToff", "no");

      const result = await store.list({ prefix: "100%" });
      expect(result.keys.map((k) => k.name)).toEqual(["100%off"]);
    });
  });

  describe("port isolation", () => {
    it("does not collide with the typed store on the shared 'invitations' namespace", async () => {
      // The reason for the str: prefix. The typed store writes an OBJECT value
      // under the bare code; the string port writes an envelope under its own
      // key. Sharing a namespace would let one port read the other's shape.
      const typed = new PostgresKvStore(executor, { namespace: NAMESPACE, now: () => NOW });
      const strings = kv();

      await typed.put("ABC123", { used: false, email: "invited@example.com" });
      await strings.put("ABC123", "a string value");

      await expect(typed.get<{ used: boolean }>("ABC123")).resolves.toMatchObject({
        value: { used: false, email: "invited@example.com" },
      });
      await expect(strings.get("ABC123")).resolves.toBe("a string value");

      const { rows } = await pool.query<{ namespace: string }>(
        `SELECT namespace FROM kv_entries WHERE key = $1 ORDER BY namespace`,
        ["ABC123"],
      );
      expect(rows.map((r) => r.namespace)).toEqual(["invitations", "str:invitations"]);
    });

    it("keeps two string bindings apart", async () => {
      const invitations = kv();
      const csrf = new PostgresKv(executor, { namespace: "csrf", now: () => NOW });
      await pool.query(`DELETE FROM kv_entries WHERE namespace = $1`, ["str:csrf"]);

      await invitations.put("shared-key", "from-invitations");
      await csrf.put("shared-key", "from-csrf");

      await expect(invitations.get("shared-key")).resolves.toBe("from-invitations");
      await expect(csrf.get("shared-key")).resolves.toBe("from-csrf");

      await pool.query(`DELETE FROM kv_entries WHERE namespace = $1`, ["str:csrf"]);
    });
  });
});
