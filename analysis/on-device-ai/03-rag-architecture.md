# On-Device RAG: Technical Architecture

**Date:** April 2026
**Question:** How does RAG work on a phone? What are the components, constraints, and realistic limits?

---

## Architecture Overview

On-device RAG follows the same retrieve-then-generate pattern as server RAG, but both components run locally within the app's sandbox.

```
+------------------+     +------------------+     +------------------+
| Embedding Model  |     | Vector Store     |     | Generation Model |
| (80-150MB)       |     | (SQLite-vss)     |     | (Gemma 2B Q4)   |
| MiniLM / BGE     |     | On-device index  |     | ~1.5 GB          |
+--------+---------+     +--------+---------+     +--------+---------+
         |                        |                         |
    embed query             k-NN search              generate answer
         |                        |                         |
         v                        v                         v
   384-dim vector  ------>  Top-k chunks  ---------->  Risk assessment
                                                       or summary
```

The retrieval half (embedding + vector search) is lightweight and feasible on nearly any modern phone. The generation half (LLM inference) is resource-intensive and may need to be offloaded to a server for mid-range and lower devices.

---

## Component 1: Embedding Models

These convert text into dense vector representations for similarity search.

| Model | Size | Dimensions | Quality | Notes |
|---|---|---|---|---|
| all-MiniLM-L6-v2 | 80MB | 384 | Good | Best size/quality tradeoff for mobile. Well-studied, widely deployed |
| BGE-small-en-v1.5 | 130MB | 384 | Better | Stronger retrieval quality, slightly larger |
| Nomic Embed Text v1 | ~100MB (quantized) | 768 | Better | Higher dimensionality, more storage per vector |
| Apple NL embeddings | Built-in (0MB) | Varies | Decent | Free on iOS, no model to bundle. Quality unknown for policy retrieval tasks |
| GTE-small | 70MB | 384 | Good | Competitive with MiniLM at smaller size |

### Recommendations

- **Start with MiniLM** (80MB, well-understood, good enough for 5K-chunk corpora)
- **Test Apple NL embeddings on iOS** -- if quality is sufficient for policy retrieval, it eliminates bundling a model on Apple devices entirely
- **Evaluate BGE-small** if retrieval quality with MiniLM proves insufficient

### Multilingual Consideration

Trellis users may post in multiple languages. Multilingual embedding models exist but are larger:

| Model | Size | Languages | Notes |
|---|---|---|---|
| paraphrase-multilingual-MiniLM-L12-v2 | 470MB | 50+ | Significantly larger than English-only |
| multilingual-e5-small | 470MB | 100+ | Good quality, same size concern |

**Decision needed:** Is multilingual on-device embedding required, or can non-English content be handled server-side?

---

## Component 2: Vector Stores

These store and search the embedded vectors on-device.

| Store | Approach | Flutter Support | Notes |
|---|---|---|---|
| **SQLite-vss** | SQLite extension, Faiss-backed ANN search | Via `sqflite` + native extension | Natural fit -- SQLite is already standard on mobile. Proven technology |
| **LanceDB** | Embedded, serverless, columnar file format | FFI binding needed | No server process. Good for append-heavy workloads |
| **ObjectBox** | Mobile-native DB with vector search | `objectbox` Flutter package | Good Flutter integration. Newer vector search support |
| **Custom HNSW** | Store vectors as BLOBs in SQLite, implement search in Dart/C | Full control | Maximum control, highest implementation effort |
| **Qdrant embedded** | Embedded mode of Qdrant | FFI binding needed | Full-featured but potentially heavy for mobile |

### Recommendations

- **SQLite-vss** is the safest choice: SQLite is battle-tested on mobile, the extension adds vector search with minimal overhead, and `sqflite` is mature in Flutter.
- **ObjectBox** is worth evaluating if its Flutter package and vector search are production-ready -- it would simplify the data layer.

### Index Management

The vector index needs to be maintained as content changes:

- **User posts:** Re-embed on create/edit/delete. Incremental updates, not full rebuilds.
- **Policy documents:** Bulk re-embed on policy update (background task when on WiFi).
- **Index versioning:** Track which embedding model version created the index. If the model changes, the index must be rebuilt.

---

## Component 3: Generation Models (Optional for RAG)

Many RAG use cases (semantic search, classification) need only retrieval. Generation is needed for synthesis ("explain why these posts are risky").

| Model | Size (Q4) | RAM | Speed (flagship) | Quality | Notes |
|---|---|---|---|---|---|
| Gemma 2B | 1.5 GB | 2-3 GB | 2-5 tok/s | Decent | Google's small model, good multilingual |
| Phi-3-mini (3.8B) | 2.2 GB | 3-4 GB | 1-3 tok/s | Better | Microsoft, strong reasoning for size |
| Gemini Nano | Managed | Managed | Faster | Good | Android only, via AICore API |
| Qwen2-1.5B | 1.0 GB | 1.5-2 GB | 3-7 tok/s | Decent | Smallest viable option |

### Recommendations

- **For Android:** Use Gemini Nano (zero bundling cost, Google-managed) with llama.cpp + Gemma as fallback for unsupported devices.
- **For iOS:** llama.cpp + Gemma 2B Q4 via Core ML delegate for Neural Engine acceleration.
- **Generation is optional** for the initial implementation -- retrieval-only features (semantic search, content warnings via classification) provide value without it.

---

## Feasibility Constraints

| Constraint | Realistic Limit (2026 flagship) | Mid-range | Low-end |
|---|---|---|---|
| Embedding model storage | 80-150 MB | Same | Same |
| Vector index (50K vectors) | <100 MB | Same | Same |
| Generation model storage | 1.5-2.2 GB | Not feasible | Not feasible |
| Embedding latency (per chunk) | 10-50ms | 30-100ms | 50-200ms |
| Retrieval latency (top-k, 50K vectors) | 5-20ms | 10-40ms | 20-80ms |
| Generation speed | 2-5 tok/s | Not feasible | Not feasible |
| RAM for retrieval | 200-400 MB | 200-400 MB | 200-400 MB |
| RAM for retrieval + generation | 2-4 GB | Not feasible | Not feasible |

### Trellis-Specific Corpus Size Estimates

| Content Type | Estimated Chunks | Notes |
|---|---|---|
| User's own posts (active user, 2 years) | 500-2,000 | ~1-3 posts/day, chunked by paragraph |
| User's comments | 200-1,000 | Shorter, fewer chunks per item |
| User's liked/saved content | 500-2,000 | If indexed for self-assessment |
| Policy documents (all countries) | 500-1,000 | Structured policy KB |
| Policy documents (single country) | 20-50 | What's needed for one trip assessment |
| **Total (typical user)** | **1,500-5,000** | Well within mobile constraints |

This corpus size means even mid-range devices can handle the retrieval workload comfortably. The constraint is generation, not retrieval.

---

## Data Flow: Indexing Pipeline

```
1. User creates/edits post
   |
2. On-device embedding model converts text to vector
   |
3. Vector + metadata (post ID, date, type) stored in SQLite-vss
   |
4. Index updated incrementally (no full rebuild)

---

5. Policy update arrives (background, on WiFi)
   |
6. New policy documents chunked and embedded
   |
7. Old policy vectors replaced in index
   |
8. Index version bumped
```

### Chunking Strategy

- **Posts/comments:** Treat each as a single chunk (most are short enough). Split long posts at paragraph boundaries.
- **Policy documents:** Chunk at section level with overlap. Include country + policy name as metadata for filtering.
- **Chunk size target:** 256-512 tokens for embedding models optimized at that range.

---

## Deeper Investigation Needed

- [ ] Benchmark MiniLM vs. Apple NL embeddings on policy document retrieval (precision@k)
- [ ] Test SQLite-vss on iOS and Android via Flutter -- any platform-specific issues with the native extension?
- [ ] Measure indexing time for 5K chunks on a mid-range device (background task feasibility)
- [ ] Evaluate quantization impact on embedding quality (INT8 vs. FP16 vs. FP32)
- [ ] Profile memory usage during concurrent retrieval + UI rendering
- [ ] Test incremental index updates vs. periodic full rebuilds for correctness

---

**Last Updated:** April 2026
