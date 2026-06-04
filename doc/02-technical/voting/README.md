# Secure Voting Feature

> **Updated 2026-05 for redesign:** The voting feature concept is orthogonal to the social graph redesign. Key infrastructure changes to be aware of: auth is AWS Cognito JWT (not AT Protocol / DIDs); the API is Express in trellis (not Fastify/Hono); the frontend is Flutter (not web-first). The cryptographic protocols, security architecture, and VVSG 2.0 compliance docs remain valid as design references. `02-technical-design.md` references "Web/Mobile App" — the mobile app is Flutter.
>
> **Moved 2026-05-25:** Relocated into the Trellis generic core from a consuming vertical. The voting feature is generic infrastructure used by every Trellis tenant, not a vertical-specific feature.

**Status**: Design Document  
**Last Updated**: January 2025  
**Purpose**: Comprehensive design for a secure voting system that enables users to vote on various topics with maximum security standards, following VVSG 2.0 principles and end-to-end verifiable voting protocols.

---

## Overview

The secure voting feature enables users to participate in polls, elections, and decision-making processes on a Trellis-hosted platform with the highest security standards. The system is designed following:

- **VVSG 2.0** (Voluntary Voting System Guidelines 2.0) - US Election Assistance Commission standards
- **ElectionGuard** - Microsoft's end-to-end verifiable voting protocol
- **End-to-End Verifiable (E2E-V) Voting** - Cryptographic protocols ensuring vote integrity
- **NIST Cybersecurity Framework** - Security best practices

### Key Security Principles

1. **Ballot Secrecy** - Voter choices remain private and cannot be linked to voter identity
2. **End-to-End Verifiability** - Voters can verify their vote was counted correctly
3. **Cryptographic Integrity** - All votes are cryptographically protected
4. **Auditability** - Complete audit trails for all voting operations
5. **Access Control** - Multi-factor authentication for critical operations
6. **System Integrity** - Protection against tampering and manipulation
7. **Detection and Monitoring** - Real-time security monitoring

---

## Documentation Structure

1. **[Security Architecture](./01-security-architecture.md)** - Comprehensive security design, threat model, and cryptographic protocols
2. **[Technical Design](./02-technical-design.md)** - System architecture, data models, API design, and implementation details
3. **[Standards Compliance](./03-standards-compliance.md)** - VVSG 2.0 compliance mapping, security controls, and certification requirements
4. **[Implementation Plan](./04-implementation-plan.md)** - Phased implementation strategy, dependencies, and rollout plan
5. **[User Experience](./05-user-experience.md)** - Voting flows, verification interfaces, and accessibility considerations
6. **[Cryptographic Protocols](./06-cryptographic-protocols.md)** - Detailed cryptographic specifications, key management, and verification procedures
7. **[Estonia Comparison](./07-estonia-comparison.md)** - Detailed comparison with Estonia's IVXV national internet voting system

---

## Core Capabilities

### 1. Vote Casting

- Secure ballot creation and encryption
- Voter verification and authentication
- Ballot submission with cryptographic proofs
- Verification code generation for voters

### 2. Vote Verification

- Individual voter verification (verify your vote was counted)
- Public verifiability (anyone can verify the election results)
- Challenge ballot mechanism (spoil and verify encryption)
- Independent third-party verification support

### 3. Vote Tallying

- Homomorphic encryption for secure aggregation
- Threshold decryption with multiple trustees
- Cryptographic proofs of correctness
- Risk-limiting audits (RLA) support

### 4. Security Controls

- Multi-factor authentication for administrators
- Cryptographic protection of all voting data
- Immutable audit logs
- Real-time anomaly detection
- Air-gapped critical components (no external network access)

---

## Use Cases

### Community Polls

- Community decision-making (e.g., event planning, rule changes)
- Non-binding advisory votes
- Preference surveys

### Governance Elections

- Community leadership elections
- Board member selection
- Policy decisions

### Content Moderation

- Community-driven content decisions
- Appeal processes
- Policy ratification

---

## Security Guarantees

1. **Vote Privacy**: Individual votes cannot be linked to voters
2. **Vote Integrity**: Votes cannot be modified after casting
3. **Verifiability**: Voters can verify their vote was counted correctly
4. **Transparency**: Election results are publicly verifiable
5. **Coercion Resistance**: Voters cannot prove how they voted to third parties
6. **Tamper Resistance**: System detects and prevents unauthorized modifications

---

## Related Features

The voting feature integrates with several Trellis primitives. Sibling-document links omitted pending Trellis-side documentation of each:

- **Feed** — Post creation and community engagement
- **Sub-Communities** — Community groups that may use voting
- **Gamification** — Potential integration for voting participation rewards
- **Community Guidelines** — Governance and moderation

---

## Standards and References

- **VVSG 2.0**: [EAC Voluntary Voting System Guidelines 2.0](https://www.eac.gov/voting-equipment/voluntary-voting-system-guidelines)
- **ElectionGuard**: [Microsoft ElectionGuard Specification](https://www.electionguard.vote/spec/)
- **NIST Cybersecurity Framework**: [NIST CSF](https://www.nist.gov/cyberframework)
- **Helios Voting**: [End-to-End Verifiable Voting](https://www.iacr.org/elections/eVoting/about-helios.html)

---

**Last Updated**: January 2025
