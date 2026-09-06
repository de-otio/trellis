/**
 * The PRODUCTION key fetcher, exercised end to end.
 *
 * `http-signatures.test.ts` injects an honest `fetchKey` into every
 * `verifyRequest` call, so it proves the verifier's arithmetic and nothing
 * about where the key comes from. That gap is exactly where the 2026-09-06
 * deep pass found actor impersonation: `defaultFetchKey` took
 * `publicKey.owner` (and `actor.id`) verbatim from a document the attacker
 * hosts, so an attacker signing with their own key could name any actor on
 * any instance as the owner and pass the F1 binding.
 *
 * Here the only thing mocked is the NETWORK (`RemoteFetchService.fetchActor`)
 * and the standalone-mode toggle (a database read). The identity rules run
 * for real.
 */

import * as crypto from "crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ATTACKER_ACTOR = "https://attacker.example/users/evil";
const ATTACKER_KEY_ID = `${ATTACKER_ACTOR}#main-key`;
const VICTIM_ACTOR = "https://victim.example/users/admin";
const INBOX_URL = "https://local.example/users/bob/inbox";

let attackerKeys: { publicKey: string; privateKey: string };
let rotatedKeys: { publicKey: string; privateKey: string };

const fetchActor = vi.fn();
const invalidateCache = vi.fn();

vi.mock("../../../src/lib/activitypub/remote-fetch-service.js", () => ({
  RemoteFetchService: {
    fetchActor: (...args: unknown[]) => fetchActor(...args),
    invalidateCache: (...args: unknown[]) => invalidateCache(...args),
  },
}));

vi.mock("../../../src/lib/activitypub/standalone-mode.js", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, isStandaloneModeEnabled: async () => false };
});

beforeAll(() => {
  const gen = () =>
    crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
  attackerKeys = gen();
  rotatedKeys = gen();
});

beforeEach(() => {
  fetchActor.mockReset();
  invalidateCache.mockReset();
});

/** An honest actor document for the attacker's own URI. */
function honestDocument(overrides: Record<string, unknown> = {}) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Person",
    id: ATTACKER_ACTOR,
    inbox: `${ATTACKER_ACTOR}/inbox`,
    publicKey: {
      id: ATTACKER_KEY_ID,
      owner: ATTACKER_ACTOR,
      publicKeyPem: attackerKeys.publicKey,
    },
    ...overrides,
  };
}

function signed(body: string, privateKey = attackerKeys.privateKey): Request {
  const parsed = new URL(INBOX_URL);
  const date = new Date().toUTCString();
  const digest = `SHA-256=${crypto.createHash("sha256").update(body).digest("base64")}`;
  const covered = ["(request-target)", "host", "date", "digest"];
  const sigString = [
    `(request-target): post ${parsed.pathname}`,
    `host: ${parsed.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join("\n");
  const s = crypto.createSign("RSA-SHA256");
  s.update(sigString);
  s.end();
  const signature = s.sign(privateKey, "base64");
  return new Request(INBOX_URL, {
    method: "POST",
    headers: {
      host: parsed.host,
      date,
      digest,
      "content-type": "application/activity+json",
      Signature: [
        `keyId="${ATTACKER_KEY_ID}"`,
        'algorithm="rsa-sha256"',
        `headers="${covered.join(" ")}"`,
        `signature="${signature}"`,
      ].join(","),
    },
    body,
  });
}

const env = { ACTIVITYPUB_BASE_URL: "https://local.example" };

async function verify(req: Request, extraEnv: Record<string, unknown> = {}) {
  const { HttpSignatureService } = await import(
    "../../../src/lib/activitypub/http-signatures.js"
  );
  // No `fetchKey` injected: this is the production path.
  return HttpSignatureService.verifyRequest(req, { ...env, ...extraEnv });
}

const activityAsVictim = JSON.stringify({
  type: "Create",
  actor: VICTIM_ACTOR,
  object: {
    id: "https://victim.example/posts/1",
    type: "Note",
    attributedTo: VICTIM_ACTOR,
    content: "forged as the victim",
  },
});

const activityAsSelf = JSON.stringify({ type: "Create", actor: ATTACKER_ACTOR });

describe("defaultFetchKey — the owner is the document's own id, never a claim", () => {
  it("accepts an honest document and reports its id as the owner", async () => {
    fetchActor.mockResolvedValue(honestDocument());
    const result = await verify(signed(activityAsSelf));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.owner).toBe(ATTACKER_ACTOR);
    expect(result.keyId).toBe(ATTACKER_KEY_ID);
  });

  it("accepts a document whose publicKey omits owner (owner := actor.id)", async () => {
    const doc = honestDocument();
    delete (doc.publicKey as Record<string, unknown>).owner;
    fetchActor.mockResolvedValue(doc);
    const result = await verify(signed(activityAsSelf));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.owner).toBe(ATTACKER_ACTOR);
  });

  it("REJECTS a forged publicKey.owner (the impersonation the deep pass found)", async () => {
    fetchActor.mockResolvedValue(
      honestDocument({
        publicKey: {
          id: ATTACKER_KEY_ID,
          owner: VICTIM_ACTOR, // the claim
          publicKeyPem: attackerKeys.publicKey,
        },
      }),
    );
    const result = await verify(signed(activityAsVictim));
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe("key-unavailable");
  });

  it("REJECTS a document whose id names another actor", async () => {
    fetchActor.mockResolvedValue(
      honestDocument({
        id: VICTIM_ACTOR,
        publicKey: {
          id: ATTACKER_KEY_ID,
          owner: VICTIM_ACTOR,
          publicKeyPem: attackerKeys.publicKey,
        },
      }),
    );
    const result = await verify(signed(activityAsVictim));
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe("key-unavailable");
  });

  it("REJECTS a document whose publicKey.id is not the keyId", async () => {
    fetchActor.mockResolvedValue(
      honestDocument({
        publicKey: {
          id: `${ATTACKER_ACTOR}#other-key`,
          owner: ATTACKER_ACTOR,
          publicKeyPem: attackerKeys.publicKey,
        },
      }),
    );
    const result = await verify(signed(activityAsSelf));
    expect(result.valid).toBe(false);
  });

  it("REJECTS a keyId from a blocked instance WITHOUT fetching it", async () => {
    fetchActor.mockResolvedValue(honestDocument());
    const result = await verify(signed(activityAsSelf), {
      ACTIVITYPUB_BLOCKED_DOMAINS: "attacker.example",
    });
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe("key-unavailable");
    expect(fetchActor).not.toHaveBeenCalled();
  });

  it("REJECTS a local keyId presented on an inbound request", async () => {
    const parsed = new URL(INBOX_URL);
    const req = signed(activityAsSelf);
    const headers = new Headers(req.headers);
    headers.set(
      "Signature",
      (headers.get("Signature") ?? "").replace(
        ATTACKER_KEY_ID,
        `https://${parsed.host}/users/bob#main-key`,
      ),
    );
    const result = await verify(new Request(req.url, { method: "POST", headers, body: activityAsSelf }));
    expect(result.valid).toBe(false);
    expect(fetchActor).not.toHaveBeenCalled();
  });
});

describe("rotated remote key — evict and refetch exactly once", () => {
  it("accepts a signature under the peer's new key after one refetch", async () => {
    fetchActor
      .mockResolvedValueOnce(honestDocument()) // stale cache: old key
      .mockResolvedValueOnce(
        honestDocument({
          publicKey: {
            id: ATTACKER_KEY_ID,
            owner: ATTACKER_ACTOR,
            publicKeyPem: rotatedKeys.publicKey,
          },
        }),
      );
    const result = await verify(signed(activityAsSelf, rotatedKeys.privateKey));
    expect(result.valid).toBe(true);
    expect(invalidateCache).toHaveBeenCalledTimes(1);
    expect(invalidateCache).toHaveBeenCalledWith(ATTACKER_ACTOR);
    expect(fetchActor).toHaveBeenCalledTimes(2);
  });

  it("does not loop: a signature that is still bad after the refetch fails", async () => {
    fetchActor.mockResolvedValue(honestDocument());
    const result = await verify(signed(activityAsSelf, rotatedKeys.privateKey));
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe("bad-signature");
    expect(fetchActor).toHaveBeenCalledTimes(2);
  });
});
