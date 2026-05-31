# Concept Sanity Check

External critical review of the package concept, written 2026-04-18 as a devil's-advocate pass over the rest of this doc set. Two questions only:

1. Does the concept make sense?
2. Why hasn't anyone else done this?

Intentionally independent of [`01-ecosystem-gap.md`](01-ecosystem-gap.md) and [`02-de-otio-alignment.md`](02-de-otio-alignment.md) — those argue *for* the package from the inside. This file tries to poke holes from the outside.

## Does the concept make sense?

Mostly yes. The "envelope layer above primitives, below protocols" slot is a real gap in the TypeScript ecosystem. Every application that stores encrypted blobs ends up reinventing AAD binding, nonce handling, versioning, and key commitment — and most get at least one of them wrong. The mistakes enumerated in the README and in [`05-mistakes-prevented.md`](05-mistakes-prevented.md) (nonce reuse, skipped AAD, partitioning oracle via missing key commitment, silent decryption failure, `Math.random` for keys) are all documented real-world failures, not straw men.

The stronger version of the claim: the library isn't selling a *primitive* (anyone can call XChaCha20-Poly1305) — it's selling a *set of defaults that can't be turned off*. That's a coherent product thesis. It lives or dies on whether the defaults are actually right, which the rest of this doc set and `chaoskb/doc/design/envelope-spec.md` spend most of their words on.

## Why hasn't anyone else done this?

The honest answer is that the slot is partially occupied, but poorly for this specific niche. Competitors and the reasons each leaves room:

- **JOSE / JWE** (`jose` in TS) — dominates the mental-model slot for "encrypt a structured blob in JS," but is notorious for footguns (`alg:none`, algorithm confusion, optional commitment, 96-bit GCM nonces with no MRAE story, base64url everywhere). Post-mortems routinely blame JOSE. It was designed for short-lived tokens, not long-lived at-rest storage.
- **Google Tink** — does almost exactly this in Java/Python/Go, including key commitment discipline. The TypeScript port was always second-class and has effectively atrophied. A well-maintained Tink-JS would arguably preempt this package; the fact that it doesn't exist is the gap.
- **libsodium-wrappers / `@noble/ciphers`** — primitives-only. No versioning, no AAD convention, no commitment, no canonical serialization. The envelope layer is exactly what they *don't* provide.
- **age** — excellent envelope design, but file-scoped and CLI-first. Not tuned for many small JSON blobs in a database.
- **AWS Encryption SDK** — envelope done well, but tied to KMS as the master-key custodian. Wrong shape for client-side / keyless-server architectures.

So part of the answer is "they have, badly." The more interesting part of the answer is **timing**. The security-relevant ingredients that make this package novel in combination are all recent:

- **Key-committing AEAD as a mandatory feature.** The attacks motivating this (Len–Grubbs–Ristenpart's partitioning-oracle work, USENIX 2021; Bellare–Hoang, EUROCRYPT 2022) are post-2020 research. Most production libraries haven't absorbed it yet, let alone made it non-optional.
- **RFC 8785 canonical JSON for AAD.** RFC 8785 was published in 2020. Prior to it, everyone rolled their own canonicalization and got subtle incompatibilities (Standard Notes is the canonical cautionary tale).
- **Verify-after-encrypt as a library-level default.** Belt-and-braces against library bugs in the primitive. Not standard in existing envelope libraries.

Combining all three into a single TS package where no caller can opt out of any of them is plausibly novel. It's not a coincidence that the gap has opened recently: the research that closes it is recent.

## Concerns worth resolving before the v1.0 freeze

These are the places where an external reviewer would push back hardest.

### 1. Scope bleed via `KeyRing`

Tiered key management (SSH-wrap default vs. Argon2id passphrase for journalist/activist tier) is an *application-UX* concern, not an *envelope-cryptography* concern. Bundling them into one package couples two things that age independently and appeal to partially non-overlapping audiences.

Consider splitting:
- `@de-otio/crypto-envelope` — envelope format, AEAD, commitment, AAD, canonicalization, secure memory. Stable wire format. Primary appeal: "safe AEAD envelope."
- `@de-otio/keyring` (or keep it in chaoskb) — tier model, upgrade flows, canary, SSH-wrap, passphrase KDF. Primary appeal: "a safe key-management UX for local-first apps."

The two-package shape matches how someone evaluating the library from the outside would think about the problem, and lets the envelope-layer product land without the tier-UX opinions attached.

If the decision is to keep them together, at minimum the design docs should make clear that `KeyRing` is a separable module that consumers can ignore.

### 2. Mandatory canonical JSON forces a shape on payloads

RFC 8785 canonicalization is the right choice for AAD binding, but making it mandatory for the *plaintext* means the library can't efficiently carry raw binary payloads, and inherits JSON's edge cases (BigInt, `-0`, `NaN`, `Date`, Map, Set, non-UTF-8 strings). Confirm every anticipated consumer (chaoskb blobs, trellis entries, future de-otio projects) is genuinely JSON-shaped, and document what happens if someone passes a `Uint8Array` or a `Date`.

### 3. Wire-format freeze at v1.0 is a strong commitment

CLAUDE.md and [`04-governance-and-rollout.md`](04-governance-and-rollout.md) already commit to wire-format stability within v1.x. That commitment is serious — it binds every future decision inside the major version, including ones driven by new research (post-quantum migration, new commitment schemes, canonicalization revisions).

The mitigation is `v` in the envelope; a v2 wire format can coexist. But the mitigation only works if v2 is a real possibility and not a reputational cost. Consider softening the stability promise to "stable after both chaoskb and trellis have shipped on it," giving real usage a chance to surface format issues before they become promises.

### 4. "Why is this a separate package at all?"

This is the question an external reader will ask first. The answer already exists in the README and in [`README.md`](README.md#maintenance-posture---honest): it's internal tooling, published for transparency and reviewability, not as a supported product. That framing is good, but it deserves to land prominently on the npm page and GitHub repo description as well, because the npm / GitHub readership is wider than the internal de-otio readership and will otherwise mistake it for a generic `jose` replacement.

### 5. Automated public scanning (threat model)

Because the repo is public, an adversary with a change-triggered AI scanner can attempt to find vulnerabilities on every commit, often within minutes. The mitigations are already partly in place:

- Pre-merge AI security review in CI (see commit `71d6def` wiring the application inference profile).
- Manual release step (no auto-publish from `main`) so a vulnerable commit does not immediately propagate to downstream consumers.
- Coordinated-disclosure patches staged in a private branch and landed atomically with the release.

These belong in [`04-governance-and-rollout.md`](04-governance-and-rollout.md) explicitly as part of the disclosure posture. The repo's public surface is itself a threat-model input and should be treated as one.

## Bottom line

- The gap is real. The design choices are defensible.
- The "nobody's done this in TypeScript" claim is closer to true than it looks, largely because the research that makes the combination interesting (key-committing AEAD, RFC 8785) is recent.
- The bigger risks are not the cryptography — they are scope (KeyRing), premature format commitment, and positioning clarity on npm.

None of these block shipping v0.1. They shape what v1.0 should look like.
