# 08 — Verdict: Neptune Serverless vs self-hosted vs AuraDB

This doc consolidates the findings from docs `01`–`07` into a decision
framework that directly complements the self-hosted analysis's revisit-trigger
framework.

## The three-way comparison

|  | Self-hosted Neo4j Community | AuraDB Professional | Neptune Serverless (writer + reader) |
|---|---|---|---|
| **SPOF (compute)** | Yes | No | **No** |
| **SPOF (storage)** | Yes (single AZ) | No | **No** (6-way, 3-AZ always) |
| **AWS-native (homogeneity)** | Yes | **No** | Yes |
| **CloudWatch / CloudTrail** | Yes | No | Yes |
| **CDK-manageable** | Yes | No | Yes |
| **Cost (~1 GB, idle)** | ~$55/mo | ~$65/mo | **~$20/mo** |
| **Cost (~5 GB, moderate load)** | ~$55/mo | ~$325/mo | ~$74/mo |
| **PITR** | No (snapshots + weekly dump) | Yes (7-day PITR) | **Yes (1–35 day PITR)** |
| **Cypher dialect** | Full Neo4j Cypher | Full Neo4j Cypher | openCypher subset |
| **APOC / GDS** | Yes | Curated subset | **No** |
| **shortestPath() in queries** | Yes | Yes | **No** |
| **Interface rework required** | — | `AuraGraphConnection` (thin) | `NeptuneServerlessConnection` (moderate) |
| **Patch surface** | Owned by you | Managed | **Managed** |

## When Neptune Serverless is the right choice

### Greenfield, no existing Cypher debt

If the project has not yet written graph queries, Neptune Serverless is the
strongest starting point. The openCypher constraints ([`04`](04-opencypher-compatibility.md))
are design-time constraints, not migration costs. A codebase written from
day one against openCypher has no compatibility debt.

### HA required before SLA obligations exist

The self-hosted analysis defers HA until "first B2B contract with an uptime
SLA" (its trigger #1). Neptune Serverless lets you have HA *before* that trigger
fires, without the AuraDB cost or the homogeneity loss. For a product where
early beta users or internal stakeholders expect reasonable uptime (even
without a formal SLA), this is a meaningful improvement.

### Cost sensitivity at scale

Once the graph exceeds 1–2 GB, Neptune is dramatically cheaper than AuraDB.
At 5 GB, Neptune is ~4× cheaper than AuraDB ($74 vs $325/month). If the
business model projects significant graph growth, Neptune's pricing model
favours the self-hoster more than AuraDB's per-GB pricing does.

### PITR without operational work

Neptune's built-in PITR eliminates the self-hosted backup complexity (EBS
snapshots + weekly `neo4j-admin dump`). If the self-hosted analysis's trigger #2
("PITR becomes a requirement") seems likely to fire early, Neptune Serverless
satisfies it from day one.

## When Neptune Serverless is NOT the right choice

### Heavy use of Neo4j-specific features

If the data model or query patterns rely on:
- `shortestPath()` / `allShortestPaths()` in real-time user-facing queries
- APOC procedures (especially `apoc.periodic.iterate` for large batch updates)
- Graph Data Science algorithms in-query
- Multi-valued list properties in the core data model

…then Neptune's openCypher subset is a genuine capability constraint, not
just a dialect difference. Evaluate whether Neptune Analytics can serve the
algorithm needs offline; if not, self-hosted Neo4j or AuraDB is the right
answer.

### Existing Neo4j codebase with unaudited Cypher

If there is already a substantial Neo4j codebase with queries that have not
been audited against the openCypher compliance table, the migration risk is
unquantified. The safe path is to audit first, or to defer Neptune until the
scope is known.

### Identical Cypher dialect is a hard requirement

The self-hosted ↔ AuraDB axis has zero query migration cost (per the self-hosted analysis).
Neptune requires at minimum a data model review and a query audit. If the
team places high value on the frictionless self-hosted ↔ AuraDB swap, adding
Neptune as an option complicates the reversibility story.

## Recommended decision tree

```
Does the data model require real-time shortestPath()
or heavy APOC/GDS procedures?
│
├─ YES → Self-hosted Neo4j (pre-launch) → AuraDB (post-SLA)
│        [self-hosted design, unchanged]
│
└─ NO ──┐
        Is there existing Cypher code with unknown Neptune
        compatibility?
        │
        ├─ YES → Audit against the openCypher table (04) first,
        │        then re-evaluate.
        │
        └─ NO ──┐
                Does the project need HA before the first
                B2B SLA, OR is cost at 2+ GB a concern?
                │
                ├─ YES → Neptune Serverless [this folder]
                │        (writer + reader, 1–8 NCU)
                │
                └─ NO ──┐
                        Is pre-launch cost the primary
                        constraint?
                        │
                        ├─ YES → Self-hosted Neo4j
                        │        Flip to Neptune or AuraDB on
                        │        first revisit trigger
                        │
                        └─ NO → Neptune Serverless still wins
                                on total picture (HA + homogeneity
                                + cost at scale)
```

## Updating the self-hosted analysis's revisit triggers

The trigger table in the self-hosted analysis should gain a seventh entry:

| # | Trigger | Why it flips | Flip to |
|---|---|---|---|
| 7 | **HA desired before first SLA contract, or graph >2 GB** | Self-hosted SPOF becomes unacceptable before trigger #1 fires; Neptune cheaper than AuraDB at scale while preserving homogeneity | Neptune Serverless (`NeptuneServerlessConnection`) — requires `IGraphConnection` interface update ([`05`](05-connection-protocol.md), [`06`](06-cdk-construct.md)) and openCypher audit ([`04`](04-opencypher-compatibility.md)) |

## The honest residual costs

Choosing Neptune Serverless over self-hosted Neo4j is not free of trade-offs:

1. **One-time build cost.** `NeptuneServerlessConnection` needs to be written
   ([`06`](06-cdk-construct.md)) and `IGraphConnection` updated
   ([`05`](05-connection-protocol.md)). Estimated: 1–2 days including tests.

2. **Query audit required.** Every Cypher query in the codebase should be
   checked against the compliance table ([`04`](04-opencypher-compatibility.md)).
   For a small pre-launch codebase, this is an afternoon. For a large
   codebase with Cypher debt, it is a project.

3. **`@aws-cdk/aws-neptune-alpha` is experimental.** The CDK package may
   have breaking changes between releases. Requires version pinning and
   periodic upgrade attention.

4. **No lookup cache.** Neptune Serverless cannot use Neptune's lookup
   cache. For heavy ID-lookup workloads this may increase latency at scale
   compared to a provisioned Neptune instance. Monitor `GremlinRequestsPerSec`
   and `BufferCacheHitRatio`; migrate to provisioned Neptune if needed.

5. **Scale-up latency from low minimum.** Sudden traffic spikes against a
   1-NCU-minimum cluster experience elevated latency during the scale-up
   window (seconds to tens of seconds). Set minimum to 2–4 NCU if P99
   latency on burst traffic is a user-facing concern.

These are real but bounded costs. For a new codebase starting from scratch,
the one-time build cost is the only material item — queries and data model
are designed for openCypher from day one.

## Open questions

- **What is the actual query workload?** The decision tree above assumes
  "no shortestPath/APOC". Validate this by enumerating the planned graph
  traversals for the first feature vertical before committing.
- **Neptune Serverless lookup cache alternative.** When Neptune's lookup
  cache support is added for Serverless (it's a listed limitation, not a
  design decision), this constraint goes away. Track the Neptune release
  notes.
