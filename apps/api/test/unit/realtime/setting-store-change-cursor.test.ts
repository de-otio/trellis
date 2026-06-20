/**
 * InMemorySettingStore — Track C (offline backfill cursor) + Track A (reserved
 * `__keyring` namespace opaque round-trip).
 *
 * The in-memory store is the zero-infra default. These tests pin its
 * `listChangedSince` behavior (the missed-change scenario at the STORE level) and
 * assert the cursor surface is metadata-only (never carries ciphertext). They
 * also confirm `__keyring` round-trips opaquely — the store gives it no special
 * handling.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemorySettingStore,
  supportsChangeCursor,
} from "../../../src/lib/realtime/index.js";
import { KEYRING_NAMESPACE } from "../../../src/env.js";

const CLOCK = new Date("2026-06-20T00:00:00.000Z");

describe("InMemorySettingStore — listChangedSince (Track C)", () => {
  let store: InMemorySettingStore;

  beforeEach(() => {
    store = new InMemorySettingStore(() => CLOCK);
  });

  it("advertises the change-cursor capability", () => {
    expect(supportsChangeCursor(store)).toBe(true);
  });

  it("supportsChangeCursor is false for a plain SettingStore (no listChangedSince)", () => {
    const plain = {
      get: async () => null,
      put: async () => ({ ok: false, reason: "not_found", current: null }) as const,
    };
    expect(supportsChangeCursor(plain)).toBe(false);
  });

  it("a change bumps version; listChangedSince surfaces exactly the advanced namespaces", async () => {
    // Seed two namespaces for u1 at version 1.
    await store.put("u1", "feed_filters", { ciphertext: "A", version: 0, updatedAt: "" }, 0);
    await store.put("u1", "read_state", { ciphertext: "B", version: 0, updatedAt: "" }, 0);

    // Client has seen up to version 1 (the high-watermark). Nothing changed yet.
    expect(await store.listChangedSince("u1", 1)).toEqual([]);

    // Now ONE namespace advances to version 2 (the "missed change").
    await store.put("u1", "feed_filters", { ciphertext: "A2", version: 1, updatedAt: "" }, 1);

    const changes = await store.listChangedSince("u1", 1);
    expect(changes).toEqual([
      { namespace: "feed_filters", version: 2, updatedAt: CLOCK.toISOString() },
    ]);
  });

  it("returns metadata ONLY — never the ciphertext blob body", async () => {
    await store.put(
      "u1",
      "feed_filters",
      { ciphertext: "SECRET-OPAQUE", version: 0, updatedAt: "" },
      0,
    );
    const changes = await store.listChangedSince("u1", 0);
    expect(changes).toHaveLength(1);
    for (const c of changes) {
      expect(c).not.toHaveProperty("ciphertext");
      expect(Object.keys(c).sort()).toEqual(["namespace", "updatedAt", "version"]);
    }
    // The opaque ciphertext appears nowhere in the serialized cursor response.
    expect(JSON.stringify(changes)).not.toContain("SECRET-OPAQUE");
  });

  it("scopes strictly to the user (no cross-user leakage)", async () => {
    await store.put("u1", "feed_filters", { ciphertext: "U1", version: 0, updatedAt: "" }, 0);
    await store.put("u2", "feed_filters", { ciphertext: "U2", version: 0, updatedAt: "" }, 0);

    const u1 = await store.listChangedSince("u1", 0);
    expect(u1.map((c) => c.namespace)).toEqual(["feed_filters"]);
    expect(u1).toHaveLength(1);
  });

  it("orders results by ascending version", async () => {
    await store.put("u1", "ns_a", { ciphertext: "A", version: 0, updatedAt: "" }, 0);
    await store.put("u1", "ns_b", { ciphertext: "B", version: 0, updatedAt: "" }, 0);
    // Push ns_b ahead to version 3.
    await store.put("u1", "ns_b", { ciphertext: "B2", version: 1, updatedAt: "" }, 1);
    await store.put("u1", "ns_b", { ciphertext: "B3", version: 2, updatedAt: "" }, 2);

    const versions = (await store.listChangedSince("u1", 0)).map((c) => c.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(versions).toEqual([1, 3]);
  });
});

describe("InMemorySettingStore — reserved __keyring namespace (Track A)", () => {
  it("round-trips the __keyring blob opaquely (no special handling)", async () => {
    const store = new InMemorySettingStore(() => CLOCK);
    const opaque = "wrapped-DEK-bundle::base64url::opaque";

    const put = await store.put(
      "u1",
      KEYRING_NAMESPACE,
      { ciphertext: opaque, version: 0, updatedAt: "" },
      0,
    );
    expect(put.ok).toBe(true);

    const got = await store.get("u1", KEYRING_NAMESPACE);
    expect(got?.ciphertext).toBe(opaque); // stored & returned byte-for-byte
    expect(got?.version).toBe(1);

    // It participates in the change cursor like any other namespace.
    const changes = await store.listChangedSince("u1", 0);
    expect(changes).toEqual([
      { namespace: KEYRING_NAMESPACE, version: 1, updatedAt: CLOCK.toISOString() },
    ]);
  });
});
