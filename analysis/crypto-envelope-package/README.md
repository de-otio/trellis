# `@de-otio/crypto-envelope` — Productization Analysis

Initial analysis, 2026-04-12.

Companion to [`analysis/chaoskb-reuse/`](../chaoskb-reuse/). Where that document asks *"should trellis import chaoskb's crypto internally?"*, this one asks a bigger question:

> **Should de-otio extract the crypto envelope layer into an MIT-licensed npm package, published publicly for transparency and reference, and used internally by chaoskb, trellis, and any future de-otio projects that need application-level encryption?**

Short answer: **yes, but staged, and honestly positioned.** The material already exists in chaoskb at specification-grade quality; the ecosystem gap is real (TypeScript-first, envelope-level, opinionated defaults, agent-installable); the de-otio values align cleanly; and the sibling package `agent-safety-pack` sets a working template for how a public @de-otio library should be shipped.

## Decisions made (2026-04-12)

Two distinct go/no-go calls that this doc set was designed to inform, confirmed:

- **Decision A — extract crypto into a shared package.** Both chaoskb and trellis will depend on the new package; chaoskb drops its in-tree `src/crypto/` (replacing it with a dependency), trellis retires `@trellis/crypto` in favour of a re-export shim over the new package. This is the core recommendation from [`chaoskb-reuse/03-integration-options.md`](../chaoskb-reuse/03-integration-options.md) Option A. **Confirmed.**
- **Decision B — publish publicly under `@de-otio/crypto-envelope`.** MIT license, public GitHub repo under `github.com/deotio`, published to npm (with provenance + Trusted Publishing per [de-otio's own supply-chain guidance](../../../dot-notes/doc/supply-chain-attack-mitigations.md)). Positioning per the honest maintenance posture below — published for transparency and reference, not as a supported product. **Confirmed.**

What this doc set is for, given the decisions: design, scoping, and implementation guidance for the rollout phases described in [`04-governance-and-rollout.md`](04-governance-and-rollout.md). The go/no-go question is closed; the "what exactly" and "in what order" questions are what this analysis now drives.

## What "envelope" means

An **encryption envelope** is the structured wrapper around a ciphertext that carries the metadata required to decrypt and verify it — version, algorithm identifier, key identifier, nonce, authentication tag, and any associated authenticated data. The metaphor is the physical envelope: the sender addresses it, seals the contents, writes routing info on the outside. Intermediaries (storage server, backup system, wire protocol) see the exterior; only the holder of the right key can open it.

The **envelope layer** sits between two better-known layers:

- **Below it: cryptographic primitives** — AES-256-GCM, ChaCha20-Poly1305, HKDF, Argon2id. These are implemented by `@noble/*`, libsodium, and similar libraries. Primitives say *how* to encrypt a block of bytes.
- **Above it: application protocols** — Signal Protocol, MLS, TLS, JOSE/JWT, OpenPGP. These say *what* to encrypt, *to whom*, and *in what sequence*.
- **In between: the envelope** — the format that decides how the primitive's output is laid out, what metadata rides alongside the ciphertext, and how a future decrypter (different device, different library version, different language) can parse it unambiguously.

Concrete example. When this package encrypts the plaintext `{"type": "note", "body": "hello"}`, it produces a JSON envelope of this shape:

```json
{
  "v": 1,
  "id": "b_7f3a9c2e1d4b8a",
  "ts": "2026-04-12T10:00:00Z",
  "enc": {
    "alg": "XChaCha20-Poly1305",
    "kid": "CEK",
    "ct": "<base64: nonce || ciphertext || tag>",
    "commit": "<base64: HMAC-SHA256 key commitment>"
  }
}
```

The outer fields (`v`, `id`, `ts`, `alg`, `kid`, `commit`) are the envelope — readable by anyone holding the blob, revealing nothing about the plaintext. `ct` is the sealed payload, useless without the right key. The full wire format is specified in chaoskb's [`envelope-spec.md`](../../../chaoskb/doc/design/envelope-spec.md) and will be carried forward as the package's published spec. (The `"b_…"` blob ID above is illustrative chaoskb-style formatting; the public package lets the caller choose its own ID format.)

Other envelope formats in the wild, for context:

- **JWE** (RFC 7516) — the envelope underlying JWT/JWS tokens. Designed for short-lived transport, not long-lived storage.
- **age** (`age-encryption.org`) — file-level envelope, excellent design, oriented toward streaming and files rather than many small structured blobs.
- **PGP/OpenPGP** — envelope-formatted ciphertext with signatures, recipient identifiers, packet-based structure. Lots of historical baggage.
- **TLS records** — envelope framing for stream transmission, not at-rest storage.
- **AWS KMS "envelope encryption"** — narrower term: a data key encrypts the data, the master key encrypts the data key. This package does that internally in tier Standard, but the broader term is the full structured wrapper described above.

This package's envelope is tuned for **long-lived, structured, at-rest encryption** — application data that lives in a database or object store, survives library upgrades, and may be decrypted by a different client implementation than the one that wrote it. Different constraints than transport tokens (JWE) or streaming (TLS) or files (age), which is why none of those existing formats were quite the right fit.

---

## Primary product goal

**Make best-practice cryptography accessible to application developers. Help them add crypto-based features to their apps while avoiding the common implementation mistakes.**

Every API decision, error message, doc page, and default is evaluated against that goal. The library is not a general-purpose primitives toolkit (that's `@noble/*`); it is an opinionated layer above the primitives that makes the right thing easy and the wrong thing hard. The concrete list of mistakes the package prevents — with publicly-documented real-world cases and the package decisions that prevent each — is [`05-mistakes-prevented.md`](05-mistakes-prevented.md). That list is the design justification.

## Maintenance posture — honest

This is a small-org / single-maintainer project. It needs to be positioned accordingly:

- **Primary use is internal.** The package will be maintained as needed for chaoskb, trellis, and any other de-otio projects that depend on it. If those projects evolve or retire, maintenance follows that evolution.
- **Public availability is for transparency and reference, not for guaranteed support.** MIT license, code on public GitHub, test vectors and envelope spec published — because crypto libraries earn trust only through review, and because the implementation embodies patterns that may be useful as teaching material. **This is not a promise of continued maintenance, SLAs, feature requests honoured, or external users supported.**
- **Forking is encouraged.** If the package stops moving and someone else needs a different direction, MIT is permissive on purpose. The wire format + test vectors are designed so a fork (or a reimplementation in a different language) can remain interoperable.
- **Security issues will be responded to on best-effort, while the package is still in internal use.** See [`04-governance-and-rollout.md`](04-governance-and-rollout.md) for the actual disclosure posture. Not a 72-hour SLA; a pledge to take reports seriously and communicate honestly about response capacity.
- **Automated review is the multiplier.** Best-effort human maintenance is realistic only because the repo will run the [anthropic-defense automated security pipeline](04-governance-and-rollout.md#automated-security-pipeline-required-from-day-one) from day one — AI-driven PR reviews, weekly codebase audits, interactive `@claude` security assistant, dependency scanning, secrets scanning. Runs continuously, costs $2–25/month, and catches in minutes what a part-time maintainer might miss for weeks.

This honest posture is actually a feature, not a weakness. Many successful internal-tools-made-public live with exactly this disclaimer (Google Guava, Airbnb's Enzyme before its retirement, Square libraries). It's less intimidating to publish than "we promise to be your crypto library partner," and it's truer.

## Why this is a different question from chaoskb-reuse

The chaoskb-reuse analysis treats the package as an internal-only refactor. A public release adds obligations that internal-only doesn't:

- Wire-format stability within majors (so published downstream users don't break)
- A disclosure process (not an SLA, but a real process)
- Semver discipline (no breaking changes within a major)
- Test vectors published as an artifact other implementations can check against
- Ecosystem positioning vs. libsodium-js, @noble/*, age-js, tink-js, jose

These are real costs, but they're lower under the "internal tool, public for transparency" posture than under a "we're selling this as a product" posture. That's why this question is worth asking: the marginal cost of making the package public is smaller than it looks, and the value (Trellis's privacy story gets external reviewability, and the code as a reference resource has real worth) is non-trivial.

## Why this is a different question from chaoskb-reuse

The chaoskb-reuse analysis treats the package as an internal-only refactor. A public release adds obligations that internal-only doesn't:

- Wire-format stability guarantees across versions
- SECURITY.md + a real disclosure process
- Semver discipline (no breaking changes inside a major)
- Test vectors published as an artifact other implementations can check against
- Higher scrutiny — crypto libraries attract security researchers
- Ecosystem positioning vs. libsodium-js, @noble/*, age-js, tink-js, jose

None of these are show-stoppers; they're the cost of doing it right. The deeper question is whether de-otio wants to pay that cost in exchange for the upside (halo effect, supply-chain credibility for Trellis's privacy story, and — modestly — a public good for the indie dev community).

## Contents

1. [**Ecosystem gap**](01-ecosystem-gap.md) — what exists (libsodium-js, @noble, age, tink, jose, Signal/MLS), what each does well, and the specific niche an envelope library fills.
2. [**De Otio alignment**](02-de-otio-alignment.md) — how this package serves each de-otio value (AI-first, Lebensfreude, infrastructure-provider role, privacy-forward), and how it sits alongside `@de-otio/agent-safety-pack` in a coherent "@de-otio libraries for agent-built private apps" lineup.
3. [**Package design**](03-package-design.md) — target users, API surface, naming options, what comes along from chaoskb and what stays behind, platform integration boundaries.
4. [**Governance and rollout**](04-governance-and-rollout.md) — license, repo, publishing (provenance + Trusted Publishing per de-otio's own supply-chain guidance), semver and wire-format policy, test vectors as an artifact, disclosure process, phased roadmap (v0.x internal → v1.0 public → v1.x additive), risks and mitigations, migration plan for chaoskb and trellis.
5. [**Common mistakes the package prevents**](05-mistakes-prevented.md) — the design justification. Each common application-level crypto mistake named, with a publicly documented real-world case, and the concrete package decision that prevents it. Expected to grow.

## How to read this

- Start with [`02-de-otio-alignment.md`](02-de-otio-alignment.md) if you want to decide whether this is a de-otio-shaped project at all.
- Read [`01-ecosystem-gap.md`](01-ecosystem-gap.md) if you want to check whether the market gap is real.
- Read [`03-package-design.md`](03-package-design.md) if you want to know what the package actually does.
- Read [`04-governance-and-rollout.md`](04-governance-and-rollout.md) to understand the commitment.

No implementation happens from this doc. It's for a go/no-go decision and, if go, a shape for v0.1.
