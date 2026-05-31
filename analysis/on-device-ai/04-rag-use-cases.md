# On-Device RAG: Use Cases for Trellis

**Date:** April 2026
**Question:** What specific features can RAG enable in Trellis, and what do the interaction patterns look like?

---

## Why RAG (Not Just a Model)

A raw on-device model has knowledge frozen at training time. For Trellis's use cases, the model needs to reason over:

- **The user's actual content** -- posts, comments, likes, connections (changes daily)
- **Current screening policies** -- ESTA requirements, CBP practices, per-country rules (changes periodically)
- **Cross-platform data** -- user-provided profiles from other platforms (provided on demand)

RAG solves this by separating **what the model knows** (general reasoning) from **what it looks up** (user-specific and policy-specific data). This is especially valuable on-device because the retrieval step is cheap and private, while the generation step is expensive and may need server assistance.

---

## Use Case 1: Local Policy-Aware Risk Assessment

**The flagship BSM use case.** Embed country-specific border screening policies on-device. When a user prepares for travel, retrieve relevant policy sections and match against their content.

### Interaction Pattern

```
User selects "USA" as destination
  |
  v
Retrieve from policy index:
  - ESTA social media disclosure requirements
  - CBP screening practices and contractor capabilities
  - Known flagging criteria (political content, protest imagery, etc.)
  |
  v
Retrieve from user content index:
  - Posts matching risk categories (political, protest, criticism of US policy)
  - Comments on flagged topics
  - Connections to flagged accounts
  |
  v
Generate (on-device or server):
  "5 posts may be flagged under current ESTA screening:
   1. Post from March 12 about immigration policy — directly relevant to CBP screening criteria
   2. Photo from January protest — visual content flagged by image analysis tools
   ..."
```

### Why RAG Specifically

The policy knowledge base is **structured, versioned, and updated independently** of the model. A fine-tuned model would need retraining when ESTA requirements change. RAG just needs new policy documents embedded.

### Technical Notes

- Policy corpus per country: 20-50 chunks (small, fast retrieval)
- User content corpus: 500-5,000 chunks depending on activity
- Two-index query: retrieve from both policy and user indexes, combine in prompt
- Filtering: vector search pre-filtered by country metadata to avoid irrelevant policy hits

---

## Use Case 2: Personal Content Semantic Search

**A general-purpose feature** that's valuable independent of BSM. Search your own content by meaning.

### Interaction Pattern

```
User types: "what have I said about protests?"
  |
  v
Embed query → 384-dim vector
  |
  v
k-NN search over user content index → top 10 matches
  |
  v
Display results directly (no generation needed):
  - "We marched downtown last Saturday" (March 15)
  - "The demonstration was peaceful despite what the media says" (Feb 28)
  - "Standing up for what's right" [photo with protest signs] (Jan 20)
```

### Why RAG Specifically

Keyword search for "protest" misses all three of those results. Semantic search finds them because the embedding model understands topical similarity.

### Technical Notes

- **No generation model needed** -- retrieval-only feature. Results displayed directly.
- Fastest path to value: embedding model + vector store, no LLM required.
- Can enhance with optional summarization ("You've posted about protests 12 times in the last year, mostly about immigration policy").
- Existing `sqflite` infrastructure in Flutter can host the vector index alongside the app's local cache.

---

## Use Case 3: Cross-Reference Detection

**An adversarial self-testing feature.** If a user provides profiles from other platforms, detect correlation risks.

### Interaction Pattern

```
User links their Twitter profile (exports data via Twitter's data export)
  |
  v
Index Twitter content alongside Trellis content (locally)
  |
  v
Cross-index similarity search:
  - Find topically overlapping posts across platforms
  - Detect shared vocabulary patterns
  - Identify temporal correlation (posting at similar times)
  |
  v
Generate report:
  "Your Trellis and Twitter accounts share:
   - 4 topical overlaps (immigration, dog training, Bay Area events, tech industry)
   - Similar posting cadence (most active 8-10pm PST)
   - 3 shared connection names
   A cross-platform correlation tool would link them with ~78% confidence.
   
   To reduce correlation:
   - Avoid posting about the same events on both platforms within 24 hours
   - Your Trellis username contains initials that match your Twitter display name"
```

### Why RAG Specifically

The cross-reference analysis needs to search across two corpora and find semantic overlaps -- exactly what vector similarity search does. The model then interprets the overlap patterns.

### Technical Notes

- Requires user to explicitly import external platform data (privacy by design)
- Multi-index query: search Trellis index with Twitter content as queries, and vice versa
- Overlap scoring: cosine similarity between cross-platform embedding clusters
- This use case benefits most from a generation model (on-device or server) for the narrative explanation

---

## Use Case 4: Contextual Safety Alerts (Real-Time)

**Pre-publish warning system.** When a user drafts a post, retrieve relevant context in real time.

### Interaction Pattern

```
User types a post mentioning "Kurdish independence"
  |
  v  (debounced, triggered on pause in typing)
Retrieve from policy index:
  - Turkey screening policies on Kurdish content
  - EU stance (generally not flagged)
  |
  v
Retrieve from user content index:
  - 3 existing posts about Kurdish topics
  - 1 connection to a Kurdish rights organization
  |
  v
Alert (on-device, no server):
  "⚠ You have 3 existing posts on Kurdish topics. Combined with this post,
   they may create a flag pattern for travel to Turkey.
   
   Not flagged for: US, EU, Canada
   Potentially flagged for: Turkey, Iraq, Syria"
```

### Why RAG Specifically

The alert needs three pieces of context simultaneously:
1. The draft post content
2. The user's existing content on the same topic (from user index)
3. Per-country policy relevance (from policy index)

Only RAG provides all three in a single, fast, on-device lookup.

### Technical Notes

- **Latency-critical:** retrieval must complete in <100ms to feel real-time during typing
- Debounce at 500ms-1s pause in typing to avoid excessive queries
- Classification (not generation) is sufficient: "flagged for Turkey" doesn't need an LLM, just policy-aware vector similarity above a threshold
- Pre-filtered by user's saved destinations to reduce retrieval scope

---

## Use Case 5: Policy Change Impact Assessment

**A notification-driven feature.** When policy documents are updated, assess impact on the user's existing content.

### Interaction Pattern

```
Policy update arrives (background sync):
  "ESTA now requires disclosure of Mastodon/Fediverse accounts"
  |
  v
Re-run policy-vs-content retrieval for affected users:
  - Does the user have Fediverse connections?
  - Do they have posts mentioning Mastodon, ActivityPub, etc.?
  |
  v
Push notification:
  "ESTA policy change: Fediverse accounts now require disclosure.
   This affects your profile — you have 2 posts mentioning Mastodon
   and a connection to a Mastodon instance. Tap to review."
```

### Why RAG Specifically

New policy content embedded and compared against the existing user content index. No full re-analysis needed -- just a targeted similarity search between new policy chunks and existing user vectors.

### Technical Notes

- Runs as a background task after policy sync
- Only notifies if similarity score exceeds threshold (avoid alert fatigue)
- Could batch across multiple policy updates

---

## Cross-Cutting Concerns

### Index Freshness

All use cases depend on the user content index being current. Strategy:

- **Embed on write:** When the user creates/edits/deletes a post, update the index immediately.
- **Background catch-up:** On app launch, check for any content changes missed while the app was closed (e.g., posts made via web).
- **Policy sync:** Background download when on WiFi, re-embed changed documents.

### Retrieval Quality

Poor retrieval quality undermines all use cases. Mitigation:

- **Hybrid search:** Combine vector similarity with keyword (BM25) search for better recall.
- **Metadata filtering:** Pre-filter by content type, date range, or destination before vector search.
- **Re-ranking:** After initial top-k retrieval, re-rank with a small cross-encoder model (adds 50-100ms but improves precision).

### Privacy UX

Users should understand what's happening:

- Show "analyzed on your device" badge on all on-device RAG features.
- For hybrid mode (local retrieval, server generation): show exactly which snippets will be sent to the server and let the user approve/redact.
- Provide "delete my local index" option that wipes all embeddings.

---

## Deeper Investigation Needed

- [ ] Prototype Use Case 2 (semantic search) as a standalone feature -- lowest complexity, highest confidence of value
- [ ] Measure retrieval quality: precision@5 and recall@10 for policy-aware risk queries with MiniLM embeddings
- [ ] Design the "approval screen" for hybrid mode -- what does the user see before data leaves the device?
- [ ] Evaluate hybrid search (vector + BM25) vs. vector-only for Trellis's content types
- [ ] Define policy document schema and chunking strategy for the knowledge base
- [ ] Test real-time alerting latency (Use Case 4) on mid-range devices

---

**Last Updated:** April 2026
