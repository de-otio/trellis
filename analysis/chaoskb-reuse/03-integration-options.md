# Integration Options

Four options, ranked by recommendation.

---

## Option A (recommended): Extract the crypto module into a shared package

1. Lift `chaoskb/src/crypto/` into a standalone npm package — `@de-otio/crypto-envelope` or similar, published to the dot/npm CodeArtifact registry alongside `@trellis/*`.
2. **Chaoskb** imports it as a dependency — no runtime-behavior change.
3. **Trellis** replaces `@trellis/crypto` internals with this package. The existing `EncryptionService` façade stays for API compatibility but now wraps XChaCha20-Poly1305 + key commitment + AAD + verify-after-encrypt.
4. Spyware-defense P1.1 (E2E DMs) and the downstream encrypted-archive feature now have a ready crypto layer. Work narrows to *protocol and UX*, not primitives.

**Cost:** medium — mostly moving files and aligning build tooling. Both codebases are TypeScript with similar conventions. CodeArtifact publishing is already set up for trellis.

**Risk:** chaoskb remains private; publishing to a private CodeArtifact registry is fine, but if chaoskb ever open-sources, the boundary between shared package and chaoskb-specific code needs to stay clean from day one.

**Upside:** every security-critical app in the dot/npm org shares one audited crypto primitive library; avoids two parallel implementations drifting.

---

## Option B: Use chaoskb's design as a specification for trellis

Don't share code; re-implement in trellis based on chaoskb's docs (which are already specification-grade). Lower integration cost, higher drift risk, two implementations to keep in sync. Not recommended unless there's a reason to keep chaoskb code out of trellis's supply chain.

---

## Option C: Integrate chaoskb as a client-side companion app

Ship chaoskb as-is alongside the product — users get both. Two apps, two sync protocols, confusing UX. Not recommended.

---

## Option D: Cherry-pick specific components

Pull only the envelope + `aead.ts` + `hkdf.ts` + commitment into trellis; skip the tier system. Reasonable if scope is narrow (e.g., only E2E DM, not the encrypted-archive feature), but Option A is only marginally more work and gets the whole set.

---

## Components worth pulling regardless of choice

These stand alone and are worth grabbing even if full integration is deferred:

| Component | Location in chaoskb | Why it's valuable |
|---|---|---|
| Envelope v1 spec + AAD binding | `doc/design/envelope-spec.md`, `src/crypto/envelope.ts`, `aad.ts` | Prevents blob substitution, version downgrade, key-ID confusion |
| Key commitment | `src/crypto/commitment.ts` | Defends against multi-key attacks modern AEAD doesn't catch on its own |
| Verify-after-encrypt | Embedded in `encryption-service.ts` | Catches silent serialization bugs (the Standard Notes 003 protocol data-loss bug) |
| Canary | Embedded in keystore logic | Catches wrong-key / keyring-swap scenarios that would otherwise silently produce garbage |
| Tier upgrade protocol | `doc/design/tier-upgrade.md` | Clean pattern for changing security posture on a live account — reusable in any consumer product |
| SSH-key wrap (ed25519 → x25519 → crypto_box_seal) | `src/crypto/ssh-keys.ts` | Lets trellis offer "Standard tier" E2E by default without any user-visible setup (dev-audience users already have SSH keys) |

---

## What to exclude from any shared package

Not everything chaoskb has is relevant to Trellis. These should **not** come along:

- `ssh-agent.ts` — chaoskb-specific; relies on `SSH_AUTH_SOCK` on dev workstations.
- `invite.ts`, `project-keys.ts`, `known-keys.ts` — chaoskb KB-sharing features, not applicable.
- `blob-id.ts`'s `b_`-prefixed CSPRNG IDs — may or may not want for trellis; separate decision.
- The MCP integration and pipeline layers — product-specific to chaoskb.

A clean extraction takes about **9 of the 19 files**: `aead.ts`, `argon2.ts`, `hkdf.ts`, `aad.ts`, `commitment.ts`, `envelope.ts` (and/or `envelope-cbor.ts`), `canonical-json.ts`, `secure-buffer.ts`, `types.ts`, plus `encryption-service.ts` as the façade. ~1,000 lines total.
