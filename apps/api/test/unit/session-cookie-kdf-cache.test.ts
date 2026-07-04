/**
 * Unit Tests: SessionCookie module-scope KDF cache (AR9)
 *
 * `new SessionManager()` happens per request (~160 call sites). Before
 * AR9 the derived-key cache lived on the SessionManager INSTANCE, so it
 * never got a warm hit and every cookie-authenticated request re-paid
 * the full 600k-iteration PBKDF2 (~100–250 ms CPU) — twice on the
 * primary+fallback rotation path. AR9 hoists the cache to module scope
 * keyed by the (secret, fallback-secret, salt) triple.
 *
 * These tests prove, by counting actual `SubtleCrypto.deriveKey`
 * invocations:
 *   1. the KDF runs ONCE per distinct secret triple, not once per
 *      request, across fresh per-request SessionManager instances;
 *   2. rotation correctness — after a secret rotation the fallback
 *      secret still decrypts pre-rotation cookies, both keys are
 *      cached, and a stale cached key is never served for a
 *      post-rotation config;
 *   3. the cache is bounded (FIFO eviction) and an evicted triple
 *      safely re-derives;
 *   4. (benchmark) a warm request skips the 600k-iteration derivation.
 *
 * NOTE on iterations: the count-based tests stub `deriveKey` to
 * delegate to the REAL WebCrypto implementation with a reduced
 * iteration count, purely so the suite runs fast. This changes nothing
 * in production code — the 600k-iteration OWASP minimum is owned by
 * foundation's `SessionCookie` and is exercised as-is by the benchmark
 * test below, which uses the real parameters.
 */

import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionManager,
  __clearSessionCookieCacheForTesting,
  type Session,
} from "../../src/lib/session-cookie.js";

// Mock session-config the same way session-manager.test.ts does, so
// getSession's inactivity-timeout path never pulls real env config.
vi.mock("../../src/lib/session-config", () => ({
  getSessionConfig: () => ({
    userSessionTimeoutDays: 90,
    ssoSessionTimeoutDays: 7,
    dashboardSessionTimeoutHours: 24,
    refreshThresholdHours: 1,
    inactivityTimeoutMinutes: 60,
  }),
  calculateCookieMaxAge: () => 90 * 24 * 60 * 60,
}));

const SECRET_A = "secret-A-0123456789-0123456789-01"; // ≥32 chars
const SECRET_B = "secret-B-0123456789-0123456789-01";
const SECRET_C = "secret-C-0123456789-0123456789-01";
const SALT = "kdf-cache-test-salt-0123456789";

const sessionPayload: Session = {
  userId: "kdf-cache-user",
  email: "kdf@example.com",
  expiresAt: Date.now() + 3_600_000,
  dataRegion: "EU",
  profileContext: "primary",
};

const subtleProto = Object.getPrototypeOf(
  webcrypto.subtle,
) as typeof webcrypto.subtle;
const realDeriveKey = subtleProto.deriveKey;

/** Count only PBKDF2 derivations (AES-GCM ops never call deriveKey). */
function pbkdf2Calls(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter(
    (call) => (call[0] as { name?: string })?.name === "PBKDF2",
  ).length;
}

function requestWithCookie(token: string): Request {
  return new Request("https://api.example.com/api/anything", {
    method: "GET",
    headers: { Cookie: `trellis_session=${token}` },
  });
}

describe("SessionCookie module-scope KDF cache (AR9)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deriveKeySpy: any;

  beforeEach(() => {
    __clearSessionCookieCacheForTesting();
    deriveKeySpy = vi.spyOn(subtleProto, "deriveKey");
  });

  afterEach(() => {
    deriveKeySpy.mockRestore();
    __clearSessionCookieCacheForTesting();
  });

  /** Speed-only stub: real WebCrypto PBKDF2, fewer iterations. Keeps
   *  distinct secrets deriving distinct keys (so wrong-key/fallback
   *  semantics stay real) while making each derivation ~instant. */
  function useFastRealKdf(): void {
    deriveKeySpy.mockImplementation(function (
      this: typeof webcrypto.subtle,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      algorithm: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...rest: any[]
    ) {
      const alg =
        algorithm?.name === "PBKDF2"
          ? { ...algorithm, iterations: 1_000 }
          : algorithm;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return (realDeriveKey as unknown as (...a: unknown[]) => unknown).call(
        this,
        alg,
        ...rest,
      );
    });
  }

  it("runs the KDF once per distinct secret, not once per request, across fresh SessionManager instances", async () => {
    useFastRealKdf();

    // Login: seal a session cookie (fresh manager, as a route would).
    const encrypted = await new SessionManager().encryptSession(
      JSON.stringify(sessionPayload),
      SECRET_A,
      SALT,
    );
    expect(pbkdf2Calls(deriveKeySpy)).toBe(1);

    // 25 subsequent "requests", each with its own SessionManager —
    // exactly the per-request instantiation pattern of the route sites.
    for (let i = 0; i < 25; i++) {
      const manager = new SessionManager();
      const session = await manager.getSession(
        requestWithCookie(encrypted),
        SECRET_A,
        { SESSION_SALT: SALT },
      );
      expect(session?.userId).toBe(sessionPayload.userId);
    }

    // Still exactly ONE derivation for the (A, none, salt) triple.
    expect(pbkdf2Calls(deriveKeySpy)).toBe(1);
  });

  it("keeps rotation correct: fallback still decrypts after rotation, both keys cached, no stale key served", async () => {
    useFastRealKdf();

    // Phase 1 — pre-rotation: cookie sealed under SECRET_A as primary.
    const preRotationCookie = await new SessionManager().encryptSession(
      JSON.stringify(sessionPayload),
      SECRET_A,
      SALT,
    );
    expect(pbkdf2Calls(deriveKeySpy)).toBe(1); // A (encrypt triple)

    // Phase 2 — rotation: primary=B, fallback=A. The old cookie must
    // still decrypt via the fallback.
    const rotatedEnv = {
      SESSION_SALT: SALT,
      SESSION_SECRET_FALLBACK: SECRET_A,
    };
    const afterRotation = await new SessionManager().getSession(
      requestWithCookie(preRotationCookie),
      SECRET_B,
      rotatedEnv,
    );
    expect(afterRotation?.userId).toBe(sessionPayload.userId);
    // New triple (B, A, salt): primary B derived (+1) and, since the
    // primary can't open an A-sealed cookie, fallback A derived (+1).
    expect(pbkdf2Calls(deriveKeySpy)).toBe(3);

    // Repeated post-rotation requests re-use BOTH cached keys — zero
    // further derivations even though every request gets a fresh manager.
    for (let i = 0; i < 10; i++) {
      const session = await new SessionManager().getSession(
        requestWithCookie(preRotationCookie),
        SECRET_B,
        rotatedEnv,
      );
      expect(session?.userId).toBe(sessionPayload.userId);
    }
    expect(pbkdf2Calls(deriveKeySpy)).toBe(3);

    // New logins under the rotated primary also decrypt (primary path).
    const postRotationCookie = await new SessionManager().encryptSession(
      JSON.stringify(sessionPayload),
      SECRET_B,
      SALT,
    );
    const viaPrimary = await new SessionManager().getSession(
      requestWithCookie(postRotationCookie),
      SECRET_B,
      rotatedEnv,
    );
    expect(viaPrimary?.userId).toBe(sessionPayload.userId);

    // Stale-key safety: after a FURTHER rotation to primary=C with no
    // fallback, neither old cookie decrypts — the cache must not serve
    // a pre-rotation key for the post-rotation config.
    const underC = await new SessionManager().getSession(
      requestWithCookie(preRotationCookie),
      SECRET_C,
      { SESSION_SALT: SALT },
    );
    expect(underC).toBeNull();
    const underC2 = await new SessionManager().getSession(
      requestWithCookie(postRotationCookie),
      SECRET_C,
      { SESSION_SALT: SALT },
    );
    expect(underC2).toBeNull();
  });

  it("bounds the cache (FIFO eviction) and safely re-derives an evicted triple", async () => {
    useFastRealKdf();

    // Prime the cache with SECRET_A's triple.
    const cookieA = await new SessionManager().encryptSession(
      JSON.stringify(sessionPayload),
      SECRET_A,
      SALT,
    );
    expect(pbkdf2Calls(deriveKeySpy)).toBe(1);

    // Flood the cache with > MAX_CACHED_COOKIES (32) distinct triples,
    // evicting A's entry.
    for (let i = 0; i < 33; i++) {
      const secret = `flood-secret-${String(i).padStart(2, "0")}-0123456789-0123456789`;
      await new SessionManager().encryptSession(
        JSON.stringify(sessionPayload),
        secret,
        SALT,
      );
    }
    const callsAfterFlood = pbkdf2Calls(deriveKeySpy);
    expect(callsAfterFlood).toBe(34); // A + 33 flood secrets

    // A's triple was evicted → next use re-derives (correctness is
    // unaffected; only the derivation cost is re-paid once).
    const session = await new SessionManager().getSession(
      requestWithCookie(cookieA),
      SECRET_A,
      { SESSION_SALT: SALT },
    );
    expect(session?.userId).toBe(sessionPayload.userId);
    expect(pbkdf2Calls(deriveKeySpy)).toBe(callsAfterFlood + 1);
  });

  it("fails closed without a salt (cache path unchanged)", async () => {
    useFastRealKdf();
    await expect(
      new SessionManager().encryptSession(
        JSON.stringify(sessionPayload),
        SECRET_A,
        undefined,
      ),
    ).rejects.toThrow(/SESSION_SALT/);
    // decryptSession swallows the missing-salt error into null.
    const result = await new SessionManager().decryptSession(
      "whatever",
      SECRET_A,
      undefined,
    );
    expect(result).toBeNull();
    expect(pbkdf2Calls(deriveKeySpy)).toBe(0);
  });

  it(
    "benchmark: warm requests skip the 600k-iteration PBKDF2 (real KDF)",
    { timeout: 60_000 },
    async () => {
      // REAL derivation parameters — no stub in this test.
      const encrypted = await new SessionManager().encryptSession(
        JSON.stringify(sessionPayload),
        SECRET_A,
        SALT,
      );

      const timeGetSession = async (): Promise<number> => {
        const manager = new SessionManager(); // fresh, as per-request
        const start = performance.now();
        const session = await manager.getSession(
          requestWithCookie(encrypted),
          SECRET_A,
          { SESSION_SALT: SALT },
        );
        const elapsed = performance.now() - start;
        expect(session?.userId).toBe(sessionPayload.userId);
        return elapsed;
      };

      // OLD behaviour (per-request derivation): simulate by clearing
      // the module cache before every request — identical code path,
      // cold key every time.
      const coldSamples: number[] = [];
      for (let i = 0; i < 3; i++) {
        __clearSessionCookieCacheForTesting();
        coldSamples.push(await timeGetSession());
      }

      // NEW behaviour: cache warm after the first request.
      __clearSessionCookieCacheForTesting();
      await timeGetSession(); // warm-up (pays the one-time derivation)
      const warmSamples: number[] = [];
      for (let i = 0; i < 10; i++) {
        warmSamples.push(await timeGetSession());
      }

      const median = (xs: number[]): number =>
        [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const cold = median(coldSamples);
      const warm = median(warmSamples);
      // eslint-disable-next-line no-console
      console.log(
        `[AR9 benchmark] cold getSession (per-request KDF): ${cold.toFixed(1)}ms | ` +
          `warm getSession (cached key): ${warm.toFixed(2)}ms | ` +
          `speedup: ${(cold / warm).toFixed(0)}x`,
      );

      // The 600k-iteration PBKDF2 dominates the cold path; a warm call
      // must be at least 5x faster (in practice ~100x).
      expect(warm).toBeLessThan(cold / 5);
    },
  );
});
