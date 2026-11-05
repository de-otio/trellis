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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ATTACKER_ACTOR = "https://attacker.example/users/evil";
const ATTACKER_KEY_ID = `${ATTACKER_ACTOR}#main-key`;
const VICTIM_ACTOR = "https://victim.example/users/admin";
const INBOX_URL = "https://local.example/users/bob/inbox";

let attackerKeys: { publicKey: string; privateKey: string };
let rotatedKeys: { publicKey: string; privateKey: string };

const fetchActor = vi.fn();
const invalidateCache = vi.fn();

// Like the real service, consult the caller's pre-network budget hook (M13)
// immediately before a "live" fetch; a refusal is a null with no fetch made.
vi.mock("../../../src/lib/activitypub/remote-fetch-service.js", () => ({
  RemoteFetchService: {
    fetchActor: async (
      uri: string,
      env: unknown,
      logger: unknown,
      options?: { beforeNetworkFetch?: (host: string) => Promise<boolean> },
    ) => {
      if (options?.beforeNetworkFetch) {
        const ok = await options
          .beforeNetworkFetch(new URL(uri).hostname.toLowerCase())
          .catch(() => false);
        if (!ok) return null;
      }
      return fetchActor(uri, env, logger, options);
    },
    invalidateCache: (...args: unknown[]) => invalidateCache(...args),
  },
}));

// Lets one test make the shared limiter throw; otherwise the real limiter runs.
let consumeOverride: ((...args: unknown[]) => Promise<unknown>) | undefined;
vi.mock("../../../src/lib/rate-limit.js", async (orig) => {
  const real = (await orig()) as Record<string, any>;
  return {
    ...real,
    consumeSharedBucket: (...args: unknown[]) =>
      consumeOverride ? consumeOverride(...args) : real.consumeSharedBucket(...args),
  };
});

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

beforeEach(async () => {
  fetchActor.mockReset();
  invalidateCache.mockReset();
  // M13: the forced-refresh cooldown is module state; without this a test
  // inherits the previous test's cooldown for the same keyId.
  const { __resetKeyRefreshCooldownForTests } = await import(
    "../../../src/lib/activitypub/http-signatures.js"
  );
  __resetKeyRefreshCooldownForTests();
  // M13: the per-host key-fetch bucket is shared in-process state.
  const { __resetRateLimiterForTests } = await import("../../../src/lib/rate-limit.js");
  __resetRateLimiterForTests();
  consumeOverride = undefined;
});

afterEach(() => {
  delete process.env.ACTIVITYPUB_KEY_REFRESH_COOLDOWN_SECONDS;
  delete process.env.ACTIVITYPUB_KEY_FETCH_RATE_LIMIT;
  delete process.env.ACTIVITYPUB_MIN_RSA_BITS;
  vi.useRealTimers();
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

function signed(
  body: string,
  privateKey = attackerKeys.privateKey,
  keyId = ATTACKER_KEY_ID,
): Request {
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
        `keyId="${keyId}"`,
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

// M13 — an unauthenticated sender must not be able to make us evict and
// re-dereference a third party's actor document on every request.
describe("forced key refresh is bounded per keyId (M13)", () => {
  it("garbage signatures naming one keyId trigger ONE eviction + live refetch, not one each", async () => {
    fetchActor.mockResolvedValue(honestDocument());

    // Five requests signed with a key that is not the actor's.
    for (let i = 0; i < 5; i++) {
      const result = await verify(
        signed(activityAsSelf + " ".repeat(i), rotatedKeys.privateKey),
      );
      expect(result.valid).toBe(false);
    }

    // Before the fix: 5 evictions and 10 fetches (cached + live, every time).
    expect(invalidateCache).toHaveBeenCalledTimes(1);
    // 5 normal (cached-path) fetches + the single forced refresh.
    expect(fetchActor).toHaveBeenCalledTimes(6);
  });

  it("a legitimately rotated peer still gets the refresh on its first request", async () => {
    fetchActor
      .mockResolvedValueOnce(honestDocument()) // stale cache
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
  });

  it("the refresh is available again once the cooldown has elapsed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
    fetchActor.mockResolvedValue(honestDocument());

    await verify(signed(activityAsSelf, rotatedKeys.privateKey));
    expect(invalidateCache).toHaveBeenCalledTimes(1);

    // Inside the default 60s cooldown: no second eviction.
    vi.setSystemTime(new Date("2026-11-05T10:00:59Z"));
    await verify(signed(activityAsSelf + " ", rotatedKeys.privateKey));
    expect(invalidateCache).toHaveBeenCalledTimes(1);

    // Past it: allowed again.
    vi.setSystemTime(new Date("2026-11-05T10:01:01Z"));
    await verify(signed(activityAsSelf + "  ", rotatedKeys.privateKey));
    expect(invalidateCache).toHaveBeenCalledTimes(2);
  });

  it("the cooldown is runtime config (ACTIVITYPUB_KEY_REFRESH_COOLDOWN_SECONDS)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
    process.env.ACTIVITYPUB_KEY_REFRESH_COOLDOWN_SECONDS = "600";
    fetchActor.mockResolvedValue(honestDocument());

    await verify(signed(activityAsSelf, rotatedKeys.privateKey));
    vi.setSystemTime(new Date("2026-11-05T10:05:00Z")); // 300s: past default, inside 600s
    await verify(signed(activityAsSelf + " ", rotatedKeys.privateKey));

    expect(invalidateCache).toHaveBeenCalledTimes(1);
  });

  it("a cooldown of 0 disables the bound (operator opt-out)", async () => {
    process.env.ACTIVITYPUB_KEY_REFRESH_COOLDOWN_SECONDS = "0";
    fetchActor.mockResolvedValue(honestDocument());

    await verify(signed(activityAsSelf, rotatedKeys.privateKey));
    await verify(signed(activityAsSelf + " ", rotatedKeys.privateKey));

    expect(invalidateCache).toHaveBeenCalledTimes(2);
  });

  it("an invalid cooldown value falls back to the default rather than disabling the bound", async () => {
    process.env.ACTIVITYPUB_KEY_REFRESH_COOLDOWN_SECONDS = "not-a-number";
    fetchActor.mockResolvedValue(honestDocument());

    await verify(signed(activityAsSelf, rotatedKeys.privateKey));
    await verify(signed(activityAsSelf + " ", rotatedKeys.privateKey));

    expect(invalidateCache).toHaveBeenCalledTimes(1);
  });

  it("a VALID signature never consumes the refresh slot", async () => {
    fetchActor.mockResolvedValue(honestDocument());
    const ok = await verify(signed(activityAsSelf, attackerKeys.privateKey));
    expect(ok.valid).toBe(true);
    expect(invalidateCache).not.toHaveBeenCalled();

    // The first BAD signature afterwards still gets its refresh.
    await verify(signed(activityAsSelf + " ", rotatedKeys.privateKey));
    expect(invalidateCache).toHaveBeenCalledTimes(1);
  });
});

// M13 — however an unauthenticated sender varies keyIds, a single third-party
// host is dereferenced at most N times a minute through us.
describe("key fetches are bounded per TARGET host (M13)", () => {
  /** An honest document for whatever actor the keyId names. */
  const honestFor = (uri: string, publicKeyPem = attackerKeys.publicKey) => ({
    type: "Person",
    id: uri,
    inbox: `${uri}/inbox`,
    publicKey: { id: `${uri}#main-key`, owner: uri, publicKeyPem },
  });
  const actorN = (host: string, i: number) => `https://${host}/users/u${i}`;

  beforeEach(() => {
    fetchActor.mockImplementation(async (uri: string) => honestFor(uri));
  });

  const verifyAs = (host: string, i: number) =>
    verify(
      signed(
        JSON.stringify({ type: "Create", actor: actorN(host, i) }),
        attackerKeys.privateKey,
        `${actorN(host, i)}#main-key`,
      ),
    );

  it("distinct keyIds on ONE host stop reaching the network once the budget is spent", async () => {
    process.env.ACTIVITYPUB_KEY_FETCH_RATE_LIMIT = "3";

    const results = [];
    for (let i = 0; i < 6; i++) results.push(await verifyAs("target.example", i));

    // Before the fix: 6 fetches toward target.example.
    expect(fetchActor).toHaveBeenCalledTimes(3);
    expect(results.filter((r) => r.valid)).toHaveLength(3);
    for (const r of results.slice(3)) {
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.reason).toBe("key-unavailable");
    }
  });

  it("the budget is per HOST: another host is unaffected by one host's exhaustion", async () => {
    process.env.ACTIVITYPUB_KEY_FETCH_RATE_LIMIT = "2";
    for (let i = 0; i < 4; i++) await verifyAs("target.example", i);
    expect(fetchActor).toHaveBeenCalledTimes(2);

    const other = await verifyAs("friendly.example", 0);
    expect(other.valid).toBe(true);
    expect(fetchActor).toHaveBeenCalledTimes(3);
  });

  it("host matching is case-insensitive (a keyId cannot dodge the bucket by case)", async () => {
    process.env.ACTIVITYPUB_KEY_FETCH_RATE_LIMIT = "1";
    await verifyAs("target.example", 0);
    const second = await verifyAs("TARGET.example", 1);
    expect(second.valid).toBe(false);
    expect(fetchActor).toHaveBeenCalledTimes(1);
  });

  it("defaults to 30 per host per minute (runtime-configurable, not unbounded)", async () => {
    for (let i = 0; i < 31; i++) await verifyAs("target.example", i);
    expect(fetchActor).toHaveBeenCalledTimes(30);
  });

  it("the forced refresh after a failed signature is charged to the same bucket", async () => {
    process.env.ACTIVITYPUB_KEY_FETCH_RATE_LIMIT = "2";
    const bad = (i: number) =>
      verify(
        signed(
          JSON.stringify({ type: "Create", actor: ATTACKER_ACTOR }) + " ".repeat(i),
          rotatedKeys.privateKey,
        ),
      );
    fetchActor.mockImplementation(async () => honestDocument());

    await bad(0); // initial fetch + forced refresh = both tokens
    expect(fetchActor).toHaveBeenCalledTimes(2);
    const next = await bad(1);
    expect(next.valid).toBe(false);
    if (!next.valid) expect(next.reason).toBe("key-unavailable");
    expect(fetchActor).toHaveBeenCalledTimes(2);
  });

  it("fails CLOSED (key-unavailable, no fetch) when the limiter cannot be consulted", async () => {
    consumeOverride = async () => {
      throw new Error("limiter backend down");
    };
    const result = await verify(signed(activityAsSelf));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("key-unavailable");
    expect(fetchActor).not.toHaveBeenCalled();
  });

  it("the bucket key is the target host, not the keyId", async () => {
    const seen: string[] = [];
    consumeOverride = async (...args: unknown[]) => {
      seen.push(String(args[1]));
      return { allowed: true, remaining: 1, resetAt: Date.now() + 1000 };
    };
    await verifyAs("target.example", 1);
    await verifyAs("target.example", 2);
    expect(seen).toEqual(["ap:keyfetch:target.example", "ap:keyfetch:target.example"]);
  });
});

// I4 — a fetched key must be RSA and at least 2048 bits.
describe("fetched signing keys must be strong RSA keys (I4)", () => {
  let weak: { publicKey: string; privateKey: string };
  let ec: { publicKey: string; privateKey: string };

  beforeAll(() => {
    weak = crypto.generateKeyPairSync("rsa", {
      modulusLength: 1024,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    ec = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
  });

  const withKey = (publicKeyPem: string) =>
    honestDocument({
      publicKey: { id: ATTACKER_KEY_ID, owner: ATTACKER_ACTOR, publicKeyPem },
    });

  it("REJECTS a 1024-bit RSA key even though the signature would verify", async () => {
    fetchActor.mockResolvedValue(withKey(weak.publicKey));
    const result = await verify(signed(activityAsSelf, weak.privateKey));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("key-unavailable");
  });

  it("ACCEPTS a 2048-bit RSA key (the floor itself)", async () => {
    fetchActor.mockResolvedValue(withKey(attackerKeys.publicKey));
    const result = await verify(signed(activityAsSelf));
    expect(result.valid).toBe(true);
  });

  it("REJECTS a non-RSA key (only rsa-sha256 is accepted)", async () => {
    fetchActor.mockResolvedValue(withKey(ec.publicKey));
    const result = await verify(signed(activityAsSelf));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("key-unavailable");
  });

  it("REJECTS an unparseable PEM", async () => {
    fetchActor.mockResolvedValue(withKey("-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----"));
    const result = await verify(signed(activityAsSelf));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("key-unavailable");
  });

  it("the floor can be raised by config", async () => {
    process.env.ACTIVITYPUB_MIN_RSA_BITS = "4096";
    fetchActor.mockResolvedValue(withKey(attackerKeys.publicKey));
    const result = await verify(signed(activityAsSelf));
    expect(result.valid).toBe(false);
  });

  it("the floor cannot be LOWERED by config", async () => {
    process.env.ACTIVITYPUB_MIN_RSA_BITS = "512";
    fetchActor.mockResolvedValue(withKey(weak.publicKey));
    const result = await verify(signed(activityAsSelf, weak.privateKey));
    expect(result.valid).toBe(false);
  });
});
