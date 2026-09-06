// T8 — device registration/deletion business logic
// (frozen contract: apps/api/src/lib/doc/push-device-contract.md §2).

import type { PushPlatform } from "@prisma/client";
import type { Env } from "../../env.js";
import { createPrisma } from "../../db.js";
import { MAX_PUSH_DEVICES_PER_USER, platformToWire } from "./push-dispatcher.js";
import type { PushPlatformWire } from "./push-transport.js";
import { hashDeviceToken, resolveKeyring, sealSecret } from "./token-crypto.js";

/** Wire platform → Prisma enum. */
export function wireToPlatform(wire: PushPlatformWire): PushPlatform {
  switch (wire) {
    case "apns":
      return "APNS";
    case "fcm":
      return "FCM";
    case "web":
      return "WEB";
  }
}

export interface RegisteredDeviceDto {
  id: string;
  platform: PushPlatformWire;
  createdAt: string;
  lastSeenAt: string;
}

export class PushDeviceHandler {
  /**
   * Register (or refresh) a device token for the session user. Idempotent
   * upsert keyed on the deterministic tokenHash; a token currently held by
   * ANOTHER account is REASSIGNED (last registration wins — the
   * account-switch case, contract §1). Enforces the per-user device cap by
   * evicting the stalest rows. The raw token is stored AES-GCM encrypted and
   * is never returned.
   */
  async registerDevice(
    userId: string,
    token: string,
    platform: PushPlatformWire,
    env: Env,
  ): Promise<RegisteredDeviceDto> {
    const db = createPrisma(env);
    try {
      const tokenHash = await hashDeviceToken(token);
      const tokenCiphertext = await sealSecret(
        token,
        resolveKeyring(env, "push"),
      );

      const device = await db.pushDevice.upsert({
        where: { tokenHash },
        create: {
          userId,
          platform: wireToPlatform(platform),
          tokenHash,
          tokenCiphertext,
        },
        update: {
          // Reassignment on account switch is deliberate (contract §1).
          userId,
          platform: wireToPlatform(platform),
          tokenCiphertext,
          lastSeenAt: new Date(),
        },
      });

      // Per-user cap: evict the stalest rows beyond the cap (bounded fan-out
      // + storage-abuse rail). `skip` past the cap on the freshest-first
      // ordering yields exactly the eviction set.
      const overflow = await db.pushDevice.findMany({
        where: { userId },
        orderBy: { lastSeenAt: "desc" },
        skip: MAX_PUSH_DEVICES_PER_USER,
        select: { id: true },
      });
      if (overflow.length > 0) {
        await db.pushDevice.deleteMany({
          where: { id: { in: overflow.map((d) => d.id) }, userId },
        });
      }

      return {
        id: device.id,
        platform: platformToWire(device.platform),
        createdAt: device.createdAt.toISOString(),
        lastSeenAt: device.lastSeenAt.toISOString(),
      };
    } finally {
      await db.release();
    }
  }

  /**
   * Delete one of the session user's devices. Owner-scoped: the delete
   * predicate includes userId, so a foreign or unknown id deletes nothing.
   * Returns false in that case (route answers 404 — no existence oracle).
   */
  async deleteDevice(
    userId: string,
    deviceId: string,
    env: Env,
  ): Promise<boolean> {
    const db = createPrisma(env);
    try {
      const { count } = await db.pushDevice.deleteMany({
        where: { id: deviceId, userId },
      });
      return count > 0;
    } finally {
      await db.release();
    }
  }
}
