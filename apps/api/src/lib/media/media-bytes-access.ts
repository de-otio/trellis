/**
 * media-bytes-access.ts — hand a moderation adapter the BYTES it needs without
 * handing it storage credentials.
 *
 * Some classifiers do not read from object storage at all: they take an image
 * in the request body. Wiring one of those up used to mean giving the adapter
 * its own storage client and its own credentials — a second identity with read
 * access to every piece of user media, living in a consuming application's
 * config, for the sake of one HTTP POST.
 *
 * This capability closes that gap. Core reads the object through the storage
 * port it already holds and passes a Buffer to the adapter. The adapter needs
 * no credentials, no bucket name, and no knowledge of where media lives.
 *
 * TWO BOUNDS, both load-bearing:
 *
 *  - A SIZE CAP. The adapter names a key; core reads it. Without a cap, an
 *    adapter (or anything that can influence which key it asks for) could make
 *    a worker pull a multi-gigabyte object into memory. The read is RANGED to
 *    the cap plus one byte, so an oversize object is detected by what came back
 *    rather than by trusting a size the store reported.
 *  - PIN PASS-THROUGH. When the ref carries a pin, the read is pinned to it, so
 *    the adapter classifies the exact bytes the pipeline recorded rather than
 *    whatever currently sits at the key.
 */

import type { StoragePort } from "./media-ports.js";
import { refPin, type ImageRef, type MediaPin } from "./moderation-provider.js";

/** Raised when the object is larger than the configured cap. */
export class MediaBytesTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(
      `media object exceeds the ${maxBytes}-byte moderation read cap; refusing to load it`,
    );
    this.name = "MediaBytesTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export class MediaBytesAccessConfigError extends Error {
  constructor() {
    super(
      "media bytes access requires a positive maxBytes cap; refusing to read unbounded",
    );
    this.name = "MediaBytesAccessConfigError";
  }
}

/**
 * The capability handed to a provider adapter at injection time.
 *
 * Deliberately minimal: one method, one direction, no bucket handle and no way
 * to write, delete, or list. An adapter holding this can read the object it was
 * asked to classify and nothing else.
 */
export interface MediaBytesAccess {
  /**
   * Read the object a ref points at, up to the configured cap.
   *
   * @throws {@link MediaBytesTooLargeError} when the object exceeds the cap.
   */
  read(ref: { readonly key: string; readonly pin?: MediaPin }): Promise<Buffer>;
  /** The cap, so an adapter can refuse early rather than provoke a throw. */
  readonly maxBytes: number;
}

export function createMediaBytesAccess(
  storage: StoragePort,
  config: { readonly maxBytes: number },
): MediaBytesAccess {
  const maxBytes = config?.maxBytes;
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new MediaBytesAccessConfigError();
  }

  return {
    maxBytes,
    async read(ref) {
      const pin = refPin({ bucket: "", key: ref.key, ...(ref.pin && { pin: ref.pin }) } as ImageRef);
      // Ask for ONE byte past the cap: if that byte comes back, the object is
      // over the cap, and we know it from the bytes rather than from a
      // self-reported length we would have to trust.
      const bytes = await storage.getObject(ref.key, {
        ...(pin?.kind === "versionId" && { versionId: pin.value }),
        range: { start: 0, end: maxBytes },
      });
      if (bytes.length > maxBytes) {
        throw new MediaBytesTooLargeError(maxBytes);
      }
      return bytes;
    },
  };
}
