/**
 * WS-2 finding 12 — a FORGED native `{ objectKey }` message (malformed / for
 * another tenant / nonexistent) must be ack-dropped by the key-form gate +
 * row-tenant re-derivation: no retry storm, no DLQ loop, and it can never
 * make the worker moderate the wrong `cas/`. Mirrors the existing
 * S3-envelope poison tests for the new shape.
 */

import { describe, expect, it, vi } from "vitest";
import {
  processRecord,
  type MediaProcessingDeps,
} from "../../../src/lib/workers/media-processing.js";

const TENANT = "cabcdefghijklmnopqrstuvwx";
const OTHER_TENANT = "czzzzzzzzzzzzzzzzzzzzzzzx";
const UPLOAD = "cupload00000000000000001x";

function makeDeps(row: { id: string; tenantId: string; uploadId: string | null } | null) {
  const markMediaForReview = vi.fn().mockResolvedValue(undefined);
  const transcode = { probeDurationSeconds: vi.fn(), transcodeVideo: vi.fn() };
  const deps = {
    persistence: {
      findMediaByUploadId: vi.fn().mockResolvedValue(row),
      markMediaForReview,
      markMediaUploaded: vi.fn().mockResolvedValue(undefined),
    },
    transcode,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as MediaProcessingDeps;
  return { deps, markMediaForReview, transcode };
}

function nativeRecord(objectKey: string) {
  return {
    messageId: "m-1",
    body: JSON.stringify({ objectKey, tenantId: TENANT, uploadId: UPLOAD }),
  };
}

describe("forged native { objectKey } messages (finding 12)", () => {
  it("a malformed key (path traversal) is ACK-dropped by the form gate — never processed", async () => {
    const { deps, transcode } = makeDeps(null);
    const outcome = await processRecord(nativeRecord("pending/../cas/x/y"), deps);
    expect(outcome.disposition).toBe("ack"); // dropped, no retry storm
    expect(transcode.probeDurationSeconds).not.toHaveBeenCalled();
  });

  it("a cas/ key is ACK-dropped (outputs are never written under pending/, cas is not our work)", async () => {
    const { deps, transcode } = makeDeps(null);
    const outcome = await processRecord(nativeRecord(`cas/${TENANT}/${"a".repeat(64)}`), deps);
    expect(outcome.disposition).toBe("ack");
    expect(transcode.probeDurationSeconds).not.toHaveBeenCalled();
  });

  it("a well-formed pending key whose row belongs to ANOTHER tenant is POISON → REVIEW + ack", async () => {
    const { deps, markMediaForReview, transcode } = makeDeps({
      id: "media-1",
      tenantId: OTHER_TENANT, // the row's authoritative tenant disagrees
      uploadId: UPLOAD,
    });
    const outcome = await processRecord(nativeRecord(`pending/${TENANT}/${UPLOAD}`), deps);

    expect(outcome.disposition).toBe("ack"); // acked — no retry storm
    expect((outcome as { poison?: boolean }).poison).toBe(true);
    expect(markMediaForReview).toHaveBeenCalledWith("media-1"); // routed to REVIEW
    // The forged key never reached transcode/moderation — it cannot moderate
    // the wrong cas/.
    expect(transcode.probeDurationSeconds).not.toHaveBeenCalled();
  });

  it("a well-formed pending key with NO row is POISON-acked (nothing to mark; no DLQ loop)", async () => {
    const { deps, markMediaForReview } = makeDeps(null);
    const outcome = await processRecord(nativeRecord(`pending/${TENANT}/${UPLOAD}`), deps);
    expect(outcome.disposition).toBe("ack");
    expect((outcome as { poison?: boolean }).poison).toBe(true);
    expect(markMediaForReview).not.toHaveBeenCalled();
  });
});
