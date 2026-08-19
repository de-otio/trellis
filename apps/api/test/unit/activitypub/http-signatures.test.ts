/**
 * Adversarial suite for the consolidated HTTP-signature verifier.
 *
 * This is the exit criterion for Phase 7 findings 1–4. Each named attack from
 * the review gets a test that must FAIL to verify:
 *
 *   - a spoofed actor (signature valid, `activity.actor` someone else's)
 *   - a swapped body under a captured, still-valid signature
 *   - a replayed request
 *   - a request whose signature covers only `(request-target)`
 *   - a stale or future-dated request
 *
 * Real RSA keys are used throughout — a test that mocks `crypto.verify` proves
 * nothing about a signature scheme. The remote key fetch is injected, since
 * that path's SSRF properties are covered in the remote-fetch-service suite.
 */

import * as crypto from "crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertActorBinding,
  HttpSignatureService,
  InMemoryNonceStore,
  type VerifyOptions,
} from "../../../src/lib/activitypub/http-signatures.js";

const REMOTE_ACTOR = "https://remote.example/users/alice";
const REMOTE_KEY_ID = `${REMOTE_ACTOR}#main-key`;
const INBOX_URL = "https://local.example/users/bob/inbox";

let keyPair: { publicKey: string; privateKey: string };
let otherKeyPair: { publicKey: string; privateKey: string };

beforeAll(() => {
  const gen = () =>
    crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
  keyPair = gen();
  otherKeyPair = gen();
});

/** Key fetcher that returns alice's real key, as the actor document would. */
function keyFetcher(
  pem: () => string = () => keyPair.publicKey,
  owner = REMOTE_ACTOR,
): VerifyOptions["fetchKey"] {
  return async (keyId) =>
    keyId === REMOTE_KEY_ID ? { pem: pem(), owner } : null;
}

interface SignedRequestSpec {
  body?: string;
  /** Override the header list actually signed AND advertised. */
  coveredHeaders?: string[];
  /** Override the Date used for both signing and the header. */
  date?: string;
  /** Sign with the wrong key. */
  privateKey?: string;
  /** Emit a Digest header that does not match the body. */
  corruptDigest?: boolean;
  /** Omit the Digest header entirely (but still claim to sign it). */
  omitDigestHeader?: boolean;
  method?: string;
  url?: string;
}

/**
 * Build a genuinely signed request. Everything an honest peer would send,
 * with precise knobs for each attack.
 */
function signedRequest(spec: SignedRequestSpec = {}): Request {
  const method = spec.method ?? "POST";
  const url = spec.url ?? INBOX_URL;
  const parsed = new URL(url);
  const body = spec.body ?? JSON.stringify({ type: "Create", actor: REMOTE_ACTOR });
  const date = spec.date ?? new Date().toUTCString();

  const digest = `SHA-256=${crypto
    .createHash("sha256")
    .update(Buffer.from(body, "utf8"))
    .digest("base64")}`;

  const covered = spec.coveredHeaders ?? [
    "(request-target)",
    "host",
    "date",
    "digest",
  ];

  const headerValues: Record<string, string> = {
    host: parsed.host,
    date,
    digest,
  };

  const signatureString = covered
    .map((name) =>
      name === "(request-target)"
        ? `(request-target): ${method.toLowerCase()} ${parsed.pathname}${parsed.search}`
        : `${name}: ${headerValues[name] ?? ""}`,
    )
    .join("\n");

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signatureString);
  sign.end();
  const signature = sign.sign(spec.privateKey ?? keyPair.privateKey, "base64");

  const headers: Record<string, string> = {
    host: parsed.host,
    date,
    "content-type": "application/activity+json",
    Signature: [
      `keyId="${REMOTE_KEY_ID}"`,
      'algorithm="rsa-sha256"',
      `headers="${covered.join(" ")}"`,
      `signature="${signature}"`,
    ].join(","),
  };
  if (!spec.omitDigestHeader) {
    headers.digest = spec.corruptDigest
      ? `SHA-256=${crypto.createHash("sha256").update("something else").digest("base64")}`
      : digest;
  }

  return new Request(url, { method, headers, body });
}

const env = { ACTIVITYPUB_BASE_URL: "https://local.example" };

describe("verifyRequest — the happy path still works", () => {
  it("accepts a correctly signed request and reports the key owner", async () => {
    const result = await HttpSignatureService.verifyRequest(
      signedRequest(),
      env,
      { fetchKey: keyFetcher() },
    );

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unreachable");
    expect(result.keyId).toBe(REMOTE_KEY_ID);
    expect(result.owner).toBe(REMOTE_ACTOR);
    // The authenticated bytes come back so the caller parses exactly those.
    expect(JSON.parse(result.body.toString("utf8")).type).toBe("Create");
  });

  it("round-trips against its own signer", async () => {
    const body = JSON.stringify({ type: "Follow", actor: REMOTE_ACTOR });
    const { signature, date, digest } = HttpSignatureService.signRequest(
      "POST",
      "/users/bob/inbox",
      "local.example",
      keyPair.privateKey,
      REMOTE_KEY_ID,
      body,
    );
    const request = new Request(INBOX_URL, {
      method: "POST",
      headers: {
        host: "local.example",
        date,
        digest: digest!,
        Signature: signature,
      },
      body,
    });

    const result = await HttpSignatureService.verifyRequest(request, env, {
      fetchKey: keyFetcher(),
    });
    expect(result.valid).toBe(true);
  });
});

describe("F3 — the body must be authenticated", () => {
  it("REJECTS a swapped body under a captured, otherwise-valid signature", async () => {
    // The headline attack: capture a valid signature, replace the JSON.
    const genuine = signedRequest({
      body: JSON.stringify({ type: "Like", actor: REMOTE_ACTOR }),
    });

    const forged = new Request(INBOX_URL, {
      method: "POST",
      headers: genuine.headers, // same Signature, same Digest, same Date
      body: JSON.stringify({
        type: "Delete",
        actor: REMOTE_ACTOR,
        object: "https://local.example/posts/everything",
      }),
    });

    const result = await HttpSignatureService.verifyRequest(forged, env, {
      fetchKey: keyFetcher(),
    });

    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("digest-mismatch");
  });

  it("REJECTS a minimal headers=\"(request-target)\" signature", async () => {
    // Previously accepted: the client chose what was covered, and chose almost
    // nothing.
    const result = await HttpSignatureService.verifyRequest(
      signedRequest({ coveredHeaders: ["(request-target)"] }),
      env,
      { fetchKey: keyFetcher() },
    );

    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("missing-covered-header");
  });

  it("REJECTS a signature that omits digest from the covered set", async () => {
    const result = await HttpSignatureService.verifyRequest(
      signedRequest({ coveredHeaders: ["(request-target)", "host", "date"] }),
      env,
      { fetchKey: keyFetcher() },
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("missing-covered-header");
  });

  it.each([["host"], ["date"]])(
    "REJECTS a signature that omits %s from the covered set",
    async (omitted) => {
      const covered = ["(request-target)", "host", "date", "digest"].filter(
        (h) => h !== omitted,
      );
      const result = await HttpSignatureService.verifyRequest(
        signedRequest({ coveredHeaders: covered }),
        env,
        { fetchKey: keyFetcher() },
      );
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error("unreachable");
      expect(result.reason).toBe("missing-covered-header");
    },
  );

  it("REJECTS when the Digest header is absent entirely", async () => {
    const result = await HttpSignatureService.verifyRequest(
      signedRequest({ omitDigestHeader: true }),
      env,
      { fetchKey: keyFetcher() },
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("missing-digest");
  });

  it("REJECTS a Digest that does not match the body", async () => {
    const result = await HttpSignatureService.verifyRequest(
      signedRequest({ corruptDigest: true }),
      env,
      { fetchKey: keyFetcher() },
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("digest-mismatch");
  });

  it("accepts the RFC 9530 Content-Digest form", async () => {
    const body = JSON.stringify({ type: "Create", actor: REMOTE_ACTOR });
    const b64 = crypto.createHash("sha256").update(body).digest("base64");
    const date = new Date().toUTCString();
    const covered = ["(request-target)", "host", "date", "digest"];
    // Note the signature still covers the classic `digest` name; the header
    // itself is supplied in structured form.
    const signatureString = [
      "(request-target): post /users/bob/inbox",
      "host: local.example",
      `date: ${date}`,
      `digest: sha-256=:${b64}:`,
    ].join("\n");
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(signatureString);
    sign.end();
    const signature = sign.sign(keyPair.privateKey, "base64");

    const request = new Request(INBOX_URL, {
      method: "POST",
      headers: {
        host: "local.example",
        date,
        digest: `sha-256=:${b64}:`,
        Signature: [
          `keyId="${REMOTE_KEY_ID}"`,
          'algorithm="rsa-sha256"',
          `headers="${covered.join(" ")}"`,
          `signature="${signature}"`,
        ].join(","),
      },
      body,
    });

    const result = await HttpSignatureService.verifyRequest(request, env, {
      fetchKey: keyFetcher(),
    });
    expect(result.valid).toBe(true);
  });
});

describe("F4 — freshness and replay", () => {
  it("REJECTS a request dated well in the past", async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000).toUTCString();
    const result = await HttpSignatureService.verifyRequest(
      signedRequest({ date: stale }),
      env,
      { fetchKey: keyFetcher() },
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("stale-date");
  });

  it("REJECTS a request dated in the future beyond the window", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toUTCString();
    const result = await HttpSignatureService.verifyRequest(
      signedRequest({ date: future }),
      env,
      { fetchKey: keyFetcher() },
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("stale-date");
  });

  it("accepts a request just inside the skew window", async () => {
    const nearly = new Date(Date.now() - 4 * 60 * 1000).toUTCString();
    const result = await HttpSignatureService.verifyRequest(
      signedRequest({ date: nearly }),
      env,
      { fetchKey: keyFetcher() },
    );
    expect(result.valid).toBe(true);
  });

  it("REJECTS an exact replay when a nonce store is configured", async () => {
    const nonceStore = new InMemoryNonceStore();
    const request = signedRequest();

    const first = await HttpSignatureService.verifyRequest(
      request.clone(),
      env,
      { fetchKey: keyFetcher(), nonceStore },
    );
    expect(first.valid).toBe(true);

    // Byte-identical replay inside the skew window.
    const second = await HttpSignatureService.verifyRequest(
      request.clone(),
      env,
      { fetchKey: keyFetcher(), nonceStore },
    );
    expect(second.valid).toBe(false);
    if (second.valid) throw new Error("unreachable");
    expect(second.reason).toBe("replayed");
  });

  it("does not confuse two distinct requests for a replay", async () => {
    const nonceStore = new InMemoryNonceStore();
    const a = await HttpSignatureService.verifyRequest(
      signedRequest({ body: JSON.stringify({ type: "Like", actor: REMOTE_ACTOR }) }),
      env,
      { fetchKey: keyFetcher(), nonceStore },
    );
    const b = await HttpSignatureService.verifyRequest(
      signedRequest({ body: JSON.stringify({ type: "Follow", actor: REMOTE_ACTOR }) }),
      env,
      { fetchKey: keyFetcher(), nonceStore },
    );
    expect(a.valid).toBe(true);
    expect(b.valid).toBe(true);
  });
});

describe("F2 — the key comes from the remote actor, not from us", () => {
  it("REJECTS when the key cannot be fetched", async () => {
    const result = await HttpSignatureService.verifyRequest(
      signedRequest(),
      env,
      { fetchKey: async () => null },
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("key-unavailable");
  });

  it("REJECTS a signature made with a different key", async () => {
    const result = await HttpSignatureService.verifyRequest(
      signedRequest({ privateKey: otherKeyPair.privateKey }),
      env,
      { fetchKey: keyFetcher() },
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("bad-signature");
  });

  it("reports the owner from the fetched key, never from the request", async () => {
    const result = await HttpSignatureService.verifyRequest(
      // Body claims to be someone else entirely.
      signedRequest({
        body: JSON.stringify({
          type: "Create",
          actor: "https://victim.example/users/admin",
        }),
      }),
      env,
      { fetchKey: keyFetcher() },
    );
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unreachable");
    expect(result.owner).toBe(REMOTE_ACTOR); // NOT the victim in the body
  });
});

describe("verifyRequest — malformed input", () => {
  it("rejects a request with no Signature header", async () => {
    const result = await HttpSignatureService.verifyRequest(
      new Request(INBOX_URL, { method: "POST", body: "{}" }),
      env,
      { fetchKey: keyFetcher() },
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("missing-signature");
  });

  it("rejects an unsupported algorithm", async () => {
    const request = signedRequest();
    const headers = new Headers(request.headers);
    headers.set(
      "Signature",
      headers.get("Signature")!.replace("rsa-sha256", "hmac-sha256"),
    );
    const result = await HttpSignatureService.verifyRequest(
      new Request(INBOX_URL, { method: "POST", headers, body: "{}" }),
      env,
      { fetchKey: keyFetcher() },
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("unsupported-algorithm");
  });

  it("rejects a Signature header missing required parameters", async () => {
    const result = await HttpSignatureService.verifyRequest(
      new Request(INBOX_URL, {
        method: "POST",
        headers: { Signature: 'keyId="x"' },
        body: "{}",
      }),
      env,
      { fetchKey: keyFetcher() },
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("malformed-signature");
  });

  it("rejects when the Date header is absent", async () => {
    const request = signedRequest();
    const headers = new Headers(request.headers);
    headers.delete("date");
    const result = await HttpSignatureService.verifyRequest(
      new Request(INBOX_URL, {
        method: "POST",
        headers,
        body: await request.text(),
      }),
      env,
      { fetchKey: keyFetcher() },
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("missing-date");
  });
});

describe("F1 — assertActorBinding", () => {
  it("REJECTS a spoofed actor (key owner != activity.actor)", async () => {
    // The CRITICAL 1 attack, stated plainly: attacker signs with their own
    // perfectly valid key, then claims to be the victim.
    const binding = assertActorBinding(REMOTE_ACTOR, {
      type: "Create",
      actor: "https://victim.example/users/admin",
    });
    expect(binding.ok).toBe(false);
    expect(binding.reason).toContain("does not match");
  });

  it("accepts when the key owner IS the actor", () => {
    expect(
      assertActorBinding(REMOTE_ACTOR, { type: "Create", actor: REMOTE_ACTOR }).ok,
    ).toBe(true);
  });

  it("accepts an actor given as an embedded object", () => {
    expect(
      assertActorBinding(REMOTE_ACTOR, {
        type: "Create",
        actor: { id: REMOTE_ACTOR, type: "Person" },
      }).ok,
    ).toBe(true);
  });

  it("tolerates a trailing slash difference", () => {
    expect(
      assertActorBinding(REMOTE_ACTOR, {
        type: "Create",
        actor: `${REMOTE_ACTOR}/`,
      }).ok,
    ).toBe(true);
  });

  it("REJECTS an activity with no resolvable actor", () => {
    expect(assertActorBinding(REMOTE_ACTOR, { type: "Create" }).ok).toBe(false);
  });

  it("REJECTS an object attributed to a third instance", () => {
    const binding = assertActorBinding(REMOTE_ACTOR, {
      type: "Create",
      actor: REMOTE_ACTOR,
      object: {
        id: "https://remote.example/notes/1",
        attributedTo: "https://victim.example/users/admin",
      },
    });
    expect(binding.ok).toBe(false);
    expect(binding.reason).toContain("attributedTo");
  });

  it("REJECTS an object whose id is on another origin", () => {
    const binding = assertActorBinding(REMOTE_ACTOR, {
      type: "Create",
      actor: REMOTE_ACTOR,
      object: { id: "https://victim.example/notes/1" },
    });
    expect(binding.ok).toBe(false);
    expect(binding.reason).toContain("object.id");
  });

  it("accepts an object on the actor's own origin", () => {
    expect(
      assertActorBinding(REMOTE_ACTOR, {
        type: "Create",
        actor: REMOTE_ACTOR,
        object: {
          id: "https://remote.example/notes/1",
          attributedTo: REMOTE_ACTOR,
        },
      }).ok,
    ).toBe(true);
  });

  it("REJECTS a non-object activity", () => {
    expect(assertActorBinding(REMOTE_ACTOR, null).ok).toBe(false);
    expect(assertActorBinding(REMOTE_ACTOR, "Create").ok).toBe(false);
  });
});

describe("signRequest", () => {
  it("covers digest when a body is supplied", () => {
    const { signature, digest } = HttpSignatureService.signRequest(
      "POST",
      "/inbox",
      "example.com",
      keyPair.privateKey,
      REMOTE_KEY_ID,
      "hello",
    );
    expect(signature).toContain('headers="(request-target) host date digest"');
    expect(digest).toMatch(/^SHA-256=/);
  });

  it("omits digest when there is no body", () => {
    const { signature, digest } = HttpSignatureService.signRequest(
      "GET",
      "/inbox",
      "example.com",
      keyPair.privateKey,
      REMOTE_KEY_ID,
    );
    expect(signature).toContain('headers="(request-target) host date"');
    expect(digest).toBeUndefined();
  });
});
