# Safe by Design and Governance

Incorporating the UN OHCHR guidance of 29 May 2026 ("Banning children from
social media is not enough — platforms must be made safe by design"). Where the
earlier files in this analysis treat safety as a **feature set**, this file
captures the UN's stronger, structural claims: safety as an **architectural
mandate**, plus the **process and governance** artifacts that regulators are
moving toward.

## Sources

3. **UN News / OHCHR** (29 May 2026): "Banning children from social media is not
   enough, UN warns — platforms must be made safe by design." Statement by UN
   High Commissioner for Human Rights Volker Türk.
4. **Al Jazeera** (29 May 2026): "UN urges 'urgent' action to protect children
   online." (Same OHCHR announcement.)

## The reframe: safe by design is an architecture mandate, not a feature toggle

The UN's central claim is that online harms stem from "deliberate commercial
choices" — naming **infinite scroll, autoplay, and persistent notifications** —
and that safety must therefore be "embedded into platform architecture from
inception," rather than left to parents and children to manage after the fact.

This sharpens the recommendation already running through files
[01](01-research-summary.md)–[06](06-competitive-differentiation.md): the
addictive-pattern controls are not per-vertical add-ons.

**Implication for Trellis specifically.** Trellis is the generic multi-tenant
core; verticals (Trellis et al.) build on it. "Safe by design" therefore belongs
in the **core**, expressed as platform-level capabilities with **safe defaults**
that extensions tune *within bounds* — not behaviour each vertical
re-implements and can silently omit. The feed shape, notification cadence,
sentiment-count visibility, and minor privacy defaults should be core concerns,
so that opting *into* harm is the explicit, auditable choice rather than the
path of least resistance. This is the same conclusion as
[06](06-competitive-differentiation.md#L48) ("part of the core architecture"),
now backed by a human-rights framework rather than only by market positioning.

## Bans are the competitor, not the standard

The UN explicitly warns that age-based bans are **easily circumvented** and risk
**pushing children toward less-monitored, riskier spaces**: "Simply limiting
access to platforms that remain unsafe cannot stand as the endpoint."

Updated regulatory landscape (extends the list in
[05](05-age-verification-and-minor-safety.md#L71), which stopped at
Australia / KOSA / DSA):

- **Australia** — under-16 ban, live since December 2025.
- **Indonesia, Malaysia** — followed Australia.
- **Austria** — proposed under-14 ban.
- **Denmark, France** — considering under-15 bans.
- **Spain, UK** — weighing under-16 restrictions.
- "Over a dozen" countries weighing similar measures.

**Design insight.** A genuinely safe-by-design platform is the answer to the
thing regulators say bans *fail* to deliver. The strategic posture is not
"comply with the ban" but "be the platform that does not need one." This
reinforces the differentiation argument in
[06](06-competitive-differentiation.md).

## Age verification: privacy-preserving, or it backfires

Türk's caution is direct: age verification "done wrong can both fail at its goal
**and endanger privacy**."

This is a tension with the phased plan in
[05](05-age-verification-and-minor-safety.md#L49). **Phase 3** routes edge cases
to identity-document providers (Jumio / Onfido / Veriff) — i.e. uploading
government ID, the exact privacy-eroding pattern the UN warns against, and a
standing PII liability.

**Added constraint for any age-assurance work:**

1. **Prefer privacy-preserving age assurance.** On-device age estimation;
   zero-knowledge / attestation-based tokens that return only an
   *over-threshold yes/no* without revealing or retaining identity (cf. the EU
   age-verification-app model with double-blind reattestation).
2. **Data minimisation as default.** If document-based verification is ever
   used, treat retained PII as a liability to delete, not an asset to keep.
   Never persist raw identity documents beyond the verification decision.
3. **Fail closed on privacy, not on access alone.** A verification method that
   leaks identity is worse than self-declaration; weigh both failure modes.

## New surfaces and process artifacts the earlier files do not cover

### 1. Child Rights Impact Assessments (CRIA) — a governance artifact

The UN calls for CRIAs to be **mandatory**. This is a recurring **process**
artifact, not a feature. Recommendation:

- Add a lightweight CRIA step to the feature lifecycle: a short template any
  feature that touches minors (or could) must pass before ship — covering the
  named harm vectors (engagement loops, notification pressure, social
  comparison, data exposure, contact risk).
- Make the **design decision itself auditable**: record *why* a given default or
  mechanic was chosen. See accountability below.

### 2. Accountability and auditability as a defensive asset

The UN frames part of the goal as ensuring "those responsible for harm can be
held to account." Combined with the **California** and **New Mexico** jury
verdicts already noted in [01](01-research-summary.md#L10), the practical
insight is that an **auditable record of design rationale** — what mechanic was
chosen, what the CRIA found, what default was set and why — becomes a defensive
asset in litigation and regulatory review, not just internal hygiene.

### 3. AI and chatbots as an emerging harm surface

The framework calls for "agile, evidence-based policymaking" adapted to
"emerging technologies like **AI and chatbots**." None of files
[01](01-research-summary.md)–[06](06-competitive-differentiation.md) address AI.

**Insight.** If Trellis (or any vertical) adds AI features — assistants,
generated replies, companions — the same safe-by-design rules must extend to
them from the start: no engagement-maximising persistence, minor-safe defaults,
and explicit guards against parasocial / companion-addiction loops. This is a
forward constraint to record now, before such features exist, rather than a
retrofit later.

### 4. Participatory design — consult the affected age group

The UN calls for "meaningful consultation with children" in shaping policy.
Where a vertical serves minors, design validation should include the affected
age group, not rely solely on adult product judgement.

## Summary of design constraints added by this file

| Constraint | Where it lands |
|---|---|
| Safe defaults live in the Trellis core, tunable-within-bounds by extensions | core architecture; cf. [06](06-competitive-differentiation.md#L48) |
| Prefer privacy-preserving age assurance over identity-doc upload | revises [05](05-age-verification-and-minor-safety.md#L49) Phase 3 |
| Mandatory CRIA step in the feature lifecycle for minor-facing changes | process / governance |
| Auditable record of design rationale | process; defensive vs. litigation |
| Safe-by-design rules extend to any future AI / chatbot features | forward constraint |
| Consult the affected age group in design validation | process |
