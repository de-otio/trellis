# On-Device AI: Use Cases for Trellis

**Date:** April 2026
**Question:** Beyond border safety triage, what else can an on-device model do for a privacy-focused social platform?

---

## Overview

The AI Strategy's Option A describes on-device AI narrowly: "basic content flagging" and "is this post obviously political?" But an on-device model -- especially combined with on-device RAG -- enables a broader set of features where the core value proposition is **the analysis never leaves the user's phone**.

For a platform whose users include journalists, activists, and travelers facing government screening, this is a meaningful differentiator.

---

## Use Case 1: Privacy-Preserving Profile Self-Assessment

**What:** Users query their own profile from an adversary's perspective entirely on-device.

> "What does my profile reveal about my political views?"
> "Could someone determine my religion from my posts?"
> "What can a screening officer infer about my travel history?"

**Why on-device:** The query itself is sensitive. Asking a server "analyze my political exposure" reveals the user's concern. Metadata about what people are worried about is valuable intelligence. On-device means the question never leaves the phone.

**Complexity:** Medium. Requires on-device RAG over the user's content + a generation model for synthesis.

**Value:** High. This is something no mainstream social platform offers.

---

## Use Case 2: Smart Content Warnings Before Posting

**What:** Before publishing, the local model flags real-time risks.

> "This post mentions a protest location -- it could be flagged by screening tools in 3 of your saved destinations."
> "This photo's EXIF data contains GPS coordinates for a location you've marked as sensitive."

**Why on-device:** Zero latency. No server dependency. Works offline -- important in countries with unreliable connectivity or censored networks. Also avoids creating a server-side log of "posts the user was warned about."

**Complexity:** Medium. Needs the post content + destination policies + user's existing content history for pattern detection.

**Value:** High. Proactive safety rather than reactive assessment.

---

## Use Case 3: On-Device Content Moderation Pre-Filter

**What:** Classify incoming feed content locally before rendering: hate speech, spam, graphic content, misinformation signals.

**Why on-device:**
- **Cost reduction** -- server-side moderation at scale is expensive. A local pre-filter reduces the volume that needs server classification.
- **Instant filtering** -- no round-trip latency, works offline.
- **Personalization** -- users could tune their own sensitivity thresholds locally without the server knowing their preferences.

**Complexity:** Low-Medium. Classification is simpler than generation. Could use a small fine-tuned classifier rather than a full LLM.

**Value:** Medium. Standard feature for social platforms, but the on-device angle adds a privacy story.

---

## Use Case 4: Semantic Search Over Personal Content

**What:** Search your own posts, saved items, and conversations by meaning rather than keywords.

> "Find discussions about dog training techniques" -- returns results even if those exact words weren't used.
> "What did I post about last summer's trip?" -- finds relevant content across post types.

**Why on-device:** Search queries over personal content reveal interests and concerns. Keeping them local is a privacy win. Also works offline.

**Complexity:** Low-Medium. Embedding + vector search, no generation needed. Could display results directly.

**Value:** High. Semantic search is a significant UX improvement over keyword search, and the privacy angle differentiates from platforms that log all search queries.

---

## Use Case 5: Smart Notification Triage

**What:** On-device model classifies notifications by urgency and relevance.

> Surfaces: "A close friend posted for the first time in 3 months"
> Suppresses: "Someone you don't interact with liked a 6-month-old post"

**Why on-device:** Personalization requires understanding the user's interaction patterns -- relationship strength, engagement history, content preferences. Keeping that behavioral model local means Trellis doesn't need to build server-side engagement graphs (which are high-value surveillance targets).

**Complexity:** Medium. Needs interaction history analysis, relationship scoring.

**Value:** Medium. Improves UX, but the privacy angle is the differentiator -- most platforms use server-side engagement models for notification ranking.

---

## Use Case 6: Offline-First Travel Mode

**What:** When entering a high-risk jurisdiction, the app functions entirely offline. On-device AI enables risk assessment, content search, and safety features with zero server communication.

**Why on-device:** In border-crossing scenarios, **network traffic itself is observable**. An app making API calls to a "safety assessment" endpoint is a signal. Authorities with device inspection tools can see recent network connections. Fully offline operation is the strongest privacy posture.

**Complexity:** High. Requires the full on-device stack: embeddings, vector store, generation model, and pre-downloaded policy data. Also needs careful UX for transitioning between online and offline modes.

**Value:** Very high for the target user base (journalists, activists, travelers to authoritarian regimes). This is the feature that justifies the investment in on-device AI infrastructure.

---

## Use Case 7: Writing Style Analysis (Anti-Correlation)

**What:** Analyze the user's writing style fingerprint on-device and warn if their Trellis writing patterns are identifiable and matchable to other platforms.

> "Your Trellis posts use similar sentence structure and vocabulary to your linked Twitter account. A stylometric analysis tool would correlate them with 78% confidence."
> "Consider varying your writing style on this platform if cross-platform anonymity is a goal."

**Why on-device:** The stylometric profile itself is sensitive metadata. If it existed on a server, it would be a high-value target -- it's literally a digital fingerprint. Running the analysis locally means the profile never exists anywhere but the user's device.

**Complexity:** High. Stylometric analysis requires NLP feature extraction (sentence length distribution, vocabulary richness, punctuation patterns, n-gram frequencies). Could use a specialized classifier rather than a general LLM.

**Value:** High for privacy-conscious users. No mainstream platform offers this. Government contractors (ShadowDragon, Babel Street) use exactly this technique for cross-platform correlation.

---

## Priority Assessment

| Use Case | Complexity | Value | Requires Generation Model? | RAG Needed? |
|---|---|---|---|---|
| Profile self-assessment | Medium | High | Yes | Yes |
| Content warnings before posting | Medium | High | No (classification) | Yes (policy retrieval) |
| Content moderation pre-filter | Low-Medium | Medium | No (classification) | No |
| Semantic search | Low-Medium | High | No | Yes (retrieval only) |
| Notification triage | Medium | Medium | No (scoring) | No |
| Offline travel mode | High | Very High | Yes | Yes |
| Writing style analysis | High | High | No (specialized) | No |

**Suggested order:** Semantic search (quick win, low complexity, high value) --> Content warnings (builds on RAG infrastructure) --> Profile self-assessment (flagship feature) --> Offline travel mode (full stack).

---

## Deeper Investigation Needed

- [ ] User research: which of these use cases do target users (journalists, activists, travelers) actually want?
- [ ] Quantify server cost savings from on-device content moderation pre-filter
- [ ] Evaluate stylometric analysis accuracy with small on-device models vs. server-side
- [ ] Define "offline travel mode" UX: how does the user transition? What's cached? How does sync work when back online?
- [ ] Legal review: are there jurisdictions where on-device content analysis raises regulatory concerns?

---

**Last Updated:** April 2026
