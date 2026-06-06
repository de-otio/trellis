---
title: Voting security
description: The security model behind Trellis's verifiable, privacy-preserving voting — ballot secrecy, end-to-end verifiability, coercion resistance, and the cryptography that delivers them.
sidebar: Voting security
order: 51
---

# Voting security

Trellis's [voting design](voting-design.md) is built to deliver three properties
that are normally in tension: ballots stay secret, every voter can confirm their
own vote was counted, and anyone can verify the final tally — all at once. This
page describes the security model that makes that possible. It follows the
principles of end-to-end verifiable election protocols in the
[ElectionGuard](https://www.electionguard.vote/) lineage.

## Ballot secrecy

A voter's choices must never be linkable to their identity.

- **Cryptographic separation.** Authentication is separated from ballot
  encryption: the token that proves who you are is never correlated with the
  ciphertext of how you voted.
- **No identity/content joins.** Participation ("did this person vote") is stored
  apart from ballot content ("what the ballot says"). The two are never stored
  together, and audit records cover participation only — never vote content.
- **Vote mixing.** Before any decryption, ballots are cryptographically
  re-encrypted and shuffled through a mix network, breaking the correlation
  between a voter and their ballot.
- **Threshold decryption.** Decryption keys are split among independent trustees,
  so no single party can decrypt anything on their own.

## End-to-end verifiability

- **Individual verifiability.** Each voter receives a verification code they can
  use — from a web interface or a verification app — to confirm their ballot was
  included in the tally.
- **Universal verifiability.** The election publishes cryptographic proofs that
  let anyone independently verify the tally is correct, without trusting the
  operator.
- **Challenge ballots.** A voter can challenge (spoil) a ballot to check that
  their device encrypted their choice correctly. A challenged ballot is excluded
  from the tally, and the voter casts a fresh one.
- **Homomorphic tallying.** Encrypted ballots are aggregated without decrypting
  any individual ballot.

## Coercion resistance

A voter who is pressured into a particular choice can quietly recast their vote
while the election remains open. Because no one — including the voter — can
produce a proof of how they ultimately voted, coercion loses its leverage.

## Cryptographic building blocks

The model is assembled from well-studied public primitives:

| Component | Primitive |
|---|---|
| Vote encoding | ElGamal encryption (homomorphic) |
| Validity proofs | Chaum–Pedersen zero-knowledge proofs (each selection is 0 or 1) |
| Non-interactive proofs | Fiat–Shamir heuristic |
| Tally decryption | Threshold cryptography across independent trustees |
| Anonymization | Verifiable re-encryption mix network |

Each ballot is encrypted with a fresh nonce, accompanied by zero-knowledge proofs
that every selection is valid and that the ballot as a whole respects the
election's selection limits. Mixing, aggregation, and decryption each emit their
own proofs, so every step of the pipeline is independently checkable.

### Election key ceremony

Election keys are generated per election in a key ceremony: multiple independent
trustees each generate a key share, a public key is published for vote
encryption, and the private shares are distributed and never combined. Decrypting
the final tally requires a threshold of trustees to each contribute a partial
decryption, accompanied by a proof that the decryption was performed correctly.

## System integrity

- **Signed operations.** Critical operations are cryptographically signed.
- **Tamper-evident audit log.** Voting operations are recorded in an append-only,
  hash-chained log, so any modification to the history is detectable.
- **Signed configuration.** Election configurations are signed by administrators
  so they cannot be silently altered.

## Access control and separation of duties

Distinct roles have distinct, minimal capabilities, and the most sensitive
operations are deliberately split so that no single person holds end-to-end
control:

| Role | Can | Cannot |
|---|---|---|
| Voter | Cast, verify, and challenge their own ballot | See others' ballots or the running tally |
| Election administrator | Configure elections, view results after close | Decrypt ballots alone |
| Trustee | Hold a decryption key share | Decrypt without a quorum of other trustees |
| Auditor | Verify integrity and review audit logs | Modify anything |

Administrative actions require strong authentication.

## Threats considered

The model is designed against a spectrum of adversaries, with a mitigation for
each:

- **Vote manipulation** — defeated by cryptographic signatures, a tamper-evident
  log, and end-to-end verification.
- **Coercion** — defeated by coercion resistance: a voter cannot prove how they
  voted, and can recast.
- **Stolen credentials** — mitigated by strong authentication.
- **Insider manipulation** — defeated by separation of duties and threshold
  cryptography, so no single insider can alter or decrypt results.

## Looking ahead: post-quantum

The current encoding relies on classical public-key cryptography, which a future
large-scale quantum computer could threaten. The design anticipates a migration
path to post-quantum or hybrid schemes, tracking emerging NIST standards, so the
protocol can evolve without abandoning its verifiability guarantees.

## See also

- [Voting design](voting-design.md) — the data model, flow, and API
- [Voting user experience](../guides/voting-user-experience.md) — how voters cast and verify
- [Security architecture](../security-and-privacy/security-architecture.md) — the platform's broader posture
