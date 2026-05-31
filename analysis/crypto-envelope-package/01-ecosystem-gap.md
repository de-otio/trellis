# Ecosystem Gap

Question: does the TypeScript / Node.js ecosystem already have a library that does what `@de-otio/crypto-envelope` would do? If yes, no point shipping another one.

Short answer: **no**. The ecosystem has excellent *primitives* libraries and excellent *full-protocol* libraries, but nothing sits at the envelope layer with opinionated defaults, AAD binding, key commitment, a tier model, and published test vectors — the things where most application-level mistakes actually happen.

## What exists

| Library | Scope | Strengths | Why it doesn't fill the gap |
|---|---|---|---|
| **[@noble/ciphers](https://github.com/paulmillr/noble-ciphers)** + **noble-hashes / noble-curves / noble-post-quantum** | Auditable crypto primitives (ChaCha20-Poly1305, AES-GCM, Salsa, HKDF, Argon2, Curve25519, ML-KEM, …) | Reference-quality implementations, zero deps, tiny, audited, maintained by Paul Miller | Primitives only. No envelope format, no AAD convention, no key commitment helper, no tier model. User has to compose correctly — which is where Standard Notes lost data and where dozens of CVEs live. |
| **[libsodium-wrappers](https://github.com/jedisct1/libsodium.js) / sodium-native** | libsodium bound to Node/browser (WASM or native) | Mature, wide language coverage, standard reference | Still primitives. ~700KB WASM for the wrapper version; uncomfortable for indie/mobile. No envelope opinion. |
| **[tweetnacl-js](https://github.com/dchest/tweetnacl-js)** | Small NaCl/box primitives | Tiny, stable, decades of deployment | No AEAD-with-AAD story. No key commitment. Often superseded by @noble today. |
| **[age-encryption / age-js](https://age-encryption.org/)** | File encryption with recipient public keys | Excellent envelope design, stable wire format, interoperable with age CLI and rage | File-oriented — not fine-grained encryption of many small blobs. No tier-upgrade UX. No canary. Designed for streams/files, not a KB's worth of chunks. |
| **[tink-js](https://github.com/tink-crypto/tink-js)** | Google's cross-language crypto lib | Key rotation, KMS integration, good envelope discipline | Java-first; JS port is partial and less active. Complex API. Pulls in a lot. Not a fit for indie/local-first. |
| **[jose](https://github.com/panva/jose)** | JOSE / JWE / JWS / JWT | Widely adopted, standards-based | JOSE is the closest precedent to an "envelope" — but the JWE spec has 12-byte GCM nonces with no commitment, complex key-management options, and a design ethos oriented toward token exchange, not long-lived encrypted storage. |
| **Signal Protocol libraries** ([libsignal-client](https://github.com/signalapp/libsignal), MLS implementations) | Full session / group protocols | Best-in-class for messaging | Solving a different problem — stateful sessions, ratchets, delivery order. Overkill for "encrypt this blob to a known key." |
| **openpgp.js** | OpenPGP | Broad compatibility, email-focused | PGP envelope is historical; no AEAD-first defaults; baggage. |
| **aws-crypto / aws-encryption-sdk-js** | AWS KMS-backed encryption | Envelope done right, KMS integration | Tied to AWS KMS as the master-key custodian. Not a fit for client-side, keyless-server architectures. |

## The specific niche

An envelope library — not a primitives library — that:

1. **Picks sensible defaults so users don't have to.** XChaCha20-Poly1305 (not GCM). Argon2id (not PBKDF2). HKDF-SHA256 with explicit context strings. AAD binding version + blob ID + key ID + algorithm. Key commitment as a first-class field. Verify-after-encrypt always.
2. **Formalizes the wire format.** A versioned envelope schema (`v: 1`, `enc: {alg, kid, ct, commit}`, AAD = canonical JSON of outer fields) with published test vectors. Other-language implementations can interoperate.
3. **Handles the UX layer around keys.** The tier model (SSH-wrap for zero-config default; Argon2id passphrase for journalist/activist tier), tier upgrades, canary-verified key derivation, secure memory wrappers — the patterns that 1Password, Bitwarden, and Signal figured out and that no public library packages together. Multi-device key transfer is documented in the spec but left out of v1.0 scope (see [`03-package-design.md`](03-package-design.md)).
4. **Is TypeScript-first and agent-installable.** A single import; full types; an agent-friendly README that an AI coding agent can act on ("install `@de-otio/crypto-envelope`, initialize an `EnvelopeClient` at tier Standard, encrypt this payload"). The sibling `agent-safety-pack` does exactly this.
5. **Has zero or minimal runtime dependencies.** Prefer `@noble/*` as the primitives backend (tiny, audited, TypeScript-native) over libsodium-wrappers (WASM, heavier). Keeps the bundle small for browser / mobile consumers.

## Prior art the library should learn from

- **age** — wire format stability, interop discipline, minimal recipient types
- **Signal** — the ratchet is out of scope, but the *operational* patterns (safety numbers, canary pages, verify-after-encrypt) are gold
- **1Password** — the three-tier key-protection UX, canary, recovery-key discipline
- **Standard Notes** — cautionary tale for serialization bugs (RFC 8785 canonical JSON is the response)
- **age / rage** — explicit test vectors as a trust artifact

## Risk: is this niche real?

Two sanity checks.

**Search volume / demand signal.** Devs building local-first, zero-knowledge, or agent-context-storage apps today visibly reach for: age (but it's file-oriented), libsodium (but it's primitives), or roll their own (and get bitten). There's consistent discussion in local-first / Ink & Switch / p2p-panda / offline-first communities about the envelope layer being missing. That's not a proof of demand, but it's a signal.

**Would trellis and chaoskb consume it?** Yes — that's the `chaoskb-reuse/` analysis. Which means de-otio itself is the anchor tenant; shipping it publicly is additive, not speculative. The package has at least two internal users who will find every bug before strangers do. That's the right way to ship a crypto library.

**Could @noble absorb this?** Possibly — Paul Miller is explicit that noble is primitives-only by design. An envelope library living *above* noble (and using noble as its primitives backend) is the cleanest layering.
