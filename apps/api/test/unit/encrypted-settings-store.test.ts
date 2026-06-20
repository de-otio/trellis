import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrismaEncryptedSettingsStore,
  type EncryptedUserSettingDelegate,
} from "../../src/lib/encrypted-settings/encrypted-settings-store.js";

const UPDATED = new Date("2026-06-20T00:00:00.000Z");

function makeDelegate() {
  return {
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  } satisfies EncryptedUserSettingDelegate;
}

describe("PrismaEncryptedSettingsStore", () => {
  let delegate: ReturnType<typeof makeDelegate>;
  let store: PrismaEncryptedSettingsStore;

  beforeEach(() => {
    vi.clearAllMocks();
    delegate = makeDelegate();
    store = new PrismaEncryptedSettingsStore({ encryptedUserSetting: delegate });
  });

  describe("get", () => {
    it("returns null for a nonexistent blob", async () => {
      delegate.findUnique.mockResolvedValue(null);
      expect(await store.get("u1", "feed_filters")).toBeNull();
    });

    it("maps a row to an EncryptedBlob with ISO updatedAt", async () => {
      delegate.findUnique.mockResolvedValue({
        ciphertext: "CT",
        version: 3,
        updatedAt: UPDATED,
      });
      const blob = await store.get("u1", "feed_filters");
      expect(blob).toEqual({
        ciphertext: "CT",
        version: 3,
        updatedAt: UPDATED.toISOString(),
      });
    });
  });

  describe("put — first write (expectVersion 0)", () => {
    it("creates version 1 on a fresh (user, namespace)", async () => {
      delegate.create.mockResolvedValue({
        ciphertext: "CT",
        version: 1,
        updatedAt: UPDATED,
      });
      const result = await store.put(
        "u1",
        "feed_filters",
        { ciphertext: "CT", version: 0, updatedAt: "" },
        0,
      );
      expect(result).toEqual({
        ok: true,
        stored: { ciphertext: "CT", version: 1, updatedAt: UPDATED.toISOString() },
      });
      expect(delegate.create).toHaveBeenCalledWith({
        data: { userId: "u1", namespace: "feed_filters", ciphertext: "CT", version: 1 },
        select: { ciphertext: true, version: true, updatedAt: true },
      });
      expect(delegate.updateMany).not.toHaveBeenCalled();
    });

    it("returns version_conflict (not 500) when a concurrent create wins (P2002)", async () => {
      delegate.create.mockRejectedValue({ code: "P2002" });
      delegate.findUnique.mockResolvedValue({
        ciphertext: "OTHER",
        version: 1,
        updatedAt: UPDATED,
      });
      const result = await store.put(
        "u1",
        "feed_filters",
        { ciphertext: "MINE", version: 0, updatedAt: "" },
        0,
      );
      expect(result).toEqual({
        ok: false,
        reason: "version_conflict",
        current: { ciphertext: "OTHER", version: 1, updatedAt: UPDATED.toISOString() },
      });
    });

    it("re-throws non-P2002 errors", async () => {
      delegate.create.mockRejectedValue(new Error("connection lost"));
      await expect(
        store.put("u1", "feed_filters", { ciphertext: "X", version: 0, updatedAt: "" }, 0),
      ).rejects.toThrow("connection lost");
    });
  });

  describe("put — update (expectVersion > 0)", () => {
    it("increments version when expectVersion matches (CAS hit)", async () => {
      delegate.updateMany.mockResolvedValue({ count: 1 });
      delegate.findUnique.mockResolvedValue({
        ciphertext: "NEW",
        version: 4,
        updatedAt: UPDATED,
      });
      const result = await store.put(
        "u1",
        "feed_filters",
        { ciphertext: "NEW", version: 3, updatedAt: "" },
        3,
      );
      expect(result).toEqual({
        ok: true,
        stored: { ciphertext: "NEW", version: 4, updatedAt: UPDATED.toISOString() },
      });
      expect(delegate.updateMany).toHaveBeenCalledWith({
        where: { userId: "u1", namespace: "feed_filters", version: 3 },
        data: { ciphertext: "NEW", version: { increment: 1 } },
      });
    });

    it("returns version_conflict with current when stale (CAS miss, row exists)", async () => {
      delegate.updateMany.mockResolvedValue({ count: 0 });
      delegate.findUnique.mockResolvedValue({
        ciphertext: "SERVER",
        version: 5,
        updatedAt: UPDATED,
      });
      const result = await store.put(
        "u1",
        "feed_filters",
        { ciphertext: "STALE", version: 3, updatedAt: "" },
        3,
      );
      expect(result).toEqual({
        ok: false,
        reason: "version_conflict",
        current: { ciphertext: "SERVER", version: 5, updatedAt: UPDATED.toISOString() },
      });
    });

    it("returns not_found when expectVersion>0 but no row exists", async () => {
      delegate.updateMany.mockResolvedValue({ count: 0 });
      delegate.findUnique.mockResolvedValue(null);
      const result = await store.put(
        "u1",
        "feed_filters",
        { ciphertext: "X", version: 2, updatedAt: "" },
        2,
      );
      expect(result).toEqual({ ok: false, reason: "not_found", current: null });
    });
  });

  describe("listChangedSince (Track C — offline backfill cursor)", () => {
    it("queries metadata strictly greater than the cursor, ordered by version", async () => {
      delegate.findMany.mockResolvedValue([
        { namespace: "feed_filters", version: 4, updatedAt: UPDATED },
        { namespace: "read_state", version: 7, updatedAt: UPDATED },
      ]);
      const changes = await store.listChangedSince("u1", 3);
      expect(changes).toEqual([
        { namespace: "feed_filters", version: 4, updatedAt: UPDATED.toISOString() },
        { namespace: "read_state", version: 7, updatedAt: UPDATED.toISOString() },
      ]);
      // The query MUST NOT select ciphertext, MUST scope to the user, and MUST
      // use a strict `version > sinceVersion` predicate.
      expect(delegate.findMany).toHaveBeenCalledWith({
        where: { userId: "u1", version: { gt: 3 } },
        select: { namespace: true, version: true, updatedAt: true },
        orderBy: { version: "asc" },
      });
    });

    it("returns metadata ONLY — the rows (and select) carry NO ciphertext", async () => {
      delegate.findMany.mockResolvedValue([
        { namespace: "feed_filters", version: 9, updatedAt: UPDATED },
      ]);
      const changes = await store.listChangedSince("u1", 0);
      for (const c of changes) {
        expect(c).not.toHaveProperty("ciphertext");
        expect(Object.keys(c).sort()).toEqual([
          "namespace",
          "updatedAt",
          "version",
        ]);
      }
      // The select projection passed to Prisma never asks for ciphertext.
      const arg = delegate.findMany.mock.calls[0][0];
      expect(arg.select).not.toHaveProperty("ciphertext");
    });

    it("returns [] when nothing advanced past the cursor", async () => {
      delegate.findMany.mockResolvedValue([]);
      expect(await store.listChangedSince("u1", 100)).toEqual([]);
    });
  });

  it("never inspects the ciphertext (passes it through opaque)", async () => {
    const opaque = '{"not":"parsed-by-server"}binary';
    delegate.create.mockResolvedValue({
      ciphertext: opaque,
      version: 1,
      updatedAt: UPDATED,
    });
    const result = await store.put(
      "u1",
      "feed_filters",
      { ciphertext: opaque, version: 0, updatedAt: "" },
      0,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stored.ciphertext).toBe(opaque);
  });
});
