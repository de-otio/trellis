# On-Device AI: Open Questions & Next Steps

**Date:** April 2026
**Purpose:** Track key decisions, unknowns, and investigation items across the on-device AI analysis.

---

## Key Decisions Needed

### 1. Model Bundling vs. Download

**Question:** Bundle the embedding model (~80MB) in the app and download the generation model (~1.5GB) on demand? Or download everything on demand?

**Tradeoffs:**
- Bundling the embedding model enables retrieval features (semantic search, content warnings) immediately with no setup.
- The generation model is too large to bundle. On-demand download requires WiFi and planning ahead.
- App Store / Play Store may have review implications for large bundled models.

**Leaning toward:** Bundle embedding model, download generation model on demand.

### 2. Platform-Specific vs. Cross-Platform Generation

**Question:** Use Gemini Nano on Android (free, no bundling) and llama.cpp + Gemma on iOS? Or standardize on llama.cpp everywhere?

**Tradeoffs:**
- Gemini Nano: zero cost on Android, managed by Google, but output quality and capabilities differ from Gemma via llama.cpp.
- Standardizing on llama.cpp: consistent behavior across platforms, but requires bundling/downloading a model on Android too.
- Platform divergence means different test matrices and potentially different feature availability.

**Leaning toward:** Start with llama.cpp everywhere for consistency. Evaluate Gemini Nano as an optimization later.

### 3. Embedding Model Choice

**Question:** MiniLM (80MB, good) vs. BGE-small (130MB, better) vs. Apple NL embeddings (free on iOS)?

**Tradeoffs:**
- MiniLM is the smallest viable option with well-understood quality.
- BGE-small is 60% larger but retrieval quality may be noticeably better.
- Apple NL embeddings are free (no bundling) on iOS but quality for policy retrieval is unknown.

**Next step:** Benchmark all three on a representative set of policy retrieval queries. Decision depends on measured precision@k.

### 4. Multilingual Support

**Question:** Do on-device embeddings need to handle multiple languages, or can non-English content be handled server-side?

**Tradeoffs:**
- Multilingual embedding models are 3-5x larger (~470MB vs. ~80MB).
- Trellis's user base likely includes multilingual users (travelers, international communities).
- English-only on-device + server-side for other languages is a pragmatic starting point but degrades the privacy story for non-English users.

**Leaning toward:** Start with English-only on-device. Flag as a known limitation. Revisit based on actual user language distribution.

### 5. Hybrid Search (Vector + BM25)

**Question:** Is pure vector search sufficient, or should we combine with keyword search for better recall?

**Tradeoffs:**
- Hybrid search (vector + BM25) consistently outperforms either alone in benchmarks.
- Adds implementation complexity: need both a vector index and a full-text index.
- SQLite already has FTS5 for full-text search, so the infrastructure cost on mobile is low.

**Leaning toward:** Implement hybrid search from the start since SQLite FTS5 is already available.

---

## Technical Unknowns

| # | Unknown | Why It Matters | Investigation |
|---|---------|---------------|---------------|
| 1 | Apple NL embedding quality for policy retrieval | Could eliminate bundling an embedding model on iOS | Benchmark precision@k against MiniLM |
| 2 | SQLite-vss stability on iOS/Android via Flutter | Core infrastructure dependency | Build a prototype and stress-test |
| 3 | Cold-start latency for model loading | Affects perceived responsiveness on first use | Measure on target devices |
| 4 | Background model download on iOS | iOS restricts background downloads >30s | Test with Background URLSession |
| 5 | App Store review for bundled ML models | Apple may flag large model files | Check current guidelines, submit test build |
| 6 | Gemma 2B Q4 accuracy on risk classification | Determines if Tier 1 triage is useful or misleading | Benchmark on labeled BSM test set |
| 7 | Memory pressure during concurrent RAG + UI rendering | Could cause app kills on mid-range devices | Profile on target devices |
| 8 | Incremental index update correctness | Edit/delete must correctly update vectors | Unit test the index management layer |

---

## Suggested Investigation Order

### Phase 1: Validate Feasibility (1-2 weeks)

1. **Prototype semantic search** (Use Case 2 from [02-use-cases.md](02-use-cases.md)) -- lowest complexity, proves the on-device RAG stack works.
   - Bundle MiniLM via ONNX Runtime
   - SQLite-vss for vector store
   - Index 1,000 sample posts
   - Measure: indexing time, retrieval latency, retrieval quality, memory usage

2. **Benchmark embedding models** -- MiniLM vs. BGE-small vs. Apple NL on a representative query set.

3. **Test on target devices** -- flagship, mid-range, low-end. Establish the capability tiers empirically.

### Phase 2: Build Core Infrastructure (2-3 weeks)

4. **On-device embedding + indexing pipeline** in Flutter (platform channels to native ONNX/Core ML).
5. **Policy document ingestion** -- chunk, embed, and store the policy knowledge base.
6. **Capability detection** -- determine device tier and available features.

### Phase 3: First Feature (2-3 weeks)

7. **Semantic search over personal content** -- ship as a standalone feature, independent of BSM.
8. **Content warnings before posting** -- leverage the same index with policy retrieval.

### Phase 4: BSM Integration (3-4 weeks)

9. **Tier 1 on-device risk triage** -- local classification of posts against policy index.
10. **Tier 2 hybrid risk assessment** -- local retrieval with server generation, approval screen UX.
11. **Tier escalation flow** -- seamless transition between tiers with consent.

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| On-device generation quality too low for useful triage | Tier 1 becomes useless, undermines the tiered approach | Medium | Benchmark early. If quality is too low, make Tier 1 retrieval-only (show flagged posts without explanation) |
| SQLite-vss has stability issues on mobile | Core infrastructure failure | Low-Medium | Have LanceDB as fallback. Prototype early |
| Users don't understand the tiered privacy model | Consent flow confusion, trust erosion | Medium | User research on the approval screen. Simplify if needed |
| Model download fails or takes too long | Users can't access generation features | Medium | Aggressive pre-download prompting. Fallback to server-only |
| App Store rejects large model bundles | Can't ship the feature | Low | Download on demand instead of bundling. Check guidelines early |
| Embedding model quality insufficient for policy retrieval | False positives/negatives in risk assessment | Medium | Benchmark early. Use hybrid search (vector + BM25) to compensate |

---

**Last Updated:** April 2026
