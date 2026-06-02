# Amazon Neptune Serverless: detailed investigation

> **Status — chosen direction.** Neptune Serverless is the selected graph-DB
> hosting approach. This folder evaluates it in depth and supersedes the
> self-hosted recommendation in
> [`graph-db-self-host-ai-revisit.md`](../graph-db-self-host-ai-revisit.md).
>
> **Provenance.** This analysis was originally written as a follow-up to a
> `saas-foundation` design folder (the "self-hosted graph DB" design, since
> removed). Where these files refer to "the self-hosted analysis" or "the
> self-hosted design," they mean that prior work, whose surviving equivalent in
> this repo is [`graph-db-self-host-ai-revisit.md`](../graph-db-self-host-ai-revisit.md)
> (with the earlier [`graph-db-hosting-decision.md`](../graph-db-hosting-decision.md)
> and [`graph-db-managed-analysis.md`](../graph-db-managed-analysis.md)).

This folder is a focused follow-up to
[the self-hosted analysis](../graph-db-self-host-ai-revisit.md), which frames
graph-DB hosting as a binary choice: cheap-but-SPOF self-hosted Neo4j, or
HA-but-non-AWS AuraDB. The gap it leaves open is that **Neptune Serverless is
the only option that simultaneously eliminates the SPOF *and* keeps everything
in the AWS account** — the two properties the self-hosted analysis treats as
mutually exclusive.

## Topic map

| File | What it covers |
|---|---|
| [`01-thesis.md`](01-thesis.md) | Why Neptune Serverless fills the gap the self-hosted analysis left open |
| [`02-storage-and-availability.md`](02-storage-and-availability.md) | 6-way replicated storage, compute HA, failover behaviour |
| [`03-capacity-and-cost.md`](03-capacity-and-cost.md) | NCU model, scaling behaviour, pricing table, cost comparison |
| [`04-opencypher-compatibility.md`](04-opencypher-compatibility.md) | What works vs Neo4j Cypher, what doesn't, migration gap table |
| [`05-connection-protocol.md`](05-connection-protocol.md) | Bolt on Neptune, IAM auth, `IGraphConnection` interface impact |
| [`06-cdk-construct.md`](06-cdk-construct.md) | `NeptuneServerlessConnection` CDK construct design |
| [`07-data-migration.md`](07-data-migration.md) | Neo4j → Neptune migration path and tooling |
| [`08-verdict.md`](08-verdict.md) | Decision framework: Neptune vs self-hosted vs AuraDB |
| [`09-implementation-plan.md`](09-implementation-plan.md) | Parallelized build plan (greenfield; first consumer = skybber, pre-launch) |
| [`10-opencypher-audit.md`](10-opencypher-audit.md) | Track-B output: every Neptune-incompatible Cypher feature in the trellis graph layer, with rewrites + revised sizing (~4–7 days) |

## The one-sentence summary

Neptune Serverless eliminates the SPOF, preserves full AWS observability, and
costs **less** than self-hosted Neo4j at pre-launch scale — at the price of a
moderate Cypher dialect gap and a `IGraphConnection` interface rework.
