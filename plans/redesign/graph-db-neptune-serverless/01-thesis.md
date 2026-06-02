# 01 — The thesis: Neptune Serverless fills the gap the self-hosted analysis left open

The self-hosted analysis frames the self-hosting decision as a binary choice:

- **Self-hosted Neo4j Community** — cheap, AWS-native (homogeneity dividend
  preserved), but SPOF.
- **AuraDB** — HA, but outside the AWS account (homogeneity dividend lost).

This is a false dichotomy. There is a third position:

> **Neptune Serverless** — managed HA *and* AWS-native. It is the option
> the self-hosted analysis names but does not evaluate.

## What the self-hosted analysis said about Neptune

[the self-hosted analysis](../graph-db-self-host-ai-revisit.md) mentions
Neptune once, as the "further escape hatch" beyond AuraDB, and calls out two
things to watch:

1. Neptune's openCypher is a *subset* of Neo4j's Cypher (no APOC, no list
   properties, no `FOREACH` in writes).
2. The Bolt-centric `IGraphConnection` abstraction doesn't directly fit
   Neptune's protocol.

Both points are real costs. What it doesn't pursue is whether those
costs are outweighed by what Neptune uniquely offers — which is the topic of
this folder.

## The gap: homogeneity *and* HA

[the self-hosted analysis](../graph-db-self-host-ai-revisit.md) makes
the homogeneity argument precisely: the value of self-hosting is not that
Neo4j-on-EC2 is cheap, it is that pulling the last stateful dependency into
AWS makes the *entire* system observable and operable through one tool surface.
AuraDB is explicitly rejected on this basis — it is a telemetry seam, a
control seam, an audit seam.

Neptune Serverless has none of those seams:

| Dimension | Self-hosted Neo4j | AuraDB | Neptune Serverless |
|---|---|---|---|
| In AWS account | Yes | **No** | Yes |
| CloudWatch metrics | Yes | No | Yes |
| CloudTrail audit | Yes | No | Yes |
| CDK-manageable | Yes | No | Yes |
| Config / cdk-nag | Yes | No | Yes |
| SPOF (compute) | **Yes** | No | No (with reader) |
| SPOF (storage) | **Yes** | No | No (always 3-AZ) |

The homogeneity argument that the self-hosted analysis uses to justify
self-hosting applies *equally* to Neptune Serverless — and Neptune removes the
SPOF that self-hosting cannot.

## Why this wasn't the obvious choice in the self-hosted analysis

Three reasons it didn't pursue Neptune:

1. **Protocol mismatch framing.** The `IGraphConnection` abstraction was
   designed around Bolt + Neo4j credentials. Neptune speaks Bolt too
   ([`05`](05-connection-protocol.md)), but the auth model differs, and the
   doc didn't work through that.

2. **"Further escape hatch" framing.** Naming Neptune as a third-tier option
   implicitly positions it as more distant and more costly than it is. In
   practice Neptune Serverless is *cheaper* than both alternatives at
   pre-launch scale ([`03`](03-capacity-and-cost.md)).

3. **Cypher compat uncertainty.** Not knowing how much Cypher code would need
   rewriting made Neptune feel risky. [`04`](04-opencypher-compatibility.md)
   maps the actual gaps — they are real but bounded.

## The trade-off in one sentence

Neptune Serverless gives you HA + homogeneity at lower cost than AuraDB, in
exchange for a one-time investment: reworking `IGraphConnection` to support
Neptune's auth model, and auditing Cypher queries against the openCypher
compliance table.

## What this folder establishes

- [`02`](02-storage-and-availability.md) — what the HA story actually looks
  like (storage is always 3-AZ; compute HA requires one reader replica).
- [`03`](03-capacity-and-cost.md) — the cost case, including that Neptune
  Serverless with one reader is **cheaper** than the current self-hosted
  design at pre-launch scale.
- [`04`](04-opencypher-compatibility.md) — the Cypher gap: concrete,
  enumerated, most gaps are edge-case features unlikely to appear in a new
  codebase.
- [`05`](05-connection-protocol.md) — Neptune supports Bolt natively; the
  `IGraphConnection` change is modest, not a rebuild.
- [`06`](06-cdk-construct.md) — what a `NeptuneServerlessConnection` CDK
  construct looks like.
- [`07`](07-data-migration.md) — how to move data if switching from
  self-hosted Neo4j.
- [`08`](08-verdict.md) — when Neptune wins and when it doesn't.
