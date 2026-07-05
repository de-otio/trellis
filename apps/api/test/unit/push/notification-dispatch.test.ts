/**
 * createNotification → PushDispatcher wiring (T8).
 *
 * - No injected PushTransport => no device dispatch (default-OFF stays
 *   double-gated: features.realtimePush AND injection).
 * - Flag off => no dispatch even with a transport injected.
 * - Flag on + injected => the user's devices receive the SAME content-free
 *   wakeup: even though the Notification row has a title/body, none of it
 *   reaches the transport payload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { decodeWakeup } from "../../../src/lib/realtime/index.js";
import type { RealtimeTransport } from "../../../src/lib/realtime/index.js";
import {
  __resetPushTransportProviderForTests,
  setPushTransportProvider,
} from "../../../src/lib/push/push-transport.js";
import type { PushTransport } from "../../../src/lib/push/push-transport.js";
import { encryptSecret } from "../../../src/lib/push/token-crypto.js";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    notification: { create: vi.fn() },
    notificationPreference: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    pushDevice: { findMany: vi.fn(), deleteMany: vi.fn() },
    release: vi.fn(),
  },
}));

vi.mock("../../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

import { NotificationHandler } from "../../../src/lib/notification-handler.js";

const KEY = "test-secret-32-characters-long!!";
const TENANT = "tenant-1";
const USER = "user-1";

const realtimeTransport: RealtimeTransport = {
  kind: "noop",
  deliver: async () => ({ delivered: true as const }),
  getSetting: async () => null,
  putSetting: async () => ({ ok: false as const, reason: "not_found" as const, current: null }),
};

function makeEnv(push: boolean): Env {
  return {
    DATABASE_URL: "postgresql://t:t@localhost:5432/t",
    SESSION_SECRET: KEY,
    features: { realtimeTransport: "poll", realtimePush: push },
    realtimeTransport,
  } as unknown as Env;
}

describe("createNotification device-push dispatch", () => {
  let handler: NotificationHandler;
  let send: ReturnType<typeof vi.fn>;
  let pushTransport: PushTransport;

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetPushTransportProviderForTests();
    handler = new NotificationHandler();
    send = vi.fn(async () => ({ ok: true as const }));
    pushTransport = { kind: "test", send };

    mockPrisma.release.mockResolvedValue(undefined);
    mockPrisma.notification.create.mockResolvedValue({ id: "notif-1" });
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({
      quietHoursEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    mockPrisma.pushDevice.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.pushDevice.findMany.mockResolvedValue([
      {
        id: "dev-1",
        platform: "APNS",
        tokenCiphertext: await encryptSecret("raw-token", KEY),
      },
    ]);
  });

  afterEach(() => {
    __resetPushTransportProviderForTests();
  });

  it("does not touch devices when no PushTransport is injected", async () => {
    await handler.createNotification(
      USER,
      "FOLLOW",
      "title",
      "body",
      {},
      makeEnv(true),
      TENANT,
    );
    expect(mockPrisma.pushDevice.findMany).not.toHaveBeenCalled();
  });

  it("does not dispatch when features.realtimePush is off (default)", async () => {
    setPushTransportProvider(pushTransport);
    await handler.createNotification(
      USER,
      "FOLLOW",
      "title",
      "body",
      {},
      makeEnv(false),
      TENANT,
    );
    expect(send).not.toHaveBeenCalled();
    expect(mockPrisma.pushDevice.findMany).not.toHaveBeenCalled();
  });

  it("dispatches the content-free wakeup to registered devices — notification content never reaches the payload", async () => {
    setPushTransportProvider(pushTransport);
    const r = await handler.createNotification(
      USER,
      "FOLLOW",
      "SECRET-TITLE",
      "SECRET-BODY",
      { secretField: "SECRET-DATA" },
      makeEnv(true),
      TENANT,
    );

    expect(r.id).toBe("notif-1");
    expect(send).toHaveBeenCalledTimes(1);

    const [target, payload] = send.mock.calls[0] as [
      { deviceId: string; platform: string; token: string },
      Uint8Array,
    ];
    expect(target).toEqual({
      deviceId: "dev-1",
      platform: "apns",
      token: "raw-token",
    });

    // The frozen envelope, nothing else.
    expect(decodeWakeup(payload)).toEqual({ v: 1, kind: "wakeup" });
    const rawJson = new TextDecoder().decode(payload);
    expect(rawJson).not.toContain("SECRET-TITLE");
    expect(rawJson).not.toContain("SECRET-BODY");
    expect(rawJson).not.toContain("SECRET-DATA");
    expect(rawJson).not.toContain(USER);
    expect(rawJson).not.toContain("notif-1");
  });

  it("a throwing push transport never breaks notification persistence", async () => {
    send.mockRejectedValue(new Error("push infra down"));
    setPushTransportProvider(pushTransport);

    const r = await handler.createNotification(
      USER,
      "FOLLOW",
      "t",
      "b",
      {},
      makeEnv(true),
      TENANT,
    );

    expect(r.id).toBe("notif-1");
    expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
  });
});
