/**
 * Unit Tests: Idempotency Store (KvStoreIdempotencyStore)
 *
 * Proves OUTCOME equivalence of the idempotency store interface against an
 * injected in-memory `KvStore` (`MemoryKvStore`) from the foundation port —
 * NOT raw DynamoDB command shapes. The DynamoDB-specific wiring is exercised by
 * the port's own adapter-contract suite; here we assert the behaviors the
 * middleware relies on (create-once dedup, sentinel resolve, delete, TTL-expiry).
 */

import { describe, expect, it } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import {
  buildPk,
  isInFlight,
  IDEMPOTENCY_TTL_SECONDS,
  IN_FLIGHT_SENTINEL,
  KvStoreIdempotencyStore,
  type IdempotencyRecord,
  type InFlightRecord,
  type StoredRecord,
} from "../../../src/lib/middleware/idempotency-store.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PK = "idem#t:tenant-a#my-key";

function makeRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    pk: PK,
    requestHash: "abc123",
    responseStatus: 200,
    responseBody: '{"ok":true}',
    responseHeaders: { "content-type": "application/json" },
    expiresAt: nowSec + IDEMPOTENCY_TTL_SECONDS,
    ...overrides,
  };
}

function makeInFlight(overrides: Partial<InFlightRecord> = {}): InFlightRecord {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    pk: PK,
    requestHash: "abc123",
    responseStatus: 0,
    responseBody: IN_FLIGHT_SENTINEL,
    responseHeaders: {},
    expiresAt: nowSec + 60,
    ...overrides,
  };
}

// ─── buildPk (pure, backend-agnostic) ────────────────────────────────────────

describe("buildPk", () => {
  it("prefixes with idem# and a default 'anon' scope when no scope is supplied", () => {
    expect(buildPk("my-key")).toBe("idem#anon#my-key");
  });

  it("includes the supplied scope in the pk", () => {
    expect(buildPk("my-key", "t:tenant-a")).toBe("idem#t:tenant-a#my-key");
  });

  it("HIGH-1: same raw key with different scopes produces distinct pks", () => {
    expect(buildPk("Idemp-Key-Reused", "t:tenant-a")).not.toBe(
      buildPk("Idemp-Key-Reused", "t:tenant-b"),
    );
  });

  it("sanitises scope so unusual characters cannot collide with another scope", () => {
    const a = buildPk("k", "t:legit");
    const b = buildPk("k", "t#legit");
    expect(a).not.toBe(b);
    expect(b).toMatch(/^idem#t_legit#k$/);
  });
});

describe("isInFlight", () => {
  it("returns true for in-flight sentinel record", () => {
    expect(isInFlight(makeInFlight())).toBe(true);
  });

  it("returns false for a resolved record", () => {
    expect(isInFlight(makeRecord())).toBe(false);
  });
});

describe("IDEMPOTENCY_TTL_SECONDS", () => {
  it("equals 24 hours", () => {
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
  });
});

// ─── KvStoreIdempotencyStore — outcome equivalence ───────────────────────────

describe("KvStoreIdempotencyStore", () => {
  function newStore(now?: () => number): KvStoreIdempotencyStore {
    return new KvStoreIdempotencyStore(new MemoryKvStore(now ? { now } : undefined));
  }

  it("get returns null for a missing key", async () => {
    const store = newStore();
    expect(await store.get(PK)).toBeNull();
  });

  it("putIfAbsent is create-once: true then false for the same key", async () => {
    const store = newStore();
    expect(await store.putIfAbsent(makeInFlight())).toBe(true);
    // A second claim on the still-live key is rejected.
    expect(await store.putIfAbsent(makeInFlight({ requestHash: "different" }))).toBe(false);
  });

  it("get after putIfAbsent reconstructs the stored record with pk and all fields intact", async () => {
    const store = newStore();
    const record = makeRecord({
      requestHash: "hash-xyz",
      responseStatus: 201,
      responseBody: '{"created":true}',
      responseHeaders: { "content-type": "application/json", location: "/things/1" },
    });
    expect(await store.putIfAbsent(record)).toBe(true);

    const got = await store.get(PK);
    expect(got).not.toBeNull();
    expect(got).toEqual(record);
    expect(got?.pk).toBe(PK);
    expect(got?.requestHash).toBe("hash-xyz");
    expect(got?.responseStatus).toBe(201);
    expect(got?.responseBody).toBe('{"created":true}');
    expect(got?.responseHeaders).toEqual({
      "content-type": "application/json",
      location: "/things/1",
    });
    expect(got?.expiresAt).toBe(record.expiresAt);
  });

  it("resolve overwrites the in-flight sentinel with the final response record", async () => {
    const store = newStore();

    // Claim the key with the in-flight sentinel first.
    expect(await store.putIfAbsent(makeInFlight())).toBe(true);
    const inflight = await store.get(PK);
    expect(inflight).not.toBeNull();
    expect(isInFlight(inflight as StoredRecord)).toBe(true);

    // Resolve to the final record.
    const final = makeRecord({ responseStatus: 200, responseBody: '{"done":true}' });
    await store.resolve(final);

    const resolved = await store.get(PK);
    expect(resolved).not.toBeNull();
    expect(isInFlight(resolved as StoredRecord)).toBe(false);
    expect(resolved?.responseStatus).toBe(200);
    expect(resolved?.responseBody).toBe('{"done":true}');
  });

  it("delete removes the record so a subsequent get returns null", async () => {
    const store = newStore();
    await store.putIfAbsent(makeInFlight());
    expect(await store.get(PK)).not.toBeNull();

    await store.delete(PK);
    expect(await store.get(PK)).toBeNull();
  });

  it("F1: an expired record is treated as absent so a fresh putIfAbsent succeeds", async () => {
    let nowMs = 1_000_000_000_000; // fixed epoch ms
    const store = newStore(() => nowMs);
    const nowSec = () => Math.floor(nowMs / 1000);

    // Write a record that expires shortly.
    const first = makeRecord({ expiresAt: nowSec() + 10, requestHash: "first" });
    expect(await store.putIfAbsent(first)).toBe(true);
    expect(await store.get(PK)).not.toBeNull();

    // Advance the injected clock past the expiry.
    nowMs += 20 * 1000;

    // The stale row now reads as absent...
    expect(await store.get(PK)).toBeNull();
    // ...and a fresh claim succeeds rather than being wrongly rejected.
    const retry = makeRecord({ expiresAt: nowSec() + IDEMPOTENCY_TTL_SECONDS, requestHash: "retry" });
    expect(await store.putIfAbsent(retry)).toBe(true);

    const got = await store.get(PK);
    expect(got?.requestHash).toBe("retry");
  });
});
