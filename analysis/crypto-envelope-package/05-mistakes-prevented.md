# Common Mistakes the Package Prevents

The design justification for `@de-otio/crypto-envelope`. Each entry names a mistake class, cites a publicly documented case where it caused real harm, and identifies the concrete package decision that makes the mistake hard or impossible to commit.

This list is expected to grow — as new classes of mistakes appear (or are recognised as common), they belong here.

---

## Summary table

| # | Mistake | Publicly documented case | How the package prevents it |
|---|---|---|---|
| 1 | Nonce reuse in AEAD | Samba CVE-2020-14318 (SMB3.1.1); countless mobile-app CVEs | 192-bit random nonces (XChaCha20-Poly1305); nonce never user-controllable |
| 2 | Skipping AAD / version binding | Matrix Megolm room-key sharing issues (2022); "E2EE" SaaS blob substitution | AAD is mandatory and auto-constructed from envelope outer fields |
| 3 | Same key for encryption and MAC/commitment | Partitioning Oracle Attacks (Grubbs–Lu–Ristenpart 2021); Shadowsocks CVE | Dedicated Commitment Key derived via HKDF with distinct context string |
| 4 | Silent serialization bugs | Standard Notes 003 protocol data loss (2020) | RFC 8785 canonical JSON + verify-after-encrypt, both mandatory |
| 5 | Weak KDF parameters | LastPass breach (2022) — 5,000-iteration PBKDF2 vaults | Argon2id at OWASP-2023 × 3.3 memory × 1.5 iterations; no weaker option |
| 6 | Timing attacks on key/tag comparison | Lucky 13 (2013), Bleichenbacher family, various padding oracles | Constant-time comparisons throughout; no user-callable non-CT path |
| 7 | Keys leaked via swap / crash dumps | Mobile forensic tooling routinely recovers keys from memory images | `SecureBuffer` over `sodium_malloc`/`sodium_memzero`; zeroise on drop |
| 8 | Weak/predictable RNG for nonces/keys | Android SecureRandom Bitcoin-wallet drains (2013); Debian OpenSSL (2008) | CSPRNG only (`crypto.getRandomValues` / `randomBytes`); no user-callable RNG for security-sensitive values |
| 9 | Silent decryption failure | iOS goto-fail (CVE-2014-1266); caught-and-ignored exceptions in app code | Canary + key commitment verified *before* ciphertext is touched; decrypt either returns valid plaintext or throws |
| 10 | Algorithm / version downgrade | POODLE (CVE-2014-3566); various TLS downgrade attacks | Version + algorithm bound in AAD; tamper = decrypt failure |
| 11 | No forward-compat version field | Keyczar upgrade friction; many unnamed internal app breakages | Mandatory `v` field; strict reject of unknown versions |
| 12 | Cross-implementation serialization drift | Standard Notes 003 again; any JSON-based crypto without canonicalization | RFC 8785 canonical JSON + published test vectors |

---

## Expanded entries

### 1. Nonce reuse in AEAD

**The mistake.** AEAD constructions like AES-GCM and ChaCha20-Poly1305 require a unique nonce per encryption under the same key. Reusing a nonce leaks the XOR of two plaintexts (confidentiality) and, for GCM, the authentication key itself (integrity — allows forgery of arbitrary ciphertexts).

**Real case.** Samba CVE-2020-14318 reused nonces in SMB3.1.1 encryption; allowed attackers to recover plaintext from captured traffic. AES-GCM's 96-bit nonce means random nonces collide with birthday-bound probability at ~2^48 encryptions — catastrophic for any long-lived system.

**Prevention.** XChaCha20-Poly1305 with 192-bit nonces — random collision probability is ~2^96, negligible across any realistic deployment lifetime. The nonce is generated internally by the library (from `crypto.getRandomValues` / `randomBytes`) and is never user-controllable. There is no `encryptWithNonce(nonce, plaintext)` entry point for a developer to misuse.

### 2. Skipping AAD / version binding

**The mistake.** Encrypting a payload without binding the context (version, blob ID, algorithm, recipient) to the ciphertext allows an attacker who can observe or substitute ciphertexts to perform blob-substitution, version-downgrade, or algorithm-confusion attacks — all of which leave the AEAD tag check intact.

**Real case.** Matrix's Megolm ratchet had room-key sharing issues documented in 2022 where message context wasn't fully bound, allowing cross-room replay. "E2EE" SaaS products that encrypt user blobs often skip AAD entirely, allowing the server to swap ciphertexts between accounts.

**Prevention.** AAD is mandatory and auto-constructed from the envelope's outer fields (`v`, `id`, `alg`, `kid`) as RFC 8785 canonical JSON. Applications cannot skip it; they cannot even opt out. Tampering with any outer field causes the AEAD tag check to fail at decrypt time.

### 3. Same key for encryption and MAC/commitment

**The mistake.** AEAD ciphertexts are not committing — an attacker with two valid keys can sometimes produce a single ciphertext that decrypts to meaningfully different plaintexts under each key. Using the same key for encryption and any separate integrity check (MAC, commitment HMAC) makes the problem worse by violating key separation.

**Real case.** *Partitioning Oracle Attacks* (Grubbs, Lu, Ristenpart, USENIX Security 2021) demonstrated real exploits against Shadowsocks and various password-based AEAD schemes.

**Prevention.** A dedicated Commitment Key is derived via HKDF with a distinct context string (`"chaoskb-commit"`). The commitment HMAC-SHA256 binds the key to the ciphertext *and the blob ID*, preventing both multi-key attacks and blob substitution. Key separation is enforced by the API — the encryption path and the commitment path each take their own typed key, so mixing them requires deliberately subverting the type system.

### 4. Silent serialization bugs

**The mistake.** JSON and similar structured-data formats admit multiple byte-level serializations of the same logical value (key order, whitespace, number formatting). Encrypting one serialization and attempting to decrypt a semantically-identical but byte-different serialization produces garbage or decryption failures, and attackers can exploit the mismatch.

**Real case.** Standard Notes 003 protocol migration (2020) — a JSON serialization mismatch between platforms caused data loss for real users. Public post-mortem.

**Prevention.** Plaintext is canonicalized per RFC 8785 (JSON Canonicalization Scheme) before encryption — sorted keys, no whitespace, deterministic number formatting. Verify-after-encrypt runs every encryption through an immediate decrypt-and-compare, aborting if the round-trip fails. This catches serialization bugs before the original plaintext is released from memory.

### 5. Weak KDF parameters

**The mistake.** Key derivation from low-entropy inputs (passwords, passphrases) requires a memory-hard KDF with parameters that make brute-force attacks expensive. Using PBKDF2 with low iteration counts, or bcrypt with low work factors, makes offline brute-force feasible on any captured ciphertext.

**Real case.** LastPass breach (2022) exfiltrated encrypted vaults. Many vaults used 5,000-iteration PBKDF2 (the LastPass default for years), brute-forceable on consumer GPUs. Users with strong master passwords remained safe; users with common passwords lost their vaults.

**Prevention.** Argon2id at OWASP-2023 × 3.3 memory × 1.5 iterations (t=3, m=64 MB, p=1). No weaker option exists in the API — callers can pick stronger parameters for the same tier, but cannot pick weaker. PBKDF2 is not exposed.

### 6. Timing attacks on key/tag comparison

**The mistake.** Comparing secret values with `==` or `memcmp` leaks information about matching prefix length through response timing. Exploited over networks and against co-resident processes.

**Real case.** Lucky 13 (Rizzo–Duong 2013, TLS CBC); long family of Bleichenbacher-style attacks; cache-timing attacks on AES T-table implementations (Bernstein 2005). Any comparison of auth tags, MACs, or keys is exposed to this.

**Prevention.** All secret comparisons go through constant-time paths: `crypto.timingSafeEqual` (Node), `sodium.crypto_verify_*` (libsodium backends). There is no user-callable non-constant-time comparison on secret material anywhere in the public API.

### 7. Keys leaked via swap / crash dumps

**The mistake.** Holding key material in ordinary heap memory allows it to be paged to swap, captured in crash dumps, or recovered by forensic memory tooling long after the key was "forgotten."

**Real case.** Mobile device forensics routinely recovers cryptographic keys from memory images of seized or compromised devices. Heartbleed (2014) demonstrated that process memory is readable far more often than developers assume.

**Prevention.** Key material lives in `SecureBuffer` — a thin wrapper that allocates via `sodium_malloc` (or the platform equivalent), which calls `mlock`/`VirtualLock` to prevent swap, marks pages as excluded from core dumps where supported, and zeroes memory on drop via `sodium_memzero`. Applies to master keys, all derived keys, and any plaintext that itself contains keys.

### 8. Weak/predictable RNG for nonces/keys

**The mistake.** Using `Math.random()`, `Random()`, or any non-cryptographic PRNG for nonces, keys, salts, or IDs lets attackers predict or recover the secret values.

**Real case.** Android `SecureRandom` bug (2013) used a predictable seed; Bitcoin wallet apps using the standard APIs lost funds to theft. Debian OpenSSL RNG bug (CVE-2008-0166) seeded only with PID for 20 months, generating ~32,000 possible keys for every SSL/SSH deployment on affected systems.

**Prevention.** All random values come from the platform CSPRNG — `crypto.getRandomValues` (browser, Deno, Bun, Workers), `crypto.randomBytes` (Node). There is no user-callable RNG entry point for nonces or keys; the library generates them internally. A single use of `Math.random()` anywhere in the source would be caught by review — the `/primitives` entry point is explicitly not an RNG.

### 9. Silent decryption failure

**The mistake.** Catching a decryption exception and continuing with whatever bytes remain, or skipping the tag check entirely, causes the application to process attacker-controlled garbage as if it were valid plaintext.

**Real case.** iOS "goto fail" (CVE-2014-1266) — a misplaced goto caused certificate signature verification to be skipped entirely. Same class of mistake appears in application code whenever developers `try { decrypt(...) } catch { return defaultValue; }`.

**Prevention.** The key commitment HMAC is verified before AEAD decryption even begins — a bad key or tampered ciphertext is rejected at the outer layer. Decrypt either returns valid plaintext or throws a specific `DecryptionFailure` error with a didactic message naming the likely cause (wrong key, tampered envelope, algorithm mismatch). There is no "returns undefined on failure" path.

### 10. Algorithm / version downgrade

**The mistake.** Allowing an attacker to force the use of a weaker algorithm, or to rewrite a new-format ciphertext as old-format, undoes the security gained by adopting the stronger primitives.

**Real case.** POODLE (CVE-2014-3566) forced TLS clients to fall back to SSL 3.0, which had a padding oracle. Widely exploited before the fix rolled out.

**Prevention.** The envelope `v` and `enc.alg` and `enc.kid` fields are bound into the AAD. Tampering with any of them changes the AAD, the AEAD tag fails, decryption aborts. Decryption also rejects unknown `v` values outright — the library never accepts "let's try a default version" fallback.

### 11. No forward-compat version field

**The mistake.** A binary envelope format without an explicit version prefix is unupgradeable — any future protocol change either breaks all existing data or requires heuristic detection that invites bugs.

**Real case.** Numerous unnamed internal-app breakages when a developer "improves" the crypto and realises the deployed users have data in the old format with no way to tell.

**Prevention.** Every envelope carries `"v": 1` as the first field. Unknown versions are a hard reject at decrypt. The wire format is frozen at v1.0; any incompatible change is a v2 format and a package-major bump. Downstream code can `switch (envelope.v)` cleanly across versions when migration becomes needed.

### 12. Cross-implementation serialization drift

**The mistake.** When the same envelope must be produced or consumed by multiple implementations (TypeScript server, Dart mobile client, another language for export/import), small differences in how each language serializes the inner plaintext structure cause decryption failures or — worse — silent data corruption.

**Real case.** Standard Notes 003 again — cross-platform JSON serialization mismatch was one of the factors.

**Prevention.** RFC 8785 canonical JSON for every structured plaintext before encryption. Published test vectors exercise the round-trip across multiple payload shapes, including the edge cases (empty objects, nested structures, numeric edge values). Any implementation in any language can verify interop by decrypting the vectors and comparing against the documented plaintext.

---

## What this list does not cover

Important to be explicit. A library at the envelope layer can prevent the mistakes above. It cannot prevent:

- **Endpoint compromise.** If the attacker owns the device running the library, they own the plaintext in memory, the master key in the keyring, and anything rendered on screen. Out of scope for any crypto library.
- **Protocol-level mistakes above the envelope.** Key exchange, identity verification, forward secrecy via ratcheting, group membership — none of these are envelope concerns. Applications that need them (e.g. real-time messaging) need a protocol library in addition (Signal Protocol, MLS).
- **Side-channel attacks on the host.** Spectre-class CPU side channels, electromagnetic emanations, acoustic cryptanalysis — hardware / OS layer.
- **Implementation bugs in this package.** Crypto libraries can ship bugs. The response is external review, test vectors, canary blobs in production, and public security reporting — not a promise of bug-free code. See [`04-governance-and-rollout.md`](04-governance-and-rollout.md) for the disclosure process.
- **Weak passphrases at the Maximum tier.** No KDF saves a user who picks "password123." The library enforces zxcvbn ≥ 3 and a minimum length, but determined weakness is still possible. The UX can only push so hard before it stops being a passphrase.
- **Key loss.** By design. The package does not implement server-side key escrow. Lose your recovery factor (SSH key for Standard tier, passphrase for Maximum tier) and the data is gone. Documented as a feature, not a gap. Consumers whose audience can't rely on SSH keys may add a BIP39 mnemonic recovery adapter (see [`03-package-design.md`](03-package-design.md#tier-model--two-tiers-not-three)); that's a per-consumer decision, not a core package concern.

---

## How this list maintains itself

This document is expected to grow over time. New classes of mistake become recognised (e.g., the 2021 partitioning-oracle paper was not a well-known mistake class in 2018). Each addition follows the same format: name the mistake, cite a publicly documented case, name the package decision that prevents it.

A mistake that the package *cannot* prevent should be added to the "does not cover" section above, with a clear explanation of why it's out of scope. The list serves a double duty: it's the positive case for the package, and also the honest statement of its limits.

Cross-reference: each entry in [`03-package-design.md`](03-package-design.md) that describes an API or wire-format decision should eventually link back to the mistake class it prevents. That makes the package design traceable — every choice has a named justification.
