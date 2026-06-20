/**
 * PollTransport + InMemorySettingStore.
 *
 * - getSetting/putSetting delegate to the store with optimistic-concurrency
 *   semantics (create, conflict, not_found, opaque ciphertext).
 * - deliver runs the policy fence (resolver invoked) then no-ops the wire and
 *   returns { delivered: false, reason: "no_transport" } when allowed,
 *   { delivered: false, reason: "policy_denied" } when the fence drops.
 */

import { describe, expect, it, vi } from "vitest";
import {
  PollTransport,
  InMemorySettingStore,
} from "../../../src/lib/realtime/index.js";
import type {
  DeliveryPolicyResolver,
  EncryptedBlob,
} from "../../../src/lib/realtime/index.js";

const allowResolver: DeliveryPolicyResolver = { decide: () => ({ deliver: true }) };

function blob(ciphertext: string): EncryptedBlob {
  return { ciphertext, version: 0, updatedAt: "" };
}

describe("InMemorySettingStore optimistic concurrency", () => {
  it("returns null for an absent (user, namespace)", async () => {
    const store = new InMemorySettingStore();
    expect(await store.get("u", "ns")).toBeNull();
  });

  it("creates version 1 on first put with expectVersion 0", async () => {
    const store = new InMemorySettingStore();
    const r = await store.put("u", "ns", blob("ct1"), 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stored.version).toBe(1);
      expect(r.stored.ciphertext).toBe("ct1");
    }
  });

  it("returns not_found when expectVersion>0 against an absent record", async () => {
    const store = new InMemorySettingStore();
    const r = await store.put("u", "ns", blob("ct"), 3);
    expect(r).toEqual({ ok: false, reason: "not_found", current: null });
  });

  it("returns version_conflict (with current) on a stale expectVersion", async () => {
    const store = new InMemorySettingStore();
    await store.put("u", "ns", blob("v1"), 0); // -> version 1
    const r = await store.put("u", "ns", blob("v2"), 0); // stale (expect 1)
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "version_conflict") {
      expect(r.current.version).toBe(1);
      expect(r.current.ciphertext).toBe("v1");
    } else {
      throw new Error("expected version_conflict");
    }
  });

  it("advances version on a matching expectVersion", async () => {
    const store = new InMemorySettingStore();
    await store.put("u", "ns", blob("v1"), 0); // -> 1
    const r = await store.put("u", "ns", blob("v2"), 1); // -> 2
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stored.version).toBe(2);
  });

  it("never parses ciphertext (opaque round-trip)", async () => {
    const store = new InMemorySettingStore();
    const opaque = "not-json-{{{ciphertext";
    await store.put("u", "ns", blob(opaque), 0);
    const got = await store.get("u", "ns");
    expect(got?.ciphertext).toBe(opaque);
  });

  it("assigns updatedAt from the injectable clock", async () => {
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const store = new InMemorySettingStore(() => fixed);
    const r = await store.put("u", "ns", blob("ct"), 0);
    if (r.ok) expect(r.stored.updatedAt).toBe(fixed.toISOString());
  });
});

describe("PollTransport", () => {
  it("kind is 'poll'", () => {
    const t = new PollTransport(new InMemorySettingStore(), allowResolver);
    expect(t.kind).toBe("poll");
  });

  it("getSetting/putSetting delegate to the store", async () => {
    const store = new InMemorySettingStore();
    const t = new PollTransport(store, allowResolver);
    await t.putSetting("u", "ns", blob("ct"), 0);
    const got = await t.getSetting("u", "ns");
    expect(got?.ciphertext).toBe("ct");
  });

  it("deliver runs the policy fence exactly once and no-ops the wire", async () => {
    const decide = vi.fn(() => ({ deliver: true as const }));
    const t = new PollTransport(new InMemorySettingStore(), { decide });
    const result = await t.deliver(
      { userId: "u", tenantId: "t" },
      { kind: "wakeup", tenantId: "t", scopeType: "user", scopeId: "u" },
      new Uint8Array(0),
    );
    expect(decide).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ delivered: false, reason: "no_transport" });
  });

  it("deliver drops with policy_denied when the fence says no", async () => {
    const decide = vi.fn(() => ({
      deliver: false as const,
      reason: "quiet_hours" as const,
    }));
    const t = new PollTransport(new InMemorySettingStore(), { decide });
    const result = await t.deliver(
      { userId: "u", tenantId: "t" },
      { kind: "wakeup", tenantId: "t", scopeType: "user", scopeId: "u" },
      new Uint8Array(0),
    );
    expect(decide).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ delivered: false, reason: "policy_denied" });
  });
});
