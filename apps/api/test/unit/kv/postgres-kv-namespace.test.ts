/**
 * Unit Tests: `PostgresKv` — the Postgres adapter for the string-KV port.
 *
 * These cover what is decidable without a database: the bound namespace, the
 * jsonb envelope, TTL/expiration arithmetic against an injected clock, LIKE
 * escaping, cursor round-tripping, and the `ArrayBuffer` path. They assert the
 * PARAMETERS the adapter binds, not the SQL text — a test that pinned the
 * statement string would fail on whitespace and pass on a wrong predicate.
 *
 * The SQL predicates themselves (expiry filtering, upsert version bump,
 * pagination ordering) are exercised against a real Postgres in
 * `test/integration/postgres-kv-namespace.integration.test.ts`, because a fake
 * executor can only confirm what this file already asserts.
 */

import { describe, expect, it } from "vitest";
import type { SqlExecutor } from "@de-otio/saas-foundation/kv/postgres";
import { PostgresKv } from "../../../src/lib/kv/postgres-kv-namespace.js";

interface Call {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** Records every statement and returns canned rows. */
function recorder(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  const executor: SqlExecutor = {
    query: async <R = Record<string, unknown>>(text: string, params: readonly unknown[]) => {
      calls.push({ text, params });
      return { rows: rows as unknown as R[] };
    },
  };
  return { executor, calls };
}

/** 2026-03-01T02:00:00Z — frozen, so every expiry assertion is exact. */
const NOW = new Date("2026-03-01T02:00:00.000Z").getTime();
const clock = () => NOW;

function kv(rows: Record<string, unknown>[] = [], namespace = "invitations") {
  const { executor, calls } = recorder(rows);
  return { store: new PostgresKv(executor, { namespace, now: clock }), calls };
}

describe("PostgresKv — namespace binding", () => {
  it("prefixes the namespace so string-KV rows can never collide with the typed store", () => {
    // Both ports use the logical namespace "invitations" with different value
    // shapes. Without the prefix a key spelled the same in both would silently
    // overwrite across ports.
    expect(new PostgresKv(recorder().executor, { namespace: "invitations" }).boundNamespace).toBe(
      "str:invitations",
    );
  });

  it("binds the namespace as a parameter on every statement", async () => {
    const { store, calls } = kv();
    await store.get("k");
    await store.put("k", "v");
    await store.delete("k");
    await store.list();

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.params[0]).toBe("str:invitations");
    }
  });
});

describe("PostgresKv — put", () => {
  it("stores the value in a jsonb envelope", async () => {
    const { store, calls } = kv();
    await store.put("token", "abc123");

    expect(JSON.parse(calls[0]!.params[2] as string)).toEqual({ v: "abc123" });
  });

  it("carries metadata in the envelope (the table has no metadata column)", async () => {
    const { store, calls } = kv();
    await store.put("k", "v", { metadata: { attempt: 2 } });

    expect(JSON.parse(calls[0]!.params[2] as string)).toEqual({
      v: "v",
      m: { attempt: 2 },
    });
  });

  it("decodes an ArrayBuffer value as UTF-8, matching DynamoKv", async () => {
    const { store, calls } = kv();
    const bytes = new TextEncoder().encode("héllo");
    await store.put("k", bytes.buffer as ArrayBuffer);

    expect(JSON.parse(calls[0]!.params[2] as string)).toEqual({ v: "héllo" });
  });

  it("resolves expirationTtl against the injected clock, not Date.now", async () => {
    const { store, calls } = kv();
    await store.put("k", "v", { expirationTtl: 3600 });

    expect(calls[0]!.params[3]).toEqual(new Date(NOW + 3600 * 1000));
  });

  it("treats expiration as absolute epoch SECONDS", async () => {
    const { store, calls } = kv();
    await store.put("k", "v", { expiration: 1_800_000_000 });

    expect(calls[0]!.params[3]).toEqual(new Date(1_800_000_000 * 1000));
  });

  it("lets expiration win over expirationTtl, matching DynamoKv's precedence", async () => {
    const { store, calls } = kv();
    await store.put("k", "v", { expiration: 1_800_000_000, expirationTtl: 60 });

    expect(calls[0]!.params[3]).toEqual(new Date(1_800_000_000 * 1000));
  });

  it("writes a null expiry when neither option is given", async () => {
    const { store, calls } = kv();
    await store.put("k", "v");

    expect(calls[0]!.params[3]).toBeNull();
  });
});

describe("PostgresKv — get", () => {
  it("unwraps the envelope for a text read", async () => {
    const { store } = kv([{ value: { v: "hello" } }]);
    await expect(store.get("k")).resolves.toBe("hello");
  });

  it("returns null when no live row matched", async () => {
    const { store } = kv([]);
    await expect(store.get("k")).resolves.toBeNull();
  });

  it("parses the stored string for a json read", async () => {
    const { store } = kv([{ value: { v: '{"a":1}' } }]);
    await expect(store.get<{ a: number }>("k", "json")).resolves.toEqual({ a: 1 });
  });

  it("reads an unparseable json value as absent rather than throwing", async () => {
    // Same choice DynamoKv makes: a caller asking for JSON gets null, not an
    // exception from deep inside the KV layer.
    const { store } = kv([{ value: { v: "not json" } }]);
    await expect(store.get("k", "json")).resolves.toBeNull();
  });

  it("passes the injected clock as the expiry bound", async () => {
    const { store, calls } = kv();
    await store.get("k");

    expect(calls[0]!.params[2]).toEqual(new Date(NOW));
  });

  it("returns value and metadata together", async () => {
    const { store } = kv([{ value: { v: "hello", m: { attempt: 2 } } }]);
    await expect(store.getWithMetadata("k")).resolves.toEqual({
      value: "hello",
      metadata: { attempt: 2 },
    });
  });

  it("reports null metadata when the envelope carries none", async () => {
    const { store } = kv([{ value: { v: "hello" } }]);
    await expect(store.getWithMetadata("k")).resolves.toEqual({
      value: "hello",
      metadata: null,
    });
  });
});

describe("PostgresKv — list", () => {
  it("escapes LIKE metacharacters in the prefix", async () => {
    // An unescaped `%` would match every key in the namespace — a correctness
    // bug (the value is parameterized, so never an injection one).
    const { store, calls } = kv();
    await store.list({ prefix: "100%_of" });

    expect(calls[0]!.params[1]).toBe("100\\%\\_of%");
  });

  it("matches everything when no prefix is given", async () => {
    const { store, calls } = kv();
    await store.list();

    expect(calls[0]!.params[1]).toBe("%");
  });

  it("requests one row beyond the limit to decide list_complete", async () => {
    const { store, calls } = kv();
    await store.list({ limit: 10 });

    expect(calls[0]!.params[4]).toBe(11);
  });

  it("reports list_complete and omits a cursor on a short page", async () => {
    const { store } = kv([{ key: "a", expiration: null }]);
    const result = await store.list({ limit: 10 });

    expect(result.list_complete).toBe(true);
    expect(result.cursor).toBeUndefined();
    expect(result.keys).toEqual([{ name: "a" }]);
  });

  it("truncates to the limit and returns a cursor when more rows exist", async () => {
    const rows = [
      { key: "a", expiration: null },
      { key: "b", expiration: null },
      { key: "c", expiration: null },
    ];
    const { store } = kv(rows);
    const result = await store.list({ limit: 2 });

    expect(result.list_complete).toBe(false);
    expect(result.keys.map((k) => k.name)).toEqual(["a", "b"]);
    expect(Buffer.from(result.cursor!, "base64").toString("utf-8")).toBe("b");
  });

  it("resumes after the cursor's key", async () => {
    const { store, calls } = kv();
    await store.list({ cursor: Buffer.from("b", "utf-8").toString("base64") });

    expect(calls[0]!.params[2]).toBe("b");
  });

  it("restarts from the beginning on a malformed cursor instead of throwing", async () => {
    // Safe-fail, same as DynamoKv. A forged cursor can at worst skip rows
    // inside the namespace the caller already holds — the namespace predicate
    // is a separate parameter and is never derived from the cursor.
    const { store, calls } = kv();
    await store.list({ cursor: "!!!not-base64!!!" });

    expect(calls[0]!.params[2]).toBe("");
  });

  it("surfaces expiry as epoch seconds", async () => {
    const { store } = kv([{ key: "a", expiration: "1800000000" }]);
    const result = await store.list();

    expect(result.keys[0]).toEqual({ name: "a", expiration: 1_800_000_000 });
  });
});
