# Crypto Comparison: `@trellis/crypto` vs. `chaoskb/src/crypto/`

| Aspect | `@trellis/crypto` today | `chaoskb/src/crypto/` |
|---|---|---|
| Files / LOC | 4 files (encryption-service, types, versioning, index) | 19 files, ~2,080 lines |
| AEAD | AES-256-GCM only | **XChaCha20-Poly1305** (192-bit nonce; AES-GCM kept decrypt-only) |
| KDF | PBKDF2; Argon2id "when available" | Argon2id at OWASP-2023 × 3.3 memory × 1.5 iterations (t=3, m=64MB, p=1) |
| Envelope format | Ad-hoc `EncryptedData` type | **Formal v1 spec** with test vectors, opaque blob ID, AAD-bound fields, key commitment HMAC |
| Key commitment | None | Dedicated Commitment Key via HKDF; HMAC-SHA256 bound to blob ID (prevents multi-key attacks) |
| Key derivation | Not documented | HKDF-SHA256 Extract+Expand with explicit context strings (`"chaoskb-content"`, `"chaoskb-metadata"`, …) |
| Verify-after-encrypt | None | Yes — 1Password / Standard Notes pattern catching serialization bugs |
| Canonical JSON | None | RFC 8785 before encryption |
| Secure memory | None | `SecureBuffer` wrapping `sodium_malloc` / `sodium_memzero` |
| Canary-verified keys | None | Known-plaintext canary validates full HKDF derivation pipeline |
| SSH-key wrap | None | `crypto_box_seal` over Ed25519-to-X25519 conversion |
| Post-quantum plan | None | ML-KEM-768 in multi-device key transfer |
| Tiered UX | None | Three tiers: SSH-wrap (default), BIP39 mnemonic, Argon2id-from-passphrase |

## Why the trellis-side library is underdeveloped

It was scoped around an abandoned single-purpose AES-GCM use case (a dual-profile decoy feature in a downstream product, see the trellis product repo). Its primitives are lower-quality than the modern standard because nobody has yet written the DM-encryption layer that would force them to be upgraded.

Modern concerns `@trellis/crypto` doesn't address:

- **GCM nonce birthday risk.** 96-bit nonces collide at ~2^48 encryptions; reuse is catastrophic. XChaCha20-Poly1305's 192-bit nonces make random collisions negligible (~2^96).
- **Multi-key attacks.** Standard AEAD doesn't commit to the key used — an attacker with two valid keys can produce a ciphertext that decrypts to different plaintexts under each. Key commitment (HMAC bound to blob ID) defends against this.
- **Silent serialization bugs.** Standard Notes lost user data in their 003 protocol migration due to a serialization mismatch. Verify-after-encrypt catches this class of bug before plaintext is discarded.
- **Blob substitution / version downgrade.** AAD binding the envelope's outer fields to the ciphertext prevents a malicious server from swapping blobs between IDs or downgrading the version / algorithm.

Full chaoskb crypto spec: [`chaoskb/doc/design/crypto.md`](../../../chaoskb/doc/design/crypto.md) and [`chaoskb/doc/design/envelope-spec.md`](../../../chaoskb/doc/design/envelope-spec.md) (with test vectors).
