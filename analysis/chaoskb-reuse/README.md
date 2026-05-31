# ChaosKB Reuse Assessment

Initial review, 2026-04-12.

Question: *"Does `/Users/rmyers/repos/dot/chaoskb` offer any insights, ideas, concepts or features useful for Trellis? If necessary, it is possible to change or fork chaoskb or refactor components out of it."*

**Short answer:** yes — primarily the crypto layer. Chaoskb has production-grade cryptographic primitives and architectural patterns that are substantially more mature than what `@trellis/crypto` has today. The most direct benefit is for the E2E-DM work in [spyware-defense P1.1](../spyware-defense/03-priorities.md) and the encrypted travel-prep snapshots implied by the downstream border-safety feature (in the trellis product repo).

## What chaoskb is

A personal encrypted knowledge base. The server (Lambda + DynamoDB, ~$0.25/mo) stores only opaque ciphertext blobs; all content fetching, embedding, search, and encryption run on the client. The server never sees plaintext URLs, content, tags, or embeddings. The architecture is zero-knowledge by design, with a formal envelope specification, test vectors, and a documented threat model in [`chaoskb/doc/design/`](../../../chaoskb/doc/design/).

The product is currently a CLI/MCP client (Claude Desktop, Cursor, VS Code integration) with a planned Flutter mobile app. Repository is private; owner is the same de-otio org as Trellis.

## Contents

1. [**Crypto comparison**](01-crypto-comparison.md) — side-by-side of `@trellis/crypto` vs chaoskb's crypto module. The gap is substantial.
2. [**Reuse map**](02-reuse-map.md) — where chaoskb's existing capabilities map onto already-documented Trellis concerns (spyware-defense P1.1/P3.2, the downstream encrypted-archive feature, tiered UX, etc.).
3. [**Integration options**](03-integration-options.md) — four options ranked, plus concrete lists of which chaoskb components to pull and which to leave behind.
4. [**Next steps and open questions**](04-next-steps.md) — a 5-step implementation plan if the recommended option is approved, plus five decisions to make before committing.

## How to read this

- **If you only read one file**, read [`03-integration-options.md`](03-integration-options.md) — it names the options and the work.
- **If you want to decide**, jump to [`04-next-steps.md`](04-next-steps.md)'s open questions.
- **If you want to justify the decision**, [`01-crypto-comparison.md`](01-crypto-comparison.md) is the evidence.
