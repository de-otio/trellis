/**
 * Unit Tests: staging object cleanup (AR7).
 *
 * Chunked S3 batch delete for user-scoped staging keys, with a hard guard
 * that `cas/*` can never be deleted through this path (approved bytes are
 * reclaimed only by the nightly GC purge).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteStagingObjects } from "../../../src/lib/media/staging-object-cleanup.js";

function makeS3() {
  return { send: vi.fn().mockResolvedValue({}) };
}

describe("deleteStagingObjects", () => {
  let s3: ReturnType<typeof makeS3>;

  beforeEach(() => {
    vi.clearAllMocks();
    s3 = makeS3();
  });

  it("deletes the given keys in one DeleteObjects batch", async () => {
    const keys = ["processing/t/h", "pending/t/u"];
    const result = await deleteStagingObjects(s3, "bucket", keys);

    expect(result).toEqual({ requested: 2, failedBatches: 0, truncated: false });
    expect(s3.send).toHaveBeenCalledTimes(1);
    const cmd: any = s3.send.mock.calls[0][0];
    expect(cmd.input).toEqual({
      Bucket: "bucket",
      Delete: { Objects: [{ Key: "processing/t/h" }, { Key: "pending/t/u" }] },
    });
  });

  it("refuses cas/* keys — approved-byte reclamation belongs to the GC purge", async () => {
    const result = await deleteStagingObjects(s3, "bucket", [
      "cas/t/hash",
      "processing/t/h",
    ]);

    expect(result.requested).toBe(1);
    const cmd: any = s3.send.mock.calls[0][0];
    expect(JSON.stringify(cmd.input)).not.toContain("cas/");
  });

  it("makes no S3 call for an empty key list", async () => {
    const result = await deleteStagingObjects(s3, "bucket", []);
    expect(result).toEqual({ requested: 0, failedBatches: 0, truncated: false });
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("chunks into batches of 1000 keys", async () => {
    const keys = Array.from({ length: 1500 }, (_, i) => `processing/t/${i}`);
    const result = await deleteStagingObjects(s3, "bucket", keys);

    expect(s3.send).toHaveBeenCalledTimes(2);
    expect((s3.send.mock.calls[0][0] as any).input.Delete.Objects).toHaveLength(1000);
    expect((s3.send.mock.calls[1][0] as any).input.Delete.Objects).toHaveLength(500);
    expect(result.requested).toBe(1500);
  });

  it("tolerates a failed batch and reports it", async () => {
    s3.send.mockRejectedValueOnce(new Error("S3 down")).mockResolvedValue({});
    const keys = Array.from({ length: 1001 }, (_, i) => `processing/t/${i}`);

    const result = await deleteStagingObjects(s3, "bucket", keys);

    expect(result.failedBatches).toBe(1);
    expect(result.requested).toBe(1); // only the second (1-key) batch succeeded
  });

  it("stops at the batch circuit breaker and reports truncation", async () => {
    const keys = Array.from({ length: 101_000 }, (_, i) => `processing/t/${i}`);
    const result = await deleteStagingObjects(s3, "bucket", keys);

    expect(s3.send).toHaveBeenCalledTimes(100);
    expect(result.truncated).toBe(true);
  });
});
