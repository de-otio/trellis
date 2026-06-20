/**
 * WS7 — transport selection / flag-fallback guard.
 *
 * The actual selection surface shipped by WS1 is:
 *   - `resolveRealtimeEnv()` reads `process.env.REALTIME_TRANSPORT` and builds
 *     the FALLBACK transport (poll by default; noop when "appsync-events" is set
 *     but no provider is injected).
 *   - `resolveRealtimeTransport(fallback)` returns the injected provider if one
 *     was registered via `setRealtimeProvider`, else the fallback.
 *
 * This suite is the WS7 "flag-fallback never crashes at boot" guard. The
 * single-writer env parsing itself is covered by di-wiring.test.ts; here we pin
 * the selection-stability + no-throw contract and the provider precedence.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRealtimeEnv } from "../../../src/env.js";
import {
  __resetRealtimeProviderForTests,
  CalmDeliveryResolver,
  NoopRealtimeTransport,
  resolveRealtimeTransport,
  setRealtimeProvider,
} from "../../../src/lib/realtime/index.js";
import type { RealtimeTransport } from "../../../src/lib/realtime/index.js";

const REALTIME_KEYS = [
  "REALTIME_TRANSPORT",
  "REALTIME_PUSH_ENABLED",
  "REALTIME_SETTING_NAMESPACES",
  "REALTIME_SETTING_MAX_BYTES",
  "REALTIME_CONN_LOG_RETENTION_DAYS",
];

function clearEnv() {
  for (const k of REALTIME_KEYS) delete process.env[k];
}

function fakeProvider(kind: RealtimeTransport["kind"]): RealtimeTransport {
  return {
    kind,
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
}

describe("realtime transport selection / flag fallback", () => {
  beforeEach(() => {
    __resetRealtimeProviderForTests();
    clearEnv();
  });
  afterEach(() => {
    __resetRealtimeProviderForTests();
    clearEnv();
  });

  it("default (no flag) selects the poll transport", () => {
    expect(resolveRealtimeEnv().realtimeTransport.kind).toBe("poll");
  });

  it("an UNKNOWN provider value falls back to poll and does NOT crash at boot", () => {
    process.env.REALTIME_TRANSPORT = "totally-unknown-provider";
    let kind: string | undefined;
    expect(() => {
      kind = resolveRealtimeEnv().realtimeTransport.kind;
    }).not.toThrow();
    expect(kind).toBe("poll");
  });

  it("empty-string flag falls back to poll (no crash)", () => {
    process.env.REALTIME_TRANSPORT = "";
    expect(resolveRealtimeEnv().realtimeTransport.kind).toBe("poll");
  });

  it("'appsync-events' with no injected provider selects the noop fallback (core has no AppSync code)", () => {
    process.env.REALTIME_TRANSPORT = "appsync-events";
    const r = resolveRealtimeEnv();
    expect(r.features.realtimeTransport).toBe("appsync-events");
    expect(r.realtimeTransport.kind).toBe("noop");
  });

  it("an injected provider takes precedence over the env fallback", () => {
    process.env.REALTIME_TRANSPORT = "appsync-events";
    setRealtimeProvider(fakeProvider("appsync-events"));
    expect(resolveRealtimeEnv().realtimeTransport.kind).toBe("appsync-events");
  });

  it("an injected provider takes precedence even when the env default is poll", () => {
    // No env flag at all -> fallback would be poll; the provider still wins.
    const provider = fakeProvider("appsync-events");
    setRealtimeProvider(provider);
    expect(resolveRealtimeEnv().realtimeTransport).toBe(provider);
  });

  it("resolveRealtimeTransport returns the fallback when no provider is registered", () => {
    const fallback = new NoopRealtimeTransport(new CalmDeliveryResolver());
    expect(resolveRealtimeTransport(fallback)).toBe(fallback);
  });

  it("selection is stable: repeated resolution with the same inputs yields the same kind", () => {
    process.env.REALTIME_TRANSPORT = "poll";
    const a = resolveRealtimeEnv().realtimeTransport.kind;
    const b = resolveRealtimeEnv().realtimeTransport.kind;
    expect(a).toBe(b);
    expect(a).toBe("poll");
  });
});
