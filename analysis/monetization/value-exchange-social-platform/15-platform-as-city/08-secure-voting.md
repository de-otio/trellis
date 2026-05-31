# Secure Voting — The Operational Realisation of the Polity-Decision Mechanism

The platform-as-city framing requires a mechanism by which the polity *makes decisions*. The mechanism-design lineage ([02-mechanism-design-and-funding.md](02-mechanism-design-and-funding.md)) supplies the funding part — Quadratic Voting and Quadratic Funding. It does not by itself supply a *trustworthy execution layer* for collective decisions. Without that layer, every interesting governance claim the framing makes is unverifiable.

The consumer-vertical repo contains a comprehensive design for that layer, predating this folder by ~14 months. It is the operational realisation of the polity-decision mechanism the platform-as-city framing presumes.

---

## The Existing Design

Location: [`doc/02-technical/voting/`](../../../../doc/02-technical/voting/) (moved here 2026-05-25 from the consumer-vertical repo's `doc/01-business/features/b2c-features/voting/` — see ["Documentation Belongs in Trellis" section](#the-documentation-belongs-in-trellis--missed-move-during-factoring) below).

Originally drafted January 2025, with a 2026-05 update note confirming the cryptographic protocols, security architecture, and standards-compliance docs remain valid against the current redesign. Seven documents:

| File | Purpose |
|---|---|
| [`README.md`](../../../../doc/02-technical/voting/README.md) | Overview, principles, use cases, security guarantees |
| [`01-security-architecture.md`](../../../../doc/02-technical/voting/01-security-architecture.md) | Threat model and cryptographic protocols |
| [`02-technical-design.md`](../../../../doc/02-technical/voting/02-technical-design.md) | System architecture, data models, API design |
| [`03-standards-compliance.md`](../../../../doc/02-technical/voting/03-standards-compliance.md) | VVSG 2.0 mapping and certification requirements |
| [`04-implementation-plan.md`](../../../../doc/02-technical/voting/04-implementation-plan.md) | Phased rollout |
| [`05-user-experience.md`](../../../../doc/02-technical/voting/05-user-experience.md) | Voting flows, verification UIs, accessibility |
| [`06-cryptographic-protocols.md`](../../../../doc/02-technical/voting/06-cryptographic-protocols.md) | Key management and verification procedures |
| [`07-estonia-comparison.md`](../../../../doc/02-technical/voting/07-estonia-comparison.md) | Detailed comparison with Estonia's IVXV national internet voting system |

The design follows four named external standards:

- **VVSG 2.0** — Voluntary Voting System Guidelines 2.0, US Election Assistance Commission. The most rigorous publicly-available specification for electronic voting systems.
- **ElectionGuard** — Microsoft's open-source end-to-end-verifiable voting protocol.
- **End-to-End Verifiable (E2E-V) Voting** — the cryptographic-voting research lineage (Helios, Pret a Voter, Scantegrity, STAR-Vote).
- **NIST Cybersecurity Framework**.

Six security guarantees the design commits to: ballot secrecy, integrity, individual verifiability, public verifiability (anyone can verify results), coercion resistance, tamper resistance. Tallying uses **homomorphic encryption with threshold decryption across multiple trustees** — i.e. no single party can decrypt votes alone.

Stated use cases include **community polls, governance elections, and content-moderation policy ratification** — all of which are city-government functions in the platform-as-city framing.

---

## Why This Matters for the Platform-as-City Framing

The framing's five design questions from [05-the-synthesis-gap.md](05-the-synthesis-gap.md) acquire concrete answers once the voting design is treated as available:

| Design question (from the gap analysis) | What the voting design contributes |
|---|---|
| 1. What are the common services? | **Verifiable collective-decision-making is one of them.** The README explicitly names community polls, leadership elections, and content-moderation ratification — the canonical city-government functions. |
| 2. What is the tax base? | Out of scope for the voting design, but the voting design is what would *legitimise* any tax mechanism. A QF/QV-shaped contribution scheme without a verifiable tallying layer is just a fundraiser. |
| 3. What is the citizenship gradient? | The voting design assumes one-citizen-one-vote and ballot secrecy. **It does not currently address the B2B/B2C distinction.** Whether a corporate citizen has the same vote weight as an individual citizen — or has voting standing at all on certain decisions — is an open question the existing design does not answer. This is the sharpest place the platform-as-city framing extends the voting work. |
| 4. What is the relationship to the operator? | The threshold-decryption-with-multiple-trustees model already structurally limits operator power. The operator alone cannot decrypt the tally. This is exactly the constitutional-court-with-checks pattern the framing presumes. |
| 5. Where does Trellis sit? | See "Trellis vs the consumer vertical" below — this is the most important question the voting design surfaces. |

---

## The Documentation Belongs in Trellis — Missed Move During Factoring

The voting design originally lived in the consumer vertical's doc tree, filed under `b2c-features`. **This was a residue of incomplete factoring.** When Trellis was factored out of the consumer vertical as the generic core, the voting documentation should have moved with it and did not. The move was corrected on 2026-05-25 — the docs now live in [`doc/02-technical/voting/`](../../../../doc/02-technical/voting/) alongside the other complex multi-document feature designs (e.g. `doc/02-technical/identity-federation/`).

The argument for the move (preserved here as the rationale):

1. **It is generic infrastructure, not vertical-specific.** A pet-fan community, a Eurovision-fan community, and a coalition-of-foundations instance all have governance decisions to make. The voting machinery — VVSG 2.0 / ElectionGuard / homomorphic tally — has nothing vertical-specific about it.
2. **The platform-as-city framing makes it constitutional.** If every tenant is a city, every tenant needs verifiable collective-decision-making. Having each vertical re-implement E2E-V independently is wasteful and unsafe — these are exactly the cryptographic protocols that benefit from being implemented once, audited once, and exposed as a Trellis primitive.

Status (design document, not built) is independent of where the documentation lives. The move does not commit Trellis to shipping the feature on any particular timeline — it only acknowledges that the design *belongs* to the generic core.

Changes made during the move:
- Filenames renamed to NN-kebab-case to match Trellis convention (`01-security-architecture.md` etc.).
- In-prose consumer-vertical references updated to "Trellis" where they referred to the platform hosting the feature.
- Sibling-feature links in the README (`./feed/`, `./sub-communities/`, etc., which were paths in the consumer-vertical repo) were delinked pending Trellis-side documentation of each.
- Cryptography cross-reference paths in `04-implementation-plan.md` updated to be correct relative to the new location (the target docs do not yet exist in either repo — these are forward references).
- The corresponding index in the consumer-vertical repo at `doc/01-business/features/b2c-features/README.md` had its `Voting` entry removed.

---

## Where the Voting Design Could Extend to Match the Framing

If the voting design is reread through the platform-as-city lens, three extension points emerge:

### 1. Citizenship classes and vote weight

The current design assumes one-citizen-one-vote with ballot secrecy. The framing's dual B2B/B2C citizenship claim implies the design may need to support **multi-class ballots**:

- Some decisions decided by one-citizen-one-vote (B2B + B2C combined).
- Some decisions decided only by B2C citizens (decisions about the social space).
- Some decisions decided by weighted vote (revenue-sharing decisions, perhaps QV-shaped).
- Some decisions decided by a *both-classes-must-approve* rule (constitutional changes affecting both classes).

The cryptographic protocols would extend naturally — eligibility predicates are already part of the E2E-V design surface — but the standards-compliance picture would need re-examination, since VVSG 2.0 assumes a single-class electorate.

### 2. Quadratic voting integration

The Posner & Weyl QV mechanism is the natural way to elicit preference intensity without disadvantaging minorities. Integrating QV into the E2E-V design is non-trivial — the homomorphic-tally machinery is built for plurality and approval voting, not for quadratic-cost-of-votes. The Plurality work (Weyl & Tang 2024) discusses this; the voting design does not.

### 3. Delegation / liquid democracy

If citizens delegate their vote to representatives (the EVE-CSM pattern, or liquid-democracy more generally), the verification protocol must support delegation-while-preserving-ballot-secrecy. This is a known research problem. Worth naming as a candidate extension if liquid democracy ever enters Trellis's design space.

---

## Connection to the Rest of This Folder

| File | Engagement with the voting feature |
|---|---|
| [01-platforms-as-public-infrastructure.md](01-platforms-as-public-infrastructure.md) | Rahman's "platform as public utility" argument is operationally hollow without a verifiable governance mechanism. Voting supplies it. |
| [02-mechanism-design-and-funding.md](02-mechanism-design-and-funding.md) | QV/QF require a verifiable execution layer to be more than fundraising mechanisms. Voting supplies that layer for QV; an analogous funding-attestation layer would do the same for QF. |
| [03-platform-cooperativism.md](03-platform-cooperativism.md) | Co-ops require member governance. Verifiable e-voting is the operational complement to the cooperativism ownership model. |
| [04-virtual-world-precedents.md](04-virtual-world-precedents.md) | EVE's Council of Stellar Management is elected without E2E-V; the voting design would let in-platform polities reach a verifiability bar that real-world internet voting (Estonia aside) generally does not. |
| [05-the-synthesis-gap.md](05-the-synthesis-gap.md) | The five design questions acquire concrete answers (see table above). |
| [06-trellis-mapping.md](06-trellis-mapping.md) | The Trellis-vs-consumer-vertical question is added as a load-bearing decision the framing forces. |
