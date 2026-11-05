/**
 * Tests for the inbox HTTP-signature entry point.
 *
 * This module used to hold a second, weaker verifier that resolved a REMOTE
 * keyId against the LOCAL user table. These tests exist mainly to pin that the
 * path is gone: the shim delegates to the single spec-compliant verifier, and
 * a local keyId on an inbound request is refused outright rather than being
 * checked against our own key material.
 */

import * as crypto from "crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import {
  signRequest,
  SigningUnavailableError,
  verifyHttpSignature,
  verifyInboxRequest,
} from "../../../../src/lib/activitypub/listeners/http-signatures.js";
import { verificationFailureStatus } from "../../../../src/lib/activitypub/http-signatures.js";

let mockGetKeyPair: any = null;

// M13: the pre-verification limiter. Default is "allowed"; individual tests
// make it deny or throw. Everything else in the module stays real.
const mockConsume = vi.fn();
vi.mock("../../../../src/lib/rate-limit", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  consumeSharedBucket: (...args: unknown[]) => mockConsume(...args),
}));

vi.mock("../../../../src/lib/activitypub/dispatchers/user-actor", () => {
  const MockUserActorDispatcher = function (this: any, _env: any) {
    this.getKeyPair = mockGetKeyPair || vi.fn().mockResolvedValue(null);
    return this;
  } as any;

  return { UserActorDispatcher: MockUserActorDispatcher };
});

// The remote-fetch path is exercised in its own suite; here we only need to
// know whether the verifier tried to dereference an actor at all.
const fetchActor = vi.fn();
vi.mock("../../../../src/lib/activitypub/remote-fetch-service", () => ({
  RemoteFetchService: {
    fetchActor: (...args: unknown[]) => fetchActor(...args),
  },
}));

vi.mock("../../../../src/lib/activitypub/standalone-mode", () => ({
  isStandaloneModeEnabled: vi.fn().mockResolvedValue(false),
  // Mirror the real isRemoteUri: compare parsed origins, not a string
  // prefix — a substring/startsWith check here would let a host like
  // "https://example.com.attacker.com" masquerade as local, and CodeQL
  // correctly flags that shape even inside a test mock.
  isRemoteUri: vi.fn((uri: string, env: any) => {
    const baseUrl = env?.ACTIVITYPUB_BASE_URL ?? "https://example.com";
    try {
      return new URL(uri).origin !== new URL(baseUrl).origin;
    } catch {
      return true;
    }
  }),
}));

const mockEnv: Partial<Env> = {
  LOG_LEVEL: "INFO",
  ACTIVITYPUB_BASE_URL: "https://example.com",
  DATABASE_URL: "postgresql://test",
};

let keyPair: { publicKey: string; privateKey: string };

beforeAll(() => {
  keyPair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
});

/** Build a fully, honestly signed inbox request for `keyId`. */
function signedRequest(
  keyId: string,
  body = '{"type":"Create"}',
  extraHeaders: Record<string, string> = {},
): Request {
  const url = "https://example.com/users/bob/inbox";
  const date = new Date().toUTCString();
  const digest = `SHA-256=${crypto.createHash("sha256").update(body).digest("base64")}`;
  const signatureString = [
    "(request-target): post /users/bob/inbox",
    "host: example.com",
    `date: ${date}`,
    `digest: ${digest}`,
  ].join("\n");
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signatureString);
  sign.end();
  const signature = sign.sign(keyPair.privateKey, "base64");

  return new Request(url, {
    method: "POST",
    headers: {
      host: "example.com",
      date,
      digest,
      ...extraHeaders,
      Signature: [
        `keyId="${keyId}"`,
        'algorithm="rsa-sha256"',
        'headers="(request-target) host date digest"',
        `signature="${signature}"`,
      ].join(","),
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetKeyPair = null;
  fetchActor.mockReset();
  mockConsume.mockReset();
  mockConsume.mockResolvedValue({
    allowed: true,
    remaining: 100,
    resetAt: Date.now() + 60_000,
  });
});

describe("verifyHttpSignature (boolean shim)", () => {
  it("returns false for a request without a Signature header", async () => {
    const request = new Request("https://example.com/users/bob/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(await verifyHttpSignature(request, mockEnv as Env)).toBe(false);
  });

  it("returns false for a malformed Signature header", async () => {
    const request = new Request("https://example.com/users/bob/inbox", {
      method: "POST",
      headers: { Signature: "garbage" },
      body: "{}",
    });

    expect(await verifyHttpSignature(request, mockEnv as Env)).toBe(false);
  });

  it("returns true for a genuinely signed remote request", async () => {
    const actorUri = "https://remote.example/users/alice";
    fetchActor.mockResolvedValue({
      id: actorUri,
      type: "Person",
      inbox: `${actorUri}/inbox`,
      publicKey: {
        id: `${actorUri}#main-key`,
        owner: actorUri,
        publicKeyPem: keyPair.publicKey,
      },
    });

    const result = await verifyHttpSignature(
      signedRequest(`${actorUri}#main-key`, '{"type":"Create","n":"happy"}'),
      mockEnv as Env,
    );
    expect(result).toBe(true);
  });
});

describe("the local-DB-key path is gone (F2)", () => {
  it("REFUSES a LOCAL keyId on an inbound request", async () => {
    // Previously: `/users/{username}` was parsed out and looked up in our own
    // user table, so an inbound request claiming a local keyId was verified
    // against OUR key. Now it is refused before any lookup happens.
    const localKeyId = "https://example.com/users/bob#main-key";

    const result = await verifyInboxRequest(
      signedRequest(localKeyId, '{"type":"Create","n":"local-keyid"}'),
      mockEnv as Env,
    );

    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("key-unavailable");
    // Crucially: no remote dereference and no local user lookup was attempted.
    expect(fetchActor).not.toHaveBeenCalled();
  });

  it("REJECTS when the fetched actor's publicKey.id does not match the keyId", async () => {
    const actorUri = "https://remote.example/users/alice";
    fetchActor.mockResolvedValue({
      id: actorUri,
      type: "Person",
      inbox: `${actorUri}/inbox`,
      publicKey: {
        // Points at a different key than the one that signed.
        id: `${actorUri}#other-key`,
        owner: actorUri,
        publicKeyPem: keyPair.publicKey,
      },
    });

    const result = await verifyInboxRequest(
      signedRequest(`${actorUri}#main-key`, '{"type":"Create","n":"keyid-mismatch"}'),
      mockEnv as Env,
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("key-unavailable");
  });

  it("REJECTS when the remote actor cannot be fetched", async () => {
    fetchActor.mockResolvedValue(null);
    const result = await verifyInboxRequest(
      signedRequest(
        "https://remote.example/users/alice#main-key",
        '{"type":"Create","n":"unfetchable"}',
      ),
      mockEnv as Env,
    );
    expect(result.valid).toBe(false);
  });
});

describe("verifyInboxRequest", () => {
  it("returns the authenticated owner and body", async () => {
    const actorUri = "https://remote.example/users/alice";
    fetchActor.mockResolvedValue({
      id: actorUri,
      type: "Person",
      inbox: `${actorUri}/inbox`,
      publicKey: {
        id: `${actorUri}#main-key`,
        owner: actorUri,
        publicKeyPem: keyPair.publicKey,
      },
    });

    const body = '{"type":"Follow","actor":"https://remote.example/users/alice"}';
    const result = await verifyInboxRequest(
      signedRequest(`${actorUri}#main-key`, body),
      mockEnv as Env,
      // Disable replay suppression: this suite reuses identical bodies.
      { nonceStore: undefined },
    );

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unreachable");
    expect(result.owner).toBe(actorUri);
    expect(result.body.toString("utf8")).toBe(body);
  });
});

describe("verifyInboxRequest — pre-verification budget (M13)", () => {
  const actorUri = "https://remote.example/users/alice";
  const keyId = `${actorUri}#main-key`;
  // Public address: trustedClientIp rejects reserved/documentation ranges.
  const CLIENT = { "x-trellis-remote-addr": "8.8.8.8" };
  const honest = () =>
    fetchActor.mockResolvedValue({
      id: actorUri,
      type: "Person",
      inbox: `${actorUri}/inbox`,
      publicKey: { id: keyId, owner: actorUri, publicKeyPem: keyPair.publicKey },
    });
  const verify = (headers: Record<string, string> = CLIENT) =>
    verifyInboxRequest(signedRequest(keyId, '{"type":"Create"}', headers), mockEnv as Env, {
      nonceStore: undefined,
    });

  afterEach(() => {
    delete process.env.ACTIVITYPUB_INBOX_PREVERIFY_RATE_LIMIT;
  });

  it("over budget: refused as rate-limited WITHOUT any outbound key fetch", async () => {
    honest();
    mockConsume.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 0, retryAfter: 30 });

    const result = await verify();

    expect(result).toMatchObject({ valid: false, reason: "rate-limited" });
    expect(fetchActor).not.toHaveBeenCalled();
  });

  it("limiter unavailable: fails CLOSED (check-failed), still no outbound fetch", async () => {
    honest();
    mockConsume.mockRejectedValue(new Error("limiter down"));

    const result = await verify();

    expect(result).toMatchObject({ valid: false, reason: "check-failed" });
    expect(fetchActor).not.toHaveBeenCalled();
  });

  it("within budget: proceeds to verification", async () => {
    honest();
    const result = await verify();
    expect(result.valid).toBe(true);
    expect(fetchActor).toHaveBeenCalled();
  });

  it("is keyed on the client ADDRESS (not the attacker-chosen keyId) at the default ceiling", async () => {
    honest();
    await verify();
    expect(mockConsume).toHaveBeenCalledTimes(1);
    const [, key, limit, windowSeconds] = mockConsume.mock.calls[0];
    expect(key).toBe("ap:preverify:8.8.8.8");
    expect(limit).toBe(120);
    expect(windowSeconds).toBe(60);
    expect(key).not.toContain("remote.example");
  });

  it("a client-supplied X-Forwarded-For cannot choose the bucket (TRUSTED_PROXY=none)", async () => {
    honest();
    await verify({ ...CLIENT, "x-forwarded-for": "1.2.3.4" });
    expect(mockConsume.mock.calls[0][1]).toBe("ap:preverify:8.8.8.8");
  });

  it("unknown client address: one shared bucket with 10x headroom, not a federation-wide throttle", async () => {
    honest();
    await verify({});
    const [, key, limit] = mockConsume.mock.calls[0];
    expect(key).toBe("ap:preverify:unknown");
    expect(limit).toBe(1200);
  });

  it("ceiling is runtime config (ACTIVITYPUB_INBOX_PREVERIFY_RATE_LIMIT)", async () => {
    honest();
    process.env.ACTIVITYPUB_INBOX_PREVERIFY_RATE_LIMIT = "7";
    await verify();
    expect(mockConsume.mock.calls[0][2]).toBe(7);
  });

  it.each(["0", "-3", "abc", ""])("ignores an invalid ceiling %j and uses the default", async (bad) => {
    honest();
    process.env.ACTIVITYPUB_INBOX_PREVERIFY_RATE_LIMIT = bad;
    await verify();
    expect(mockConsume.mock.calls[0][2]).toBe(120);
  });

  it("maps outcomes to HTTP: 429 back-off, 503 limiter down, 401 otherwise", () => {
    expect(verificationFailureStatus("rate-limited")).toBe(429);
    expect(verificationFailureStatus("check-failed")).toBe(503);
    expect(verificationFailureStatus("bad-signature")).toBe(401);
    expect(verificationFailureStatus("missing-signature")).toBe(401);
  });
});

describe("signRequest", () => {
  it("THROWS when no key pair is available — never returns an unsigned request", async () => {
    mockGetKeyPair = vi.fn().mockResolvedValue(null);
    const request = new Request("https://remote.example/inbox", {
      method: "POST",
      body: "{}",
    });

    await expect(
      signRequest(request, mockEnv as Env, "https://example.com/users/bob"),
    ).rejects.toBeInstanceOf(SigningUnavailableError);
  });

  it("THROWS when the key lookup itself fails", async () => {
    mockGetKeyPair = vi.fn().mockRejectedValue(new Error("db down"));
    const request = new Request("https://remote.example/inbox", {
      method: "POST",
      body: "{}",
    });

    await expect(
      signRequest(request, mockEnv as Env, "https://example.com/users/bob"),
    ).rejects.toBeInstanceOf(SigningUnavailableError);
  });

  it("signs with the local private key, covering the digest", async () => {
    mockGetKeyPair = vi.fn().mockResolvedValue({
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    });

    const request = new Request("https://remote.example/inbox", {
      method: "POST",
      body: '{"type":"Create"}',
    });

    const signed = await signRequest(
      request,
      mockEnv as Env,
      "https://example.com/users/bob",
    );

    const signature = signed.headers.get("Signature");
    expect(signature).toContain(
      'headers="(request-target) host date digest"',
    );
    expect(signed.headers.get("Digest")).toMatch(/^SHA-256=/);
  });
});
