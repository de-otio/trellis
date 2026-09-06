// T8 — WakeupEnvelope → registered device tokens → PushTransport.send().
//
// The dispatcher is the ONE place a content-free wakeup fans out to a user's
// registered push devices. The content-free guarantee stays STRUCTURAL: the
// payload is built ONLY via buildNotificationWakeup() (the frozen WS1
// envelope) — there is no code path here that can put notification content on
// the wire.
//
// Semantics (push-device-contract.md §4):
//   - BEST-EFFORT: dispatch() never throws. A transport throw or a store
//     hiccup is logged and absorbed; the caller's persisted Notification row
//     is durable regardless, and polling remains the floor.
//   - Token-invalidation cleanup: a transport outcome of "unregistered"
//     deletes the PushDevice row.
//   - Bounded fan-out: the per-user device query is capped at
//     MAX_PUSH_DEVICES_PER_USER (registration enforces the same cap).

import type { PushPlatform } from "@prisma/client";
import type { Logger } from "../logger.js";
import { buildNotificationWakeup } from "../realtime/push-notifier.js";
import type { WakeupKind } from "../realtime/push-notifier.js";
import { needsReseal, openSecret, sealSecret, type Keyring } from "./token-crypto.js";
import type { PushPlatformWire, PushTransport } from "./push-transport.js";

/** Per-user registered-device cap (also enforced at registration). */
export const MAX_PUSH_DEVICES_PER_USER = 20;

/** Prisma enum → wire platform. */
export function platformToWire(platform: PushPlatform): PushPlatformWire {
  switch (platform) {
    case "APNS":
      return "apns";
    case "FCM":
      return "fcm";
    case "WEB":
      return "web";
  }
}

/**
 * The slice of the Prisma client the dispatcher needs — structural, so unit
 * tests inject a plain mock and the dispatcher stays vendor-blind.
 */
export interface PushDeviceStore {
  pushDevice: {
    findMany(args: {
      where: { userId: string };
      orderBy: { lastSeenAt: "desc" };
      take: number;
      select: { id: true; platform: true; tokenCiphertext: true };
    }): Promise<
      Array<{ id: string; platform: PushPlatform; tokenCiphertext: string }>
    >;
    deleteMany(args: { where: { id: string } }): Promise<{ count: number }>;
    /**
     * Optional: lets the dispatcher re-seal a token that opened in an older
     * at-rest format (legacy raw-key wrap, or the previous session secret).
     * Best effort and non-fatal; a store without it just leaves the row as is.
     */
    update?(args: {
      where: { id: string };
      data: { tokenCiphertext: string };
    }): Promise<unknown>;
  };
}

export interface PushDispatchInput {
  /** Server-resolved recipient (never client-asserted). */
  userId: string;
  /** "safety" for ALWAYS_DELIVER types, else "wakeup" — same as PushNotifier. */
  kind: WakeupKind;
}

export interface PushDispatchResult {
  attempted: number;
  delivered: number;
  invalidated: number;
}

export class PushDispatcher {
  constructor(
    private readonly transport: PushTransport,
    private readonly logger: Logger,
  ) {}

  /**
   * Fan one content-free wakeup out to every registered device of the user.
   * NEVER throws; resolves with counters for observability.
   */
  async dispatch(
    input: PushDispatchInput,
    db: PushDeviceStore,
    keyring: Keyring,
  ): Promise<PushDispatchResult> {
    const result: PushDispatchResult = {
      attempted: 0,
      delivered: 0,
      invalidated: 0,
    };

    // The ONLY payload constructor — frozen content-free envelope (WS1/WS4).
    const payload = buildNotificationWakeup(input.kind);

    let devices: Array<{
      id: string;
      platform: PushPlatform;
      tokenCiphertext: string;
    }>;
    try {
      devices = await db.pushDevice.findMany({
        where: { userId: input.userId },
        orderBy: { lastSeenAt: "desc" },
        take: MAX_PUSH_DEVICES_PER_USER,
        select: { id: true, platform: true, tokenCiphertext: true },
      });
    } catch (err) {
      this.logger.warn("push dispatch: device lookup failed (non-fatal)", err);
      return result;
    }

    for (const device of devices) {
      result.attempted += 1;
      try {
        const token = await openSecret(device.tokenCiphertext, keyring);
        if (db.pushDevice.update && needsReseal(device.tokenCiphertext, keyring)) {
          // Migrate-on-use: the plaintext is in hand, so bring the row up to
          // the current format. Never blocks delivery.
          try {
            await db.pushDevice.update({
              where: { id: device.id },
              data: { tokenCiphertext: await sealSecret(token, keyring) },
            });
          } catch (err) {
            this.logger.warn("push dispatch: token re-seal failed (non-fatal)", err);
          }
        }
        const outcome = await this.transport.send(
          {
            deviceId: device.id,
            platform: platformToWire(device.platform),
            token,
          },
          payload,
        );

        if (outcome.ok) {
          result.delivered += 1;
          continue;
        }

        if (outcome.reason === "unregistered") {
          // Token-invalidation cleanup: the platform says this token is dead.
          try {
            await db.pushDevice.deleteMany({ where: { id: device.id } });
            result.invalidated += 1;
          } catch (err) {
            this.logger.warn(
              "push dispatch: invalidation cleanup failed (non-fatal)",
              err,
            );
          }
        } else {
          // "transient" | "config": keep the row; the next notification is
          // the retry. Logged at debug so absence of a push is observable.
          this.logger.debug("push dispatch: send not delivered", {
            reason: outcome.reason,
            kind: input.kind,
          });
        }
      } catch (err) {
        // A throwing transport or a decrypt failure is treated as transient.
        this.logger.warn("push dispatch: send threw (non-fatal)", err);
      }
    }

    return result;
  }
}
