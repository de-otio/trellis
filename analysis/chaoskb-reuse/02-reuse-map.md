# Reuse Map: ChaosKB Capabilities → Trellis Concerns

Each Trellis item already documented elsewhere has a chaoskb counterpart that's already built. The table is ordered by how much existing Trellis work chaoskb would unblock.

| Trellis item | What chaoskb already has |
|---|---|
| **[Spyware-defense P1.1](../spyware-defense/03-priorities.md)** — E2E DMs, flagged as "substantial project; defer full Signal Protocol / MLS" | Envelope format, AEAD with key commitment, HKDF hierarchy, Argon2id, canonical JSON, secure memory, verify-after-encrypt, canary. Most of the crypto plumbing is already built — the remaining work is the DM *protocol* (key exchange, ratchet) and UX (safety numbers). |
| **[Spyware-defense P3.2](../spyware-defense/03-priorities.md)** — client-side encryption of User fields with a passphrase (stretch goal) | This **is** chaoskb's Maximum tier. Full UX designed: zxcvbn ≥ 3, session-only caching with inactivity timeout, re-enter on timeout. Code exists. |
| **Encrypted travel-prep snapshots** (a downstream product feature keyed off `UserEncryptionKey.keyType`; see the border-safety feature in the trellis product repo) | Opaque-blob pattern fits exactly. Archive snapshot stored as encrypted blob keyed to user's master key; server learns nothing about what was archived. |
| **Tiered user security UX** (casual consumer vs. journalist/activist at border) | Three-tier Standard → Enhanced → Maximum mental model, with [formal tier-upgrade protocol](../../../chaoskb/doc/design/tier-upgrade.md). |
| **BIP39 recovery** — useful for at-risk users who may lose a device at a border | Already implemented — BIP39 mnemonic as an optional second recovery factor alongside SSH key. |
| **Multi-device key transfer** — relevant if a consumer product ever supports users on multiple phones | QR-code-out-of-band X25519 + ML-KEM-768 hybrid protocol, fully specced. |
| **Portability / shutdown guarantee** — aligns with [spyware-defense policy commitment](../spyware-defense/04-rollout-policy.md) on "no bulk data sale" and data portability | Chaoskb's explicit "shutdown guarantee" export mechanism is a drop-in pattern. |
| **Threat model document format** | Chaoskb's "What's Protected / What's NOT Protected" tabular format is cleaner than the current [spyware-defense narrative](../spyware-defense/01-threat-model.md). Worth adopting for consistency. |

## What this implies for effort estimates

Two spyware-defense items become materially cheaper if chaoskb's crypto is shared:

- **P1.1 (E2E DMs)** was flagged as "Quarter 2, substantial project." With chaoskb primitives in place, the primitive-level crypto is done and the work narrows to protocol + UX. Revised estimate: 2–4 weeks for an MVP rather than a quarter.
- **P3.2 (passphrase-derived client-side field encryption)** was flagged as "P3 stretch / never." With chaoskb's Maximum tier already implemented, this becomes a P2-level decision about *when* to expose it to users, not a question of whether the code exists.

The downstream border-safety feature's Phase 2 (in the trellis product repo) currently has a TODO — *"Snapshot storage? (Server-side, encrypted, tied to user)"* — that chaoskb's envelope pattern closes directly.
