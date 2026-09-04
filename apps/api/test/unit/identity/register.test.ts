/**
 * POST /auth/register tests.
 *
 * Load-bearing properties, in rough order of how much damage getting them wrong
 * would do:
 *
 *  - the signup ATTRIBUTES reach the provider. They are what the application
 *    provisions its invite gate and age tier from on first sign-in, and dropping
 *    them does not fail — it produces an un-gated adult account;
 *  - the invitation gate runs BEFORE the user is created, so a rejected
 *    registration leaves nothing behind that could later receive a sign-in link;
 *  - an already-registered email is indistinguishable from a fresh one
 *    (C-13/F10) and is never rewritten;
 *  - the address is NOT created pre-verified — the magic link proves it;
 *  - a provider without `registerUser` (Cognito) says so rather than silently
 *    doing nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IdentityProviderPort } from "@de-otio/saas-foundation/identity";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";

import type { Env } from "../../../src/env.js";
import {
  handleRegister,
  parseDateOfBirth,
  __setInvitationStoreForTest,
} from "../../../src/lib/identity/register.js";
import { __setIdentityProviderForTest } from "../../../src/lib/identity/identity-provider.js";
import { RateLimiter, __resetRateLimiterForTests } from "../../../src/lib/rate-limit.js";

const NOW = Date.parse("2026-08-07T12:00:00.000Z");
const now = () => NOW;

function makeEnv(): Env {
  return { APP_DOMAIN: "app.example.test" } as unknown as Env;
}

function makeRequest(body: unknown): Request {
  return new Request("https://api.example.test/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type RegisterCall = Parameters<NonNullable<IdentityProviderPort["registerUser"]>>[0];

function provider(result: "created" | "exists" = "created"): {
  port: IdentityProviderPort;
  calls: RegisterCall[];
} {
  const calls: RegisterCall[] = [];
  return {
    calls,
    port: {
      initiateMagicLink: async () => ({ userId: "u-1", emailSent: true }),
      deleteUser: async () => {},
      registerUser: async (input) => {
        calls.push(input);
        return result;
      },
    },
  };
}

const VALID = {
  email: "newcomer@example.test",
  dateOfBirth: "2000-01-01",
  invitationCode: "INVITE1",
};

let store: MemoryKvStore;

beforeEach(async () => {
  process.env.IDENTITY_PROVIDER = "keycloak";
  store = new MemoryKvStore();
  await store.put("INVITE1", {});
  __setInvitationStoreForTest(store);
  __resetRateLimiterForTests();
});

afterEach(() => {
  delete process.env.IDENTITY_PROVIDER;
  __setInvitationStoreForTest(null);
  __setIdentityProviderForTest(null);
  __resetRateLimiterForTests();
  vi.restoreAllMocks();
});

async function post(body: unknown, p?: IdentityProviderPort): Promise<Response> {
  if (p) __setIdentityProviderForTest(p);
  return handleRegister(makeRequest(body), makeEnv(), new RateLimiter(), {}, now);
}

describe("handleRegister", () => {
  it("creates the user carrying every signup attribute", async () => {
    const { port, calls } = provider();

    const res = await post(
      { ...VALID, guardianEmail: "Parent@Example.test", handle: "newcomer" },
      port,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "registered" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.email).toBe("newcomer@example.test");
    expect(calls[0]!.attributes).toEqual({
      invitationCode: ["INVITE1"],
      dateOfBirth: ["2000-01-01"],
      guardianEmail: ["parent@example.test"],
      handle: ["newcomer"],
      signupMethod: ["MAGIC_LINK"],
    });
  });

  it("does not create the address pre-verified", async () => {
    // Registration has not proven the address; the magic link does. Creating it
    // verified would let someone register an address they do not control.
    const { port, calls } = provider();
    await post(VALID, port);
    expect(calls[0]!.emailVerified).toBeUndefined();
  });

  it("rejects an unknown invitation code WITHOUT creating a user", async () => {
    const { port, calls } = provider();

    const res = await post({ ...VALID, invitationCode: "NOPE" }, port);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/invalid or expired/i);
    // The ordering property: nothing was created, so nothing is left behind
    // that could later be sent a sign-in link.
    expect(calls).toHaveLength(0);
  });

  it("rejects a used invitation code", async () => {
    await store.put("USED", { used: true });
    const { port, calls } = provider();

    const res = await post({ ...VALID, invitationCode: "USED" }, port);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/already been used/i);
    expect(calls).toHaveLength(0);
  });

  it("requires an invitation code at all (fail closed)", async () => {
    const { port, calls } = provider();
    const res = await post({ email: VALID.email, dateOfBirth: VALID.dateOfBirth }, port);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("is indistinguishable for an already-registered email", async () => {
    // C-13/F10. Byte-identical to the fresh-registration response.
    const fresh = await post(VALID, provider("created").port);
    __resetRateLimiterForTests();
    const existing = await post(VALID, provider("exists").port);

    expect(existing.status).toBe(fresh.status);
    expect(await existing.json()).toEqual(await fresh.json());
  });

  it("returns 501 when the provider has no registerUser (Cognito)", async () => {
    const res = await post(VALID, {
      initiateMagicLink: async () => ({ userId: "u", emailSent: true }),
      deleteUser: async () => {},
    });

    expect(res.status).toBe(501);
    // Explicit, not a 404 — a client hitting this on Cognito is misconfigured,
    // and a quiet success would look like a registration that did nothing.
    expect((await res.json()).error).toMatch(/not handled by this API/i);
  });

  describe("input validation", () => {
    it.each([
      ["missing email", { dateOfBirth: "2000-01-01", invitationCode: "INVITE1" }],
      ["malformed email", { ...VALID, email: "not-an-email" }],
    ])("rejects %s", async (_label, body) => {
      const { port, calls } = provider();
      const res = await post(body, port);
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it.each([
      ["missing", undefined],
      ["not a date", "yesterday"],
      ["wrong format", "01/01/2000"],
      ["in the future", "2030-01-01"],
      ["absurdly old", "1800-01-01"],
      ["a day that does not exist", "2025-02-31"],
    ])("rejects a date of birth that is %s", async (_label, dob) => {
      const { port, calls } = provider();
      const res = await post({ ...VALID, dateOfBirth: dob }, port);
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    // ── Minimum-age floor (18+) ──────────────────────────────────────────
    //
    // The client refuses an under-18 date of birth before it reaches here.
    // This is a public HTTP endpoint, so the floor is re-applied server-side
    // (`src/lib/age-gate.ts`). NOW is pinned at 2026-08-07.
    it.each([
      ["a child", "2016-01-01"],
      ["a teenager", "2010-01-01"],
      ["one day short of 18", "2008-08-08"],
    ])("refuses %s with a 403 and the structured envelope", async (_label, dob) => {
      const { port, calls } = provider();
      const res = await post({ ...VALID, dateOfBirth: dob }, port);

      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, string>;
      expect(body.error).toBe("AGE_REQUIREMENT_NOT_MET");
      expect(body.message).toContain("18");
      expect(body.remediation.length).toBeGreaterThan(0);
      expect(body.field).toBe("dateOfBirth");

      // Fail closed: no realm user, so no account a sign-in link could reach.
      expect(calls).toHaveLength(0);
    });

    it("admits someone on their 18th birthday", async () => {
      const { port, calls } = provider();
      // NOW is 2026-08-07; this is exactly 18 years earlier.
      const res = await post({ ...VALID, dateOfBirth: "2008-08-07" }, port);

      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
    });

    it("checks age before burning the invitation gate", async () => {
      // An under-age attempt must not consume or even consult the invitation:
      // ordering the checks the other way would let a mistyped birth year
      // spend somebody's code.
      const { port, calls } = provider();
      const res = await post(
        { ...VALID, dateOfBirth: "2016-01-01", invitationCode: "NO-SUCH-CODE" },
        port,
      );

      // 403 AGE_REQUIREMENT_NOT_MET, not the invitation gate's 403.
      expect(res.status).toBe(403);
      expect(((await res.json()) as Record<string, string>).error).toBe(
        "AGE_REQUIREMENT_NOT_MET",
      );
      expect(calls).toHaveLength(0);
    });

    it("rejects a malformed guardian email", async () => {
      const { port, calls } = provider();
      const res = await post({ ...VALID, guardianEmail: "nope" }, port);
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("rejects a non-JSON body", async () => {
      __setIdentityProviderForTest(provider().port);
      const res = await handleRegister(
        new Request("https://api.example.test/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
        makeEnv(),
        new RateLimiter(),
        {},
        now,
      );
      expect(res.status).toBe(400);
    });
  });

  it("rate-limits per email and 429s over the cap", async () => {
    const { port } = provider();
    __setIdentityProviderForTest(port);

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (await handleRegister(makeRequest(VALID), makeEnv(), new RateLimiter(), {}, now))
          .status,
      );
    }

    // Its own bucket (3/900s), deliberately smaller than the sign-in budget and
    // separate from it, so registration attempts cannot lock a legitimate user
    // out of signing in.
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });
});

describe("parseDateOfBirth", () => {
  const today = new Date(NOW);

  it("accepts a plain ISO calendar date", () => {
    expect(parseDateOfBirth("2000-02-29", today)?.toISOString()).toBe(
      "2000-02-29T00:00:00.000Z",
    );
  });

  it.each(["2025-02-31", "2000-13-01", "2000-1-1", "20000101", "", "2000-01-01T00:00:00Z"])(
    "rejects %s",
    (raw) => {
      expect(parseDateOfBirth(raw, today)).toBeUndefined();
    },
  );

  it("rejects the future", () => {
    // A future DOB computes as the most restricted age tier, which would lock a
    // real user out of the product rather than erroring.
    expect(parseDateOfBirth("2026-08-08", today)).toBeUndefined();
    expect(parseDateOfBirth("2027-01-01", today)).toBeUndefined();
  });

  it("accepts today's date, which is not the future", () => {
    // Midnight today is strictly before "now" on any later clock reading, and
    // matches provision-confirmed-user.ts's own `parsed < new Date()` rule. A
    // birth today is implausible but not invalid, and the age gate — not this
    // parser — is what makes it safe (CHILD tier, guardian required).
    expect(parseDateOfBirth("2026-08-07", today)).toBeDefined();
  });
});
