/**
 * DI / config wiring (§4 single-writer + provider injection).
 *
 * - resolveRealtimeEnv() defaults to a poll transport with no env set.
 * - REALTIME_* env vars are parsed (single-writer).
 * - setRealtimeProvider() injects a transport that resolveRealtimeTransport /
 *   resolveRealtimeEnv then return, with ZERO edits to realtime/.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRealtimeEnv } from "../../../src/env.js";
import {
  setRealtimeProvider,
  resolveRealtimeTransport,
  __resetRealtimeProviderForTests,
  NoopRealtimeTransport,
  CalmDeliveryResolver,
} from "../../../src/lib/realtime/index.js";
import type { RealtimeTransport } from "../../../src/lib/realtime/index.js";

const REALTIME_KEYS = [
  "REALTIME_TRANSPORT",
  "REALTIME_PUSH_ENABLED",
  "REALTIME_SETTING_NAMESPACES",
  "REALTIME_SETTING_MAX_BYTES",
  "REALTIME_CONN_LOG_RETENTION_DAYS",
];

function clearRealtimeEnv() {
  for (const k of REALTIME_KEYS) delete process.env[k];
}

describe("resolveRealtimeEnv — single-writer config", () => {
  beforeEach(() => {
    __resetRealtimeProviderForTests();
    clearRealtimeEnv();
  });
  afterEach(() => {
    __resetRealtimeProviderForTests();
    clearRealtimeEnv();
  });

  it("defaults to a poll transport with no env set", () => {
    const r = resolveRealtimeEnv();
    expect(r.features.realtimeTransport).toBe("poll");
    expect(r.features.realtimePush).toBe(false);
    expect(r.realtimeTransport.kind).toBe("poll");
  });

  it("applies the documented defaults for namespaces / bytes / retention", () => {
    const r = resolveRealtimeEnv();
    // Track A: the reserved `__keyring` namespace is ALWAYS present, even with no
    // deployment opt-in. With nothing configured, it is the sole allowed namespace.
    expect(r.REALTIME_SETTING_NAMESPACES).toEqual(["__keyring"]);
    expect(r.REALTIME_SETTING_MAX_BYTES).toBe(65536);
    expect(r.REALTIME_CONN_LOG_RETENTION_DAYS).toBe(7);
  });

  it("parses REALTIME_SETTING_NAMESPACES into a trimmed, non-empty list (+ reserved __keyring)", () => {
    process.env.REALTIME_SETTING_NAMESPACES = " feed_filters , read_state ,,";
    // Track A: `__keyring` is appended to the configured allowlist.
    expect(resolveRealtimeEnv().REALTIME_SETTING_NAMESPACES).toEqual([
      "feed_filters",
      "read_state",
      "__keyring",
    ]);
  });

  it("does not duplicate __keyring when it is explicitly configured", () => {
    process.env.REALTIME_SETTING_NAMESPACES = "feed_filters,__keyring";
    expect(resolveRealtimeEnv().REALTIME_SETTING_NAMESPACES).toEqual([
      "feed_filters",
      "__keyring",
    ]);
  });

  it("parses byte cap + retention from env", () => {
    process.env.REALTIME_SETTING_MAX_BYTES = "1024";
    process.env.REALTIME_CONN_LOG_RETENTION_DAYS = "30";
    const r = resolveRealtimeEnv();
    expect(r.REALTIME_SETTING_MAX_BYTES).toBe(1024);
    expect(r.REALTIME_CONN_LOG_RETENTION_DAYS).toBe(30);
  });

  it("falls back to defaults on invalid numeric env", () => {
    process.env.REALTIME_SETTING_MAX_BYTES = "-5";
    process.env.REALTIME_CONN_LOG_RETENTION_DAYS = "notanumber";
    const r = resolveRealtimeEnv();
    expect(r.REALTIME_SETTING_MAX_BYTES).toBe(65536);
    expect(r.REALTIME_CONN_LOG_RETENTION_DAYS).toBe(7);
  });

  it("REALTIME_PUSH_ENABLED=true flips features.realtimePush", () => {
    process.env.REALTIME_PUSH_ENABLED = "true";
    expect(resolveRealtimeEnv().features.realtimePush).toBe(true);
  });

  it("REALTIME_TRANSPORT=appsync-events without a provider falls back to noop", () => {
    process.env.REALTIME_TRANSPORT = "appsync-events";
    const r = resolveRealtimeEnv();
    expect(r.features.realtimeTransport).toBe("appsync-events");
    // Core has no AppSync code: the fallback is noop until a provider is injected.
    expect(r.realtimeTransport.kind).toBe("noop");
  });

  it("an unknown REALTIME_TRANSPORT value defaults to poll", () => {
    process.env.REALTIME_TRANSPORT = "carrier-pigeon";
    expect(resolveRealtimeEnv().features.realtimeTransport).toBe("poll");
  });
});

describe("setRealtimeProvider / resolveRealtimeTransport injection", () => {
  beforeEach(() => __resetRealtimeProviderForTests());
  afterEach(() => __resetRealtimeProviderForTests());

  it("returns the fallback when no provider is injected", () => {
    const fallback = new NoopRealtimeTransport(new CalmDeliveryResolver());
    expect(resolveRealtimeTransport(fallback)).toBe(fallback);
  });

  it("returns the injected transport over the fallback", () => {
    const fakeAppSync: RealtimeTransport = {
      kind: "appsync-events",
      async deliver() {
        return { delivered: true };
      },
      async getSetting() {
        return null;
      },
      async putSetting() {
        return { ok: false, reason: "not_found", current: null };
      },
    };
    setRealtimeProvider(fakeAppSync);
    const fallback = new NoopRealtimeTransport(new CalmDeliveryResolver());
    expect(resolveRealtimeTransport(fallback)).toBe(fakeAppSync);
  });

  it("an injected provider lands on resolveRealtimeEnv().realtimeTransport", () => {
    const fakeAppSync: RealtimeTransport = {
      kind: "appsync-events",
      async deliver() {
        return { delivered: true };
      },
      async getSetting() {
        return null;
      },
      async putSetting() {
        return { ok: false, reason: "not_found", current: null };
      },
    };
    setRealtimeProvider(fakeAppSync);
    expect(resolveRealtimeEnv().realtimeTransport).toBe(fakeAppSync);
  });
});
