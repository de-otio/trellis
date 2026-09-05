/**
 * Third-party data-sharing consent — the pure semantics.
 *
 * A `Consent` row with `purpose = THIRD_PARTY_DATA_SHARING` records that a USER
 * permitted a named external client (an external partner agent) to read one of
 * their resources. The row is the GDPR Art. 7 lawful-basis evidence for that
 * disclosure, so the history is append-only exactly as it is for `CROSS_REGION`:
 * a grant and a withdrawal are each a NEW row, `active` / `supersededAt`
 * discriminate history, and a withdrawal row carries `consented = false` +
 * `withdrawnAt` while PRESERVING the grant's `consentedAt`.
 *
 * This module is a functional core: no I/O, no Prisma import beyond types, and
 * `now` is always a parameter — never `Date.now()` inside — so every predicate
 * here is a total function of its inputs and testable at any instant.
 *
 * NOTHING IN THIS REPOSITORY CALLS IT YET, by design. The record shape and its
 * semantics are what is expensive to retrofit; the enforcement is not. There is
 * no route, no middleware and no authorization check for a sharing grant.
 *
 * The shape invariant these functions assume is ALSO enforced at the database
 * by `consent_third_party_sharing_shape_check`
 * (`prisma/migrations/20260904130100_consent_third_party_columns_and_key`), so
 * a row that reaches this module by some path that skipped the Zod boundary
 * still cannot be malformed.
 */

import { z } from "zod";

/**
 * Scope strings are `<resource>:<verb>`: lowercase, EXACTLY two segments.
 *
 * No `*` and no third segment. A third segment is how a release profile would
 * smuggle itself into a scope string (`dogs:share:boarding`); the profile is a
 * grant column (`grantProfile`) instead, so adding one later is not a new scope
 * string every existing client has to re-request (owner gate G2.3).
 */
export const SCOPE_PATTERN = /^[a-z][a-z0-9_-]{1,31}:[a-z][a-z0-9_-]{1,31}$/;

/**
 * Scopes that may never appear in a sharing grant until an owner decision says
 * otherwise (owner gate G2). `health:read` is continuous read access to the
 * underlying health record — a different ask, with a different weight, from
 * releasing a bounded passport document under `dogs:share`. The temptation at
 * integration time is to bundle them into one authorization request because it
 * is one fewer screen; until G2 answers, the Zod schema below REJECTS a grant
 * containing one of these.
 */
export const RESERVED_UNGRANTABLE = ["health:read"] as const;

/**
 * Canonical scope-array form: de-duplicated and sorted ascending.
 *
 * This is what makes `consent_third_party_sharing_key` correct in spirit even
 * though the array is deliberately NOT part of that key: two spellings of the
 * same permission set (`["walks:read","dogs:share"]` and
 * `["dogs:share","walks:read"]`) must be ONE stored value, so a re-grant that
 * only reorders the array is recognisably the same grant rather than a
 * different one. Applied by `thirdPartySharingGrantSchema`'s transform.
 */
export function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort();
}

/** Shape of a client id, as it arrives in a verified `client_id`/`azp` claim. */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/;

/**
 * The validated shape of a sharing grant.
 *
 * NEITHER `granteeClientId` NOR `granteeIssuer` IS EVER TAKEN FROM A REQUEST
 * BODY. Both are populated only from the VERIFIED `client_id`/`azp` and `iss`
 * claims of the token presented in the authorization flow that creates the row;
 * they are validated here because the row must not be written with a malformed
 * claim, not because a caller may supply them. A future route that reads either
 * from user-supplied JSON has misunderstood the record. A client id is
 * issuer-scoped — two clients spelled the same at two issuers are different
 * principals — which is why the issuer is mandatory here and by CHECK, even
 * though the column is nullable for the other purposes' sake.
 */
export const thirdPartySharingGrantSchema = z.object({
  granteeClientId: z.string().regex(CLIENT_ID_PATTERN),
  granteeIssuer: z.string().url(),
  grantedScopes: z
    .array(z.string().regex(SCOPE_PATTERN))
    .min(1)
    .refine(
      (scopes) =>
        !scopes.some((s) =>
          (RESERVED_UNGRANTABLE as readonly string[]).includes(s),
        ),
      { message: "scope is reserved and cannot be granted (owner gate G2)" },
    )
    // Canonicalise: de-duplicate + sort. See normalizeScopes — two orderings of
    // the same permission set must be one stored value.
    .transform((scopes) => normalizeScopes(scopes)),
  /** Which passport profile this grant releases. A column, never a scope segment. */
  grantProfile: z.string().min(1).optional(),
  /** The single resource released. Absent means "every resource this user owns". */
  subjectEntityId: z.string().min(1).optional(),
  /**
   * REQUIRED at this boundary even though the column is nullable — the column
   * is nullable only because the other consent purposes share it, and the
   * database CHECK makes it mandatory for sharing rows regardless. An
   * indefinite sharing grant is precisely what this design rules out.
   */
  expiresAt: z.date(),
});

export type ThirdPartySharingGrantInput = z.infer<
  typeof thirdPartySharingGrantSchema
>;

/**
 * The subset of a `Consent` row this module's predicates read.
 *
 * Structurally compatible with Prisma's generated `Consent` type; declared
 * locally so the functional core does not depend on a generated client.
 */
export interface ConsentGrantRow {
  readonly purpose: string;
  readonly consented: boolean;
  readonly active: boolean;
  readonly consentedAt: Date | null;
  readonly withdrawnAt: Date | null;
  readonly supersededAt: Date | null;
  readonly granteeClientId: string | null;
  readonly granteeIssuer: string | null;
  readonly grantedScopes: readonly string[];
  readonly grantProfile: string | null;
  readonly subjectEntityId: string | null;
  readonly expiresAt: Date | null;
}

export const THIRD_PARTY_DATA_SHARING = "THIRD_PARTY_DATA_SHARING";

/**
 * Is this consent row a live authority, at instant `now`?
 *
 * FAIL-CLOSED, and purpose-aware. For a sharing row every one of these must
 * hold — a NULL `expiresAt` on a sharing row is a DEFECT, never "indefinite",
 * because an indefinite sharing grant is the eternal disclosure this design
 * exists to rule out:
 *
 *   consented && active && withdrawnAt === null && supersededAt === null
 *     && granteeClientId !== null && granteeIssuer !== null
 *     && grantedScopes.length > 0
 *     && expiresAt !== null && expiresAt > now
 *
 * For every other purpose the expiry term degrades to
 * `expiresAt === null || expiresAt > now`, which preserves today's
 * `CROSS_REGION` behaviour (`data-router.ts`'s
 * `consented === true && withdrawnAt === null` on the single `active` row)
 * exactly — those rows have no expiry concept and must not acquire one.
 *
 * Note the boundary: expiry is STRICT (`expiresAt > now`), so a grant is
 * inactive at the instant it expires, not one tick later.
 */
export function isGrantActive(row: ConsentGrantRow, now: Date): boolean {
  const liveDecision =
    row.consented === true &&
    row.active === true &&
    row.withdrawnAt === null &&
    row.supersededAt === null;

  if (!liveDecision) return false;

  if (row.purpose !== THIRD_PARTY_DATA_SHARING) {
    // Non-sharing purposes: no expiry concept today. A NULL expiry means the
    // decision stands, which is what CROSS_REGION has always meant.
    return row.expiresAt === null || row.expiresAt.getTime() > now.getTime();
  }

  return (
    row.granteeClientId !== null &&
    row.granteeIssuer !== null &&
    row.grantedScopes.length > 0 &&
    row.expiresAt !== null &&
    row.expiresAt.getTime() > now.getTime()
  );
}

/** The field values of a new `Consent` row, ready to hand to a `create`. */
export interface NextConsentRow {
  readonly purpose: typeof THIRD_PARTY_DATA_SHARING;
  readonly consented: boolean;
  readonly consentedAt: Date | null;
  readonly withdrawnAt: Date | null;
  readonly active: true;
  readonly granteeClientId: string;
  readonly granteeIssuer: string;
  readonly grantedScopes: string[];
  readonly grantProfile: string | null;
  readonly subjectEntityId: string | null;
  readonly expiresAt: Date | null;
}

/** How an existing `active` row must be updated when a new row supersedes it. */
export interface SupersedePriorRow {
  readonly active: false;
  readonly supersededAt: Date;
}

/** A new row plus the supersession, if any, that must accompany it. */
export interface ConsentTransition {
  readonly next: NextConsentRow;
  /** `null` when there was no prior `active` row to supersede. */
  readonly supersede: SupersedePriorRow | null;
}

/**
 * Withdrawal: a NEW row, never a mutation of the grant.
 *
 * The withdrawal row carries `consented = false` and `withdrawnAt = now`, and
 * CARRIES THE GRANT'S `consentedAt` FORWARD — nulling it would destroy the only
 * record of when the disclosure was authorised, which is the evidence the row
 * exists to hold. The grantee identity, scopes, profile, subject and expiry are
 * copied verbatim so the withdrawn row still says WHAT was withdrawn.
 *
 * The prior row is superseded in the same transaction, which is what keeps the
 * partial unique key (`user_id`, `grantee_client_id`, `subject_entity_id`)
 * satisfiable: afterwards exactly one row for that triple is `active`, and it is
 * the withdrawal row.
 */
export function nextRowForWithdrawal(
  prior: ConsentGrantRow,
  now: Date,
): ConsentTransition {
  if (prior.granteeClientId === null || prior.granteeIssuer === null) {
    throw new Error(
      "nextRowForWithdrawal: prior sharing row has no grantee identity",
    );
  }

  return {
    next: {
      purpose: THIRD_PARTY_DATA_SHARING,
      consented: false,
      // Preserve the grant's timestamp. Never null it.
      consentedAt: prior.consentedAt,
      withdrawnAt: now,
      active: true,
      granteeClientId: prior.granteeClientId,
      granteeIssuer: prior.granteeIssuer,
      grantedScopes: normalizeScopes(prior.grantedScopes),
      grantProfile: prior.grantProfile,
      subjectEntityId: prior.subjectEntityId,
      expiresAt: prior.expiresAt,
    },
    supersede: prior.active ? { active: false, supersededAt: now } : null,
  };
}

/**
 * Grant (or re-grant): a NEW row, superseding whatever `active` row exists for
 * the same (user, grantee client, subject) triple.
 *
 * WHY THE SUPERSESSION IS NOT LEFT TO THE CALL SITE: an EXPIRED sharing row
 * still has `active = true`. Nothing sweeps it — expiry is a predicate, not a
 * state transition — so a re-grant that does not supersede the prior row hits
 * `consent_third_party_sharing_key` and fails at the database. That is the
 * failure mode a future writer would otherwise discover in production, so it is
 * encoded here rather than remembered there.
 *
 * A fresh `consentedAt` is stamped: this is a new authorisation, not a
 * continuation of the old one.
 */
export function nextRowForGrant(
  prior: ConsentGrantRow | null,
  input: ThirdPartySharingGrantInput,
  now: Date,
): ConsentTransition {
  return {
    next: {
      purpose: THIRD_PARTY_DATA_SHARING,
      consented: true,
      consentedAt: now,
      withdrawnAt: null,
      active: true,
      granteeClientId: input.granteeClientId,
      granteeIssuer: input.granteeIssuer,
      // Already canonical if it came through the schema; normalise again so a
      // hand-built input cannot store an uncanonical array.
      grantedScopes: normalizeScopes(input.grantedScopes),
      grantProfile: input.grantProfile ?? null,
      subjectEntityId: input.subjectEntityId ?? null,
      expiresAt: input.expiresAt,
    },
    supersede:
      prior !== null && prior.active ? { active: false, supersededAt: now } : null,
  };
}
