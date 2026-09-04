/**
 * Persists the C2PA manifest store extracted at ingest, as a sidecar object
 * beside the stored media plus a summary on the `MediaFile` row.
 *
 * WHY A SIDECAR AND NOT THE FILE. The re-encode strips the manifest out of the
 * served bytes on purpose — it carries camera identity, serial numbers, capture
 * times and edit history — and that strip stays. But throwing the manifest away
 * is irreversible: once the original is gone nobody can ever check a Content
 * Credentials claim about that image again. Keeping the bytes to one side is the
 * only version of "keep the strip AND keep the evidence" that works.
 *
 * NOTHING HERE VERIFIES ANYTHING. No signature is checked, no certificate chain
 * is walked, no assertion is read. The summary says a manifest was present and
 * what its bytes hash to; it never says the manifest is true. `verified` is a
 * constant `false` at the response boundary, not a stored column, precisely so
 * that no code path can flip it without implementing verification first.
 *
 * CLAIM BEFORE WRITE — the ordering matters, and it is the whole reason this is
 * a module rather than four inline statements:
 *
 *   `contentHash` addresses the RE-ENCODED bytes, so two different originals —
 *   one carrying a manifest, one carrying a different manifest — collapse onto
 *   the SAME row and the SAME sidecar key. Writing the object first would let
 *   the second upload silently overwrite the first's bytes while the row still
 *   recorded the first's sha256. So the row's c2pa slot is claimed with a
 *   guarded update FIRST (`where: { c2paManifestPresent: null }`, atomic and
 *   idempotent under concurrency), and only the writer that actually claimed it
 *   stores an object. First manifest wins; the loser writes nothing at all.
 *
 * The corollary is the erasure invariant: **every sidecar object that exists is
 * named by a live `MediaFile.c2paSidecarKey`**. No deletion path has to guess at
 * or enumerate sidecars, and no sidecar can outlive the row that points at it.
 */

/** The additive summary columns on `MediaFile`. All nullable, all optional. */
export interface C2paSidecarColumns {
  /** A C2PA/JUMBF container was found in the original bytes. */
  readonly c2paManifestPresent: boolean;
  /** How it was carried: "jpeg-app11", "png-cabx", or "unidentified". */
  readonly c2paContainer: string;
  /** Storage key of the manifest bytes. Null ⇒ presence recorded, bytes not kept. */
  readonly c2paSidecarKey: string | null;
  /** Byte length of the sidecar object. */
  readonly c2paSidecarBytes: number | null;
  /** SHA-256 (lowercase hex) of the sidecar object, so a later read can check
   *  it got the bytes we stored. NOT a signature check. */
  readonly c2paSidecarSha256: string | null;
}

/**
 * The I/O this needs, as narrow function ports rather than a Prisma client and
 * a bucket. Keeps the decision testable without either.
 */
export interface C2paSidecarPorts {
  /**
   * Atomically claim the row's c2pa slot. MUST be guarded on the slot being
   * unset (`c2paManifestPresent: null`) so a dedup hit never overwrites an
   * earlier manifest. Returns the number of rows updated: 0 means another
   * upload of these bytes got there first.
   */
  readonly claim: (columns: C2paSidecarColumns) => Promise<number>;
  /** Undo a claim whose object write then failed, so the row never names a
   *  key that does not exist. Best-effort. */
  readonly release: () => Promise<void>;
  /** Write the sidecar object. */
  readonly put: (key: string, bytes: Uint8Array) => Promise<void>;
  /** Diagnostics. Never receives manifest content — only shapes and sizes. */
  readonly onEvent: (event: string, detail: Record<string, unknown>) => void;
}

export type C2paSidecarOutcome =
  /** No manifest in the original bytes; nothing written. */
  | "absent"
  /** A manifest was there, its bytes could not be located; presence recorded. */
  | "presence-only"
  /** Manifest bytes stored and summarised on the row. */
  | "stored"
  /** Another upload of the identical re-encoded bytes recorded a manifest
   *  first. Its record stands; we wrote nothing. */
  | "already-recorded"
  /** Slot claimed but the object write failed; the claim was released. */
  | "store-failed";

/** Lowercase-hex SHA-256, matching the CAS hash convention. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Record the result of a C2PA scan against one `MediaFile` row.
 *
 * NEVER THROWS: every port failure resolves to an outcome. A missing manifest
 * sidecar must never be able to fail an upload — the pixels are what the user
 * asked us to store.
 */
export async function recordC2paSidecar(
  scan:
    | { readonly kind: "absent" }
    | { readonly kind: "presence-only"; readonly container: "unidentified" }
    | {
        readonly kind: "extracted";
        readonly container: "jpeg-app11" | "png-cabx";
        readonly bytes: Uint8Array;
      },
  sidecarKey: string,
  ports: C2paSidecarPorts,
): Promise<C2paSidecarOutcome> {
  try {
    if (scan.kind === "absent") return "absent";

    if (scan.kind === "presence-only") {
      const claimed = await ports.claim({
        c2paManifestPresent: true,
        c2paContainer: scan.container,
        c2paSidecarKey: null,
        c2paSidecarBytes: null,
        c2paSidecarSha256: null,
      });
      return claimed > 0 ? "presence-only" : "already-recorded";
    }

    const digest = await sha256Hex(scan.bytes);
    const claimed = await ports.claim({
      c2paManifestPresent: true,
      c2paContainer: scan.container,
      c2paSidecarKey: sidecarKey,
      c2paSidecarBytes: scan.bytes.byteLength,
      c2paSidecarSha256: digest,
    });
    if (claimed === 0) {
      // A different original with the same re-encoded bytes already recorded a
      // manifest. Writing ours would overwrite bytes the row does not describe.
      ports.onEvent("c2pa.sidecar_already_recorded", { sidecarKey });
      return "already-recorded";
    }

    try {
      await ports.put(sidecarKey, scan.bytes);
    } catch (error) {
      // The row now names an object that does not exist. Put it back.
      ports.onEvent("c2pa.sidecar_store_failed", {
        sidecarKey,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await ports.release();
      } catch (releaseError) {
        ports.onEvent("c2pa.sidecar_release_failed", {
          sidecarKey,
          error:
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError),
        });
      }
      return "store-failed";
    }

    ports.onEvent("c2pa.sidecar_stored", {
      sidecarKey,
      container: scan.container,
      byteLength: scan.bytes.byteLength,
    });
    return "stored";
  } catch (error) {
    ports.onEvent("c2pa.sidecar_record_failed", {
      sidecarKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return "store-failed";
  }
}
