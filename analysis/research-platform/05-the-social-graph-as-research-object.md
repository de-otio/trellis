# 05 — The social graph as a research object

*Regime: observation. Primary risk: structural re-identification.*

Network science is one of the richest areas of social-media research —
homophily, contagion, tie formation and decay, community structure, diffusion.
Trellis is unusual in that its social graph is a **first-class, queryable,
scored artefact** rather than a quantity reconstructed at read time. This makes
it a genuinely attractive object of study, and a genuinely dangerous one to
release.

## What the graph layer actually offers researchers

From `apps/api/src/lib/graph/`:

- **Typed, scored edges.** `scoring-engine.ts` computes user→user scores from
  *reciprocity, frequency, connection, and decay* components, and user→entity
  scores from *engagement, frequency, proximity, content-creation, connection,
  decay*. The edge weight has **documented, inspectable semantics** — a
  researcher knows what the number means, instead of treating an opaque
  "affinity" score as a black box.
- **Tiers.** `TIER_THRESHOLDS` bucket relationships into strength tiers — a
  ready-made operationalisation of strong/weak ties (Granovetter), with the
  cutoffs written down.
- **Temporal structure.** Edges carry `createdAt`; decay is explicit. Tie
  *formation and decay over time* — the heart of dynamic-network research — is
  directly observable rather than inferred.
- **Reciprocity as data.** `reciprocated` is a stored property, not a join you
  have to guess at — directed vs. mutual ties are first-class.
- **A real backend for it.** Neo4j/Neptune (`graph-factory.ts`) means
  graph-native queries (paths, communities, centrality) run where they belong,
  and a research extract can be a subgraph export rather than a pile of edge
  rows to reassemble.

For an *observational* study run **inside** the platform (Tier-1 aggregate
queries over graph metrics — degree distributions, clustering coefficients,
component sizes, tie-strength distributions), this is close to ideal and
low-risk: the statistics leave, the graph doesn't.

## Why releasing the graph is the hardest disclosure problem

Graphs resist de-identification far worse than tabular data. Stripping names is
nearly worthless because **structure itself identifies people**:

- **Backstrom, Dwork & Kleinberg (WWW 2007)** showed both active and passive
  attacks that re-identify nodes in an "anonymised" social graph using only its
  structure (and, for active attacks, a few planted accounts).
- **Narayanan & Shmatikov (2009)** de-anonymised a real social network (a
  Twitter/Flickr cross-mapping) using a second graph as auxiliary information.
- A person with a **unique neighbourhood** (an unusual-degree node, a bridge
  between two communities, a distinctive triangle pattern) is re-identifiable
  even with every attribute removed — and in a bounded research instance, many
  nodes are unique.

So the Tier-2/Tier-3 ladder from doc 03 applies, but with graph-specific
transforms, and the bar for any *exported* graph is high.

## Graph-specific protections

For studies that genuinely need structure (not just metrics), in increasing
strength:

1. **Aggregate-only (Tier 1).** Release distributions and global metrics, never
   the edge list. Covers a large fraction of network studies. **Default.**
2. **k-degree anonymity** (Liu & Terzi, 2008) — perturb the graph (add/remove
   edges) so every node shares its degree with ≥ k−1 others. Resists
   degree-based attacks; weak against neighbourhood/subgraph attacks.
3. **Differentially private graph statistics** — release metrics (degree
   sequence, triangle/subgraph counts) under edge-DP or node-DP. Node-DP is very
   costly in accuracy but is the strong guarantee; edge-DP is the usual
   practical compromise. Pair this with the doc-03 per-study ε budget.
4. **Synthetic graphs** — fit a generative model (stochastic block model,
   degree-corrected SBM, or a privacy-aware generator) to the real graph and
   release *synthetic* edges that preserve target statistics without
   corresponding to real ties. Increasingly the preferred release for structure.
5. **Sealed enclave only** for any analysis on the true graph (Tier 2), with no
   copy-out and a DUA.

**Recommendation:** the default graph product is **Tier-1 aggregate metrics +
optional synthetic-graph release**; true-structure access is enclave-only and
rare. There is no responsible "download the anonymised social graph" endpoint.

## Federation interacts with this

The graph edges may reference **remote ActivityPub actors** once federation is
on. Two consequences:

- A research instance should generally run **non-federated / standalone**
  (`activitypub/standalone-mode.ts`) for the study duration, so the studied
  population is bounded and consent-tracked, and the graph doesn't sprout edges
  to people who never consented to anything.
- If federated, edges to remote actors are **edges to non-participants** and
  must be dropped or generalised before any analysis touching them — a remote
  follower never joined the study.

## Build on what exists

- `ExtensionGraphService` (read-only, no write methods) is the correct base; the
  research path adds a **de-identifying / aggregating layer** above it, not raw
  Cypher access.
- The scoring components in `scoring-engine.ts` should be **published as a
  codebook** (doc 07): a researcher must be told exactly how an edge weight is
  computed for the weight to be scientifically usable.
- A subgraph extract reuses the export-pipeline skeleton (`routes/export.ts`)
  with a graph-transform stage (perturbation / synthesis) before egress.

## Sources

- L. Backstrom, C. Dwork, J. Kleinberg, "Wherefore Art Thou R3579X?", *WWW*,
  2007.
- A. Narayanan & V. Shmatikov, "De-anonymizing Social Networks", *IEEE S&P*,
  2009.
- K. Liu & E. Terzi, "Towards Identity Anonymization on Graphs", *SIGMOD*, 2008.
- M. Hay et al., "Accurate Estimation of the Degree Distribution of Private
  Networks" (edge-DP graph statistics), *ICDM*, 2009.
- M. Granovetter, "The Strength of Weak Ties", *AJS*, 1973 (tie-strength
  operationalisation).
