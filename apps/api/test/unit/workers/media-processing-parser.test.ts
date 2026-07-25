/**
 * WS-2 T6 §4 parser gate: `extractObjectKeys` accepts BOTH the S3-event
 * envelope AND the native control-inversion `{ objectKey }` message, and both
 * shapes resolve to the same key set (Option B — unified path).
 */

import { describe, expect, it } from "vitest";
import { extractObjectKeys } from "../../../src/lib/workers/media-processing.js";

const TENANT = "cabcdefghijklmnopqrstuvwx";
const UPLOAD = "cupload00000000000000001x";
const KEY = `pending/${TENANT}/${UPLOAD}`;

function s3Envelope(...keys: string[]): string {
  return JSON.stringify({
    Records: keys.map((k) => ({ s3: { object: { key: encodeURIComponent(k) } } })),
  });
}

function nativeMessage(key: string): string {
  return JSON.stringify({ objectKey: key, tenantId: TENANT, uploadId: UPLOAD });
}

describe("extractObjectKeys (§4 dual-shape parser)", () => {
  it("parses the S3-event envelope (URL-decoded), as before", () => {
    expect(extractObjectKeys(s3Envelope(KEY))).toEqual([KEY]);
  });

  it("parses the native { objectKey } message", () => {
    expect(extractObjectKeys(nativeMessage(KEY))).toEqual([KEY]);
  });

  it("BOTH shapes yield the same key set for the same key (unified-path gate)", () => {
    // Property over a representative key set incl. S3's '+'-for-space quirk.
    const keys = [
      KEY,
      `pending/${TENANT}/cupload00000000000000002x`,
      "pending/t/file with spaces",
      "pending/t/unicode-äöü",
    ];
    for (const k of keys) {
      const viaEnvelope = extractObjectKeys(
        JSON.stringify({
          // S3 notifications encode spaces as '+' and URL-encode the rest.
          Records: [{ s3: { object: { key: encodeURIComponent(k).replace(/%20/g, "+") } } }],
        }),
      );
      const viaNative = extractObjectKeys(nativeMessage(k));
      expect(viaNative).toEqual(viaEnvelope);
      expect(viaNative).toEqual([k]);
    }
  });

  it("multi-record S3 envelopes still yield every key", () => {
    const k2 = `pending/${TENANT}/cupload00000000000000002x`;
    expect(extractObjectKeys(s3Envelope(KEY, k2))).toEqual([KEY, k2]);
  });

  it("an empty/non-string objectKey falls through to the envelope branch (empty set)", () => {
    expect(extractObjectKeys(JSON.stringify({ objectKey: "" }))).toEqual([]);
    expect(extractObjectKeys(JSON.stringify({ objectKey: 42 }))).toEqual([]);
    expect(extractObjectKeys(JSON.stringify({}))).toEqual([]);
  });

  it("still throws on an unparseable body (processRecord acks it as poison)", () => {
    expect(() => extractObjectKeys("not json")).toThrow();
  });

  it("the native shape is NOT URL-decoded (the producer sends the literal key)", () => {
    // A literal '+' in a native key must survive (only S3 envelopes use
    // '+'-for-space encoding).
    const plusKey = "pending/t/a+b";
    expect(extractObjectKeys(nativeMessage(plusKey))).toEqual([plusKey]);
  });
});
