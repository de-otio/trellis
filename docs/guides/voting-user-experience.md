---
title: Voting User Experience
description: User flows, roles, accessibility requirements, and error handling for the secure voting feature.
sidebar: Voting UX
order: 30
---

# Voting User Experience

## User Roles

### Voter

- View available elections
- Cast votes
- Verify their vote was counted
- Challenge ballots
- View election results (after close)

### Election Administrator

- Create elections
- Configure election settings
- Monitor election status
- View results (after close)
- Manage trustees

### Trustee

- Participate in key generation
- Provide partial decryption
- Verify decryption proofs

### Auditor

- View audit logs
- Verify election integrity
- Perform risk-limiting audits

---

## Voting Flow

### 1. Election Discovery

1. User navigates to the voting section
2. Sees a list of available elections
3. Filters by status (open, upcoming, closed)
4. Selects an election to view details

**UI elements:**

- Election list with status indicators
- Search and filter options
- Election cards showing title, description, status, time remaining, option count, and participation count (if visible)

**Accessibility:** screen reader announcements, keyboard navigation, high contrast mode, clear status indicators.

---

### 2. Election Details

1. User views election details
2. Reads description and options
3. Checks eligibility (if applicable)
4. Reviews voting instructions
5. Proceeds to vote (if eligible and open)

**UI elements:** election title and description, list of options, voting instructions, eligibility information, time remaining, "Cast Vote" button (if eligible).

**Accessibility:** clear heading structure, descriptive link text, plain-language instructions, time information in multiple formats.

---

### 3. Vote Casting

**Step 1 — Selection**

- Radio buttons or checkboxes (depending on election type)
- Option labels and descriptions
- Selection counter (for multi-select elections)
- "Review Vote" button

**Step 2 — Review**

- Summary of selections
- Option to go back and change
- "Confirm and Cast Vote" button
- Warning about vote finality

**Step 3 — Confirmation**

- Processing indicator
- Success message
- Verification code display (with QR code for mobile scanning)
- Instructions for verification
- "Verify My Vote" button
- "Change My Vote" button (if vote overwriting is enabled and election is still open)
- "Done" button

**Accessibility:** clear form labels, error messages, focus management, confirmation dialogs, screen reader announcements.

---

### 4. Verification Code Display

The verification code is a **critical security element** shown immediately after a vote is cast.

**UI elements:**

- Large, readable verification code — format: human-readable word + alphanumeric (e.g. `coffee-A3B7C9`)
- Copy to clipboard button
- Print option
- QR code for mobile app scanning
- Instructions:
  - "Save this code to verify your vote was counted"
  - "Scan the QR code with the mobile app for quick verification"
  - "You can verify your vote after the election closes"
  - "This code does not reveal how you voted"
  - "You can change your vote while the election is open" (if overwriting is enabled)

**Security:** the code is displayed once and cannot be retrieved later; it carries no information about vote content.

**Accessibility:** high contrast display, large font size, screen reader announcement, keyboard-accessible copy button.

---

### 5. Vote Verification

**Web interface:**

1. User navigates to the verification page
2. Enters the verification code (or scans the QR code via a mobile app)
3. Views verification status

**Verification status display:**

- "Vote Found" / "Vote Not Found"
- Election information
- Cast time
- Inclusion status (included in tally)
- Overwritten status (if the vote was subsequently changed)

**Accessibility:** clear form labels, error messages, status announcements, keyboard navigation, screen reader support.

---

### 5a. Vote Overwriting (Change Vote)

Available while the election is open.

1. User navigates to the vote overwriting page
2. Enters the previous verification code
3. Selects new voting options
4. Reviews and confirms the new vote — review screen shows old vs. new selections
5. Receives a new verification code; previous vote is automatically invalidated

**Security:** requires the previous verification code to prove ownership; only allowed while the election is open; provides coercion resistance (a voter who was coerced can change their vote).

---

### 6. Challenge Ballot

Allows a voter to verify that their ballot was encrypted correctly. Challenging a ballot prevents it from being counted; the voter may then cast a new vote.

1. User enters their verification code
2. Clicks "Challenge Ballot" and confirms the warning
3. Views decrypted ballot content and verifies encryption was correct
4. Optionally casts a new vote (if election is still open)

---

### 7. Election Results

Available after the election closes.

**UI elements:**

- Results table: option names, vote counts, percentages, visual charts
- Total votes cast
- Challenge ballot count
- "Verify Election" button and verification status

**Accessibility:** table with headers, text alternatives for charts, keyboard navigation.

---

### 8. Public Verification

Anyone can run independent verification of a closed election.

**Verification status indicators:**

- Ballot proofs valid
- Aggregation valid
- Decryption valid
- Overall verification: PASS / FAIL

Includes download option for the election record and instructions for running verification independently.

---

## Accessibility Requirements

The voting interface targets **WCAG 2.1 AA** compliance.

| Principle | Key requirements |
|-----------|-----------------|
| Perceivable | Alt text on images; minimum 4.5:1 contrast; text resizable to 200% |
| Operable | Full keyboard navigation; no seizure-inducing content; no hard time limits on voting |
| Understandable | Plain language; consistent navigation; clear error messages |
| Robust | Compatible with assistive technologies; full screen-reader and keyboard-only support |

---

## Mobile Experience

- Mobile-first responsive design with minimum 44 × 44 px touch targets
- Verification code displayed as a QR code for easy scanning
- Push notifications for election reminders and result publications

**Mobile verification app:** a dedicated mobile app (modelled on the Estonian system) supports:

- QR code scanning for instant verification
- Manual code entry
- Local storage of verification codes for later verification
- Push notifications when results are published

---

## Error Handling

| Error | Message | Actions |
|-------|---------|---------|
| Vote already cast | "You have already cast a vote in this election. Each voter can only vote once." | View verification code, verify vote |
| Election closed | "This election is closed. Voting ended on [date/time]." | View results, verify election |
| Invalid verification code | "Verification code not found. Please check your code and try again." | Re-enter code, contact support |
| Network error | "Unable to connect. Please check your internet connection and try again." | Retry |

---

## Security UX

- Clear indicators that the vote is secret
- Explanation that the verification code cannot reveal how the voter voted
- Messaging that voters cannot prove their choice to a third party (coercion resistance)
- Support resources for handling coercion attempts
