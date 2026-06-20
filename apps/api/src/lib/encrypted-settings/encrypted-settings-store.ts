// WS5 — PrismaEncryptedSettingsStore: the production SettingStore.
//
// Implements the FROZEN WS1 `SettingStore` port (apps/api/src/lib/realtime/
// types.ts) backed by the `EncryptedUserSetting` Postgres table. Postgres (not
// DynamoKv) is chosen for two reasons recorded in the frozen contract §M5:
//   1. Cascade-on-user-delete — the blob is dropped via the existing User
//      deletion path; no second deletion surface to audit
//      (surveillance-threat-model data-minimization).
//   2. Prisma consistency — optimistic concurrency (CAS) is a single conditional
//      `updateMany({ where: { ..., version } })`, atomic at the DB.
//
// SERVER-BLIND: this store reads/writes `ciphertext` as an opaque string. It
// NEVER parses, decodes, or logs the ciphertext. Only plaintext sync metadata
// (`version`, `updatedAt`) is interpreted.

import type {
  ChangeCursorStore,
  ChangedSettingMeta,
  EncryptedBlob,
  PutResult,
  SettingStore,
} from "./types.js";

/** The row shape this store reads back from Postgres. */
interface EncryptedUserSettingRow {
  ciphertext: string;
  version: number;
  updatedAt: Date;
}

/**
 * The change-cursor projection. Note the DELIBERATE absence of `ciphertext`:
 * `listChangedSince` selects metadata ONLY, so the blob body never leaves the DB.
 */
interface ChangedSettingRow {
  namespace: string;
  version: number;
  updatedAt: Date;
}

/**
 * The minimal Prisma surface this store needs. Declared structurally so the
 * store is unit-testable against a mock without importing the generated client
 * (which also keeps it decoupled from Prisma version drift).
 */
export interface EncryptedUserSettingDelegate {
  findUnique(args: {
    where: { userId_namespace: { userId: string; namespace: string } };
    select: { ciphertext: true; version: true; updatedAt: true };
  }): Promise<EncryptedUserSettingRow | null>;
  create(args: {
    data: { userId: string; namespace: string; ciphertext: string; version: number };
    select: { ciphertext: true; version: true; updatedAt: true };
  }): Promise<EncryptedUserSettingRow>;
  updateMany(args: {
    where: { userId: string; namespace: string; version: number };
    data: { ciphertext: string; version: { increment: number } };
  }): Promise<{ count: number }>;
  findMany(args: {
    where: { userId: string; version: { gt: number } };
    select: { namespace: true; version: true; updatedAt: true };
    orderBy: { version: "asc" };
  }): Promise<ChangedSettingRow[]>;
}

export interface PrismaWithEncryptedUserSetting {
  encryptedUserSetting: EncryptedUserSettingDelegate;
}

function toBlob(row: EncryptedUserSettingRow): EncryptedBlob {
  return {
    ciphertext: row.ciphertext,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PrismaEncryptedSettingsStore
  implements SettingStore, ChangeCursorStore
{
  constructor(private readonly db: PrismaWithEncryptedUserSetting) {}

  async get(userId: string, namespace: string): Promise<EncryptedBlob | null> {
    const row = await this.db.encryptedUserSetting.findUnique({
      where: { userId_namespace: { userId, namespace } },
      select: { ciphertext: true, version: true, updatedAt: true },
    });
    return row ? toBlob(row) : null;
  }

  /**
   * Optimistic concurrency, matching InMemorySettingStore semantics exactly:
   *  - `expectVersion === 0`: a fresh create. A pre-existing row (lost the race)
   *    surfaces as a P2002 unique violation -> version_conflict with current.
   *  - `expectVersion > 0`: conditional `updateMany WHERE version = expectVersion`.
   *    `count === 0` means the stored version moved (or the row is gone) ->
   *    re-read and return version_conflict / not_found.
   * On success the new version is `expectVersion + 1`; the DB assigns updatedAt.
   */
  async put(
    userId: string,
    namespace: string,
    blob: EncryptedBlob,
    expectVersion: number,
  ): Promise<PutResult> {
    if (expectVersion === 0) {
      try {
        const row = await this.db.encryptedUserSetting.create({
          data: { userId, namespace, ciphertext: blob.ciphertext, version: 1 },
          select: { ciphertext: true, version: true, updatedAt: true },
        });
        return { ok: true, stored: toBlob(row) };
      } catch (err) {
        if ((err as { code?: string })?.code === "P2002") {
          // A row already exists: caller's expectVersion=0 is stale.
          const current = await this.get(userId, namespace);
          if (current) return { ok: false, reason: "version_conflict", current };
          // Vanishingly rare: row deleted between create-fail and re-read.
          return { ok: false, reason: "not_found", current: null };
        }
        throw err;
      }
    }

    const result = await this.db.encryptedUserSetting.updateMany({
      where: { userId, namespace, version: expectVersion },
      data: { ciphertext: blob.ciphertext, version: { increment: 1 } },
    });

    if (result.count === 0) {
      // CAS failed: either the version moved (conflict) or no row (not_found).
      const current = await this.get(userId, namespace);
      if (current) return { ok: false, reason: "version_conflict", current };
      return { ok: false, reason: "not_found", current: null };
    }

    const stored = await this.get(userId, namespace);
    // The row exists (we just updated it); narrow for the type system.
    if (!stored) return { ok: false, reason: "not_found", current: null };
    return { ok: true, stored };
  }

  /**
   * Track C — offline backfill cursor. Returns metadata for this user's
   * namespaces whose `version` is strictly greater than `sinceVersion`, ordered
   * by ascending version. Backed by the `@@index([userId])` on the table.
   *
   * SERVER-BLIND: the `select` projects `namespace`/`version`/`updatedAt` ONLY.
   * `ciphertext` is NEVER selected, so the opaque blob body never leaves the DB
   * on this path. The cursor is an opaque per-user version high-watermark.
   */
  async listChangedSince(
    userId: string,
    sinceVersion: number,
  ): Promise<ChangedSettingMeta[]> {
    const rows = await this.db.encryptedUserSetting.findMany({
      where: { userId, version: { gt: sinceVersion } },
      select: { namespace: true, version: true, updatedAt: true },
      orderBy: { version: "asc" },
    });
    return rows.map((row) => ({
      namespace: row.namespace,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}
