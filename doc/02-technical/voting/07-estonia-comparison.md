# Comparison with Estonia's IVXV Internet Voting System

**Part of**: [Secure Voting Feature](./README.md)  
**Status**: Design Document  
**Last Updated**: January 2025

---

## Overview

Estonia's IVXV (Internet Voting System) is one of the most mature and widely-deployed internet voting systems in the world, having been used in national elections since 2005. This document compares our secure voting design with Estonia's IVXV system to identify similarities, differences, and areas where we can learn from their experience.

---

## System Comparison Matrix

| Aspect                   | Estonia IVXV                  | Trellis Design                | Notes                                   |
| ------------------------ | ----------------------------- | ----------------------------- | --------------------------------------- |
| **Deployment**           | National elections since 2005 | Community polls/elections     | Different scale and legal requirements  |
| **Cryptography**         | ElGamal (homomorphic)         | ElGamal (homomorphic)         | ✅ Same encryption scheme               |
| **Verification**         | Individual + Universal        | Individual + Universal        | ✅ Both support E2E-V                   |
| **Vote Mixing**          | Yes (anonymization)           | No (cryptographic separation) | Different approach to privacy           |
| **Vote Overwriting**     | Yes (can vote again)          | No (one vote per voter)       | Different security model                |
| **Authentication**       | Estonian ID card (PKI)        | Platform authentication + MFA | Different identity systems              |
| **Challenge Ballots**    | No                            | Yes                           | Our design includes challenge mechanism |
| **Threshold Decryption** | Yes                           | Yes                           | ✅ Both use threshold cryptography      |
| **Open Source**          | Yes (since 2017)              | Planned                       | Estonia publishes source code           |
| **Audit Rate**           | ~4% of voters                 | Target: >50%                  | Our design emphasizes verification      |

---

## Detailed Comparison

### 1. Cryptographic Foundation

#### Estonia IVXV

- **Encryption**: ElGamal with homomorphic properties
- **Key Management**: Threshold cryptography with multiple trustees
- **Vote Mixing**: Cryptographic mixing to break link between voter and vote
- **Verification**: Individual verification (vote reached collector) + universal verifiability

#### Trellis Design

- **Encryption**: ElGamal with homomorphic properties (ElectionGuard-compatible)
- **Key Management**: Threshold cryptography (3 of 5 trustees)
- **Vote Mixing**: No mixing; relies on cryptographic separation of identity and vote
- **Verification**: Individual verification (verification code) + universal verifiability + challenge ballots

**Analysis**:

- ✅ **Same cryptographic foundation**: Both use ElGamal homomorphic encryption
- ⚠️ **Different privacy approach**: Estonia uses vote mixing; our design uses cryptographic separation
- ✅ **Our advantage**: Challenge ballot mechanism provides additional verification

---

### 2. Vote Casting and Authentication

#### Estonia IVXV

- **Authentication**: Estonian national ID card (PKI-based)
- **Vote Overwriting**: Voters can vote multiple times; last vote counts
- **Vote Period**: Early voting period (can vote from home)
- **Revocation**: Previous vote automatically invalidated when new vote cast

#### Trellis Design

- **Authentication**: Platform authentication + optional MFA
- **Vote Overwriting**: One vote per voter (no overwriting)
- **Vote Period**: Election-specific time window
- **Revocation**: Challenge ballot mechanism (spoil and verify)

**Analysis**:

- ⚠️ **Different authentication models**: Estonia uses government-issued PKI; we use platform authentication
- ⚠️ **Different vote models**: Estonia allows overwriting; we enforce single vote
- ✅ **Our advantage**: Challenge ballots provide cryptographic proof of correctness
- ⚠️ **Estonia's advantage**: Vote overwriting provides coercion resistance (can vote again at polling place)

---

### 3. Verification Mechanisms

#### Estonia IVXV

- **Individual Verification**: Voters can check their encrypted vote reached the collector
- **Verification App**: Smartphone app to verify vote was received
- **Universal Verifiability**: Public verification of election integrity
- **Audit Rate**: Only ~4% of voters actually verify (but achieves E2E-V in practice)

#### Trellis Design

- **Individual Verification**: Verification code to check vote was counted
- **Verification Interface**: Web-based verification
- **Universal Verifiability**: Public election record with cryptographic proofs
- **Challenge Ballots**: Voters can challenge and verify encryption correctness
- **Target Audit Rate**: >50% voter verification (more emphasis on verification)

**Analysis**:

- ✅ **Both support individual and universal verification**
- ✅ **Our advantage**: Challenge ballot mechanism provides stronger verification
- ⚠️ **Estonia's advantage**: Mobile app may be more convenient
- ✅ **Our advantage**: Higher target for voter verification participation

---

### 4. Privacy and Anonymization

#### Estonia IVXV

- **Vote Mixing**: Cryptographic mixing breaks link between voter and vote
- **Anonymization**: Votes are mixed before decryption
- **Privacy Attack**: Known vulnerability - encrypted vote copying possible (2025 research)

#### Trellis Design

- **Cryptographic Separation**: Voter identity and vote content stored separately
- **No Mixing**: Relies on database design and cryptographic separation
- **Challenge Ballots**: Reveal vote content only when challenged (privacy-preserving)

**Analysis**:

- ⚠️ **Different approaches**: Estonia uses mixing; we use separation
- ⚠️ **Known vulnerability**: Estonia has privacy attack (encrypted vote copying)
- ✅ **Our advantage**: Challenge mechanism doesn't require mixing
- ⚠️ **Estonia's advantage**: Mixing provides stronger theoretical privacy guarantees

---

### 5. Security Architecture

#### Estonia IVXV

- **Network**: Internet-based (voters vote from home)
- **Infrastructure**: Government-controlled infrastructure
- **Physical Security**: Government facilities
- **Code Review**: Open source, public review

#### Trellis Design

- **Network**: Internet-based (voters vote from anywhere)
- **Infrastructure**: Cloud-based (Cloudflare Workers, Supabase)
- **Physical Security**: Cloud provider security
- **Air-Gapped Tallying**: Isolated tallying system (no external network)

**Analysis**:

- ⚠️ **Different infrastructure models**: Estonia uses government infrastructure; we use cloud
- ✅ **Our advantage**: Air-gapped tallying provides additional security layer
- ⚠️ **Estonia's advantage**: Government control may provide different trust model
- ✅ **Both**: Open source approach (Estonia publishes code; we plan to)

---

### 6. Standards and Compliance

#### Estonia IVXV

- **Standards**: Estonian election law
- **Certification**: Estonian National Electoral Committee
- **International Review**: Academic security analysis (2021, 2025)
- **Formal Verification**: UC framework analysis (2021)

#### Trellis Design

- **Standards**: VVSG 2.0 (US Election Assistance Commission)
- **Certification**: Planned security audits and compliance verification
- **International Review**: Designed for academic review
- **Formal Verification**: ElectionGuard protocol (formally specified)

**Analysis**:

- ⚠️ **Different standards**: Estonia follows national law; we follow VVSG 2.0
- ✅ **Both**: Designed for academic and security review
- ✅ **Our advantage**: VVSG 2.0 is comprehensive international standard
- ✅ **Estonia's advantage**: 20 years of real-world deployment experience

---

### 7. Known Vulnerabilities and Improvements

#### Estonia IVXV Known Issues

1. **Privacy Attack** (2025): Encrypted vote copying vulnerability
2. **Low Audit Rate**: Only 4% of voters verify (though achieves E2E-V)
3. **ID Card Vulnerabilities**: Estonian ID card security flaws (Parsovs, 2020)
4. **Quantum Threat**: Not quantum-resistant (future concern)

#### Trellis Design Mitigations

1. **Challenge Ballots**: Prevent encrypted vote copying (voters can verify)
2. **Higher Verification Target**: >50% voter verification goal
3. **Platform Authentication**: Different from Estonian ID cards
4. **Future-Proofing**: Can upgrade to post-quantum cryptography

**Analysis**:

- ✅ **Our advantage**: Challenge ballots address encrypted vote copying
- ✅ **Our advantage**: Higher verification participation target
- ⚠️ **Estonia's advantage**: 20 years of addressing vulnerabilities in practice
- ✅ **Both**: Need to consider quantum threat

---

## Key Differences Summary

### Where Our Design is Stronger

1. **Challenge Ballot Mechanism**: Provides cryptographic proof of encryption correctness
2. **Higher Verification Target**: >50% vs ~4% voter verification
3. **Air-Gapped Tallying**: Additional security layer for critical operations
4. **VVSG 2.0 Compliance**: Comprehensive international standard
5. **ElectionGuard Protocol**: Modern, formally specified protocol

### Where Estonia's System is Stronger

1. **Real-World Deployment**: 20 years of production use in national elections
2. **Vote Mixing**: Stronger theoretical privacy guarantees
3. **Vote Overwriting**: Provides coercion resistance (can vote again at polling place)
4. **Government Infrastructure**: Different trust model with government control
5. **Mobile Verification App**: Convenient smartphone-based verification

### Where They're Similar

1. **Cryptographic Foundation**: Both use ElGamal homomorphic encryption
2. **Threshold Decryption**: Both use multiple trustees
3. **End-to-End Verifiability**: Both support individual and universal verification
4. **Open Source**: Both publish or plan to publish source code
5. **Academic Review**: Both designed for security analysis

---

## Lessons Learned from Estonia

### What Works Well

1. **Individual Verification**: Even low audit rates (4%) achieve E2E-V in practice
2. **Open Source**: Publishing code enables security research and trust
3. **Vote Overwriting**: Allows voters to change mind or vote at polling place
4. **Mobile Verification**: Convenient verification app increases usability

### What to Avoid

1. **Privacy Vulnerabilities**: Encrypted vote copying attack (2025)
2. **Low Verification Participation**: Only 4% verify (though sufficient)
3. **ID Card Dependencies**: Vulnerabilities in authentication infrastructure
4. **Quantum Vulnerability**: Not quantum-resistant (future concern)

---

## Recommendations for Our Design

### Adopt from Estonia

1. **Mobile Verification App**: Consider smartphone app for easier verification
2. **Vote Overwriting Option**: Consider allowing vote changes (with proper security)
3. **Vote Mixing**: Consider adding mixing for stronger privacy guarantees
4. **Public Source Code**: Publish source code early for security review

### Keep Our Advantages

1. **Challenge Ballots**: Maintain challenge mechanism for stronger verification
2. **Higher Verification Target**: Continue emphasizing voter verification
3. **Air-Gapped Tallying**: Maintain isolation for critical operations
4. **VVSG 2.0 Compliance**: Continue following comprehensive standards

### Address Known Issues

1. **Privacy Attacks**: Design to prevent encrypted vote copying
2. **Quantum Resistance**: Plan for post-quantum cryptography migration
3. **Verification Usability**: Make verification as easy as possible
4. **Academic Review**: Engage security researchers early

---

## Conclusion

Our design shares the same cryptographic foundation as Estonia's IVXV system (ElGamal homomorphic encryption) but takes a different approach in several key areas:

- **Privacy**: We use cryptographic separation instead of vote mixing
- **Verification**: We include challenge ballots for stronger verification
- **Vote Model**: We enforce single vote vs. Estonia's vote overwriting
- **Standards**: We follow VVSG 2.0 vs. Estonia's national law

Estonia's 20 years of real-world deployment provides valuable lessons:

- Even low verification rates can achieve E2E-V
- Open source enables security research
- Vote overwriting provides coercion resistance
- Mobile verification improves usability

Our design incorporates modern best practices (ElectionGuard, VVSG 2.0) while learning from Estonia's experience. The challenge ballot mechanism addresses known vulnerabilities while maintaining strong security guarantees.

---

## References

1. **Estonia IVXV System**: [valimised.ee](https://www.valimised.ee/en/internet-voting/)
2. **UC Modeling Analysis** (2021): Zhang, Li, Willemson - "UC Modelling and Security Analysis of the Estonian IVXV Internet Voting System"
3. **SoK and Suggestions** (2025): Arafat - "On the Estonian Internet Voting System, IVXV, SoK and Suggestions"
4. **Estonian ID Card Vulnerabilities**: Parsovs (2020) - Security flaws in Estonian ID-cards
5. **Estonia E-Voting Documents**: [Documents about Internet Voting](https://www.valimised.ee/en/internet-voting/documents-about-internet-voting)

---

**Last Updated**: January 2025
