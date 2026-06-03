# 03 · Suggested changes & additional features

Concrete proposals that follow from the research in
[`01-the-argument.md`](01-the-argument.md) and the mapping in
[`02-trellis-alignment.md`](02-trellis-alignment.md). These are **design
proposals, not asserted current behaviour**; current-state claims are drawn from
the sibling analysis docs and `CLAUDE.md` and should be confirmed against code
before implementation.

## Compliance reality (the framing constraint)

The age-tier work already in the codebase — `dateOfBirth`, `ageTier`
(`CHILD`/`TEEN`/`ADULT`), `ParentalLink`, `privacy-defaults.ts`,
`age-tier-transition.ts` — is **likely required for near-term compliance** (KOSA,
EU DSA, AU/EU age laws) and **stays**. The brief's anti-age-gating argument is a
critique of age-gating *as the primary remedy*, not a reason to remove
legally-required minor protections.

So every suggestion below is **additive**: it shapes *how* Trellis meets
compliance and where it goes *beyond* it — privacy-preserving assurance,
mechanism-level protection, agency-first positioning — while the age-tier
substrate remains. Where a suggestion touches the age-tier work, it is called out
explicitly.

---

## Group A — Make attention mechanics auditable & swappable (recs 5.1, 5.2)

### S1 · Feed/ranking as a declared, inspectable policy boundary
- **Why:** the brief says regulators will target ranking *mechanisms*; a
  regulator (and a tenant) must be able to see and contest what the feed does.
- **Current (per `analysis/redesign/07`):** `FeedStrategy` removed; content is
  chronological within relationship tiers — already the calm, non-engagement
  posture. The gap is *structural legibility*, not behaviour.
- **Proposal:** keep all ranking/ordering logic behind one explicit, named policy
  module with a documented contract ("recency within tier; ranking input =
  relationship score only"), so it is disclosable to a regulator and a tenant can
  run a documented "calm" policy. Forbid extensions from reintroducing
  engagement ranking (already the intent — make it an enforced boundary).
- **Effort:** low–medium (mostly structural + documentation). **Priority: medium.**

### S2 · Ranking transparency & contestability — "why am I seeing this"
- **Why:** rec 5.2 is the one place the brief asks for *more* than Trellis does
  today.
- **Current (per `analysis/redesign/02`):** the relationship score and its inputs
  (explicit calibration, reciprocity, interaction frequency/recency, connection
  method) are already user-visible and adjustable.
- **Proposal:** a per-item / per-relationship explanation affordance surfacing
  *why* a post is in a given tier (which score inputs placed this person where).
  Data already exists; this is presentation + a read endpoint.
- **Effort:** low. **Priority: high** (closes the single identified gap, cheaply).

### S3 · Notification cadence as explicit, inspectable, tenant-configurable policy
- **Why:** notification design is a named attention mechanism; re-engagement
  pushes are a dark pattern.
- **Current (per `analysis/redesign/07`):** notifications are poll-based (no
  push), scoped to tier.
- **Proposal:** keep cadence logic at an explicit boundary, document what it does
  and does not do (no re-engagement nudges), make it tenant-configurable.
- **Effort:** low. **Priority: medium.**

---

## Group B — Minor safety at the mechanism level (rec 5.1; complements compliance)

### S4 · A `ageTier`-keyed "calm defaults" mechanism bundle
- **Why:** the brief argues minor protection should be *mechanism-level*, not
  exclusion. This is the bridge between the research and the compliance reality:
  the age tiers exist (compliance); this makes the *protection they trigger*
  structural.
- **Current:** `privacy-defaults.ts` enforces age-tier privacy locks; finite
  views / circles already limit usage structurally.
- **Proposal:** formalise a protection bundle keyed on `ageTier` — calm default
  ranking, finite views non-overridable, no microtargeting, protective privacy
  defaults — as one named policy rather than scattered feature gates.
- **Effort:** medium. **Priority: high** (directly serves both compliance and the
  research).

### S5 · No behavioural/micro-targeted ad surface for minors (design constraint)
- **Why:** brief §4.1/§5.1 — micro-targeting is a primary harm mechanism;
  targeting minors is the least defensible case.
- **Current:** no ad-driven attention market today.
- **Proposal:** record as a hard platform constraint — if any ad/recommendation
  surface is ever added, minors are excluded from behavioural targeting entirely;
  ideally the platform avoids real-time-bidding/behavioural ads for *all* users.
- **Effort:** low now (a written constraint). **Priority: medium** (cheap
  insurance against a future mistake).

---

## Group C — Age assurance done right (the compliance bridge)

### S6 · Privacy-preserving age assurance over identity-document collection
- **Why:** brief + UN OHCHR — age verification "done wrong can both fail at its
  goal and endanger privacy." This is *how* to satisfy a verification mandate
  without creating a surveillance liability.
- **Current (per `analysis/safer-social-design/05`):** age is self-declared;
  `identityVerificationProvider` (jumio/onfido/veriff) infra exists; no Phase 2/3
  wired up.
- **Proposal:** if assurance beyond self-declaration becomes legally required,
  prefer **zero-knowledge attestations / third-party (double-blind) age tokens**
  over storing identity documents or biometrics. Gate any identity-document path
  on an *explicit* regulatory demand plus data-localisation. Keep self-declared
  tiers as the default.
- **Effort:** medium–high (integration, only when triggered). **Priority:
  medium** now / high *if/when* a verification mandate lands. **Touches the
  age-tier work directly — this is the recommended escalation path.**

---

## Group D — Agency & interoperability as positioning (recs 5.4, 5.5)

### S7 · Treat federation + data portability as a first-class agency commitment
- **Why:** rec 5.4 — interoperability is *the* lever against lock-in; "leave
  without losing your network."
- **Current (per `CLAUDE.md`):** ActivityPub/Fedify federation is **disabled by
  default**, enabled per environment.
- **Proposal:** re-evaluate the default-disabled posture (at least make it a
  prominent, recommended-on option), and ensure a complete user **data-export /
  account-portability** path exists. Position federation as core, not optional.
- **Effort:** medium. **Priority: medium** (positioning leverage is high; code
  cost moderate).

### S8 · A "public-interest / calm" tenant profile preset
- **Why:** rec 5.5 — be the public-interest infrastructure; the multi-tenant core
  can ship the agency-first defaults as a named preset.
- **Current:** multi-tenant config exists; no named "calm" preset.
- **Proposal:** a config preset bundling calm ranking, no ads, protective privacy
  defaults, federation on — aimed at public-sector/educational/civic tenants.
- **Effort:** low–medium (config preset over existing knobs). **Priority: medium.**

### S9 · Reframe positioning & internal design principles to *agency / cognitive liberty*
- **Why:** brief §3/§4.3 — the mental-health frame is empirically shaky and
  strategically weak; agency/cognitive-liberty is the stronger, evidence-aligned
  frame.
- **Current:** `safer-social-design/` and skybber's `003-safer-social-design`
  lean on anti-addiction / mental-health (and KOSA) framing.
- **Proposal:** reframe platform copy, tenant-facing values, and the design-
  principles docs around returning attentional agency to the user. Non-code.
- **Effort:** low. **Priority: high** (highest leverage-to-cost ratio; reframes
  the rest).

---

## Priority summary

| Priority | Items |
|---|---|
| **High** | S2 (ranking transparency), S4 (`ageTier` calm-defaults bundle), S9 (agency reframe) — and S6 *if* a verification mandate lands |
| **Medium** | S1 (ranking policy boundary), S3 (notification policy), S5 (no minor microtargeting), S6 (now), S7 (federation/portability), S8 (calm tenant preset) |

The two cheapest high-leverage moves are **S9** (reframe — non-code) and **S2**
(why-am-I-seeing-this — data already exists). **S4** and **S6** are where this
research meets the age-tier compliance work: keep the tiers, make the protection
mechanism-level and the assurance privacy-preserving.

None of these is a committed change — they are a menu derived from the research,
to be scoped against the compliance roadmap and current code.
