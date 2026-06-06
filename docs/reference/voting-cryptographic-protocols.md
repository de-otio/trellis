---
title: Voting — Cryptographic Protocols
description: Formal specification of the ElGamal-based encryption, zero-knowledge proofs, mixing, aggregation, threshold decryption, and verification protocols used in Trellis voting.
sidebar: Voting Crypto
order: 60
---

# Voting — Cryptographic Protocols

This page specifies the cryptographic protocols underlying the Trellis voting
system. The system implements end-to-end verifiable voting using
ElectionGuard-compatible protocols.

For the system design and API, see [Voting Design](../concepts/voting-design.md).

---

## Cryptographic Primitives

### Encryption Scheme: ElGamal

**Purpose**: Homomorphic encryption for votes

**Parameters**:

- Large prime `p` (e.g., 4096-bit)
- Generator `g` of multiplicative group modulo `p`
- Public key `h = g^x mod p` where `x` is private key
- Private key `x` (distributed via threshold cryptography)

**Properties**:

- Homomorphic: `E(m1) * E(m2) = E(m1 + m2)`
- Semantic security
- Efficient zero-knowledge proofs

---

### Zero-Knowledge Proofs

#### Chaum-Pedersen Proof

**Purpose**: Prove that an encryption is of a specific value without revealing the value.

**Statement**: Prove that `(α, β) = (g^r, h^r * g^m)` is an encryption of `m` without revealing `r` or `m`.

**Protocol**:

1. Prover generates random `w`, computes `(a, b) = (g^w, h^w)`
2. Prover computes challenge `c = H(α, β, a, b)`
3. Prover computes response `v = w + c*r mod q`
4. Verifier checks: `g^v = a * α^c` and `h^v = b * (β/g^m)^c`

---

#### Disjunctive Chaum-Pedersen Proof (OR Proof)

**Purpose**: Prove that an encryption is of one of two values (0 or 1) without revealing which.

**Statement**: Prove that `(α, β)` encrypts either 0 or 1.

**Protocol**:

1. For the selected value `b ∈ {0,1}`:
   - Generate proof that encryption is of `b` (Chaum-Pedersen)
   - Generate simulated proof for `1-b` (using Fiat-Shamir)
2. Verifier checks both proofs

**Application**: Prove that a vote selection is valid (0 = not selected, 1 = selected)

---

#### Fiat-Shamir Heuristic

**Purpose**: Convert interactive proofs to non-interactive proofs.

**Method**: Replace verifier's random challenge with hash of public values.

**Application**: All zero-knowledge proofs in the system are non-interactive.

---

## Vote Encryption Protocol

### Input

- Election public key: `h`
- Voter selections: `s[i] ∈ {0,1}` for each option `i`
- Ballot nonce: `n` (unique random value)

### Process

1. **For each option `i`**:
   - Generate random `r[i]`
   - Compute encryption: `(α[i], β[i]) = (g^r[i], h^r[i] * g^s[i])`
   - Generate zero-knowledge proof: `π[i]` proving `s[i] ∈ {0,1}`

2. **Generate ballot proof**:
   - Prove that sum of selections equals selection limit `L`
   - Use homomorphic property: `E(Σs[i]) = E(L)`

3. **Generate verification code**:
   - Compute: `code = H(electionId, α[1..n], β[1..n], n)`
   - Format as human-readable (word + alphanumeric)

### Output

- Encrypted ballot: `{(α[i], β[i], π[i])}`
- Ballot proof: `π_ballot`
- Verification code: `code`
- Ballot nonce: `n` (encrypted and included)

---

## Vote Mixing Protocol (Anonymization)

### Purpose

Break the link between voter identity and vote content through cryptographic
mixing.

### Mix Network

**Input**: Encrypted votes `V[j] = {(α[j,i], β[j,i])}` with voter correlation

**Process** (for each mixing server):

1. **Re-encryption**: For each vote, generate new random `r'` and compute:
   - `α'[j,i] = α[j,i] * g^r' mod p`
   - `β'[j,i] = β[j,i] * h^r' mod p`
2. **Shuffling**: Randomly permute the order of votes
3. **Mixing Proof**: Generate zero-knowledge proof that:
   - All input votes are present in output (no votes lost)
   - Output votes are valid re-encryptions
   - Shuffling was performed correctly
4. **Output**: Re-encrypted and shuffled votes

**Properties**:

- Breaks voter-vote correlation
- Provides stronger privacy guarantees
- Verifiable mixing (proofs of correctness)
- Multiple mixing servers increase security

### Mixing Proof

**Purpose**: Prove that mixing was performed correctly without revealing permutation.

**Protocol**:

1. Generate proof that all input votes are present in output
2. Generate proof that output votes are valid re-encryptions
3. Generate proof of correct shuffling (without revealing permutation)
4. Verifier can check mixing correctness

---

## Vote Aggregation Protocol

### Homomorphic Addition

**Input**: Mixed encrypted votes `V[j] = {(α[j,i], β[j,i])}` (after mixing)

**Process**:

1. For each option `i`:
   - Compute: `α_total[i] = Π α[j,i] mod p`
   - Compute: `β_total[i] = Π β[j,i] mod p`
2. Result: `E(Σ votes[i]) = (α_total[i], β_total[i])`

**Properties**:

- No decryption required
- Preserves vote privacy
- Efficient computation
- Works on mixed votes (voter-vote correlation already broken)

### Aggregation Proof

**Purpose**: Prove that aggregation was performed correctly.

**Protocol**:

1. Compute intermediate values for each vote
2. Generate proof that aggregation follows homomorphic addition
3. Verifier can check aggregation correctness

---

## Threshold Decryption Protocol

### Key Generation (Key Ceremony)

**Participants**: `n` trustees (e.g., n=5)

**Process**:

1. Each trustee `j` generates:
   - Private key share: `x[j]` (secret)
   - Public key share: `h[j] = g^x[j] mod p`
2. Combined public key: `h = Π h[j] mod p`
3. Each trustee verifies key shares
4. Threshold: Requires `t` of `n` trustees (e.g., t=3)

**Security**: No single trustee can decrypt votes alone.

---

### Partial Decryption

**Input**: Encrypted tally `(α, β)` for option `i`

**Process** (for trustee `j`):

1. Compute partial decryption: `M[j] = α^x[j] mod p`
2. Generate proof: `π[j]` proving `M[j] = α^x[j]` (Chaum-Pedersen)
3. Publish: `(M[j], π[j])`

**Verification**:

- Anyone can verify: `g^v = a * α^c` where proof is `(a, v, c)`
- Confirms trustee performed decryption correctly

---

### Decryption Combination

**Input**: Partial decryptions `M[j]` from `t` trustees

**Process**:

1. Select `t` valid partial decryptions
2. Combine using Lagrange interpolation:
   - `M = Π M[j]^λ[j] mod p` where `λ[j]` are Lagrange coefficients
3. Compute final tally: `m = β / M mod p`

**Result**: Decrypted vote count for option `i`

---

## Verification Protocols

### Individual Vote Verification

**Input**: Verification code `code`

**Process**:

1. Lookup encrypted ballot using `code`
2. Verify ballot proofs:
   - Each selection proof (0 or 1)
   - Ballot proof (sum equals limit)
3. Check inclusion in tally:
   - Verify ballot was included in aggregation
   - Verify aggregation was correct

**Output**: Confirmation that vote was counted correctly

---

### Public Election Verification

**Input**: Election record (all encrypted ballots, proofs, decryptions)

**Process**:

1. **Ballot Verification**:
   - For each ballot, verify selection proofs
   - Verify ballot proofs
   - Verify all ballots are properly formed

2. **Mixing Verification** (if vote mixing enabled):
   - Verify mixing proofs for each mixing server
   - Verify all input votes are present in output
   - Verify shuffling was performed correctly
   - Verify re-encryption was performed correctly

3. **Aggregation Verification**:
   - Verify aggregation proofs
   - Verify homomorphic addition was correct

4. **Decryption Verification**:
   - Verify each partial decryption proof
   - Verify decryption combination
   - Verify final tally matches decrypted values

**Output**: Overall verification status (PASS/FAIL)

---

## Challenge Ballot Protocol

### Purpose

Allow voters to verify that their ballot was encrypted correctly without
revealing their vote to the system.

### Process

1. **Voter Challenges**:
   - Provides verification code
   - System marks ballot as challenged

2. **Ballot Decryption**:
   - System decrypts challenged ballot (using election keys)
   - Reveals vote selections to voter

3. **Verification**:
   - Voter verifies decrypted selections match their choices
   - Confirms encryption was correct

4. **Exclusion**:
   - Challenged ballot excluded from final tally
   - Voter can cast new vote (if election still open)

### Security Properties

- System cannot distinguish challenge ballots from regular ballots before challenge
- System must assume any ballot might be challenged
- Prevents manipulation (system can't modify votes without detection)

---

## Key Management

### Key Generation

**Ceremony Requirements**:

- Multiple independent trustees
- Secure communication channels
- Verification of key shares
- Public key publication

**Security**:

- No single point of failure
- Threshold cryptography
- Verifiable key generation

---

### Key Storage

**Requirements**:

- Private keys never stored in plaintext
- Hardware Security Modules (HSM) or cloud KMS
- Encrypted backups
- Key rotation procedures

**Implementation**:

- Cloud KMS (AWS KMS, Google Cloud KMS)
- FIPS 140-2 Level 3 validation
- Key access logging
- Separation of key storage from application

---

### Key Rotation

**Procedure**:

- New keys for each election
- Old keys securely deleted after retention period
- Key material never reused

---

## Hash Functions

### Requirements

- **Cryptographic Hash**: SHA-256 or SHA-3
- **Collision Resistance**: 2^128 security level
- **Preimage Resistance**: 2^256 security level

### Applications

- Verification code generation
- Election record hashing
- Audit log chaining
- Proof challenges (Fiat-Shamir)

---

## Random Number Generation

### Requirements

- **Cryptographically Secure**: Use CSPRNG
- **Nonce Generation**: Unique per ballot
- **Key Generation**: Secure random for key shares

### Implementation

- Platform CSPRNG (e.g., `/dev/urandom`, `crypto.getRandomValues()`)
- No predictable patterns
- Sufficient entropy

---

## Security Parameters

### Recommended Parameters

**Prime `p`**:

- Size: 4096 bits
- Generation: Safe prime (p = 2q + 1 where q is prime)
- Basis: ln(2) for prime generation

**Generator `g`**:

- Order: q (where p = 2q + 1)
- Verification: g^q = 1 mod p, g ≠ 1

**Threshold**:

- Trustees: 5
- Threshold: 3 (3 of 5 required)

**Vote Mixing**:

- Mixing Servers: 3-5 (recommended)
- Mixing Rounds: Multiple rounds for stronger privacy
- Mixing Proofs: Zero-knowledge proofs of correct mixing

---

## Post-Quantum Cryptography Considerations

### Quantum Threat

**Current Status**:

- ElGamal encryption is vulnerable to quantum computers (Shor's algorithm)
- Current security based on discrete logarithm problem (quantum-vulnerable)

### Migration Strategy

**Hybrid Approach**:

The system is designed for algorithm agility. A transition path exists from
classical ElGamal to hybrid classical/post-quantum schemes, and eventually to
fully post-quantum cryptography, without redesigning the overall protocol
structure.

### Post-Quantum Algorithms

**NIST PQC Standards** (monitoring):

- **Key Encapsulation**: CRYSTALS-Kyber, NTRU
- **Digital Signatures**: CRYSTALS-Dilithium, SPHINCS+
- **Homomorphic Encryption**: Research ongoing for post-quantum homomorphic schemes

### Implementation Considerations

**Design for Migration**:

- Modular cryptographic layer (easy to swap algorithms)
- Support for hybrid schemes during transition
- Backward compatibility considerations
- Performance impact assessment

---

## Protocol Security Properties

### Vote Privacy

- Individual votes cannot be linked to voters
- Even with decryption keys, voter identity separated
- Verification codes don't reveal vote content

### Vote Integrity

- Votes cannot be modified after casting
- Cryptographic signatures prevent tampering
- Audit logs provide tamper evidence

### Verifiability

- Individual voters can verify their vote
- Anyone can verify election integrity
- Cryptographic proofs enable independent verification

### Coercion Resistance

- Voters cannot prove how they voted
- Challenge mechanism prevents vote buying
- System cannot provide proof of vote

---

## Implementation Considerations

### Performance

- **Encryption**: ~10-50ms per vote (depending on options)
- **Aggregation**: O(n) where n is number of votes
- **Decryption**: O(t) where t is threshold
- **Verification**: O(n) for full election verification

### Scalability

- Batch processing for large elections
- Parallel processing where possible
- Efficient cryptographic operations

### Error Handling

- Invalid proofs rejected
- Malformed ballots rejected
- Cryptographic errors logged and reported

---

## References

- **ElectionGuard Specification**: [electionguard.vote](https://www.electionguard.vote/spec/)
- **ElGamal Encryption**: Original paper and standards
- **Zero-Knowledge Proofs**: Chaum-Pedersen, Fiat-Shamir
- **Threshold Cryptography**: Shamir's secret sharing
