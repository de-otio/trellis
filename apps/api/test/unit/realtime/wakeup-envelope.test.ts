/**
 * Wakeup envelope encode/decode — structural content-free guarantee (§2.4).
 */

import { describe, expect, it } from "vitest";
import {
  encodeWakeup,
  decodeWakeup,
} from "../../../src/lib/realtime/index.js";
import type { WakeupEnvelope } from "../../../src/lib/realtime/index.js";

describe("encodeWakeup / decodeWakeup", () => {
  it("round-trips a minimal wakeup", () => {
    const e: WakeupEnvelope = { v: 1, kind: "wakeup" };
    expect(decodeWakeup(encodeWakeup(e))).toEqual(e);
  });

  it("round-trips a setting_sync with a changeToken", () => {
    const e: WakeupEnvelope = {
      v: 1,
      kind: "setting_sync",
      changeToken: "ver-42",
    };
    expect(decodeWakeup(encodeWakeup(e))).toEqual(e);
  });

  it("produces bytes (Uint8Array)", () => {
    expect(encodeWakeup({ v: 1, kind: "wakeup" })).toBeInstanceOf(Uint8Array);
  });

  it("has NO free-form field — encode ignores unknown props at the type level", () => {
    // Construct an envelope with a smuggled extra field at runtime and confirm
    // the canonical encoding drops it (content-free is structural).
    const smuggled = {
      v: 1,
      kind: "wakeup",
      secret: "leak-me",
    } as unknown as WakeupEnvelope;
    const decoded = decodeWakeup(encodeWakeup(smuggled));
    expect(decoded).toEqual({ v: 1, kind: "wakeup" });
    expect((decoded as Record<string, unknown>).secret).toBeUndefined();
  });

  it("decodeWakeup throws on unknown fields", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, kind: "wakeup", title: "hello" }),
    );
    expect(() => decodeWakeup(bytes)).toThrow(/unknown field/);
  });

  it("decodeWakeup throws on unsupported version", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 2, kind: "wakeup" }));
    expect(() => decodeWakeup(bytes)).toThrow();
  });

  it("decodeWakeup throws on non-JSON / non-object input", () => {
    expect(() => decodeWakeup(new TextEncoder().encode("not json"))).toThrow();
    expect(() => decodeWakeup(new TextEncoder().encode("123"))).toThrow();
  });

  it("encodeWakeup throws on a bad version", () => {
    const bad = { v: 9, kind: "wakeup" } as unknown as WakeupEnvelope;
    expect(() => encodeWakeup(bad)).toThrow();
  });
});
