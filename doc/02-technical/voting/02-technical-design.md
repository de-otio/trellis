# Technical Design

**Part of**: [Secure Voting Feature](./README.md)  
**Status**: Design Document  
**Last Updated**: January 2025

---

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Public Voting Interface                  │
│  (Web/Mobile App - Vote Casting, Verification)              │
└──────────────────────┬──────────────────────────────────────┘
                       │ TLS 1.3
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Vote Collection Service (API)                   │
│  (Encrypted Vote Storage, Verification Code Generation)     │
└──────────────────────┬──────────────────────────────────────┘
                       │ Encrypted Storage
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Vote Storage (Encrypted Database)               │
│  (No Vote Content Accessible to Storage Layer)              │
└──────────────────────┬──────────────────────────────────────┘
                       │ Air-Gapped Transfer
                       ▼
┌─────────────────────────────────────────────────────────────┐
│         Tallying System (Air-Gapped, Offline)              │
│  (Homomorphic Aggregation, Threshold Decryption)            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Results Publication Service                     │
│  (Public Verification, Election Record)                      │
└─────────────────────────────────────────────────────────────┘
```

### Component Architecture

#### 1. Voting Frontend

- **Technology**: React/Flutter (existing platform stack)
- **Responsibilities**:
  - Ballot presentation
  - Vote selection interface
  - Verification code display
  - Challenge ballot interface
  - Vote verification interface
  - Vote overwriting (change vote if election still open)

#### 1a. Mobile Verification App

- **Technology**: Native mobile app (iOS/Android) or Flutter
- **Responsibilities**:
  - Quick vote verification via QR code scanning
  - Push notifications for election updates
  - Offline verification code storage
  - Convenient verification interface (adopted from Estonia)

#### 2. Vote Collection API

- **Technology**: Cloudflare Workers (existing platform)
- **Responsibilities**:
  - Voter authentication
  - Vote encryption (client-side or server-side)
  - Encrypted vote storage
  - Verification code generation
  - Challenge ballot handling
  - Vote overwriting (invalidate previous vote, store new vote)
  - Vote mixing coordination

#### 3. Vote Storage

- **Technology**: Supabase PostgreSQL (existing platform)
- **Responsibilities**:
  - Encrypted vote storage
  - Voter participation tracking (separate from votes)
  - Election configuration storage
  - Audit log storage

#### 4. Vote Mixing System

- **Technology**: Isolated compute environment (air-gapped or secure network)
- **Responsibilities**:
  - Cryptographic vote mixing (re-encryption and shuffling)
  - Mix network coordination (multiple mixing servers)
  - Mixing proof generation
  - Breaking voter-vote correlation (adopted from Estonia)

#### 5. Tallying System

- **Technology**: Isolated compute environment (air-gapped)
- **Responsibilities**:
  - Vote aggregation (homomorphic, after mixing)
  - Threshold decryption
  - Cryptographic proof generation
  - Election record creation

#### 6. Verification Service

- **Technology**: Public API endpoint
- **Responsibilities**:
  - Individual vote verification (web and mobile app)
  - Public election verification
  - Election record publication
  - Challenge ballot decryption
  - Mobile app API endpoints

---

## Data Models

### Election

```typescript
interface Election {
  id: string; // Unique election identifier
  title: string; // Election title
  description: string; // Election description
  electionType: "poll" | "election" | "referendum";
  status: "draft" | "open" | "closed" | "tallied" | "published";

  // Timing
  startTime: Date; // When voting opens
  endTime: Date; // When voting closes
  tallyTime?: Date; // When tallying completed

  // Configuration
  options: ElectionOption[]; // Voting options
  allowMultipleSelections: boolean;
  maxSelections?: number; // For multiple selection elections
  allowVoteOverwriting: boolean; // Allow voters to change their vote (coercion resistance)

  // Security
  publicKey: string; // Election public key (for encryption)
  trusteePublicKeys: string[]; // Trustee public keys
  threshold: number; // Threshold for decryption (e.g., 3 of 5)
  useVoteMixing: boolean; // Enable vote mixing for stronger privacy (adopted from Estonia)

  // Metadata
  createdBy: string; // User ID of creator
  createdAt: Date;
  updatedAt: Date;

  // Results (after tallying)
  results?: ElectionResults;
  electionRecord?: string; // Cryptographic election record
}
```

### Election Option

```typescript
interface ElectionOption {
  id: string; // Unique option identifier
  electionId: string; // Reference to election
  label: string; // Option label
  description?: string; // Option description
  order: number; // Display order
}
```

### Encrypted Vote

```typescript
interface EncryptedVote {
  id: string; // Unique vote identifier
  electionId: string; // Reference to election
  voterId: string; // Voter identifier (separate from vote content)

  // Encrypted vote content
  encryptedSelections: EncryptedSelection[]; // Encrypted choices
  ballotNonce: string; // Unique nonce for this ballot
  verificationCode: string; // Voter verification code

  // Cryptographic proofs
  selectionProofs: ZeroKnowledgeProof[]; // Proofs of valid selections
  ballotProof: ZeroKnowledgeProof; // Proof of ballot correctness

  // Metadata
  castAt: Date; // When vote was cast
  isChallenged: boolean; // Whether this is a challenge ballot
  challengedAt?: Date; // When ballot was challenged
  isOverwritten: boolean; // Whether this vote was overwritten by a new vote
  overwrittenAt?: Date; // When vote was overwritten

  // Device information (for verification)
  deviceInfoHash: string; // Hash of device information
}
```

### Encrypted Selection

```typescript
interface EncryptedSelection {
  optionId: string; // Which option this selection is for
  encryptedValue: string; // ElGamal encryption of 0 or 1
  proof: ZeroKnowledgeProof; // Proof that value is 0 or 1
}
```

### Voter Participation Record

```typescript
interface VoterParticipation {
  id: string;
  electionId: string;
  voterId: string;
  hasVoted: boolean; // Whether voter has cast a vote
  verificationCode?: string; // Voter's verification code (if voted)
  castAt?: Date; // When vote was cast
  challengedCount: number; // Number of ballots challenged

  // Note: This record does NOT contain vote content
  // Vote content is only in encrypted form, separate from voter identity
}
```

### Election Results

```typescript
interface ElectionResults {
  electionId: string;
  totalVotes: number; // Total valid votes cast
  optionResults: OptionResult[];
  challengeBallots: number; // Number of challenge ballots

  // Cryptographic proofs
  aggregationProof: ZeroKnowledgeProof; // Proof of correct aggregation
  decryptionProofs: ZeroKnowledgeProof[]; // Proofs of correct decryption

  // Election record
  electionRecordHash: string; // Hash of complete election record
  publishedAt: Date; // When results were published
}
```

### Option Result

```typescript
interface OptionResult {
  optionId: string;
  optionLabel: string;
  voteCount: number; // Decrypted vote count
  percentage: number; // Percentage of total votes
}
```

### Audit Log

```typescript
interface AuditLog {
  id: string;
  timestamp: Date;
  eventType: AuditEventType;
  userId?: string; // User who performed action (if applicable)
  electionId?: string; // Related election (if applicable)
  details: Record<string, any>; // Event-specific details
  signature: string; // Cryptographic signature of log entry
  previousHash: string; // Hash of previous log entry (chain)
}
```

---

## API Design

### Vote Casting

#### POST /api/voting/elections/:electionId/votes

**Request**:

```typescript
{
  encryptedSelections: EncryptedSelection[];
  ballotNonce: string;
  selectionProofs: ZeroKnowledgeProof[];
  ballotProof: ZeroKnowledgeProof;
  deviceInfo: {
    userAgent: string;
    platform: string;
    timestamp: string;
  };
}
```

**Response**:

```typescript
{
  voteId: string;
  verificationCode: string; // For voter to verify their vote
  castAt: Date;
  message: "Vote cast successfully";
}
```

**Security**:

- Requires authenticated user
- Rate limiting (prevent vote spamming)
- Cryptographic verification of proofs
- No vote content stored in plaintext
- If vote overwriting enabled: Previous vote automatically invalidated

---

### Vote Overwriting

#### POST /api/voting/elections/:electionId/votes/overwrite

**Request**:

```typescript
{
  previousVerificationCode: string; // Verification code of previous vote
  encryptedSelections: EncryptedSelection[];
  ballotNonce: string;
  selectionProofs: ZeroKnowledgeProof[];
  ballotProof: ZeroKnowledgeProof;
  deviceInfo: {
    userAgent: string;
    platform: string;
    timestamp: string;
  };
}
```

**Response**:

```typescript
{
  voteId: string;
  verificationCode: string; // New verification code
  castAt: Date;
  previousVoteInvalidated: boolean;
  message: "Vote updated successfully. Previous vote has been invalidated.";
}
```

**Security**:

- Requires authenticated user
- Previous vote automatically marked as overwritten
- Only allowed if election still open
- Provides coercion resistance (can change vote if coerced)
- Rate limiting to prevent abuse

---

### Vote Verification (Individual)

#### GET /api/voting/verify/:verificationCode

**Response**:

```typescript
{
  found: boolean;
  electionId?: string;
  electionTitle?: string;
  includedInTally: boolean;      // Whether vote was included in final tally
  castAt?: Date;
  challenged?: boolean;          // Whether this was a challenge ballot
  overwritten?: boolean;         // Whether this vote was overwritten

  // If challenged, can show decrypted content
  decryptedSelections?: {
    optionId: string;
    selected: boolean;
  }[];
}
```

**Security**:

- Public endpoint (no authentication required)
- Verification code is the only identifier needed
- No voter identity information exposed

---

### Mobile Verification API

#### POST /api/voting/mobile/verify

**Request** (QR code scan or manual entry):

```typescript
{
  verificationCode: string;
  deviceId?: string; // Optional device identifier for push notifications
}
```

**Response**:

```typescript
{
  found: boolean;
  electionId?: string;
  electionTitle?: string;
  includedInTally: boolean;
  castAt?: Date;
  // Same structure as web verification
}
```

**Mobile-Specific Features**:

- QR code scanning support
- Push notification registration
- Offline verification code storage
- Quick verification interface

---

### Challenge Ballot

#### POST /api/voting/votes/:voteId/challenge

**Request**:

```typescript
{
  verificationCode: string; // Voter must provide their verification code
}
```

**Response**:

```typescript
{
  challenged: boolean;
  decryptedSelections: {
    optionId: string;
    optionLabel: string;
    selected: boolean;
  }
  [];
  message: "Ballot challenged. This vote will not be included in the tally.";
}
```

**Security**:

- Requires verification code (proves voter owns the ballot)
- Challenge invalidates the vote (cannot be included in tally)
- Decrypted content shown to verify encryption correctness
- Voter can cast new vote after challenge

---

### Election Results

#### GET /api/voting/elections/:electionId/results

**Response**:

```typescript
{
  electionId: string;
  status: 'closed' | 'tallied' | 'published';
  results?: ElectionResults;
  electionRecord?: string;      // Complete cryptographic election record
  verificationInstructions: string;  // How to verify the election
}
```

**Security**:

- Results only available after election closes
- Includes all cryptographic proofs for verification
- Election record enables independent verification

---

### Public Verification

#### GET /api/voting/elections/:electionId/verify

**Response**:

```typescript
{
  electionId: string;
  electionRecord: string; // Complete election record
  verificationStatus: {
    ballotProofsValid: boolean;
    aggregationValid: boolean;
    decryptionValid: boolean;
    overallValid: boolean;
  }
  verificationDetails: {
    totalBallots: number;
    validBallots: number;
    invalidBallots: number;
    challengeBallots: number;
  }
}
```

**Security**:

- Public endpoint (anyone can verify)
- Includes all cryptographic proofs
- Enables independent third-party verification

---

## Database Schema

### Elections Table

```sql
CREATE TABLE elections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  election_type TEXT NOT NULL CHECK (election_type IN ('poll', 'election', 'referendum')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'closed', 'tallied', 'published')),

  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  tally_time TIMESTAMPTZ,

  allow_multiple_selections BOOLEAN DEFAULT false,
  max_selections INTEGER,

  public_key TEXT NOT NULL,              -- Election public key
  trustee_public_keys JSONB NOT NULL,    -- Array of trustee public keys
  threshold INTEGER NOT NULL,            -- Threshold for decryption

  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Results (encrypted until decryption)
  results JSONB,
  election_record TEXT,

  CONSTRAINT valid_threshold CHECK (threshold > 0 AND threshold <= array_length(trustee_public_keys::text[], 1))
);
```

### Election Options Table

```sql
CREATE TABLE election_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  description TEXT,
  display_order INTEGER NOT NULL,

  UNIQUE(election_id, display_order)
);
```

### Encrypted Votes Table

```sql
CREATE TABLE encrypted_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  voter_id UUID NOT NULL REFERENCES users(id),

  -- Encrypted vote content (never decrypted except for challenge ballots)
  encrypted_selections JSONB NOT NULL,   -- Array of EncryptedSelection
  ballot_nonce TEXT NOT NULL,            -- Unique nonce per ballot
  verification_code TEXT NOT NULL UNIQUE, -- Voter verification code

  -- Cryptographic proofs
  selection_proofs JSONB NOT NULL,       -- Array of zero-knowledge proofs
  ballot_proof JSONB NOT NULL,          -- Proof of ballot correctness

  -- Metadata
  cast_at TIMESTAMPTZ DEFAULT NOW(),
  is_challenged BOOLEAN DEFAULT false,
  challenged_at TIMESTAMPTZ,
  is_overwritten BOOLEAN DEFAULT false,  -- Whether this vote was overwritten
  overwritten_at TIMESTAMPTZ,           -- When vote was overwritten
  device_info_hash TEXT NOT NULL,        -- Hash of device information

  -- Indexes for verification
  INDEX idx_verification_code (verification_code),
  INDEX idx_election_voter (election_id, voter_id),
  INDEX idx_election_challenged (election_id, is_challenged),
  INDEX idx_election_overwritten (election_id, is_overwritten)
);
```

### Voter Participation Table

```sql
CREATE TABLE voter_participation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  voter_id UUID NOT NULL REFERENCES users(id),

  has_voted BOOLEAN DEFAULT false,
  verification_code TEXT,                -- Only if voted
  cast_at TIMESTAMPTZ,
  challenged_count INTEGER DEFAULT 0,

  UNIQUE(election_id, voter_id),
  INDEX idx_election_voter (election_id, voter_id)
);
```

### Audit Logs Table

```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL,
  user_id UUID REFERENCES users(id),
  election_id UUID REFERENCES elections(id),
  details JSONB NOT NULL,
  signature TEXT NOT NULL,               -- Cryptographic signature
  previous_hash TEXT NOT NULL,           -- Hash of previous log entry

  INDEX idx_timestamp (timestamp),
  INDEX idx_event_type (event_type),
  INDEX idx_election (election_id)
);
```

---

## Cryptographic Operations

### Vote Encryption

1. **Generate Ballot Nonce**: Unique random nonce per ballot
2. **Encrypt Selections**: For each option, encrypt 1 if selected, 0 if not
3. **Generate Proofs**: Zero-knowledge proofs that each selection is 0 or 1
4. **Generate Ballot Proof**: Proof that sum of selections equals selection limit
5. **Generate Verification Code**: Hash of encrypted ballot + election ID

### Vote Mixing (Anonymization)

1. **Re-encryption**: Each mixing server re-encrypts votes with new randomness
2. **Shuffling**: Votes are randomly shuffled to break voter-vote correlation
3. **Mixing Proofs**: Zero-knowledge proofs that mixing was performed correctly
4. **Mix Network**: Multiple mixing servers in sequence for stronger privacy
5. **Output**: Mixed votes ready for aggregation (adopted from Estonia)

### Vote Aggregation

1. **Homomorphic Addition**: Combine encrypted votes without decryption (after mixing)
2. **Aggregation Proof**: Prove aggregation was performed correctly
3. **Intermediate Verification**: Can verify partial tallies

### Vote Decryption

1. **Threshold Decryption**: Requires threshold of trustees
2. **Partial Decryptions**: Each trustee provides partial decryption
3. **Combination**: Combine partial decryptions to get final tally
4. **Decryption Proofs**: Prove each decryption is correct

---

## Security Considerations

### Client-Side vs Server-Side Encryption

**Recommendation**: Client-side encryption preferred for maximum security.

**Client-Side Encryption**:

- Vote content never visible to server
- Maximum privacy protection
- Requires cryptographic library in client

**Server-Side Encryption**:

- Simpler client implementation
- Server sees vote content (trusted server model)
- Less secure but acceptable for some use cases

### Key Management

- **Election Keys**: Generated during election setup ceremony
- **Storage**: HSM or cloud KMS (AWS KMS, Google Cloud KMS)
- **Rotation**: New keys for each election
- **Backup**: Encrypted backups of key shares (trustees)

### Performance Optimization

- **Batch Processing**: Process votes in batches for aggregation
- **Caching**: Cache election configurations
- **Indexing**: Optimize database indexes for verification queries
- **CDN**: Serve election records via CDN for public verification

---

**Last Updated**: January 2025
