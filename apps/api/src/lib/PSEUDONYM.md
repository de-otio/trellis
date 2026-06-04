# Research pseudonym (`User.anonymousId`) — design + caveats

Foundations for research/cohort analytics. **Separation-based
pseudonymisation only.** This is a one-way-door foundation: changing the base
formula or the domain-separation prefix re-keys every pseudonym, so the design
is fixed here deliberately. Implemented in `lib/pseudonym.ts`; populated at
account creation in `lambda/post-confirmation.ts`.

## Base formula + domain separation

```
anonymousId = base64( HMAC-SHA256( key, "trellis.user.pseudonym:" + user.id ) )
```

- **Input is `user.id` only** — the immutable cuid primary key. We **never**
  hash PII (`email`, `cognitoSub`, `handle`). PII is mutable and
  dictionary-reversible; the PK is stable and opaque.
- **Domain separation:** the constant prefix `trellis.user.pseudonym:` scopes
  the MAC. If the same KMS key is ever reused for another MAC purpose, the
  output spaces cannot collide. Changing the prefix is equivalent to a key
  rotation (see below).
- Output is base64 of the raw 32-byte MAC.

## Key management — KMS `GenerateMac`

The HMAC key is a **KMS HMAC key (`HMAC_SHA_256`)** referenced by
`PSEUDONYM_HMAC_KMS_KEY_ID` (env). We call KMS `GenerateMac`:

- Key material lives in a **FIPS 140-2/3 HSM** and **never leaves KMS** — the
  derivation process never holds the key.
- Access is IAM-gated and CloudTrail-audited per call.

**Fail-safe:** if `PSEUDONYM_HMAC_KMS_KEY_ID` is unset, `computeAnonymousId`
**throws**. The account-creation caller catches and **skips** population. We do
**not** fall back to an unkeyed `SHA-256(user.id)` — that would be recomputable
by anyone who learns the (semi-public) cuid, defeating the pseudonym.

> **SSM SecureString is a documented fallback only.** If a deployment cannot
> use a KMS HMAC key, an SSM SecureString holding raw HMAC key bytes + local
> `node:crypto` HMAC is the *documented* alternative — but it is **not** the
> default and is **not** implemented here. It trades the HSM guarantee for
> at-rest KMS encryption of the SSM parameter; only adopt it with explicit
> sign-off.

## Rotation protocol (stub)

**KMS HMAC keys do NOT auto-rotate.** Rotation is therefore a deliberate,
expensive operation:

1. Provision a new KMS HMAC key; expose it as `PSEUDONYM_HMAC_KMS_KEY_ID_NEXT`.
2. **Re-derive** `anonymousId` for **every** user under the new key (the input
   is `user.id`, which is stable, so this is a full-table recompute).
3. **Re-key / re-seal every research dataset** that referenced the old
   `anonymousId` (datasets keyed on the pseudonym are invalidated by rotation).
4. Cut over `PSEUDONYM_HMAC_KMS_KEY_ID` to the new key; retire the old key only
   after all datasets are migrated.

There is no in-place, zero-downtime rotation — pseudonyms keyed on the old key
are not derivable from those keyed on the new key. Treat rotation as a planned
migration, not a routine credential rotation.

## What this is NOT — security boundary

`anonymousId` is **separation-based pseudonymisation**, **not a row-level
access control.** The PK (`user.id`) and the pseudonym (`anonymousId`) sit in
the **same `users` row**. Anyone with read access to `users` can join the
pseudonym back to the identified user. The pseudonym's value is for **exported
/ downstream research datasets** that carry only `anonymousId` (not `user.id`),
so a leak of *that dataset* does not directly re-identify users.

## Future: per-study re-keying

For per-study unlinkability, derive a study-scoped pseudonym from the base:

```
study_pseudonym = HMAC( study_key, anonymousId )
```

A separate `study_key` per study means a leak of one study's dataset cannot be
cross-linked to another study's. (Not implemented yet — recorded here so the
base formula stays compatible with it.)

## No-backfill population bias (accepted, pre-launch)

`anonymousId` is populated **only at account creation**, with **no backfill**
of pre-existing rows. Pre-launch this is acceptable — there is no meaningful
production user base — but any cohort built before a future backfill would be
**biased toward post-launch accounts**. Record this caveat in any analysis that
predates a backfill.

---

## Tracked risk — `email_hash` is an unkeyed PII hash (FLAGGED, not fixed)

`lib/email-privacy.ts` computes `User.emailHash = SHA-256(lower(trim(email)))`
— an **unkeyed** hash of PII. Email address spaces are small and structured, so
this is **dictionary-/rainbow-reversible**: an attacker with the hash column can
recover most emails by hashing candidate addresses.

**TODO (tracked):** re-key `emailHash` with a KMS MAC (same `GenerateMac` path
as the pseudonym, with its own domain-separation prefix
`trellis.user.email_hash:`) **or** deprecate the column if the
privacy-preserving-lookup use case no longer needs it. Do **not** copy the
unkeyed `email-privacy.ts` pattern for new code. Out of scope for this
foundations change; flagged for a follow-up.

---

## Related: `User.ageVerified` — fail-CLOSED research age signal

`User.ageVerified Boolean @default(false)` is the **only** signal a research /
cohort query may use to decide age-based inclusion. **`ageTier` must never be
used as an includability signal.**

**Known, accepted product-side fail-OPEN:** `ageTier @default(ADULT)` and the
age-gate middleware's `?? "ADULT"` fallback mean an unverified user is treated
as an **adult** for product feature-access. This is a deliberate,
**accepted** minor-safety fail-open with COPPA / UK AADC / DSA implications,
owned on the product side and **left unchanged** by this foundations work. The
research path sidesteps it by gating on `ageVerified = true` (fail-closed):
unverified users — defaulting to `ageTier = ADULT` — are **excluded** from
adult research cohorts until explicitly verified.
