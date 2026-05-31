# Age Verification and Minor Safety

Addressing the research finding that current age verification is ineffective and that platforms need specific protections for younger users.

## The Problem

From the Nagata et al. study:
- Two-thirds of 11- and 12-year-olds already have social media accounts
- Most have 3+ accounts
- "Anyone right now can put in a fake date of birth and get access to an account"
- The vast majority of study participants were under the minimum age of 13 for social media

Trellis currently has **no age verification at all** — no date-of-birth field, no age gating at registration.

> **Correction (post-audit):** This is no longer accurate. The "Proposed
> Approach" below has been **partially implemented**: the User model now has
> `dateOfBirth` and an `ageTier` (`CHILD`/`TEEN`/`ADULT`) computed at
> registration (`apps/api/src/lib/age-tier-transition.ts`,
> `apps/api/src/lambda/post-confirmation.ts`); a `ParentalLink` model exists; and
> age-tier privacy locks are enforced in `apps/api/src/lib/privacy-defaults.ts`.
> What remains true is that age is **self-declared and unverified** (no Phase 2
> parental confirmation or Phase 3 identity step is wired up). See
> [08](08-commercial-targeting-of-minors.md) for the verified current state.

## Proposed Approach

### 1. Collect Date of Birth at Registration

Add a `dateOfBirth` field to the User model. This is the minimum baseline — it doesn't prevent lying, but it:
- Establishes a legal basis for the platform's terms of service
- Enables age-appropriate feature gating in the application layer
- Creates the data foundation for more robust verification later

### 2. Age-Gated Feature Tiers

Based on the declared age, apply different feature sets:

| Feature | Under 13 | 13-17 | 18+ |
|---------|----------|-------|-----|
| Account creation | Requires parent/guardian | Allowed | Allowed |
| DMs from non-connections | Blocked | Blocked | Allowed |
| Sentiment counts visible | Hidden | Hidden by default | Shown |
| Feed pagination | Hard limit (5 pages/session) | Soft nudge | No limit |
| Quiet hours | Enforced (parent-set) | Suggested | Optional |
| Profile visibility | Private by default | Private by default | Public by default |
| Data sharing / analytics | Opted out | Opted out | Opt-in |
| Content personalization | Off | Interest-tags only | Full |

### 3. Parental Controls (for Under-18 Accounts)

If a user is under 18, a parent/guardian account can be linked to manage:
- Quiet hours and session time limits
- Who can send DMs
- Content visibility settings
- Ability to review reported content

This requires a new `ParentalLink` model connecting two user accounts.

### 4. Graduated Age Verification

Don't try to solve verification all at once. A phased approach:

**Phase 1 — Self-declaration:** Date of birth at registration. Low friction, low assurance.

**Phase 2 — Parental confirmation:** For under-13 accounts, require a parent/guardian email confirmation. Moderate friction, moderate assurance.

**Phase 3 — Identity verification integration:** Trellis already has identity verification infrastructure (`identityVerificationProvider`: jumio, onfido, veriff). Extend this to support age verification for edge cases or when required by regulation.

## Privacy Defaults for Minors

Both Prinstein and Nagata recommend that minor accounts should default to maximum privacy:

- **Data not shared** with other companies
- **Data not used** for content personalization
- **Profile not discoverable** in public search
- **Location tracking disabled**
- **Analytics opted out**

Trellis already has the schema fields for most of these (`analyticsOptOut`, `locationTrackingEnabled`, `stealthMode`). The change is making the defaults protective for minor accounts rather than permissive.

## Regulatory Landscape

- **Kids Online Safety Act (KOSA):** Passed U.S. Senate in 2024, pending in House. Proposes restricting infinite scroll, personalized feeds, and notifications for minors.
- **Australia:** Banned social media for children under 16 (live since December 2025); **Indonesia** and **Malaysia** followed.
- **Other bans under consideration (mid-2026):** Austria (under-14), Denmark and France (under-15), Spain and UK (under-16) — "over a dozen" countries weighing measures.
- **EU Digital Services Act:** Requires platforms to assess and mitigate risks to minors.

Building these protections now positions Trellis ahead of likely regulation rather than scrambling to comply retroactively.

> **Caveat on Phase 3 (29 May 2026 UN OHCHR guidance):** age verification "done
> wrong can both fail at its goal and endanger privacy." The identity-document
> route below is exactly that risk. See
> [07-safe-by-design-and-governance.md](07-safe-by-design-and-governance.md#L66)
> for the privacy-preserving age-assurance constraint that should govern any
> Phase 3 work.
