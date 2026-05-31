# Current State: Trellis Design Patterns vs. Research Findings

An audit of Trellis's current features against the harmful design patterns identified in the research.

## Existing Design Decisions (Already Positive)

### Sentiments Instead of Likes

Trellis uses a nuanced **sentiment system** rather than binary likes. Users choose from 11 emotions: joy, gratitude, calm, love, hope, compassion, awe, sadness, anger, fear, insightful.

**Why this matters:** The research specifically calls out the "like" feature as harmful to developing brains because it creates a simple dopamine-driven feedback loop. Trellis's sentiment model encourages emotional literacy rather than popularity scoring. This is a genuine differentiator.

**Gap:** Sentiment counts are still visible and could still drive compulsive checking behavior. The _number_ of sentiments on a post can function like a like count.

### Chronological Feed Default

The feed defaults to chronological ordering (`createdAt DESC`), with optional taxonomy-based personalization (not engagement-optimized).

**Why this matters:** Researchers specifically recommend restricting personalized/algorithmic feeds for minors. Trellis's approach — chronological by default, with interest-tag filtering — is far less addictive than engagement-maximized algorithmic feeds.

**Gap:** The feed personalization engine (`feed-personalization.ts`) does exist and could be extended in ways that create compulsive patterns if not constrained.

### No Traditional Notification System

Trellis does not have push notifications for likes, comments, or follows. Activity tracking is limited to ActivityPub federation events.

**Why this matters:** Constant notifications were identified as a key driver of compulsive use and sleep disruption in adolescents. The absence of a notification system is currently protective.

**Gap:** If/when notifications are added, they should be designed with the research findings in mind from the start.

## Current Gaps

> **Correction (post-audit):** The age/parental/privacy gaps in this section
> have since been **partially closed in code** and no longer reflect the current
> schema. The User model now has `dateOfBirth` and an `ageTier`
> (`CHILD`/`TEEN`/`ADULT`) computed at registration; a `ParentalLink` model and
> age-tier-aware privacy locks (`apps/api/src/lib/privacy-defaults.ts`) exist.
> See [05](05-age-verification-and-minor-safety.md) and the commercial-targeting
> analysis for the verified current state. The
> remaining gaps are that age is **self-declared/unverified** and the TEEN-tier
> defaults are not locked.

### No Age Verification or Minor-Specific Protections

The User model has no `dateOfBirth`, `age`, or `isMinor` fields. There is no age gating at registration. The identity verification system (`identityVerified`, `identityVerificationProvider`) exists but is designed for anti-impersonation, not age verification.

### No Parental Controls

No mechanism for a parent/guardian to manage a minor's account, restrict content visibility, limit usage time, or control who can interact with them.

### Infinite Scroll

The feed uses cursor-based pagination with a `hasMore` boolean — a standard infinite scroll pattern. This is one of the specific design elements the Kids Online Safety Act proposes restricting for minors.

### No Usage Time Awareness

No session duration tracking, no "you've been scrolling for X minutes" friction, no quiet hours configuration.

### Privacy Defaults Favor Openness

The existing privacy-related fields (`stealthMode`, `locationTrackingEnabled`, `analyticsOptOut`) default to permissive settings. Research recommends defaults should be maximally protective, especially for minors.
