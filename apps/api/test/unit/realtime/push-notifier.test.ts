/**
 * WS4 — PushNotifier unit tests.
 *
 * The headline guard is STRUCTURAL content-freeness: PushNotifier builds its
 * payload only via encodeWakeup(), so there is NO code path that can put a
 * title/body/data on the wire. We assert the decoded envelope carries only
 * { v, kind } across arbitrary recipients/kinds (property-style), and that the
 * raw bytes never contain notification-content strings.
 *
 * Best-effort: a transport that throws or reports not-delivered NEVER surfaces
 * to the caller — notify() resolves (false), never rejects.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../src/lib/logger.js";
import {
  buildNotificationWakeup,
  PushNotifier,
} from "../../../src/lib/realtime/push-notifier.js";
import { decodeWakeup } from "../../../src/lib/realtime/index.js";
import type {
  Channel,
  DeliveryResult,
  DeliveryTarget,
  RealtimeTransport,
} from "../../../src/lib/realtime/index.js";

function makeLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
}

interface SettingStub {
  getSetting: RealtimeTransport["getSetting"];
  putSetting: RealtimeTransport["putSetting"];
}
const SETTING_STUB: SettingStub = {
  async getSetting() {
    return null;
  },
  async putSetting() {
    return { ok: false, reason: "not_found", current: null };
  },
};

function transportThatDelivers(result: DeliveryResult): {
  transport: RealtimeTransport;
  deliver: ReturnType<typeof vi.fn>;
} {
  const deliver = vi.fn(async () => result);
  return {
    deliver,
    transport: { kind: "appsync-events", deliver, ...SETTING_STUB },
  };
}

describe("buildNotificationWakeup — content-free by construction", () => {
  for (const kind of ["wakeup", "safety"] as const) {
    it(`${kind}: encodes only { v, kind }`, () => {
      const bytes = buildNotificationWakeup(kind);
      const decoded = decodeWakeup(bytes);
      expect(decoded).toEqual({ v: 1, kind });
      // No content keys ever appear in the canonical JSON.
      const json = new TextDecoder().decode(bytes);
      expect(json).not.toMatch(/title|body|data|message|text/i);
    });
  }

  it("never carries a changeToken (notification wakeups are not setting_sync)", () => {
    const decoded = decodeWakeup(buildNotificationWakeup("wakeup"));
    expect(decoded.changeToken).toBeUndefined();
  });
});

describe("PushNotifier.notify", () => {
  const target = { userId: "u-1", tenantId: "t-1" };

  it("relays a content-free wakeup on the wakeup channel and reports delivered", async () => {
    const { transport, deliver } = transportThatDelivers({ delivered: true });
    const notifier = new PushNotifier(transport, makeLogger());

    const ok = await notifier.notify({ target, kind: "wakeup" });

    expect(ok).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [to, channel, payload] = deliver.mock.calls[0] as [
      DeliveryTarget,
      Channel,
      Uint8Array,
    ];
    expect(to).toEqual(target);
    expect(channel).toEqual({
      kind: "wakeup",
      tenantId: "t-1",
      scopeType: "user",
      scopeId: "u-1",
    });
    // Structural content-free guarantee on the actual wire bytes.
    expect(decodeWakeup(payload)).toEqual({ v: 1, kind: "wakeup" });
  });

  it("routes the safety kind onto the safety channel", async () => {
    const { transport, deliver } = transportThatDelivers({ delivered: true });
    const notifier = new PushNotifier(transport, makeLogger());

    await notifier.notify({ target, kind: "safety" });

    const channel = deliver.mock.calls[0][1] as Channel;
    expect(channel.kind).toBe("safety");
    expect(decodeWakeup(deliver.mock.calls[0][2] as Uint8Array)).toEqual({
      v: 1,
      kind: "safety",
    });
  });

  it("returns false (not thrown) when the transport reports not-delivered", async () => {
    const logger = makeLogger();
    const { transport } = transportThatDelivers({
      delivered: false,
      reason: "no_transport",
    });
    const notifier = new PushNotifier(transport, logger);

    const ok = await notifier.notify({ target, kind: "wakeup" });

    expect(ok).toBe(false);
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("BEST-EFFORT: a thrown transport never rejects — notify resolves false and logs warn", async () => {
    const logger = makeLogger();
    const deliver = vi.fn(async () => {
      throw new Error("socket boom");
    });
    const transport: RealtimeTransport = {
      kind: "appsync-events",
      deliver,
      ...SETTING_STUB,
    };
    const notifier = new PushNotifier(transport, logger);

    const ok = await notifier.notify({ target, kind: "wakeup" });

    expect(ok).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("policy_denied is reported as not-delivered, not an error", async () => {
    const { transport } = transportThatDelivers({
      delivered: false,
      reason: "policy_denied",
    });
    const notifier = new PushNotifier(transport, makeLogger());
    await expect(notifier.notify({ target, kind: "wakeup" })).resolves.toBe(
      false,
    );
  });
});
