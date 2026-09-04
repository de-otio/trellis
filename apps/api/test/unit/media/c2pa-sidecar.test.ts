/**
 * C2PA sidecar persistence — the claim-then-write decision.
 *
 * The invariant under test is an ERASURE invariant, not a storage one: every
 * sidecar object that exists must be named by a live `MediaFile.c2paSidecarKey`.
 * If an object can be written that no row points at, no deletion path can ever
 * find it, and a manifest — camera serial numbers, capture times, an identity
 * claim — outlives the account that uploaded it. So the tests here are mostly
 * about who is allowed to call `put`, and what happens when it fails.
 *
 * The other half is dedup. `contentHash` addresses the RE-ENCODED bytes, so two
 * different originals carrying two different manifests collapse onto one row and
 * one key. The claim is what stops the second from overwriting bytes the row
 * describes as the first's.
 */

import { describe, expect, it, vi } from "vitest";
import {
  recordC2paSidecar,
  sha256Hex,
  type C2paSidecarColumns,
} from "../../../src/lib/media/c2pa-sidecar.js";
import { c2paSidecarKey, isCasKeyError } from "../../../src/lib/media/cas-keys.js";

const TENANT = "c" + "a".repeat(24);
const HASH = "b".repeat(64);
const KEY = (() => {
  const k = c2paSidecarKey(TENANT, HASH);
  if (isCasKeyError(k)) throw new Error("fixture key invalid");
  return k;
})();

const MANIFEST = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function ports(overrides?: {
  claimCount?: number;
  put?: (key: string, bytes: Uint8Array) => Promise<void>;
  release?: () => Promise<void>;
}) {
  const claimed: C2paSidecarColumns[] = [];
  const claim = vi.fn(async (columns: C2paSidecarColumns) => {
    claimed.push(columns);
    return overrides?.claimCount ?? 1;
  });
  const release = vi.fn(overrides?.release ?? (async () => {}));
  const put = vi.fn(overrides?.put ?? (async () => {}));
  const onEvent = vi.fn();
  return { claim, release, put, onEvent, claimed };
}

describe("recordC2paSidecar — extracted manifests", () => {
  it("claims the row, then stores the bytes under the derived key", async () => {
    const p = ports();
    const outcome = await recordC2paSidecar(
      { kind: "extracted", container: "jpeg-app11", bytes: MANIFEST },
      KEY,
      p,
    );

    expect(outcome).toBe("stored");
    expect(p.put).toHaveBeenCalledWith(KEY, MANIFEST);
    expect(p.claimed[0]).toEqual({
      c2paManifestPresent: true,
      c2paContainer: "jpeg-app11",
      c2paSidecarKey: KEY,
      c2paSidecarBytes: 8,
      c2paSidecarSha256: await sha256Hex(MANIFEST),
    });
  });

  it("claims BEFORE it writes", async () => {
    // Ordering is the whole design. Writing first would let a second upload of
    // the same re-encoded bytes clobber an object the row still describes by
    // the first upload's sha256.
    const order: string[] = [];
    const p = ports({
      put: async () => {
        order.push("put");
      },
    });
    p.claim.mockImplementation(async () => {
      order.push("claim");
      return 1;
    });

    await recordC2paSidecar(
      { kind: "extracted", container: "png-cabx", bytes: MANIFEST },
      KEY,
      p,
    );
    expect(order).toEqual(["claim", "put"]);
  });

  it("writes NOTHING when another upload of the same bytes claimed first", async () => {
    const p = ports({ claimCount: 0 });
    const outcome = await recordC2paSidecar(
      { kind: "extracted", container: "jpeg-app11", bytes: MANIFEST },
      KEY,
      p,
    );

    expect(outcome).toBe("already-recorded");
    expect(p.put).not.toHaveBeenCalled();
  });

  it("releases the claim when the object write fails", async () => {
    // Otherwise the row names a key that does not exist, and a later read
    // reports a sidecar the store cannot produce.
    const p = ports({
      put: async () => {
        throw new Error("503 SlowDown");
      },
    });
    const outcome = await recordC2paSidecar(
      { kind: "extracted", container: "jpeg-app11", bytes: MANIFEST },
      KEY,
      p,
    );

    expect(outcome).toBe("store-failed");
    expect(p.release).toHaveBeenCalledTimes(1);
  });

  it("still resolves when the release itself fails", async () => {
    const p = ports({
      put: async () => {
        throw new Error("503 SlowDown");
      },
      release: async () => {
        throw new Error("db gone");
      },
    });
    await expect(
      recordC2paSidecar(
        { kind: "extracted", container: "jpeg-app11", bytes: MANIFEST },
        KEY,
        p,
      ),
    ).resolves.toBe("store-failed");
    expect(p.onEvent).toHaveBeenCalledWith(
      "c2pa.sidecar_release_failed",
      expect.anything(),
    );
  });

  it("never throws when the claim itself fails — an upload must not fail on this", async () => {
    const p = ports();
    p.claim.mockRejectedValue(new Error("statement timeout"));
    await expect(
      recordC2paSidecar(
        { kind: "extracted", container: "jpeg-app11", bytes: MANIFEST },
        KEY,
        p,
      ),
    ).resolves.toBe("store-failed");
    expect(p.put).not.toHaveBeenCalled();
  });
});

describe("recordC2paSidecar — presence-only and absent", () => {
  it("records presence with no key and no object", async () => {
    const p = ports();
    const outcome = await recordC2paSidecar(
      { kind: "presence-only", container: "unidentified" },
      KEY,
      p,
    );

    expect(outcome).toBe("presence-only");
    expect(p.put).not.toHaveBeenCalled();
    expect(p.claimed[0]).toEqual({
      c2paManifestPresent: true,
      c2paContainer: "unidentified",
      c2paSidecarKey: null,
      c2paSidecarBytes: null,
      c2paSidecarSha256: null,
    });
  });

  it("touches nothing at all when there is no manifest", async () => {
    const p = ports();
    const outcome = await recordC2paSidecar({ kind: "absent" }, KEY, p);

    expect(outcome).toBe("absent");
    expect(p.claim).not.toHaveBeenCalled();
    expect(p.put).not.toHaveBeenCalled();
  });
});

describe("c2paSidecarKey", () => {
  it("is the media key plus a .c2pa suffix — a sibling, not a preset", () => {
    expect(KEY).toBe(`cas/${TENANT}/${HASH}.c2pa`);
  });

  it("rejects the inputs casKey rejects, rather than building a traversal", () => {
    expect(isCasKeyError(c2paSidecarKey("../../etc", HASH))).toBe(true);
    expect(isCasKeyError(c2paSidecarKey(TENANT, "../../../secret"))).toBe(true);
  });
});

describe("sha256Hex", () => {
  it("matches the CAS hash convention (lowercase hex of the bytes)", async () => {
    // Known vector: SHA-256 of the empty input.
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes only the view, not the whole backing buffer", async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5);
    expect(await sha256Hex(view)).toBe(
      await sha256Hex(new Uint8Array([1, 2, 3])),
    );
  });
});
