# Prior Art

## Ephemerizer (Perlman, 2005)

The foundational work in this space. Radia Perlman proposed concentrating key management in a server ("ephemerizer") that creates keys, makes them available for encryption, aids in decryption, and destroys them at the appropriate time. Key property: even if a client's machine is later compromised and all long-term keys are stolen, data whose ephemeral key has been destroyed remains unrecoverable.

**Relevance:** Our access-control approach shares the user-controlled revocation concept, but uses visibility flags rather than key destruction. If encryption is added later (Approach E), the architecture becomes more directly comparable.

**Limitation identified:** Single point of failure / trust in the centralized server.

## Vanish (Geambasu et al., University of Washington, 2009)

Encryption key is split into Shamir secret shares and scattered across BitTorrent DHT nodes. DHT nodes purge every 8 hours, so key fragments are naturally lost and content becomes permanently unrecoverable.

**Relevance:** Demonstrated the concept of self-destructing data for email and social media (Firefox plugin for Gmail/Facebook).

**Limitation identified:** Vulnerable to Sybil attacks -- adversaries could cheaply join the DHT and harvest key shares before expiry. Led to follow-up work (Cascade, Tide) to harden the system.

## Proxy Re-Encryption Approaches (EASiER, Princeton, 2011)

Content encrypted with user's key; server holds a re-encryption key that transforms ciphertexts so clients can decrypt -- but the server never sees plaintext. Revocation = delete the re-encryption key.

**Relevance:** Would provide stronger guarantees than our access-control approach (server never sees plaintext), but significantly more complex.

**Decision:** Excluded due to complexity; our threat model targets casual discovery, not server compromise.

## Attribute-Based Encryption with Revocation (PLOS One, 2023)

Broadcast encryption schemes where update keys are periodically issued to non-revoked users. Supports fine-grained policies (e.g., "friends can see this for 2 years").

**Relevance:** Interesting for future granular access control, but over-engineered for initial launch.

## Blockchain-Based Assured Deletion (BBAD, 2024)

Uses smart contracts for access control and Shamir secret sharing for key deletion with public verification via Merkle Hash Trees. Eliminates trusted third party.

**Relevance:** Interesting for trustless deletion verification, but introduces blockchain dependency.
