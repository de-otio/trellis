# 06 — Ethics, consent, and governance

*Regime: governance. Primary risk: legitimacy.*

This is the load-bearing document. The technical capabilities in docs 03–05 are
the easy part; what determines whether Trellis-for-research is a contribution or
a scandal is **who is allowed to do what, under whose review, with what rights
for the people in the data.** A platform that experiments on or exposes its
users without independent oversight *is the thing social-media research exists to
criticise.* The governance must be designed as **structural invariants** —
visible, costly to reverse — for the same reason as everything else in this repo.

## Three principals, not one

Today the codebase knows about *users* and *tenant admins*. Research needs two
more, kept distinct:

1. **Researcher** — an external (or internal) investigator granted scoped,
   time-bounded, audited access to a specific approved study. *Not* a user, *not*
   a tenant admin, *not* a developer with a generic API key. A researcher
   credential carries: approved study ID, access tier (doc 03), expiry, and the
   IRB/ethics reference. Every action is an `AuditEvent` with `actorKind:
   "researcher"`.
2. **Ethics reviewer / oversight board** — the principal that *approves* studies
   and can *halt* them. Approval is a precondition for a researcher credential
   existing at all.

Vetting maps onto the DSA Article 40 model: identity + institutional
affiliation + an approved research question, mediated by an oversight process.
Reuse the existing identity-federation machinery — a researcher authenticates
through their institution's IdP (the same SAML/OIDC federation tenants already
use), so "is this a real researcher at a real institution" is answered by
federation, not a homemade check.

## Consent as a first-class, generalised record

`CrossRegionConsent` already models *a person granting a specific data use at a
specific time, withdrawably, with the decision context captured.* Rather than
invent a parallel structure, **generalise it into a `Consent` record with a
`purpose`** discriminator:

- `purpose: "cross_region"` — the existing behaviour, unchanged.
- `purpose: "research_observation"` — included in de-identified Tier-2 extracts.
- `purpose: "research_participation"` — enrolled as a Tier-3 / experiment
  participant for a named study.

Each consent is **per-study, specific, informed, and withdrawable**, with
`consentedAt` / `withdrawnAt` and the study ID in scope. This directly satisfies
the GDPR's specificity-of-consent requirement and the Common Rule's informed
consent — and it means *withdrawal is a real, mechanical event* (revoke
credential's reach to that person, exclude from future extracts, dissolve their
experiment arm via the deletion path).

**Layered consent**, by regime:

| Regime | Basis | Mechanism |
|---|---|---|
| Tier-0/1 aggregates | Legitimate interest / public-interest research, *with opt-out* | An `analyticsOptOut`-style **research opt-out** flag excludes a user even from de-identified aggregates |
| Tier-2 de-identified microdata | Opt-out + de-identification + DUA + IRB | `research_observation` consent or documented opt-out regime |
| Tier-3 identified / experiments | **Opt-in informed consent** | `research_participation` consent, per study |

The default for the strong regimes is **opt-in**; the default for weak
aggregates is **opt-out with a real, discoverable switch** — never silent
inclusion.

## Special protection for minors

The `ageTier` enum (CHILD / TEEN / ADULT) and `ParentalLink` already exist.
Governance rules that must be **enforced in code, not policy**:

- **CHILD/TEEN are excluded from all research by default** — observation and
  intervention alike.
- Inclusion of minors requires IRB approval *plus* verified parental/guardian
  consent (`ParentalLink`) *plus* a documented minor-specific benefit, and even
  then only at the minimal-risk level. This mirrors the heightened bar in
  [`safer-social-design/05`](../safer-social-design/05-age-verification-and-minor-safety.md)
  and [`08`](../safer-social-design/08-commercial-targeting-of-minors.md).
- The arm-assignment and extract pipelines must **filter `ageTier` first** and
  fail closed — a minor must never be enrollable by a query that forgot to
  exclude them.

## Independent ethics review built into the workflow

The point of the **Menlo Report** (2012) — the ICT-research adaptation of
Belmont — is that ICT research has stakeholders beyond the immediate subject
(other users, the platform, the public), and that review must be *independent*
of the researcher's incentives. Concretely:

- A study cannot move from "proposed" to "approved" without an oversight-board
  decision recorded as an `AuditEvent`. No approval → no researcher credential →
  no data access. This is the **invariant**: access is impossible without a
  logged approval, not merely discouraged.
- The board can issue a **halt** that immediately revokes credentials and
  reverts experiment toggles (graceful-degradation-to-control, per doc 04).
- For internal/platform-run A/B tests, the same board reviews them — the
  platform does not get a lighter ethics standard than outside researchers.

## Participant-facing transparency

Surveillance is done *to* people; legitimate research is done *with* them. A
**participant study dashboard** (reusing the export/consent UI patterns) lets a
user:

- See whether their data is eligible for / included in research, and toggle the
  research opt-out.
- See which studies they have consented to and which experiments they are/were
  enrolled in (doc 04).
- **Withdraw** from any study with one action, triggering exclusion + arm
  revert.
- Read plain-language summaries of completed studies they contributed to
  (debriefing as a default, not a request).

A public **research register** (approved studies, their questions, their
ethics references, their results) makes the whole apparatus externally
observable — the difference between "trust us" and "here is the log."

## The invariants (what makes this enshittification-resistant)

Stated as the kind of binding-your-own-hands commitments doc 07 of the
enshittification analysis argues for:

1. **No data access without a logged ethics approval.** Enforced by the
   credential-issuance path, not a checkbox.
2. **No research without the appropriate consent basis for its tier.** Opt-in
   for strong regimes; opt-out-with-a-real-switch for weak aggregates.
3. **No minors by default**, ever, without the heightened gate — fail closed.
4. **No experiment outside the allow-listed treatment catalogue** (doc 04/07) —
   the abandoned dark patterns are *unrepresentable*, not merely unused.
5. **Every access and every approval is auditable and (where appropriate)
   publicly registered.**
6. **Withdrawal is real and mechanical**, built on the deletion pipeline.

If these are reversible config, the research framework becomes a laundering
mechanism for the surveillance the platform claims to reject. If they are
structural — enforced in the credential, consent, and pipeline code, and visible
in the register — then "research-grade" and "trustworthy" are the same property.

## Sources

- The Menlo Report: *Ethical Principles Guiding Information and Communication
  Technology Research*, US DHS, 2012; and the Belmont Report (1979).
- US Common Rule, 45 CFR 46 (informed consent, minimal risk, protections for
  children, subpart D).
- GDPR Arts. 6, 7, 9, 89 (legal bases, consent specificity, special-category
  data, safeguards for research).
- EU DSA Art. 40 vetted-researcher regime (doc 01).
- Internal: [`analysis/enshittification-resistance/07-binding-your-own-hands.md`](../enshittification-resistance/07-binding-your-own-hands.md);
  [`analysis/safer-social-design/`](../safer-social-design/).
