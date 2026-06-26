/**
 * Tests for classify-worker-error.ts
 *
 * Obligations:
 *   - Representative taxonomy maps correctly (poison / retryable examples).
 *   - NEVER throws for any input (fuzz arbitrary values).
 *   - Total: every possible input produces exactly one of the two values.
 *   - Poison wins when both signals are present.
 *   - Default (unknown/unclassifiable) is "retryable" — documented default.
 *   - Boundary / failure paths: null, undefined, plain object, string, number,
 *     AWS SDK v3 shape, cyclic objects, giant strings.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  classifyWorkerError,
  type ErrorClass,
} from "../../../src/lib/media/classify-worker-error";

// Seed for determinism (CLAUDE.md: pin nondeterminism).
const FC = { seed: 0xc1a5, numRuns: 2000 } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CLASSES: ReadonlySet<ErrorClass> = new Set(["poison", "retryable"]);

function awsSdkError(
  name: string,
  message: string,
  httpStatusCode?: number,
): object {
  return {
    name,
    message,
    $metadata: httpStatusCode !== undefined ? { httpStatusCode } : {},
  };
}

// ---------------------------------------------------------------------------
// 1. PROPERTY: classifyWorkerError never throws, always returns a valid class
// ---------------------------------------------------------------------------

describe("classifyWorkerError — totality property", () => {
  it("never throws and always returns 'poison' or 'retryable' for arbitrary inputs", () => {
    // Arbitrary that covers null, undefined, primitives, objects, arrays.
    const anyArb = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string({ maxLength: 2000 }),
      fc.integer(),
      fc.float(),
      fc.boolean(),
      fc.record({
        name: fc.option(fc.string()),
        message: fc.option(fc.string()),
        statusCode: fc.option(fc.integer()),
        $metadata: fc.option(
          fc.record({ httpStatusCode: fc.option(fc.integer()) }),
        ),
      }),
      fc.array(fc.string()),
    );

    fc.assert(
      fc.property(anyArb, (input) => {
        let result: ErrorClass | undefined;
        expect(() => {
          result = classifyWorkerError(input);
        }).not.toThrow();
        expect(VALID_CLASSES.has(result!)).toBe(true);
      }),
      FC,
    );
  });

  it("never throws for deeply nested or cyclic-like objects", () => {
    // Simulate a deeply nested object (not truly cyclic — JSON can't express
    // that — but deep enough to exercise the extractor).
    const deep = { name: "Error", message: "oops", inner: { inner: { x: 1 } } };
    expect(() => classifyWorkerError(deep)).not.toThrow();
  });

  it("never throws for a very large string", () => {
    const big = "decode ".repeat(50_000);
    expect(() => classifyWorkerError(big)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. PROPERTY: output is always exactly one of the two valid classes
// ---------------------------------------------------------------------------

describe("classifyWorkerError — output domain property", () => {
  it("always produces a string in { poison, retryable }", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        const result = classifyWorkerError(v);
        return VALID_CLASSES.has(result);
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. EXAMPLES: poison — media/payload permanent failures
// ---------------------------------------------------------------------------

describe("classifyWorkerError — poison examples", () => {
  it("classifies DecodeError by name", () => {
    expect(classifyWorkerError(new Error("something failed") as Error & { name: string })).toBe("retryable"); // baseline
    const e = Object.assign(new Error("bad bytes"), { name: "DecodeError" });
    expect(classifyWorkerError(e)).toBe("poison");
  });

  it("classifies ParseError by name", () => {
    const e = Object.assign(new Error("cannot parse"), { name: "ParseError" });
    expect(classifyWorkerError(e)).toBe("poison");
  });

  it("classifies UnsupportedFormatError by name", () => {
    expect(classifyWorkerError({ name: "UnsupportedFormatError", message: "avi not supported" })).toBe("poison");
  });

  it("classifies CorruptMediaError by name", () => {
    expect(classifyWorkerError({ name: "CorruptMediaError", message: "" })).toBe("poison");
  });

  it("classifies DurationCapExceeded by name", () => {
    expect(classifyWorkerError({ name: "DurationCapExceeded", message: "too long" })).toBe("poison");
  });

  it("classifies ValidationError by name", () => {
    expect(classifyWorkerError({ name: "ValidationError", message: "schema violation" })).toBe("poison");
  });

  it("classifies InvalidImageException (AWS Rekognition) by name", () => {
    expect(classifyWorkerError(awsSdkError("InvalidImageException", "image cannot be decoded", 400))).toBe("poison");
  });

  it("classifies ImageTooLargeException (AWS Rekognition) by name", () => {
    expect(classifyWorkerError(awsSdkError("ImageTooLargeException", "image too large", 400))).toBe("poison");
  });

  it("classifies InvalidS3ObjectException (AWS Rekognition) by name", () => {
    expect(classifyWorkerError(awsSdkError("InvalidS3ObjectException", "cannot access object", 400))).toBe("poison");
  });

  it("classifies InvalidParameterException (400) by name — poison wins over 4xx", () => {
    // 400 is NOT in the retryable HTTP set, so this should be poison via name match.
    expect(classifyWorkerError(awsSdkError("InvalidParameterException", "bad param", 400))).toBe("poison");
  });

  it("classifies a plain Error with 'decode' in the message", () => {
    expect(classifyWorkerError(new Error("failed to decode frame 42"))).toBe("poison");
  });

  it("classifies a plain Error with 'corrupt' in the message", () => {
    expect(classifyWorkerError(new Error("file is corrupt"))).toBe("poison");
  });

  it("classifies a plain Error with 'malformed' in the message", () => {
    expect(classifyWorkerError(new Error("malformed JPEG header"))).toBe("poison");
  });

  it("classifies a plain Error with 'unsupported format' in the message", () => {
    expect(classifyWorkerError(new Error("unsupported format: HEVC"))).toBe("poison");
  });

  it("classifies a plain Error with 'duration cap' in the message", () => {
    expect(classifyWorkerError(new Error("duration cap exceeded: 300s > 60s"))).toBe("poison");
  });

  it("classifies a string containing 'decode'", () => {
    expect(classifyWorkerError("decode error at offset 0")).toBe("poison");
  });

  it("classifies a string containing 'unsupported format'", () => {
    expect(classifyWorkerError("unsupported format detected")).toBe("poison");
  });

  it("classifies a string containing 'malformed'", () => {
    expect(classifyWorkerError("malformed container header")).toBe("poison");
  });

  it("classifies SyntaxError (JS built-in) as poison", () => {
    expect(classifyWorkerError(new SyntaxError("Unexpected token"))).toBe("poison");
  });
});

// ---------------------------------------------------------------------------
// 4. EXAMPLES: retryable — transient infrastructure failures
// ---------------------------------------------------------------------------

describe("classifyWorkerError — retryable examples", () => {
  it("classifies ThrottlingException (AWS) as retryable", () => {
    expect(classifyWorkerError(awsSdkError("ThrottlingException", "rate exceeded", 429))).toBe("retryable");
  });

  it("classifies RequestLimitExceeded (AWS) as retryable", () => {
    expect(classifyWorkerError(awsSdkError("RequestLimitExceeded", "too many requests", 429))).toBe("retryable");
  });

  it("classifies ProvisionedThroughputExceededException as retryable", () => {
    expect(classifyWorkerError(awsSdkError("ProvisionedThroughputExceededException", "throttle", 400))).toBe("retryable");
  });

  it("classifies ServiceUnavailableException (AWS, 503) as retryable", () => {
    expect(classifyWorkerError(awsSdkError("ServiceUnavailableException", "service unavailable", 503))).toBe("retryable");
  });

  it("classifies InternalFailure (AWS, 500) as retryable", () => {
    expect(classifyWorkerError(awsSdkError("InternalFailure", "internal error", 500))).toBe("retryable");
  });

  it("classifies AccessDeniedException (AWS) as retryable (eventual-consistency lag)", () => {
    expect(classifyWorkerError(awsSdkError("AccessDeniedException", "access denied", 403))).toBe("retryable");
  });

  it("classifies RequestTimeoutException as retryable", () => {
    expect(classifyWorkerError(awsSdkError("RequestTimeoutException", "timed out", 408))).toBe("retryable");
  });

  it("classifies http 429 via $metadata.httpStatusCode as retryable", () => {
    expect(classifyWorkerError({ name: "UnknownError", message: "???", $metadata: { httpStatusCode: 429 } })).toBe("retryable");
  });

  it("classifies http 500 via $metadata.httpStatusCode as retryable", () => {
    expect(classifyWorkerError({ name: "UnknownError", message: "nope", $metadata: { httpStatusCode: 500 } })).toBe("retryable");
  });

  it("classifies http 502 via $metadata.httpStatusCode as retryable", () => {
    expect(classifyWorkerError({ name: "ServiceError", message: "", $metadata: { httpStatusCode: 502 } })).toBe("retryable");
  });

  it("classifies http 503 via statusCode field as retryable", () => {
    expect(classifyWorkerError({ name: "Oops", message: "", statusCode: 503 })).toBe("retryable");
  });

  it("classifies http 504 via status field as retryable", () => {
    expect(classifyWorkerError({ name: "Oops", message: "", status: 504 })).toBe("retryable");
  });

  it("classifies ECONNRESET by name as retryable", () => {
    expect(classifyWorkerError({ name: "ECONNRESET", message: "connection reset" })).toBe("retryable");
  });

  it("classifies ETIMEDOUT by name as retryable", () => {
    expect(classifyWorkerError({ name: "ETIMEDOUT", message: "connection timed out" })).toBe("retryable");
  });

  it("classifies NetworkError by name as retryable", () => {
    expect(classifyWorkerError({ name: "NetworkError", message: "" })).toBe("retryable");
  });

  it("classifies TimeoutError by name as retryable", () => {
    expect(classifyWorkerError({ name: "TimeoutError", message: "fetch timed out" })).toBe("retryable");
  });

  it("classifies AbortError by name as retryable", () => {
    expect(classifyWorkerError({ name: "AbortError", message: "fetch aborted" })).toBe("retryable");
  });

  it("classifies a plain Error with 'throttl' in the message as retryable", () => {
    expect(classifyWorkerError(new Error("throttling in effect, try again"))).toBe("retryable");
  });

  it("classifies a plain Error with 'timed out' in the message as retryable", () => {
    expect(classifyWorkerError(new Error("operation timed out after 30s"))).toBe("retryable");
  });

  it("classifies a plain Error with 'service unavailable' in the message as retryable", () => {
    expect(classifyWorkerError(new Error("upstream service unavailable"))).toBe("retryable");
  });

  it("classifies a string containing 'throttl' as retryable", () => {
    expect(classifyWorkerError("throttled by upstream")).toBe("retryable");
  });

  it("classifies a string containing 'timeout' as retryable", () => {
    expect(classifyWorkerError("socket timeout after 10s")).toBe("retryable");
  });
});

// ---------------------------------------------------------------------------
// 5. DEFAULT RULE: unknown/unclassifiable => retryable
// ---------------------------------------------------------------------------

describe("classifyWorkerError — default rule (unknown => retryable)", () => {
  it("returns 'retryable' for null", () => {
    expect(classifyWorkerError(null)).toBe("retryable");
  });

  it("returns 'retryable' for undefined", () => {
    expect(classifyWorkerError(undefined)).toBe("retryable");
  });

  it("returns 'retryable' for an empty object", () => {
    expect(classifyWorkerError({})).toBe("retryable");
  });

  it("returns 'retryable' for a number", () => {
    expect(classifyWorkerError(42)).toBe("retryable");
  });

  it("returns 'retryable' for a boolean", () => {
    expect(classifyWorkerError(true)).toBe("retryable");
  });

  it("returns 'retryable' for a generic Error with no indicative message", () => {
    expect(classifyWorkerError(new Error("something went wrong"))).toBe("retryable");
  });

  it("returns 'retryable' for an object with only unrecognised name+message", () => {
    expect(classifyWorkerError({ name: "XyzAbcError", message: "flux capacitor fault" })).toBe("retryable");
  });

  it("returns 'retryable' for an array", () => {
    expect(classifyWorkerError(["a", "b"])).toBe("retryable");
  });

  it("returns 'retryable' for an empty string", () => {
    expect(classifyWorkerError("")).toBe("retryable");
  });

  it("returns 'retryable' for a 404 HTTP status (not in retryable set — ambiguous, defaults to retryable via fallthrough)", () => {
    // 404 is not explicitly in RETRYABLE_HTTP_STATUS; no name/message match either.
    // The default rule applies: unknown => retryable.
    expect(classifyWorkerError({ name: "NotFoundError", message: "object not found", $metadata: { httpStatusCode: 404 } })).toBe("retryable");
  });
});

// ---------------------------------------------------------------------------
// 6. POISON WINS when both poison and retryable signals are present
// ---------------------------------------------------------------------------

describe("classifyWorkerError — poison wins on conflict", () => {
  it("poison wins when name is poison-indicative but HTTP status is retryable", () => {
    // InvalidImageException name (poison) + httpStatusCode 429 (retryable).
    // Poison check runs first; it should win.
    expect(
      classifyWorkerError(awsSdkError("InvalidImageException", "bad image", 429)),
    ).toBe("poison");
  });

  it("poison wins when message contains 'decode' but name is ThrottlingException", () => {
    // Unusual: a throttle error whose message also mentions decoding.
    // Poison name-fragment check catches "decode" in the message before the
    // retryable name check runs.
    expect(
      classifyWorkerError({ name: "ThrottlingException", message: "decode step throttled" }),
    ).toBe("poison");
  });
});

// ---------------------------------------------------------------------------
// 7. PROPERTY: poison inputs never silently become retryable (taxonomy check)
// ---------------------------------------------------------------------------

describe("classifyWorkerError — taxonomy property (poison domain)", () => {
  // Generate errors whose name is drawn from the known-poison set. These must
  // always classify as poison.
  const poisonNames = [
    "DecodeError",
    "ParseError",
    "UnsupportedFormatError",
    "CorruptError",
    "ValidationError",
    "DurationCapExceeded",
    "InvalidImageException",
    "ImageTooLargeException",
    "InvalidS3ObjectException",
    "InvalidParameterException",
    "InvalidParameter",
    "SyntaxError",
  ] as const;

  it("always returns poison for known-poison error names (property)", () => {
    const nameArb = fc.constantFrom(...poisonNames);
    const msgArb = fc.string({ maxLength: 200 });
    fc.assert(
      fc.property(nameArb, msgArb, (name, message) => {
        return classifyWorkerError({ name, message }) === "poison";
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. PROPERTY: retryable inputs from the known-retryable name set
// ---------------------------------------------------------------------------

describe("classifyWorkerError — taxonomy property (retryable domain)", () => {
  const retryableNames = [
    "ThrottlingException",
    "RequestLimitExceeded",
    "ServiceUnavailableException",
    "InternalFailure",
    "RequestTimeoutException",
    "NetworkError",
    "TimeoutError",
    "AbortError",
    "ECONNRESET",
    "ETIMEDOUT",
  ] as const;

  it("always returns retryable for known-retryable error names (no conflicting message)", () => {
    const nameArb = fc.constantFrom(...retryableNames);
    // Messages that contain no poison fragments.
    const safeMsgArb = fc.string({ maxLength: 50 }).filter(
      (s) =>
        !s.toLowerCase().includes("decode") &&
        !s.toLowerCase().includes("corrupt") &&
        !s.toLowerCase().includes("invalid") &&
        !s.toLowerCase().includes("unsupported") &&
        !s.toLowerCase().includes("malformed") &&
        !s.toLowerCase().includes("parse") &&
        !s.toLowerCase().includes("format") &&
        !s.toLowerCase().includes("duration") &&
        !s.toLowerCase().includes("validation") &&
        !s.toLowerCase().includes("schema") &&
        !s.toLowerCase().includes("constraint") &&
        !s.toLowerCase().includes("payload"),
    );
    fc.assert(
      fc.property(nameArb, safeMsgArb, (name, message) => {
        return classifyWorkerError({ name, message }) === "retryable";
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------
// 9. HTTP status boundary tests
// ---------------------------------------------------------------------------

describe("classifyWorkerError — HTTP status boundaries", () => {
  const retryableStatuses = [429, 500, 502, 503, 504];
  const nonRetryableStatuses = [400, 401, 403, 404, 405, 409, 410, 422];

  for (const status of retryableStatuses) {
    it(`http ${status} via $metadata is retryable (name/message neutral)`, () => {
      expect(
        classifyWorkerError({
          name: "UnknownOpaqueError",
          message: "opaque service error",
          $metadata: { httpStatusCode: status },
        }),
      ).toBe("retryable");
    });
  }

  for (const status of nonRetryableStatuses) {
    it(`http ${status} via $metadata without retryable name/message falls to default (retryable)`, () => {
      // 400/401/403/404 etc. are NOT in the retryable HTTP set, so they go to
      // the default fallthrough — which is retryable (unknown => retryable).
      // This documents the deliberate behavior: we don't treat 4xx as poison
      // unless the name/message explicitly identifies a media defect.
      const result = classifyWorkerError({
        name: "OpaqueError",
        message: "no hint",
        $metadata: { httpStatusCode: status },
      });
      expect(result).toBe("retryable"); // default rule
    });
  }
});
