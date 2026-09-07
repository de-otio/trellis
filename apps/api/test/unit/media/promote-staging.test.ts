/**
 * Unit tests: media/promote-staging.ts — the version-pinned staging->CAS
 * promotion shared by both the automatic and human-moderator approval paths.
 *
 * The claim under test is the TOCTOU defence: promotion copies the EXACT
 * pinned version that was scanned, never "whatever is at the staging key
 * now". Covers `resolvePromoteSource`'s precedence (pinned staging > existing
 * CAS > none) and `promotePinned`'s fail-closed guard + best-effort cleanup.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { promotePinned, resolvePromoteSource } from "../../../src/lib/media/promote-staging.js";
import type { StoragePort } from "../../../src/lib/media/media-ports.js";

function fakeStorage(): StoragePort {
  return {
    getObject: vi.fn(),
    putObject: vi.fn(),
    copyObject: vi.fn().mockResolvedValue(undefined),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    headObject: vi.fn().mockResolvedValue({ exists: false }),
  } as unknown as StoragePort;
}

describe("resolvePromoteSource", () => {
  let storage: StoragePort;

  beforeEach(() => {
    storage = fakeStorage();
  });

  it("resolves to the pinned staging version when it still exists", async () => {
    (storage.headObject as any).mockImplementation(
      async (key: string, options?: { versionId?: string }) => {
        if (key === "staging/k" && options?.versionId === "v1") {
          return { exists: true };
        }
        return { exists: false };
      },
    );
    const source = await resolvePromoteSource({
      storage,
      stagingKey: "staging/k",
      casKey: "cas/k",
      stagingVersionId: "v1",
    });
    expect(source).toEqual({ kind: "staging", versionId: "v1" });
  });

  it("falls back to an existing CAS object when the pinned version is GONE (not degraded to an unpinned head read)", async () => {
    (storage.headObject as any).mockImplementation(async (key: string) => {
      if (key === "cas/k") return { exists: true };
      return { exists: false }; // pinned staging version head fails
    });
    const source = await resolvePromoteSource({
      storage,
      stagingKey: "staging/k",
      casKey: "cas/k",
      stagingVersionId: "v1",
    });
    expect(source).toEqual({ kind: "cas" });
    // Only ever probed the PINNED version, never an unpinned head of staging.
    expect(storage.headObject).toHaveBeenCalledWith("staging/k", { versionId: "v1" });
    expect(storage.headObject).not.toHaveBeenCalledWith("staging/k", undefined);
  });

  it("a null pin is NOT degraded to an unpinned staging head read — only an already-promoted CAS object can satisfy it", async () => {
    (storage.headObject as any).mockImplementation(async (key: string) => {
      if (key === "cas/k") return { exists: true };
      return { exists: false };
    });
    const source = await resolvePromoteSource({
      storage,
      stagingKey: "staging/k",
      casKey: "cas/k",
      stagingVersionId: null,
    });
    expect(source).toEqual({ kind: "cas" });
    // The staging key is NEVER probed at all when there is no pin.
    expect(storage.headObject).not.toHaveBeenCalledWith("staging/k", expect.anything());
  });

  it("treats an undefined and an empty-string pin the same as null", async () => {
    (storage.headObject as any).mockResolvedValue({ exists: false });
    const undef = await resolvePromoteSource({
      storage,
      stagingKey: "staging/k",
      casKey: "cas/k",
      stagingVersionId: undefined,
    });
    const empty = await resolvePromoteSource({
      storage,
      stagingKey: "staging/k",
      casKey: "cas/k",
      stagingVersionId: "",
    });
    expect(undef).toEqual({ kind: "none" });
    expect(empty).toEqual({ kind: "none" });
  });

  it("resolves to none when neither the pinned version nor a CAS object exists (fail-closed)", async () => {
    (storage.headObject as any).mockResolvedValue({ exists: false });
    const source = await resolvePromoteSource({
      storage,
      stagingKey: "staging/k",
      casKey: "cas/k",
      stagingVersionId: "v1",
    });
    expect(source).toEqual({ kind: "none" });
  });
});

describe("promotePinned", () => {
  let storage: StoragePort;

  beforeEach(() => {
    storage = fakeStorage();
  });

  it("throws rather than silently no-op when called with source kind 'none'", async () => {
    await expect(
      promotePinned({
        storage,
        source: { kind: "none" },
        stagingKey: "staging/k",
        casKey: "cas/k",
        cleanupKeys: [],
      }),
    ).rejects.toThrow(/no certifiable source/);
    expect(storage.copyObject).not.toHaveBeenCalled();
  });

  it("copies the version-pinned source to the CAS key", async () => {
    await promotePinned({
      storage,
      source: { kind: "staging", versionId: "v1" },
      stagingKey: "staging/k",
      casKey: "cas/k",
      cleanupKeys: [],
    });
    expect(storage.copyObject).toHaveBeenCalledWith("staging/k", "cas/k", {
      fromVersionId: "v1",
    });
  });

  it("does NOT copy when the source is already 'cas' — re-copying could adopt post-moderation bytes", async () => {
    await promotePinned({
      storage,
      source: { kind: "cas" },
      stagingKey: "staging/k",
      casKey: "cas/k",
      cleanupKeys: [],
    });
    expect(storage.copyObject).not.toHaveBeenCalled();
  });

  it("cleans up every transient key after a successful copy", async () => {
    await promotePinned({
      storage,
      source: { kind: "staging", versionId: "v1" },
      stagingKey: "staging/k",
      casKey: "cas/k",
      cleanupKeys: ["raw/orig", "staging/k", "poster/k"],
    });
    expect(storage.deleteObject).toHaveBeenCalledTimes(3);
    expect(storage.deleteObject).toHaveBeenCalledWith("raw/orig");
    expect(storage.deleteObject).toHaveBeenCalledWith("staging/k");
    expect(storage.deleteObject).toHaveBeenCalledWith("poster/k");
  });

  it("tolerates a cleanup delete failure — the CAS copy already succeeded, a stray transient object is noise not a hole", async () => {
    (storage.deleteObject as any).mockRejectedValueOnce(new Error("delete failed"));
    const log = { warn: vi.fn() };
    await expect(
      promotePinned({
        storage,
        source: { kind: "staging", versionId: "v1" },
        stagingKey: "staging/k",
        casKey: "cas/k",
        cleanupKeys: ["raw/orig", "poster/k"],
        log,
        logContext: { mediaId: "m1" },
      }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "promote: transient-object delete tolerated",
      expect.objectContaining({ mediaId: "m1", key: "raw/orig" }),
    );
    // The SECOND cleanup key is still attempted even though the first failed.
    expect(storage.deleteObject).toHaveBeenCalledWith("poster/k");
  });

  it("does not throw when no `log` is supplied and a cleanup delete fails", async () => {
    (storage.deleteObject as any).mockRejectedValue(new Error("boom"));
    await expect(
      promotePinned({
        storage,
        source: { kind: "cas" },
        stagingKey: "staging/k",
        casKey: "cas/k",
        cleanupKeys: ["raw/orig"],
      }),
    ).resolves.toBeUndefined();
  });
});
