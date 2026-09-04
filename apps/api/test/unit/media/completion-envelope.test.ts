import { describe, expect, it } from "vitest";

import {
  completionEnvelopeBody,
  parseCompletionEnvelope,
  sanitizeProviderString,
} from "../../../src/lib/media/completion-envelope.js";

/**
 * Fixture identifiers are placeholders throughout: no real account ids, ARNs,
 * bucket names, or topic names. The SHAPES mirror what notification services
 * actually publish; the VALUES are invented.
 */
const PLACEHOLDER_TOPIC_ARN =
  "arn:aws:sns:eu-central-1:000000000000:example-topic";

describe("parseCompletionEnvelope — canonical shape", () => {
  it("parses the canonical envelope for both tracks", () => {
    expect(parseCompletionEnvelope('{"track":"VISUAL","jobId":"job-1"}')).toEqual(
      { track: "VISUAL", jobId: "job-1" },
    );
    expect(parseCompletionEnvelope('{"track":"AUDIO","jobId":"job-2"}')).toEqual(
      { track: "AUDIO", jobId: "job-2" },
    );
  });

  it("round-trips whatever completionEnvelopeBody produces", () => {
    for (const track of ["VISUAL", "AUDIO"] as const) {
      const body = completionEnvelopeBody({ track, jobId: "round-trip-id" });
      expect(parseCompletionEnvelope(body)).toEqual({
        track,
        jobId: "round-trip-id",
      });
    }
  });

  it("returns null for an unrecognised track rather than defaulting one", () => {
    expect(parseCompletionEnvelope('{"track":"OTHER","jobId":"job-1"}')).toBeNull();
    expect(parseCompletionEnvelope('{"track":"visual","jobId":"job-1"}')).toBeNull();
    expect(parseCompletionEnvelope('{"track":123,"jobId":"job-1"}')).toBeNull();
    expect(parseCompletionEnvelope('{"track":null,"jobId":"job-1"}')).toBeNull();
  });

  it("returns null for a canonical envelope with no usable jobId", () => {
    expect(parseCompletionEnvelope('{"track":"VISUAL"}')).toBeNull();
    expect(parseCompletionEnvelope('{"track":"VISUAL","jobId":""}')).toBeNull();
    expect(parseCompletionEnvelope('{"track":"VISUAL","jobId":42}')).toBeNull();
  });

  it("resolves canonical when the body ALSO carries legacy fields", () => {
    // A message carrying both must not be steerable down the compat path by
    // adding a second id under a different key.
    const ambiguous = JSON.stringify({
      track: "AUDIO",
      jobId: "canonical-id",
      JobId: "legacy-visual-id",
      TranscriptionJobName: "legacy-audio-id",
    });
    expect(parseCompletionEnvelope(ambiguous)).toEqual({
      track: "AUDIO",
      jobId: "canonical-id",
    });
  });

  it("does not fall through to compat when the canonical track is invalid", () => {
    const body = JSON.stringify({ track: "OTHER", JobId: "legacy-visual-id" });
    expect(parseCompletionEnvelope(body)).toBeNull();
  });
});

describe("parseCompletionEnvelope — historical wire shapes", () => {
  it("parses a notification whose Message string carries the visual job id", () => {
    const body = JSON.stringify({
      Type: "Notification",
      TopicArn: PLACEHOLDER_TOPIC_ARN,
      Message: JSON.stringify({
        JobId: "visual-job-abc",
        Status: "SUCCEEDED",
        API: "StartContentModeration",
      }),
    });
    expect(parseCompletionEnvelope(body)).toEqual({
      track: "VISUAL",
      jobId: "visual-job-abc",
    });
  });

  it("parses a directly-carried visual job id", () => {
    expect(parseCompletionEnvelope('{"JobId":"visual-job-abc"}')).toEqual({
      track: "VISUAL",
      jobId: "visual-job-abc",
    });
  });

  it("parses an event envelope carrying the transcription job name", () => {
    const body = JSON.stringify({
      version: "0",
      account: "000000000000",
      region: "eu-central-1",
      "detail-type": "Transcribe Job State Change",
      detail: {
        TranscriptionJobName: "audio-job-xyz",
        TranscriptionJobStatus: "COMPLETED",
      },
    });
    expect(parseCompletionEnvelope(body)).toEqual({
      track: "AUDIO",
      jobId: "audio-job-xyz",
    });
  });

  it("parses a directly-carried transcription job name", () => {
    expect(
      parseCompletionEnvelope('{"TranscriptionJobName":"audio-job-xyz"}'),
    ).toEqual({ track: "AUDIO", jobId: "audio-job-xyz" });
  });

  it("ignores any verdict the body claims — only the pointer survives", () => {
    const body = JSON.stringify({
      track: "VISUAL",
      jobId: "job-1",
      decision: "approved",
      labels: [],
    });
    expect(parseCompletionEnvelope(body)).toEqual({
      track: "VISUAL",
      jobId: "job-1",
    });
  });
});

describe("parseCompletionEnvelope — hostile input", () => {
  it("returns null and never throws for malformed input", () => {
    const inputs = [
      "",
      "not json",
      "null",
      "[]",
      '"a string"',
      "123",
      "{}",
      '{"Message":"not json"}',
      '{"Message":123}',
      '{"detail":null}',
      '{"detail":"string"}',
    ];
    for (const input of inputs) {
      expect(() => parseCompletionEnvelope(input)).not.toThrow();
      expect(parseCompletionEnvelope(input)).toBeNull();
    }
  });

  it("rejects an oversized outer body before parsing it", () => {
    // Valid JSON, valid canonical shape, just far too big to be a completion.
    const padding = "x".repeat(300 * 1024);
    const body = JSON.stringify({
      track: "VISUAL",
      jobId: "job-1",
      padding,
    });
    expect(parseCompletionEnvelope(body)).toBeNull();
  });

  it("rejects an oversized wrapped Message even when the outer body is small", () => {
    // The outer body is only just over the cap thanks to the inner string, so
    // a cap applied ONLY to the outer body would let this through.
    const inner = JSON.stringify({
      JobId: "visual-job-abc",
      padding: "y".repeat(300 * 1024),
    });
    const body = JSON.stringify({ Message: inner });
    expect(parseCompletionEnvelope(body)).toBeNull();
  });

  it("survives deeply nested input without throwing", () => {
    let nested: unknown = { JobId: "visual-job-abc" };
    for (let i = 0; i < 5000; i += 1) nested = { detail: nested };
    let body: string;
    try {
      body = JSON.stringify(nested);
    } catch {
      // The fixture itself blew the stack — nothing to assert about the parser.
      return;
    }
    expect(() => parseCompletionEnvelope(body)).not.toThrow();
  });

  it("strips control characters from provider-supplied ids", () => {
    // A forged id that would otherwise inject a second line into a log stream.
    const hostile =
      "job" + String.fromCharCode(10, 13, 27) + "id";
    const parsed = parseCompletionEnvelope(
      JSON.stringify({ track: "VISUAL", jobId: hostile }),
    );
    expect(parsed).toEqual({ track: "VISUAL", jobId: "jobid" });
    expect(parsed?.jobId).not.toContain(String.fromCharCode(10));
  });

  it("truncates an over-long provider id", () => {
    const parsed = parseCompletionEnvelope(
      JSON.stringify({ track: "AUDIO", jobId: "z".repeat(10_000) }),
    );
    expect(parsed?.jobId.length).toBe(256);
  });

  it("returns null when an id is nothing but control characters", () => {
    expect(
      parseCompletionEnvelope(
        JSON.stringify({ track: "AUDIO", jobId: String.fromCharCode(10, 10) }),
      ),
    ).toBeNull();
  });
});

describe("sanitizeProviderString", () => {
  it("leaves ordinary ids untouched", () => {
    expect(sanitizeProviderString("job-1_ABC.def")).toBe("job-1_ABC.def");
  });

  it("removes C0 and C1 control characters", () => {
    const dirty =
      "a" + String.fromCharCode(0) + "b" + String.fromCharCode(0x1f) +
      "c" + String.fromCharCode(0x7f) + "d" + String.fromCharCode(0x9f);
    expect(sanitizeProviderString(dirty)).toBe("abcd");
  });
});
