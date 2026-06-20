/**
 * createNotification push hand-off (the WS1 default-off deliver() gate).
 *
 * - Push is NOT invoked when features.realtimePush is false (default).
 * - Push IS invoked when features.realtimePush is true and the decision delivers.
 * - A transport throw is non-fatal: the notification still persists.
 * - ALWAYS_DELIVER types route to the "safety" channel; others to "wakeup".
 * - A quiet-hours deferral (deliver:false) suppresses the push.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type {
  Channel,
  RealtimeTransport,
} from "../../../src/lib/realtime/index.js";
import { decodeWakeup } from "../../../src/lib/realtime/index.js";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    notification: { create: vi.fn() },
    notificationPreference: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    release: vi.fn(),
  },
}));

vi.mock("../../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

import { NotificationHandler } from "../../../src/lib/notification-handler.js";

const TENANT = "tenant-1";
const USER = "user-1";

function makeTransport(): { transport: RealtimeTransport; deliver: ReturnType<typeof vi.fn> } {
  const deliver = vi.fn(async () => ({ delivered: true as const }));
  const transport: RealtimeTransport = {
    kind: "appsync-events",
    deliver,
    async getSetting() {
      return null;
    },
    async putSetting() {
      return { ok: false, reason: "not_found", current: null };
    },
  };
  return { transport, deliver };
}

function makeEnv(opts: {
  push: boolean;
  transport: RealtimeTransport;
}): Env {
  return {
    DATABASE_URL: "postgresql://t:t@localhost:5432/t",
    SESSION_SECRET: "test-secret-32-characters-long!!",
    features: { realtimeTransport: "appsync-events", realtimePush: opts.push },
    realtimeTransport: opts.transport,
  } as unknown as Env;
}

describe("createNotification push hand-off", () => {
  let handler: NotificationHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new NotificationHandler();
    mockPrisma.release.mockResolvedValue(undefined);
    mockPrisma.notification.create.mockResolvedValue({ id: "notif-1" });
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({
      quietHoursEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
    });
  });

  it("does NOT push when features.realtimePush is false (default)", async () => {
    const { transport, deliver } = makeTransport();
    const env = makeEnv({ push: false, transport });
    const r = await handler.createNotification(
      USER,
      "FOLLOW",
      "t",
      "b",
      {},
      env,
      TENANT,
    );
    expect(r.id).toBe("notif-1");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("pushes a content-free wakeup when realtimePush is true and decision delivers", async () => {
    const { transport, deliver } = makeTransport();
    const env = makeEnv({ push: true, transport });
    await handler.createNotification(USER, "FOLLOW", "t", "b", {}, env, TENANT);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [target, channel, payload] = deliver.mock.calls[0] as [
      { userId: string; tenantId: string },
      Channel,
      Uint8Array,
    ];
    expect(target).toEqual({ userId: USER, tenantId: TENANT });
    expect(channel.kind).toBe("wakeup");
    expect(channel.scopeType).toBe("user");
    expect(channel.scopeId).toBe(USER);
    expect(channel.tenantId).toBe(TENANT);
    expect(payload).toBeInstanceOf(Uint8Array);
    // Content-free is now STRUCTURAL (WS4): the payload is a frozen WakeupEnvelope
    // built via encodeWakeup(), carrying only { v, kind } — never title/body/data.
    const env2 = decodeWakeup(payload);
    expect(env2).toEqual({ v: 1, kind: "wakeup" });
  });

  it("routes ALWAYS_DELIVER types to the 'safety' channel", async () => {
    const { transport, deliver } = makeTransport();
    const env = makeEnv({ push: true, transport });
    await handler.createNotification(
      USER,
      "SAFETY_ALERT",
      "t",
      "b",
      {},
      env,
      TENANT,
    );
    expect(deliver).toHaveBeenCalledTimes(1);
    const channel = deliver.mock.calls[0][1] as Channel;
    expect(channel.kind).toBe("safety");
  });

  it("suppresses the push when quiet hours defer the notification", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      quietHoursEnabled: true,
      quietHoursStart: 0,
      quietHoursEnd: 1440, // whole day -> always quiet
    });
    const { transport, deliver } = makeTransport();
    const env = makeEnv({ push: true, transport });
    const r = await handler.createNotification(
      USER,
      "FOLLOW",
      "t",
      "b",
      {},
      env,
      TENANT,
    );
    expect(r.id).toBe("notif-1"); // still persisted
    expect(deliver).not.toHaveBeenCalled();
  });

  it("is non-fatal: a transport throw does not roll back persistence", async () => {
    const deliver = vi.fn(async () => {
      throw new Error("socket boom");
    });
    const transport: RealtimeTransport = {
      kind: "appsync-events",
      deliver,
      async getSetting() {
        return null;
      },
      async putSetting() {
        return { ok: false, reason: "not_found", current: null };
      },
    };
    const env = makeEnv({ push: true, transport });
    const r = await handler.createNotification(
      USER,
      "FOLLOW",
      "t",
      "b",
      {},
      env,
      TENANT,
    );
    expect(r.id).toBe("notif-1");
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
