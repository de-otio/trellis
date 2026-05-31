# Package Design

## Target users (in order of priority)

1. **Indie devs building private-by-default apps** — local-first knowledge bases, journals, notes, personal finance, end-to-end encrypted backups. The biggest population; the ones @noble-primitives-plus-a-README currently underserves.
2. **De Otio internal projects** — chaoskb, trellis, any future de-otio tool that needs to hold user data without being able to read it.
3. **B2B SaaS adding zero-knowledge backup/sync** — a small-but-valuable segment. Existing SaaS built on plaintext storage that wants to add an opt-in "you hold the key" tier. High willingness to pay for audit + support, if offered.
4. **AI agent context / memory storage** — agents increasingly want to persist memory server-side. Those memories contain user data. Envelope library makes it routine to do that without the agent operator ever seeing plaintext.
5. **Educational / reference** — the library's published test vectors + formal envelope spec become useful teaching material for "how to do envelope crypto right" courses / posts.

Not a target user: developers who want to build full messaging protocols, or who need FIPS-certified primitives, or who need KMS-backed master keys. Those ship elsewhere.

## API surface (sketch)

The library should have one primary entry point for the 95% case, plus clean sub-entry points for the tiering, key material, and low-level primitives.

```typescript
// 95% case: already have a key, want to encrypt/decrypt blobs
import { EnvelopeClient } from '@de-otio/crypto-envelope';

const client = new EnvelopeClient({ masterKey });  // 32-byte Uint8Array
const blob   = client.encrypt({ type: 'note', body: 'hello' });  // → { v, id, enc: {…} }
const back   = client.decrypt(blob);                              // → { type: 'note', body: 'hello' }

// Tiered key management (one step above the 95% case)
import { KeyRing } from '@de-otio/crypto-envelope';

const ring = await KeyRing.init({ tier: 'standard', sshPublicKey });
// ring.masterKey (SecureBuffer), ring.tier, ring.wrap()/unwrap()

// Upgrade to Maximum (passphrase-derived)
await ring.upgradeTo('maximum', { passphrase });

// Advanced: build your own flow from primitives
import { aead, hkdf, argon2, commitment, canonicalJson } from '@de-otio/crypto-envelope/primitives';
```

Three public surfaces:
- **`EnvelopeClient`** — the opinionated wrapper. Everyone uses this unless they have a specific reason not to.
- **`KeyRing`** — tier management, tier upgrades, SSH/passphrase integration. Stateful.
- **`/primitives`** — a stable but explicitly "you're on your own" sub-entry exposing aead, hkdf, argon2, commitment, canonical-json. For advanced users who want envelope-style discipline on a non-default shape.

Everything else (`SecureBuffer`, AAD construction, canary, verify-after-encrypt) is internal to `EnvelopeClient` / `KeyRing` and not exposed. Reducing surface area is a security property, not a convenience.

## Tier model — two tiers, not three

The package ships **two tiers** in v1.0:

| Tier | Master key protection | Recovery |
|---|---|---|
| **Standard** (default) | SSH public key wraps a CSPRNG-generated master key; wrapped copy may be stored server-side | SSH private key (via ssh-agent or `~/.ssh/`) |
| **Maximum** | Argon2id-derived from user passphrase (OWASP-2023 × 3.3 params) | Passphrase only; no escrow |

**The original chaoskb design had a third "Enhanced" tier** (BIP39 24-word mnemonic as a second recovery factor alongside SSH key). Chaoskb's maintainers deprecated it after concluding it added complexity without meaningful security benefit over Standard's SSH-based recovery (per the comment in `chaoskb/src/crypto/tiers/enhanced.ts`). The package inherits that decision — v1.0 ships with two tiers.

**But:** the Enhanced-tier reasoning is audience-specific. SSH keys are ubiquitous in chaoskb's developer audience; they are *not* ubiquitous in, e.g., a consumer-app audience built on Trellis, or any at-risk user segment (journalists, activists, travellers) who may deliberately avoid persistent cryptographic identity. If a downstream consumer wants BIP39 mnemonic recovery for that audience, the recommended path is:

- Add it as an **optional adapter** in a sub-entry (`@de-otio/crypto-envelope/adapters/bip39`) — wraps the master key to a 24-word mnemonic, unwraps on recovery, does not change the wire format.
- The core tier model stays two-tier; the adapter is opt-in per-application.

This keeps the core package small and the design clean while leaving the door open for audiences the deprecation reasoning doesn't serve.

## Multi-device key transfer — out of scope for v1.0

`chaoskb-reuse/02-reuse-map.md` described multi-device transfer as *"QR-code-out-of-band X25519 + ML-KEM-768 hybrid protocol, fully specced."* That's accurate for the chaoskb design doc, but the actual chaoskb implementation (`src/cli/tools/device-link-start.ts`, `device-link-confirm.ts`) uses `node:crypto` primitives, not the post-quantum hybrid.

v1.0 decision: **multi-device transfer is not a core package feature.** The envelope library's scope is encrypt/decrypt/tier-management. Multi-device key sharing is a protocol above the envelope layer, with significant UX implications (QR display on the source device, scan on the target, out-of-band verification) that don't generalise cleanly across consumer apps.

Consumers needing multi-device (e.g., a Trellis-based product if/when it adds web + mobile for the same account) have three paths:

1. Use the package's primitives directly with `@noble/curves` to build X25519 key exchange; the envelope layer wraps the result.
2. Adopt chaoskb's `device-link` CLI tool pattern as a reference implementation and port it to the consumer's framework.
3. Wait for v1.x — if multiple consumers end up needing this, it may graduate into an `@de-otio/crypto-envelope/adapters/device-link` sub-entry, at which point the spec-level ML-KEM-768 hybrid could be the implementation.

For a phone-centric pre-launch product specifically, this is a non-issue. Flag it as follow-up if/when multi-device ships.

## What comes along from chaoskb

From `chaoskb/src/crypto/` (19 files, ~2,080 lines), the 9-10 files that go into the public package:

| File | Role |
|---|---|
| `aead.ts` | XChaCha20-Poly1305 + AES-256-GCM decrypt-legacy |
| `argon2.ts` | Argon2id wrapper with OWASP-2023 parameters |
| `hkdf.ts` | HKDF-SHA256 Extract+Expand with context strings |
| `aad.ts` | RFC 8785 canonical AAD construction |
| `commitment.ts` | Key commitment HMAC |
| `envelope.ts` | v1 envelope encode/decode, verify-after-encrypt |
| `canonical-json.ts` | RFC 8785 implementation |
| `secure-buffer.ts` | Locked-memory key material |
| `types.ts` | Shared TS types |
| `encryption-service.ts` → `envelope-client.ts` | The `EnvelopeClient` façade (renamed for public audience) |

Plus the tier logic lifted from `chaoskb/src/crypto/tiers/` (not yet surveyed file-by-file but clearly exists per the directory listing) into `KeyRing`.

## What stays chaoskb-specific

These are product features of chaoskb, not primitives:

| File | Why it stays |
|---|---|
| `ssh-agent.ts` | Dev-workstation-specific; relies on `SSH_AUTH_SOCK`. Could reappear as an optional integration package later. |
| `invite.ts` | Chaoskb's sharing/invite feature |
| `project-keys.ts` | Chaoskb project-scoped KB feature |
| `known-keys.ts` | Chaoskb contact/recipient management |
| `blob-id.ts` | Opinion on ID format; de-otio public package should let the caller choose |
| `envelope-cbor.ts` | CBOR variant may or may not make v1.0 — still a product-scope decision |
| `keyring.ts` (chaoskb's, OS-keyring-specific) | Chaoskb handles OS keyring integration for its own persistence story |

`ssh-keys.ts` (Ed25519 → X25519 conversion + `crypto_box_seal`) is a borderline case. It's useful beyond chaoskb but drags in a philosophical choice about SSH-as-identity. Recommendation: include in the public package but behind an optional adapter — `import { SSHKeyAdapter } from '@de-otio/crypto-envelope/adapters/ssh'`. Can be removed if it turns out to be chaoskb-only.

## Naming options

| Name | Pros | Cons |
|---|---|---|
| `@de-otio/crypto-envelope` | Descriptive; matches what it is; easy to search | Slightly long; "envelope" might read as email to non-crypto readers |
| `@de-otio/aead-envelope` | More specific; signals the AEAD focus | Only crypto people know what AEAD is |
| `@de-otio/e2e-kit` | Friendly; agent-readable; matches "kit" naming (ink-kit, etc.) | Vague; could mean anything |
| `@de-otio/zero-envelope` | Evokes zero-knowledge | Also evokes "empty envelope" which is wrong |
| `@de-otio/crypto` | Short, matches `@noble/ciphers` tradition | Clashes mentally with Node's `crypto`; too broad |

Recommendation: **`@de-otio/crypto-envelope`**. Descriptive wins over clever for crypto; people searching for "how do I build an encrypted envelope in TypeScript" will find it. Keeps the door open to later siblings (`@de-otio/crypto-recipients`, etc.) if the scope ever grows.

## Platform scope

| Platform | Supported in v1.0? | Notes |
|---|---|---|
| Node.js 20+ | Yes | Primary target. Matches de-otio's existing Node baseline. |
| Modern browser (ES2022) | Yes | All primitives work via @noble. No polyfills required. |
| React Native | Yes, with `react-native-get-random-values` polyfill | Document clearly. Test in CI. |
| Deno | Yes | Via npm: specifier. Low extra cost. |
| Bun | Yes | Same. |
| Cloudflare Workers | Yes | crypto.subtle is available; no Node-specific APIs in the core. |
| Flutter / Dart | No (separate package needed) | The Dart port would consume the published test vectors for interop. That's actually the right shape — v1.x grows by adding language implementations that share the spec, not by one monster polyglot package. |

## The one hard rule

The wire format is frozen at v1.0. Any change that breaks the ability to decrypt a v1 envelope produced by v1.0 is a v2 envelope format — not a minor/patch bump. This is the single commitment that makes it safe for other implementations to depend on the package as an interop reference.
