# User Experience

**Part of**: [Secure Voting Feature](./README.md)  
**Status**: Design Document  
**Last Updated**: January 2025

---

## Overview

This document describes the user experience design for the secure voting feature, including voting flows, verification interfaces, and accessibility considerations.

---

## User Roles

### Voter

**Capabilities**:

- View available elections
- Cast votes
- Verify their vote was counted
- Challenge ballots
- View election results (after close)

### Election Administrator

**Capabilities**:

- Create elections
- Configure election settings
- Monitor election status
- View results (after close)
- Manage trustees

### Trustee

**Capabilities**:

- Participate in key generation
- Provide partial decryption
- Verify decryption proofs

### Auditor

**Capabilities**:

- View audit logs
- Verify election integrity
- Perform risk-limiting audits

---

## Voting Flow

### 1. Election Discovery

**User Journey**:

1. User navigates to voting section
2. Sees list of available elections
3. Filters by status (open, upcoming, closed)
4. Selects election to view details

**UI Elements**:

- Election list with status indicators
- Search and filter options
- Election cards with key information:
  - Title and description
  - Status (open/closed)
  - Time remaining (if open)
  - Number of options
  - Participation count (if visible)

**Accessibility**:

- Screen reader announcements
- Keyboard navigation
- High contrast mode
- Clear status indicators

---

### 2. Election Details

**User Journey**:

1. User views election details
2. Reads description and options
3. Checks eligibility (if applicable)
4. Reviews voting instructions
5. Proceeds to vote (if eligible and open)

**UI Elements**:

- Election title and description
- List of voting options
- Voting instructions
- Eligibility information
- Time remaining
- "Cast Vote" button (if eligible)

**Accessibility**:

- Clear heading structure
- Descriptive link text
- Instructions in plain language
- Time information in multiple formats

---

### 3. Vote Casting

**User Journey**:

1. User selects voting options
2. Reviews selections
3. Confirms vote
4. Receives verification code
5. Optionally verifies vote immediately

**UI Elements**:

**Step 1: Selection**

- Radio buttons or checkboxes (depending on election type)
- Option labels and descriptions
- Selection counter (if multiple selections allowed)
- "Review Vote" button

**Step 2: Review**

- Summary of selections
- Option to go back and change
- "Confirm and Cast Vote" button
- Warning about vote finality

**Step 3: Confirmation**

- Processing indicator
- Success message
- Verification code display (with QR code for mobile scanning)
- Instructions for verification
- "Verify My Vote" button
- "Change My Vote" button (if vote overwriting enabled and election still open)
- "Done" button

**Accessibility**:

- Clear form labels
- Error messages
- Focus management
- Confirmation dialogs
- Screen reader announcements

---

### 4. Verification Code Display

**Critical Security Element**

**UI Elements**:

- Large, readable verification code
- Format: Human-readable word + alphanumeric code
  - Example: "coffee-A3B7C9"
- Copy to clipboard button
- Print option
- QR code (for easy mobile app scanning - adopted from Estonia)
- Instructions:
  - "Save this code to verify your vote was counted"
  - "Scan the QR code with the mobile app for quick verification"
  - "You can verify your vote after the election closes"
  - "This code does not reveal how you voted"
  - "You can change your vote while the election is open" (if overwriting enabled)

**Security Considerations**:

- Code displayed only once
- Cannot be retrieved later (privacy)
- No association with vote content
- Clear instructions about privacy

**Accessibility**:

- High contrast display
- Large font size
- Screen reader announcement
- Copy functionality accessible via keyboard

---

### 5. Vote Verification

**User Journey**:

1. User navigates to verification page (web or mobile app)
2. Enters verification code (or scans QR code on mobile)
3. Views verification status
4. Sees confirmation that vote was counted

**UI Elements**:

**Web Interface**:

- Verification code input field
- "Verify" button
- Verification status display

**Mobile App** (adopted from Estonia):

- QR code scanner (scan verification code from receipt)
- Manual code entry option
- Quick verification interface
- Push notification support (optional)

**Verification Status Display**:

- "Vote Found" / "Vote Not Found"
- Election information
- Cast time
- Inclusion status (included in tally)
- Overwritten status (if vote was changed)

**Accessibility**:

- Clear form labels
- Error messages
- Status announcements
- Keyboard navigation
- Screen reader support for mobile app

---

### 5a. Vote Overwriting (Change Vote)

**User Journey**:

1. User wants to change their vote (election still open)
2. Navigates to vote overwriting page
3. Enters previous verification code
4. Selects new voting options
5. Reviews and confirms new vote
6. Receives new verification code
7. Previous vote automatically invalidated

**UI Elements**:

- Previous verification code input
- Warning message:
  - "Changing your vote will invalidate your previous vote"
  - "You can only change your vote while the election is open"
- New vote selection interface
- Review screen showing old vs new selections
- "Confirm Change" button
- New verification code display

**Security Considerations**:

- Requires previous verification code (proves ownership)
- Only allowed if election still open
- Previous vote marked as overwritten
- Provides coercion resistance (can change vote if coerced)

**Accessibility**:

- Clear warnings
- Confirmation dialogs
- Status announcements

---

### 6. Challenge Ballot

**User Journey**:

1. User wants to verify encryption correctness
2. Enters verification code
3. Challenges ballot
4. Views decrypted ballot content
5. Verifies encryption was correct
6. Can cast new vote if desired

**UI Elements**:

- Verification code input
- "Challenge Ballot" button
- Warning message:
  - "Challenging this ballot will prevent it from being counted"
  - "You can cast a new vote after challenging"
- Decrypted ballot display:
  - Shows which options were selected
  - Confirms encryption was correct
- "Cast New Vote" button (if election still open)

**Accessibility**:

- Clear warnings
- Confirmation dialogs
- Status announcements

---

### 7. Election Results

**User Journey**:

1. User navigates to election results
2. Views vote counts and percentages
3. Optionally verifies election integrity
4. Views detailed verification information

**UI Elements**:

- Election title and description
- Results table:
  - Option names
  - Vote counts
  - Percentages
  - Visual charts (bar/pie)
- Total votes cast
- Challenge ballots count
- "Verify Election" button
- Verification status (if verified)

**Accessibility**:

- Table structure with headers
- Chart alternatives (text descriptions)
- Clear data presentation
- Keyboard navigation

---

### 8. Public Verification

**User Journey**:

1. User (anyone) navigates to verification page
2. Views election record
3. Runs verification checks
4. Views verification results

**UI Elements**:

- Election information
- Verification status indicators:
  - ✅ Ballot proofs valid
  - ✅ Aggregation valid
  - ✅ Decryption valid
  - ✅ Overall verification: PASS
- Detailed verification information
- Download election record option
- Instructions for independent verification

**Accessibility**:

- Clear status indicators
- Detailed information available
- Download options accessible

---

## Accessibility Requirements

### WCAG 2.1 AA Compliance

#### Perceivable

- **Text Alternatives**: All images have alt text
- **Captions**: Video content has captions
- **Contrast**: Minimum 4.5:1 contrast ratio
- **Text Resize**: Text can be resized up to 200%

#### Operable

- **Keyboard Navigation**: All functionality available via keyboard
- **No Seizures**: No flashing content
- **Time Limits**: No time limits for voting (or extendable)
- **Navigation**: Clear navigation structure

#### Understandable

- **Readable**: Plain language, clear instructions
- **Predictable**: Consistent navigation and functionality
- **Input Assistance**: Clear error messages and help text

#### Robust

- **Compatible**: Works with assistive technologies
- **Screen Readers**: Full screen reader support
- **Keyboard Only**: Full keyboard-only operation

---

## Mobile Experience

### Responsive Design

- **Mobile-First**: Optimized for mobile devices
- **Touch Targets**: Minimum 44x44px touch targets
- **Readable**: Text size appropriate for mobile
- **Simplified**: Streamlined interface for small screens

### Mobile-Specific Features

- **QR Code**: Verification code as QR code for easy sharing
- **Offline Support**: Basic offline capabilities (view elections)
- **Push Notifications**: Election reminders and result notifications

### Mobile Verification App (Adopted from Estonia)

**Purpose**: Dedicated mobile app for convenient vote verification

**Features**:

- **QR Code Scanning**: Scan verification code QR code for instant verification
- **Quick Verification**: Streamlined interface for fast verification
- **Offline Storage**: Store verification codes locally for later verification
- **Push Notifications**: Get notified when election results are published
- **Election Updates**: Receive updates about election status

**User Journey**:

1. User downloads mobile verification app
2. User scans QR code from vote confirmation (or enters code manually)
3. App displays verification status immediately
4. User can save verification code for later
5. App sends push notification when results published

**Benefits**:

- More convenient than web verification
- Faster verification process
- Better user experience
- Higher verification participation (target: >50%)

---

## Error Handling

### Common Errors

#### Vote Already Cast

**Message**: "You have already cast a vote in this election. Each voter can only vote once."

**Actions**: View verification code, verify vote

#### Election Closed

**Message**: "This election is closed. Voting ended on [date/time]."

**Actions**: View results, verify election

#### Invalid Verification Code

**Message**: "Verification code not found. Please check your code and try again."

**Actions**: Re-enter code, contact support

#### Network Error

**Message**: "Unable to connect. Please check your internet connection and try again."

**Actions**: Retry, offline mode (if available)

---

## Security UX Considerations

### Privacy Indicators

- Clear indicators that vote is secret
- Explanation of verification code privacy
- Information about what data is stored

### Trust Indicators

- Security badges/certifications
- Transparency information
- Links to verification documentation

### Coercion Resistance

- Clear messaging that voters cannot prove how they voted
- Instructions for handling coercion attempts
- Support resources

---

## User Education

### Voting Instructions

- Step-by-step guides
- Video tutorials
- FAQ section
- Help documentation

### Security Education

- Explanation of end-to-end verifiability
- How verification works
- Why it's secure
- What to do if something seems wrong

---

## Design Principles

1. **Clarity**: Clear, simple interface
2. **Trust**: Transparent security information
3. **Accessibility**: Usable by everyone
4. **Security**: Security without sacrificing usability
5. **Feedback**: Clear confirmation and status

---

**Last Updated**: January 2025
