/**
 * PushDispatcher (T8) — WakeupEnvelope → token lookup → PushTransport.send.
 *
 * - Looks up the user's registered devices, decrypts each token, and hands the
 *   frozen content-free WakeupEnvelope bytes to the transport.
 * - Content-free is STRUCTURAL: the payload decodes via decodeWakeup() to
 *   exactly { v, kind } — no title/body/data can reach the wire.
 * - Token-invalidation cleanup: an "unregistered" outcome deletes the row.
 * - BEST-EFFORT: transport throws, decrypt failures, and store errors are
 *   absorbed; dispatch() never throws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeWakeup } from "../../../src/lib/realtime/types.js";
import {
  MAX_PUSH_DEVICES_PER_USER,
  PushDispatcher,
  platformToWire,
} from "../../../src/lib/push/push-dispatcher.js";
import type { PushDeviceStore } from "../../../src/lib/push/push-dispatcher.js";
import type {
  PushSendOutcome,
  PushTransport,
} from "../../../src/lib/push/push-transport.js";
import { encryptSecret } from "../../../src/lib/push/token-crypto.js";

const KEY = "test-secret-32-characters-long!!";
const USER = "user-1";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function makeTransport(
  outcomes: PushSendOutcome[] | ((i: number) => PushSendOutcome),
): { transport: PushTransport; send: ReturnType<typeof vi.fn> } {
  let call = 0;
  const send = vi.fn(async (): Promise<PushSendOutcome> => {
    const i = call++;
    return typeof outcomes === "function" ? outcomes(i) : outcomes[i];
  });
  return { transport: { kind: "test-transport", send }, send };
}

function makeStore(
  devices: Array<{ id: string; platform: any; tokenCiphertext: string }>,
): { store: PushDeviceStore; findMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> } {
  const findMany = vi.fn(async () => devices);
  const deleteMany = vi.fn(async () => ({ count: 1 }));
  return {
    store: { pushDevice: { findMany, deleteMany } } as unknown as PushDeviceStore,
    findMany,
    deleteMany,
  };
}

describe("PushDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("looks up the user's devices, decrypts tokens, and sends the content-free envelope", async () => {
    const cipherA = await encryptSecret("raw-token-a", KEY);
    const cipherB = await encryptSecret("raw-token-b", KEY);
    const { store, findMany } = makeStore([
      { id: "dev-a", platform: "APNS", tokenCiphertext: cipherA },
      { id: "dev-b", platform: "FCM", tokenCiphertext: cipherB },
    ]);
    const { transport, send } = makeTransport(() => ({ ok: true }));

    const dispatcher = new PushDispatcher(transport, logger);
    const result = await dispatcher.dispatch({ userId: USER, kind: "wakeup" }, store, KEY);

    expect(result).toEqual({ attempted: 2, delivered: 2, invalidated: 0 });
    // Token lookup is user-scoped and bounded.
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER },
      orderBy: { lastSeenAt: "desc" },
      take: MAX_PUSH_DEVICES_PER_USER,
      select: { id: true, platform: true, tokenCiphertext: true },
    });
    // Decrypted tokens + wire platforms reach the transport.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toEqual({
      deviceId: "dev-a",
      platform: "apns",
      token: "raw-token-a",
    });
    expect(send.mock.calls[1][0]).toEqual({
      deviceId: "dev-b",
      platform: "fcm",
      token: "raw-token-b",
    });
  });

  it("consumes the frozen WakeupEnvelope with NO content in the payload", async () => {
    const cipher = await encryptSecret("raw-token", KEY);
    const { store } = makeStore([
      { id: "dev-1", platform: "WEB", tokenCiphertext: cipher },
    ]);
    const { transport, send } = makeTransport(() => ({ ok: true }));

    const dispatcher = new PushDispatcher(transport, logger);
    await dispatcher.dispatch({ userId: USER, kind: "safety" }, store, KEY);

    const payload = send.mock.calls[0][1] as Uint8Array;
    expect(payload).toBeInstanceOf(Uint8Array);
    // Round-trips through the frozen decoder (which REJECTS unknown fields)...
    expect(decodeWakeup(payload)).toEqual({ v: 1, kind: "safety" });
    // ...and the raw JSON carries ONLY the envelope keys — no content fields.
    const raw = JSON.parse(new TextDecoder().decode(payload));
    expect(Object.keys(raw).sort()).toEqual(["kind", "v"]);
  });

  it("deletes the device row on an 'unregistered' outcome (token-invalidation cleanup)", async () => {
    const cipherA = await encryptSecret("dead-token", KEY);
    const cipherB = await encryptSecret("live-token", KEY);
    const { store, deleteMany } = makeStore([
      { id: "dev-dead", platform: "APNS", tokenCiphertext: cipherA },
      { id: "dev-live", platform: "FCM", tokenCiphertext: cipherB },
    ]);
    const { transport } = makeTransport([
      { ok: false, reason: "unregistered" },
      { ok: true },
    ]);

    const dispatcher = new PushDispatcher(transport, logger);
    const result = await dispatcher.dispatch({ userId: USER, kind: "wakeup" }, store, KEY);

    expect(result).toEqual({ attempted: 2, delivered: 1, invalidated: 1 });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "dev-dead" } });
  });

  it("keeps the row on 'transient' and 'config' outcomes", async () => {
    const cipher = await encryptSecret("token", KEY);
    const { store, deleteMany } = makeStore([
      { id: "dev-1", platform: "APNS", tokenCiphertext: cipher },
      { id: "dev-2", platform: "FCM", tokenCiphertext: cipher },
    ]);
    const { transport } = makeTransport([
      { ok: false, reason: "transient" },
      { ok: false, reason: "config" },
    ]);

    const dispatcher = new PushDispatcher(transport, logger);
    const result = await dispatcher.dispatch({ userId: USER, kind: "wakeup" }, store, KEY);

    expect(result).toEqual({ attempted: 2, delivered: 0, invalidated: 0 });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("never throws: a throwing transport is absorbed as transient", async () => {
    const cipher = await encryptSecret("token", KEY);
    const { store, deleteMany } = makeStore([
      { id: "dev-1", platform: "APNS", tokenCiphertext: cipher },
      { id: "dev-2", platform: "FCM", tokenCiphertext: cipher },
    ]);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("APNs down"))
      .mockResolvedValueOnce({ ok: true });
    const transport: PushTransport = { kind: "boom", send };

    const dispatcher = new PushDispatcher(transport, logger);
    const result = await dispatcher.dispatch({ userId: USER, kind: "wakeup" }, store, KEY);

    expect(result).toEqual({ attempted: 2, delivered: 1, invalidated: 0 });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("never throws: an undecryptable token is skipped, the rest still send", async () => {
    const good = await encryptSecret("good-token", KEY);
    const { store } = makeStore([
      { id: "dev-bad", platform: "APNS", tokenCiphertext: "not-valid-ciphertext" },
      { id: "dev-good", platform: "FCM", tokenCiphertext: good },
    ]);
    const { transport, send } = makeTransport(() => ({ ok: true }));

    const dispatcher = new PushDispatcher(transport, logger);
    const result = await dispatcher.dispatch({ userId: USER, kind: "wakeup" }, store, KEY);

    expect(result.attempted).toBe(2);
    expect(result.delivered).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].token).toBe("good-token");
  });

  it("never throws: a failing device lookup resolves with zero counters", async () => {
    const findMany = vi.fn().mockRejectedValue(new Error("db down"));
    const store = {
      pushDevice: { findMany, deleteMany: vi.fn() },
    } as unknown as PushDeviceStore;
    const { transport, send } = makeTransport(() => ({ ok: true }));

    const dispatcher = new PushDispatcher(transport, logger);
    const result = await dispatcher.dispatch({ userId: USER, kind: "wakeup" }, store, KEY);

    expect(result).toEqual({ attempted: 0, delivered: 0, invalidated: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("absorbs a failing invalidation delete (cleanup is best-effort too)", async () => {
    const cipher = await encryptSecret("dead-token", KEY);
    const findMany = vi.fn(async () => [
      { id: "dev-dead", platform: "APNS", tokenCiphertext: cipher },
    ]);
    const deleteMany = vi.fn().mockRejectedValue(new Error("db down"));
    const store = { pushDevice: { findMany, deleteMany } } as unknown as PushDeviceStore;
    const { transport } = makeTransport([{ ok: false, reason: "unregistered" }]);

    const dispatcher = new PushDispatcher(transport, logger);
    const result = await dispatcher.dispatch({ userId: USER, kind: "wakeup" }, store, KEY);

    expect(result).toEqual({ attempted: 1, delivered: 0, invalidated: 0 });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("maps every Prisma platform to its wire form", () => {
    expect(platformToWire("APNS")).toBe("apns");
    expect(platformToWire("FCM")).toBe("fcm");
    expect(platformToWire("WEB")).toBe("web");
  });
});
