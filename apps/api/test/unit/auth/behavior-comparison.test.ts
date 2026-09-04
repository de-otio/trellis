/**
 * WS-3.1 §5.6 — behavior-comparison harness (the neutrality gate).
 *
 * Proves the new generic-OIDC `verifyJwt` path is behavior-identical to the
 * pre-WS-3.1 pool-pinned `verifyCognitoJwt` for existing Cognito deployments:
 *
 *   1. A committed golden (`test/fixtures/auth/behavior-golden.json`) records
 *      the CURRENT accept/reject decision per fixture, plus the resolved claims
 *      and AuthContext for the valid token.
 *   2. Every fixture is run through the new path in BOTH config modes —
 *      (A) Cognito-derived defaults (no new env vars) and (B) explicit
 *      OIDC_ISSUER_URL/OIDC_APP_CLIENT_ID set to the derived values — and must yield
 *      the golden outcome in both, and the two modes must agree.
 *   3. Outcomes (accept/reject) and the resolved AuthContext are compared, NOT
 *      internal attempt counts [SEC-10] (the [SEC-2] retry narrowing changes
 *      attempt counts for permanent failures but never the decision).
 *   4. The two MUST-fix fixtures (no_exp [SEC-1], missing_sub [SEC-8]) are the
 *      sanctioned new rejects — the old path accepted no_exp forever and coerced
 *      a missing sub to "".
 *
 * Real crypto: an ephemeral RSA (and Ed25519) keypair signs the fixtures; the
 * JWKS is primed via a JwtVerifier.create spy (no network). Clock pinned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  generateKeyPairSync,
  KeyObject,
  sign as cryptoSign,
  createHmac,
} from "node:crypto";
import { JwtVerifier } from "aws-jwt-verify";

import { verifyJwt, resetVerifier } from "../../../src/lib/auth/cognito-jwt.js";
import { authMiddleware } from "../../../src/lib/auth/auth-middleware.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(__dirname, "../../fixtures/auth/behavior-golden.json"), "utf8"),
) as {
  fixtures: { name: string; outcome: "accept" | "reject" }[];
  validClaims: Record<string, string>;
  validAuthContext: Record<string, string>;
};

const FIXED_EPOCH_S = 1893456000; // 2030-01-01
const FIXED_EPOCH_MS = FIXED_EPOCH_S * 1000;

const REGION = "us-east-1";
const POOL_ID = "us-east-1_TestPool123";
const CLIENT_ID = "test-client-id-abc";
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}`;
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;

/* --- key material --- */
function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const rsa = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const j = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return { publicKey, privateKey, jwk: { kty: "RSA", use: "sig", alg: "RS256", kid: "rsa-1", n: j.n, e: j.e } };
})();
const ed = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const j = publicKey.export({ format: "jwk" }) as { x: string };
  return { privateKey, jwk: { kty: "OKP", use: "sig", alg: "EdDSA", kid: "ed-1", crv: "Ed25519", x: j.x } };
})();

interface Payload {
  iss?: string;
  aud?: unknown;
  sub?: unknown;
  token_use?: string;
  exp?: number | null;
  nbf?: number;
  [k: string]: unknown;
}
function makeToken(payload: Payload, opts: { alg?: string; kid?: string; hmacSecret?: string; rawSig?: string; privateKey?: KeyObject } = {}): string {
  const alg = opts.alg ?? "RS256";
  const header = { alg, typ: "JWT", kid: opts.kid ?? "rsa-1" };
  const body: Record<string, unknown> = {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "opaque-subject-abc",
    token_use: "id",
    iat: FIXED_EPOCH_S,
    exp: FIXED_EPOCH_S + 3600,
    "cognito:username": golden.validClaims.username,
    email: golden.validClaims.email,
    "custom:userId": golden.validClaims.userId,
    "custom:globalRole": golden.validClaims.globalRole,
    "custom:activeTenantId": golden.validClaims.activeTenantId,
    "custom:tenantSlug": golden.validClaims.tenantSlug,
    "custom:tenantRole": golden.validClaims.tenantRole,
    "custom:handle": golden.validClaims.handle,
  };
  for (const [k, v] of Object.entries(payload)) {
    if (v === null && (k === "exp" || k === "sub" || k === "aud")) delete body[k];
    else body[k] = v;
  }
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  if (opts.rawSig !== undefined) return `${input}.${opts.rawSig}`;
  let sig: Buffer;
  if (opts.hmacSecret !== undefined) sig = createHmac("sha256", opts.hmacSecret).update(input).digest();
  else if (alg === "EdDSA") sig = cryptoSign(null, Buffer.from(input), opts.privateKey ?? ed.privateKey);
  else sig = cryptoSign("RSA-SHA256", Buffer.from(input), opts.privateKey ?? rsa.privateKey);
  return `${input}.${b64url(sig)}`;
}

/** Build a fixture token for a golden fixture name. */
function fixtureToken(name: string): string {
  switch (name) {
    case "valid_id_token": return makeToken({});
    case "expired": return makeToken({ exp: FIXED_EPOCH_S - 100 });
    case "not_yet_valid_nbf": return makeToken({ nbf: FIXED_EPOCH_S + 3600 });
    case "wrong_audience": return makeToken({ aud: "some-other-client" });
    case "aud_array_includes": return makeToken({ aud: ["other", CLIENT_ID] });
    case "aud_array_excludes": return makeToken({ aud: ["other", "third"] });
    case "wrong_issuer": return makeToken({ iss: `https://cognito-idp.${REGION}.amazonaws.com/us-east-1_zzzzzzzz` });
    case "wrong_token_use_access": return makeToken({ token_use: "access" });
    case "alg_none": return makeToken({}, { alg: "none", rawSig: "" });
    case "alg_confusion_hs256": {
      const pubPem = rsa.publicKey.export({ type: "spki", format: "pem" });
      return makeToken({}, { alg: "HS256", hmacSecret: pubPem });
    }
    case "alg_eddsa": return makeToken({}, { alg: "EdDSA", kid: "ed-1", privateKey: ed.privateKey });
    case "malformed_two_part": return "aaa.bbb";
    case "no_exp_SEC1_new_reject": return makeToken({ exp: null });
    case "missing_sub_SEC8_new_reject": return makeToken({ sub: null });
    default: throw new Error(`unknown fixture ${name}`);
  }
}

/* --- JWKS priming spy (no network) --- */
let spy: ReturnType<typeof vi.spyOn> | null = null;
function installJwksSpy() {
  const original = JwtVerifier.create.bind(JwtVerifier);
  spy = vi.spyOn(JwtVerifier, "create").mockImplementation((props: unknown) => {
    const inst = original(props as Parameters<typeof original>[0]);
    (inst as unknown as { cacheJwks: (j: unknown) => void }).cacheJwks({ keys: [rsa.jwk, ed.jwk] });
    return inst;
  });
}

const ENV_KEYS = ["COGNITO_USER_POOL_ID", "COGNITO_APP_CLIENT_ID", "COGNITO_REGION", "OIDC_ISSUER_URL", "OIDC_APP_CLIENT_ID", "OIDC_JWKS_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_EPOCH_MS);
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  resetVerifier();
  installJwksSpy();
});
afterEach(() => {
  vi.useRealTimers();
  spy?.mockRestore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetVerifier();
});

/** Set env for a config mode, resetting the cached verifier. */
function setMode(mode: "derived" | "explicit") {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.COGNITO_USER_POOL_ID = POOL_ID;
  process.env.COGNITO_APP_CLIENT_ID = CLIENT_ID;
  process.env.COGNITO_REGION = REGION;
  process.env.OIDC_JWKS_URL = JWKS_URI;
  if (mode === "explicit") {
    process.env.OIDC_ISSUER_URL = ISSUER;
    process.env.OIDC_APP_CLIENT_ID = CLIENT_ID;
  }
  resetVerifier();
}

async function outcomeOf(token: string): Promise<"accept" | "reject"> {
  try {
    await verifyJwt(token);
    return "accept";
  } catch {
    return "reject";
  }
}

describe("behavior-comparison — outcomes match golden in BOTH config modes", () => {
  for (const mode of ["derived", "explicit"] as const) {
    describe(`mode: ${mode}`, () => {
      for (const fx of golden.fixtures) {
        it(`${fx.name} → ${fx.outcome}`, async () => {
          setMode(mode);
          expect(await outcomeOf(fixtureToken(fx.name))).toBe(fx.outcome);
        });
      }
    });
  }

  it("the two config modes agree on every fixture (equivalence)", async () => {
    for (const fx of golden.fixtures) {
      setMode("derived");
      const a = await outcomeOf(fixtureToken(fx.name));
      setMode("explicit");
      const b = await outcomeOf(fixtureToken(fx.name));
      expect(a).toBe(b);
      expect(a).toBe(fx.outcome);
    }
  });
});

describe("behavior-comparison — valid token resolves the golden claims + AuthContext", () => {
  it("verifyJwt yields the golden neutral claims (derived mode)", async () => {
    setMode("derived");
    const claims = await verifyJwt(fixtureToken("valid_id_token"));
    expect(claims).toEqual(golden.validClaims);
  });

  it("authMiddleware resolves the byte-identical golden AuthContext", async () => {
    setMode("derived");
    const req = new Request("https://api.example.com/api/tenants", {
      headers: { Authorization: `Bearer ${fixtureToken("valid_id_token")}` },
    });
    const ctx = await authMiddleware(req, {} as never);
    expect(ctx).not.toBeNull();
    const { membershipsLoader, ...fields } = ctx!;
    expect(typeof membershipsLoader).toBe("function");
    expect(fields).toEqual(golden.validAuthContext);
  });
});

describe("behavior-comparison — [SEC-2] permanent-failure flood triggers zero resets", () => {
  it("20 expired tokens build the verifier once (no reset thrash)", async () => {
    setMode("derived");
    // Prime once, then count constructions across the flood.
    await outcomeOf(fixtureToken("valid_id_token"));
    const before = (spy!.mock.calls.length);
    for (let i = 0; i < 20; i++) {
      expect(await outcomeOf(makeToken({ exp: FIXED_EPOCH_S - 100 - i }))).toBe("reject");
    }
    // No JwtVerifier.create beyond what the 24h-recreate/lazy-build already did.
    expect(spy!.mock.calls.length).toBe(before);
  });
});
