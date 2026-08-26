import { describe, expect, it } from "vitest";
import { describeError } from "../../src/lib/media/describe-error.js";

describe("describeError", () => {
  // The case this function was written for. An AWS SDK connect/abort error has
  // an EMPTY message, so the previous `error?.message` logging produced `""` —
  // a failure report carrying no information. Anything that lets this case
  // return an empty or contentless string is the regression.
  it("describes an SDK connection error whose message is empty", () => {
    const sdkTimeout = Object.assign(new Error(""), {
      name: "TimeoutError",
      $metadata: { attempts: 3 },
    });

    const described = describeError(sdkTimeout);

    expect(described).toContain("TimeoutError");
    expect(described).not.toBe("");
  });

  it("includes the HTTP status and code when the endpoint answered", () => {
    const accessDenied = Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
      code: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });

    const described = describeError(accessDenied);

    expect(described).toContain("AccessDenied");
    expect(described).toContain("Access Denied");
    expect(described).toContain("http=403");
  });

  // The distinction that matters operationally: a timeout means the request
  // never reached the endpoint (suspect the network path); a 403 means it did
  // (suspect credentials or policy). Both must be legible from the log alone.
  it("distinguishes never-reached from endpoint-refused", () => {
    const timeout = describeError(
      Object.assign(new Error(""), { name: "TimeoutError" }),
    );
    const refused = describeError(
      Object.assign(new Error("Access Denied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      }),
    );

    expect(timeout).not.toBe(refused);
    expect(timeout).not.toContain("http=");
    expect(refused).toContain("http=");
  });

  it("handles an ordinary Error", () => {
    expect(describeError(new Error("boom"))).toContain("boom");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("never returns an empty string for %s", (_label, value) => {
    expect(describeError(value).length).toBeGreaterThan(0);
  });

  it("never returns an empty string for a shapeless object throw", () => {
    expect(describeError({}).length).toBeGreaterThan(0);
    expect(describeError({ name: "", message: "" }).length).toBeGreaterThan(0);
  });

  it("stringifies non-object throws", () => {
    expect(describeError("just a string")).toBe("just a string");
    expect(describeError(42)).toBe("42");
  });

  // Some SDK errors hang the whole request/response on the error object, and
  // request headers carry the Authorization signature. Only the four named
  // fields are read, so such a field cannot reach a log line through here.
  it("does not surface unrelated fields that may carry credentials", () => {
    const leaky = Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
      $response: { headers: { authorization: "AWS4-HMAC-SHA256 Credential=SECRETVALUE" } },
      request: { headers: { authorization: "AWS4-HMAC-SHA256 Credential=SECRETVALUE" } },
    });

    expect(describeError(leaky)).not.toContain("SECRETVALUE");
    expect(describeError(leaky)).not.toContain("authorization");
  });
});
