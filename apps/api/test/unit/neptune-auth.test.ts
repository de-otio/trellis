import { beforeAll, describe, expect, it } from "vitest";
import {
  createNeptuneAuthTokenManager,
  parseBoltEndpoint,
  signNeptuneAuthToken,
} from "../../src/lib/graph/neptune-auth";

// Static credentials so the SigV4 signer resolves deterministically (no IMDS).
beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
  process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  delete process.env.AWS_SESSION_TOKEN;
});

describe("parseBoltEndpoint", () => {
  it("parses host and port from a bolt URI", () => {
    expect(parseBoltEndpoint("bolt://c.cluster-x.eu-central-1.neptune.amazonaws.com:8182")).toEqual({
      host: "c.cluster-x.eu-central-1.neptune.amazonaws.com",
      port: 8182,
    });
  });

  it("defaults the port to 8182 when absent", () => {
    expect(parseBoltEndpoint("bolt://host").port).toBe(8182);
  });

  it("handles the bolt+s scheme", () => {
    expect(parseBoltEndpoint("bolt+s://host:7687")).toEqual({ host: "host", port: 7687 });
  });
});

describe("signNeptuneAuthToken", () => {
  it("produces a basic-scheme token whose credentials carry the SigV4 headers", async () => {
    const token = await signNeptuneAuthToken({
      host: "c.cluster-x.eu-central-1.neptune.amazonaws.com",
      port: 8182,
      region: "eu-central-1",
    });

    expect(token.scheme).toBe("basic");
    expect(token.principal).toBe("username");
    expect(token.realm).toBe("realm");

    const cred = JSON.parse(token.credentials as string);
    // Real SigV4 output, signed for the neptune-db service in the given region.
    expect(cred.Authorization).toContain("AWS4-HMAC-SHA256");
    expect(cred.Authorization).toContain("/eu-central-1/neptune-db/aws4_request");
    expect(cred.HttpMethod).toBe("GET");
    expect(cred.Host).toBe("c.cluster-x.eu-central-1.neptune.amazonaws.com:8182");
    expect(cred["X-Amz-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("re-signs on each call (fresh signature for the rotating credential)", async () => {
    const opts = { host: "h.neptune.amazonaws.com", port: 8182, region: "eu-central-1" };
    const a = JSON.parse((await signNeptuneAuthToken(opts)).credentials as string);
    await new Promise((r) => setTimeout(r, 1100)); // X-Amz-Date has 1s resolution
    const b = JSON.parse((await signNeptuneAuthToken(opts)).credentials as string);
    expect(a["X-Amz-Date"]).not.toBe(b["X-Amz-Date"]);
  });
});

describe("createNeptuneAuthTokenManager", () => {
  it("returns an AuthTokenManager (driver re-signs via its tokenProvider)", () => {
    const mgr = createNeptuneAuthTokenManager({ host: "h.neptune.amazonaws.com", port: 8182, region: "eu-central-1" });
    expect(typeof mgr.getToken).toBe("function");
  });
});
