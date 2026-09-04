/**
 * Third-party data-sharing consent semantics (partner-integration-readiness
 * lane A, task A.4).
 *
 * These are the tests for a record nothing writes yet, so they carry the whole
 * verification burden for the invariants: fail-closed activity, append-only
 * withdrawal that preserves the grant timestamp, the scope canonicalisation
 * that keeps two spellings of one permission set from becoming two grants, and
 * the guards that keep a profile out of a scope string.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  CLIENT_ID_PATTERN,
  RESERVED_UNGRANTABLE,
  SCOPE_PATTERN,
  THIRD_PARTY_DATA_SHARING,
  isGrantActive,
  nextRowForGrant,
  nextRowForWithdrawal,
  normalizeScopes,
  thirdPartySharingGrantSchema,
  type ConsentGrantRow,
} from "../../../src/lib/consent/third-party-grant.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const LATER = new Date("2026-09-11T12:00:00.000Z");
const EARLIER = new Date("2026-09-01T12:00:00.000Z");

/** A fully-granted, live sharing row. Every test narrows from this. */
function sharingRow(overrides: Partial<ConsentGrantRow> = {}): ConsentGrantRow {
  return {
    purpose: THIRD_PARTY_DATA_SHARING,
    consented: true,
    active: true,
    consentedAt: EARLIER,
    withdrawnAt: null,
    supersededAt: null,
    granteeClientId: "partner-agent-01",
    granteeIssuer: "https://issuer.example.com/realms/main",
    grantedScopes: ["dogs:share", "walks:read"],
    grantProfile: "boarding",
    subjectEntityId: "dog_abc123",
    expiresAt: LATER,
    ...overrides,
  };
}

function crossRegionRow(
  overrides: Partial<ConsentGrantRow> = {},
): ConsentGrantRow {
  return {
    purpose: "CROSS_REGION",
    consented: true,
    active: true,
    consentedAt: EARLIER,
    withdrawnAt: null,
    supersededAt: null,
    granteeClientId: null,
    granteeIssuer: null,
    grantedScopes: [],
    grantProfile: null,
    subjectEntityId: null,
    expiresAt: null,
    ...overrides,
  };
}

const validGrantInput = {
  granteeClientId: "partner-agent-01",
  granteeIssuer: "https://issuer.example.com/realms/main",
  grantedScopes: ["walks:read", "dogs:share"],
  grantProfile: "boarding",
  subjectEntityId: "dog_abc123",
  expiresAt: LATER,
};

describe("isGrantActive — sharing rows are fail-closed", () => {
  it("is true for a fully-formed, unexpired sharing grant", () => {
    expect(isGrantActive(sharingRow(), NOW)).toBe(true);
  });

  it("is FALSE for a sharing row with a NULL expiry, even when every other field says granted", () => {
    const row = sharingRow({ expiresAt: null });
    // Everything else is a live grant …
    expect(row.consented).toBe(true);
    expect(row.active).toBe(true);
    expect(row.withdrawnAt).toBeNull();
    expect(row.supersededAt).toBeNull();
    expect(row.granteeClientId).not.toBeNull();
    expect(row.granteeIssuer).not.toBeNull();
    expect(row.grantedScopes.length).toBeGreaterThan(0);
    // … and it is still inactive. A NULL expiry is a defect, not "indefinite".
    expect(isGrantActive(row, NOW)).toBe(false);
  });

  it("is TRUE for a CROSS_REGION row with a NULL expiry — today's behaviour is unaffected", () => {
    expect(isGrantActive(crossRegionRow(), NOW)).toBe(true);
  });

  it("preserves CROSS_REGION's withdrawal semantics", () => {
    expect(
      isGrantActive(crossRegionRow({ consented: false }), NOW),
    ).toBe(false);
    expect(
      isGrantActive(crossRegionRow({ withdrawnAt: EARLIER }), NOW),
    ).toBe(false);
  });

  it.each([
    ["active === false", { active: false } as Partial<ConsentGrantRow>],
    ["supersededAt !== null", { supersededAt: EARLIER }],
    ["grantedScopes is empty", { grantedScopes: [] }],
    ["consented === false", { consented: false }],
    ["withdrawnAt !== null", { withdrawnAt: EARLIER }],
    ["granteeClientId is NULL", { granteeClientId: null }],
    ["granteeIssuer is NULL", { granteeIssuer: null }],
    ["the expiry is in the past", { expiresAt: EARLIER }],
  ])("is false when %s, independently", (_label, overrides) => {
    expect(isGrantActive(sharingRow(overrides), NOW)).toBe(false);
  });

  it("expires strictly: a grant is inactive at the instant expiresAt is reached", () => {
    const row = sharingRow({ expiresAt: NOW });
    expect(isGrantActive(row, NOW)).toBe(false);
    expect(isGrantActive(row, new Date(NOW.getTime() - 1))).toBe(true);
  });

  it("does not confuse a Date instance with its timestamp", () => {
    // Distinct Date objects with equal time must compare by value.
    const row = sharingRow({ expiresAt: new Date(LATER.getTime()) });
    expect(isGrantActive(row, new Date(LATER.getTime()))).toBe(false);
  });
});

describe("nextRowForWithdrawal — append-only, consentedAt preserved", () => {
  it("appends a withdrawal row that carries the grant's consentedAt forward", () => {
    const prior = sharingRow({ consentedAt: EARLIER });
    const { next, supersede } = nextRowForWithdrawal(prior, NOW);

    expect(next.consented).toBe(false);
    expect(next.withdrawnAt).toEqual(NOW);
    expect(next.consentedAt).toEqual(EARLIER);
    expect(next.active).toBe(true);
    // The withdrawn row still says WHAT was withdrawn.
    expect(next.granteeClientId).toBe(prior.granteeClientId);
    expect(next.granteeIssuer).toBe(prior.granteeIssuer);
    expect(next.grantedScopes).toEqual(["dogs:share", "walks:read"]);
    expect(next.subjectEntityId).toBe(prior.subjectEntityId);
    expect(next.grantProfile).toBe(prior.grantProfile);
    expect(supersede).toEqual({ active: false, supersededAt: NOW });
  });

  it("leaves exactly one ACTIVE row per (userId, granteeClientId, subjectEntityId) — the withdrawal row", () => {
    // Simulate the transaction: supersede the prior row, insert the new one.
    const userId = "user_1";
    const prior = sharingRow();
    let rows: (ConsentGrantRow & { id: string; userId: string })[] = [
      { ...prior, id: "row_grant", userId },
    ];

    const { next, supersede } = nextRowForWithdrawal(prior, NOW);
    rows = rows.map((r) => (supersede ? { ...r, ...supersede } : r));
    rows.push({ ...next, id: "row_withdrawal", userId });

    const key = (r: (typeof rows)[number]) =>
      `${r.userId}|${r.granteeClientId}|${r.subjectEntityId}`;
    const activeForKey = rows.filter(
      (r) => r.active && key(r) === `${userId}|${prior.granteeClientId}|${prior.subjectEntityId}`,
    );

    expect(activeForKey).toHaveLength(1);
    expect(activeForKey[0]!.id).toBe("row_withdrawal");
    expect(activeForKey[0]!.consented).toBe(false);
    // The grant row is retained, not mutated away: history is reconstructable.
    expect(rows).toHaveLength(2);
    expect(rows[0]!.consentedAt).toEqual(EARLIER);
    expect(rows[0]!.supersededAt).toEqual(NOW);
    // And nothing is active by the predicate afterwards.
    expect(rows.some((r) => isGrantActive(r, NOW))).toBe(false);
  });

  it("refuses to build a withdrawal from a row with no grantee identity", () => {
    expect(() =>
      nextRowForWithdrawal(sharingRow({ granteeClientId: null }), NOW),
    ).toThrow(/grantee identity/);
  });
});

describe("nextRowForGrant — supersedes the prior active row", () => {
  it("supersedes an EXPIRED-but-active prior row (expiry is a predicate, not a state transition)", () => {
    const expiredPrior = sharingRow({ expiresAt: EARLIER });
    // The row is inactive by the predicate …
    expect(isGrantActive(expiredPrior, NOW)).toBe(false);
    // … but still `active = true` in the database, so it occupies the key.
    expect(expiredPrior.active).toBe(true);

    const parsed = thirdPartySharingGrantSchema.parse(validGrantInput);
    const { next, supersede } = nextRowForGrant(expiredPrior, parsed, NOW);

    expect(supersede).toEqual({ active: false, supersededAt: NOW });
    expect(next.consented).toBe(true);
    expect(next.consentedAt).toEqual(NOW);
    expect(next.withdrawnAt).toBeNull();
    expect(next.expiresAt).toEqual(LATER);
    expect(isGrantActive({ ...sharingRow(), ...next }, NOW)).toBe(true);
  });

  it("supersedes nothing when there is no prior row", () => {
    const parsed = thirdPartySharingGrantSchema.parse(validGrantInput);
    expect(nextRowForGrant(null, parsed, NOW).supersede).toBeNull();
  });

  it("supersedes nothing when the prior row is already inactive", () => {
    const parsed = thirdPartySharingGrantSchema.parse(validGrantInput);
    const inactive = sharingRow({ active: false, supersededAt: EARLIER });
    expect(nextRowForGrant(inactive, parsed, NOW).supersede).toBeNull();
  });

  it("stores an unbound subject as NULL, not undefined", () => {
    const parsed = thirdPartySharingGrantSchema.parse({
      ...validGrantInput,
      subjectEntityId: undefined,
      grantProfile: undefined,
    });
    const { next } = nextRowForGrant(null, parsed, NOW);
    expect(next.subjectEntityId).toBeNull();
    expect(next.grantProfile).toBeNull();
  });

  it("re-normalises scopes even for a hand-built input that bypassed the schema", () => {
    const { next } = nextRowForGrant(
      null,
      {
        ...validGrantInput,
        grantedScopes: ["walks:read", "dogs:share", "walks:read"],
      },
      NOW,
    );
    expect(next.grantedScopes).toEqual(["dogs:share", "walks:read"]);
  });
});

describe("scope canonicalisation", () => {
  it("normalizes two orderings of one permission set identically", () => {
    const a = thirdPartySharingGrantSchema.parse({
      ...validGrantInput,
      grantedScopes: ["walks:read", "dogs:share"],
    });
    const b = thirdPartySharingGrantSchema.parse({
      ...validGrantInput,
      grantedScopes: ["dogs:share", "walks:read"],
    });
    expect(a.grantedScopes).toEqual(b.grantedScopes);
    expect(a.grantedScopes).toEqual(["dogs:share", "walks:read"]);
  });

  it("de-duplicates", () => {
    expect(normalizeScopes(["dogs:share", "dogs:share", "walks:read"])).toEqual([
      "dogs:share",
      "walks:read",
    ]);
  });
});

describe("thirdPartySharingGrantSchema — the vocabulary guards", () => {
  it("accepts a well-formed grant", () => {
    expect(
      thirdPartySharingGrantSchema.safeParse(validGrantInput).success,
    ).toBe(true);
  });

  it("rejects a missing expiresAt", () => {
    const { expiresAt: _drop, ...withoutExpiry } = validGrantInput;
    expect(thirdPartySharingGrantSchema.safeParse(withoutExpiry).success).toBe(
      false,
    );
  });

  it.each([
    ["a bare wildcard", "*"],
    ["a wildcard verb", "dogs:*"],
    ["a dotted separator", "posts.write"],
    ["a third segment (a profile smuggled into a scope)", "dogs:share:boarding"],
    ["an uppercase segment", "Dogs:share"],
    ["a single segment", "dogs"],
    ["an empty string", ""],
  ])("rejects %s as a scope", (_label, scope) => {
    expect(
      thirdPartySharingGrantSchema.safeParse({
        ...validGrantInput,
        grantedScopes: [scope],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty scope array", () => {
    expect(
      thirdPartySharingGrantSchema.safeParse({
        ...validGrantInput,
        grantedScopes: [],
      }).success,
    ).toBe(false);
  });

  it('rejects ["dogs:share","health:read"] — health:read is reserved pending owner gate G2', () => {
    expect(RESERVED_UNGRANTABLE).toContain("health:read");
    expect(
      thirdPartySharingGrantSchema.safeParse({
        ...validGrantInput,
        grantedScopes: ["dogs:share", "health:read"],
      }).success,
    ).toBe(false);
  });

  it("rejects a scope string used as a client id", () => {
    expect(
      thirdPartySharingGrantSchema.safeParse({
        ...validGrantInput,
        granteeClientId: "dogs:share",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty issuer", () => {
    expect(
      thirdPartySharingGrantSchema.safeParse({
        ...validGrantInput,
        granteeIssuer: "",
      }).success,
    ).toBe(false);
  });

  it("rejects a non-URL issuer — a client id is issuer-scoped, so the issuer must be one", () => {
    expect(
      thirdPartySharingGrantSchema.safeParse({
        ...validGrantInput,
        granteeIssuer: "issuer.example.com",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty client id and an empty grantProfile/subjectEntityId", () => {
    for (const patch of [
      { granteeClientId: "" },
      { grantProfile: "" },
      { subjectEntityId: "" },
    ]) {
      expect(
        thirdPartySharingGrantSchema.safeParse({ ...validGrantInput, ...patch })
          .success,
      ).toBe(false);
    }
  });

  it("SCOPE_PATTERN forbids exactly what the reserved vocabulary needs it to", () => {
    expect(SCOPE_PATTERN.test("dogs:share")).toBe(true);
    expect(SCOPE_PATTERN.test("walks:read")).toBe(true);
    expect(SCOPE_PATTERN.test("dogs:share:boarding")).toBe(false);
    expect(CLIENT_ID_PATTERN.test("partner-agent-01")).toBe(true);
    expect(CLIENT_ID_PATTERN.test("-leading-hyphen")).toBe(false);
  });
});

/* ────────────────────────── properties ────────────────────────── */

const dateArb = fc
  .integer({ min: 0, max: 4_102_444_800_000 })
  .map((ms) => new Date(ms));

/** Arbitrary well-formed rows of either purpose, across every field's states. */
const rowArb: fc.Arbitrary<ConsentGrantRow> = fc.record({
  purpose: fc.constantFrom(
    THIRD_PARTY_DATA_SHARING,
    "CROSS_REGION",
    "RESEARCH_OBSERVATION",
  ),
  consented: fc.boolean(),
  active: fc.boolean(),
  consentedAt: fc.option(dateArb, { nil: null }),
  withdrawnAt: fc.option(dateArb, { nil: null }),
  supersededAt: fc.option(dateArb, { nil: null }),
  granteeClientId: fc.option(fc.constant("partner-agent-01"), { nil: null }),
  granteeIssuer: fc.option(fc.constant("https://issuer.example.com"), {
    nil: null,
  }),
  grantedScopes: fc.subarray(["dogs:share", "walks:read"]),
  grantProfile: fc.option(fc.constant("boarding"), { nil: null }),
  subjectEntityId: fc.option(fc.constant("dog_abc123"), { nil: null }),
  expiresAt: fc.option(dateArb, { nil: null }),
});

describe("isGrantActive — properties", () => {
  it("is monotone in `now`: once inactive by time, never active again", () => {
    // The property is vacuous unless the generator actually produces live
    // rows, so count the non-vacuous cases and assert the count afterwards.
    let live = 0;
    fc.assert(
      fc.property(rowArb, dateArb, dateArb, (row, t1, t2) => {
        const [earlier, later] =
          t1.getTime() <= t2.getTime() ? [t1, t2] : [t2, t1];
        // Activity is non-increasing in `now`: true at the later instant
        // implies true at the earlier one.
        if (isGrantActive(row, later)) {
          live += 1;
          expect(isGrantActive(row, earlier)).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
    expect(live).toBeGreaterThan(0);
  });

  it("is never true when active === false", () => {
    // Non-vacuous by construction: the same rows WITH active === true do
    // sometimes hold, so flipping the flag is what makes the difference.
    let liveWhenActive = 0;
    fc.assert(
      fc.property(rowArb, dateArb, (row, now) => {
        if (isGrantActive({ ...row, active: true }, now)) liveWhenActive += 1;
        expect(isGrantActive({ ...row, active: false }, now)).toBe(false);
      }),
      { numRuns: 2000 },
    );
    expect(liveWhenActive).toBeGreaterThan(0);
  });

  it("is never true for a sharing row with a NULL expiry", () => {
    // Non-vacuous: the SAME row read as CROSS_REGION is sometimes active, so
    // the purpose branch — not some other field — is doing the work.
    let liveAsCrossRegion = 0;
    fc.assert(
      fc.property(rowArb, dateArb, (row, now) => {
        if (isGrantActive({ ...row, purpose: "CROSS_REGION", expiresAt: null }, now)) {
          liveAsCrossRegion += 1;
        }
        expect(
          isGrantActive(
            { ...row, purpose: THIRD_PARTY_DATA_SHARING, expiresAt: null },
            now,
          ),
        ).toBe(false);
      }),
      { numRuns: 2000 },
    );
    expect(liveAsCrossRegion).toBeGreaterThan(0);
  });

  it("is never true when the decision is withdrawn or superseded", () => {
    fc.assert(
      fc.property(rowArb, dateArb, dateArb, (row, now, stamp) => {
        expect(isGrantActive({ ...row, withdrawnAt: stamp }, now)).toBe(false);
        expect(isGrantActive({ ...row, supersededAt: stamp }, now)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});

describe("normalizeScopes — properties", () => {
  const scopeArb = fc.constantFrom("dogs:share", "walks:read", "dogs:read");

  it("is idempotent and permutation-invariant", () => {
    fc.assert(
      fc.property(fc.array(scopeArb, { maxLength: 12 }), (scopes) => {
        const once = normalizeScopes(scopes);
        expect(normalizeScopes(once)).toEqual(once);
        expect(normalizeScopes([...scopes].reverse())).toEqual(once);
      }),
      { numRuns: 500 },
    );
  });

  it("preserves the set of scopes exactly", () => {
    fc.assert(
      fc.property(fc.array(scopeArb, { maxLength: 12 }), (scopes) => {
        expect(new Set(normalizeScopes(scopes))).toEqual(new Set(scopes));
      }),
      { numRuns: 500 },
    );
  });
});

describe("nextRowForWithdrawal — property: consentedAt is never destroyed", () => {
  it("carries the prior consentedAt forward for every prior row shape", () => {
    fc.assert(
      fc.property(rowArb, dateArb, (row, now) => {
        const prior: ConsentGrantRow = {
          ...row,
          granteeClientId: "partner-agent-01",
          granteeIssuer: "https://issuer.example.com",
        };
        const { next } = nextRowForWithdrawal(prior, now);
        expect(next.consentedAt).toEqual(prior.consentedAt);
        expect(next.consented).toBe(false);
        expect(next.withdrawnAt).toEqual(now);
        expect(isGrantActive(next as unknown as ConsentGrantRow, now)).toBe(
          false,
        );
      }),
      { numRuns: 500 },
    );
  });
});
