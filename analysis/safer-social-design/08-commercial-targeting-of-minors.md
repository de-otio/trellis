# Commercial Targeting of Minors

Addresses the principle (UN OHCHR, 29 May 2026; see
[07](07-safe-by-design-and-governance.md)) that **children should not be
targeted by companies or other users for commercial activity** — and audits
what in the Trellis codebase actually prevents that today.

The headline distinction: Trellis's protection is largely **emergent** (it
prevents commercial targeting by *omission* — no ad/commerce engine exists),
reinforced by **explicit privacy locks** on CHILD accounts. There is no named,
enforced "no commercial solicitation of minors" rule. That distinction matters
for compliance and for any future feature work.

## Verified findings (as of this audit)

All claims below were checked against the code, not inferred from the earlier
analysis files (which predate the age-tier implementation and incorrectly state
there is "no age verification at all").

### 1. No commercial-targeting surface exists at all

A grep of the entire API source tree and the Prisma schema for
`advertis | sponsor | promoted | ad targeting | ad campaign | ad network |
marketplace | monetiz` returns **no matches**. There is:

- No Ad / Sponsorship / Promotion / Marketplace / Commerce model in
  `prisma/schema.prisma`.
- No ad-serving, ad-targeting, or promoted-content routes or handlers.
- No behavioral targeting. The feed is chronological; personalization is
  taxonomy-based (interest tags such as breed / life-stage), not
  engagement-profiling.

**This is the strongest protection: the most common vector for companies
targeting children — ad targeting — has no surface on which to exist.** It is a
true preventive property, but it is a property of *absence*, not an enforced
rule (see Gaps).

### 2. CHILD-tier accounts (under 13) are hard-locked

`apps/api/src/lib/privacy-defaults.ts` defines per-age-tier defaults and a
`LOCKED_FIELDS` table. For `CHILD`, the following are **locked** (cannot be
overridden to a less restrictive value by the user *or* guardian):

| Setting | CHILD value | Locked? |
|---|---|---|
| `dmAccess` | `NOBODY` | **locked** |
| `analyticsOptOut` | `true` | **locked** |
| `locationTrackingEnabled` | `false` | **locked** |
| `locationAnonymizationLevel` | `3` (max) | **locked** |
| `profileVisibility` | `PRIVATE` | default (not in lock table) |

Effect: a child cannot be contacted, cannot be discovered in search, and is not
fed into analytics. This blocks the "other users / commercial DM" vector for the
youngest tier.

### 3. No exemption for business / organization accounts

`B2B_PARTNER` and `ORGANIZATION` accounts pass through the **same** DM gate as
any sender — `apps/api/src/lib/routes/activitypub/messages.ts` (the
`dmAccess` enforcement block). A recipient with `dmAccess: "NOBODY"` rejects all
senders with HTTP 403 regardless of role. There is no business-account bypass.

### 4. TEEN tier (13–17) is softer — and not locked

`TEEN` defaults to `dmAccess: "CONNECTIONS"` and
`profileVisibility: "CONNECTIONS"`, but `LOCKED_FIELDS.TEEN` is **empty** — so a
teen can loosen these (e.g. to `dmAccess: "ANYONE"`, `profileVisibility:
"PUBLIC"`). The under-13 guarantees do **not** extend to teens.

## Gaps — what does NOT prevent commercial targeting

1. **Age is self-declared, unverified.** `dateOfBirth → ageTier` is computed at
   registration with no verification
   (`apps/api/src/lib/age-tier-transition.ts`,
   `apps/api/src/lambda/post-confirmation.ts`). A child who enters an adult date
   of birth receives `ADULT` defaults and **none** of the CHILD locks. The
   protection is only as strong as the declared age. (Consistent with the
   privacy-preserving stance in [07](07-safe-by-design-and-governance.md), but
   it caps the assurance level.)

2. **The CONNECTIONS DM check is stubbed.** In `messages.ts` the mutual-follow
   lookup for `dmAccess: "CONNECTIONS"` currently `return false` with a
   `TODO: redesign - use GraphService`. Today this **fails closed** (no one can
   DM a CONNECTIONS-tier user at all), so it is over-restrictive rather than a
   hole — but the real mutual-follow gate that will govern teen/adult commercial
   DMs **is not implemented yet**. When wired up, it becomes load-bearing.

3. **No explicit "no commercial solicitation of minors" rule.** The protection
   is emergent (no ad system) plus per-tier privacy locks — not a named,
   enforced commercial-contact prohibition. Nothing in the schema flags "this
   feature must exclude minors." **If an ad, marketplace, promoted-content, or
   lead-gen feature is ever added, there is no guardrail that would
   automatically exclude minor accounts** — it would have to be remembered and
   built in. This is the single most important thing to fix proactively.

## Recommendations

1. **Make the absence explicit and durable.** Add a CRIA checklist item (see
   [07](07-safe-by-design-and-governance.md)) requiring that any new
   commercial / monetization / promoted-content / marketplace feature
   demonstrate how it excludes `CHILD` (and ideally `TEEN`) accounts from being
   *targeted or solicited* — turning today's emergent property into an enforced
   rule before the feature surface ever exists.
2. **Lock the TEEN-tier contact and discoverability defaults**, or at minimum
   gate loosening them behind guardian consent, so the 13–17 band is not a
   silent commercial-contact channel.
3. **Implement the mutual-follow check** in `messages.ts` so CONNECTIONS-tier
   DM control is real rather than fail-closed-by-accident; until then, document
   that CONNECTIONS currently blocks all DMs.
4. **Treat self-declared age as the assurance ceiling**: pair it with the
   privacy-preserving age-assurance approach in
   [07](07-safe-by-design-and-governance.md#L66) for any feature where
   mis-declared age would expose a child to commercial contact.

## Bottom line

Trellis prevents commercial targeting of children primarily by **omission** (no
ad / commerce / targeting engine) reinforced by **hard privacy locks on CHILD
accounts** (no DMs, not discoverable, not analyzed). The weak points —
self-declared age, the stubbed connection check, and the lack of an explicit
minor-exclusion rule for future commercial features — do not undermine the
*child*-tier protection today, but each matters if this is being relied on for
compliance or if monetization is ever introduced.
