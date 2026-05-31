# Graph DB Hosting — Decision Analysis

> ## Status: Superseded (2026-04-12)
>
> This document's recommendation (Plain EC2 + Docker + EBS, self-hosted Neo4j Community) was **not** the final decision. After further analysis in [`graph-db-managed-analysis.md`](graph-db-managed-analysis.md), the solo-developer opportunity cost flipped the answer back to managed. The final choice is **Neo4j AuraDB Professional** for prod and **AuraDB Free** for dev/CI, with Docker `neo4j:5-community` for local work. See also the consuming deployment's graph-DB decision record (external) and [`graph-db-nonprod-environments.md`](graph-db-nonprod-environments.md).
>
> This file is retained as the record of the comparative analysis (Neptune vs self-hosted sub-variants) that led to discarding Neptune Serverless.

**Date:** 2026-04-12
**Status:** Historical. Self-hosted EC2 proposal was not pursued; AuraDB chosen instead.

---

## Context

The redesign chose Neptune Serverless for the social graph (users ↔ entities, relationships, circles, discovery). The original rationale (recorded in the consuming deployment's graph-DB decision record, external) cited "scales to zero, near-zero pre-launch cost" as a key reason.

**That claim is wrong.** Neptune Database Serverless does not scale to zero — the minimum is 1.0 NCU, billing continuously at ~$0.18/NCU-hour. Idle cost is ~$130/month floor. Confirmed via AWS docs ([Neptune pricing](https://aws.amazon.com/neptune/pricing/), [serverless capacity scaling](https://docs.aws.amazon.com/neptune/latest/userguide/neptune-serverless-capacity-scaling.html)). "Neptune Analytics" has a 10%-pause feature but is a different product (analytics/vector graph, not transactional Bolt reads).

This document reconsiders hosting given corrected pricing.

---

## Options Considered

### 1. Neptune Serverless (current plan)
- **Cost (pre-launch, idle):** ~$130/month
- **Cost (50k users):** ~$200–400/month realistic (2–4 NCU bursts)
- **Pros:** CDK-managed, IAM SigV4 auth, CloudWatch metrics, no ops
- **Cons:** 4× more expensive than self-host at every tier; locked-in to openCypher subset (no APOC, restricted list types)

### 2. Neo4j AuraDB Free
- **Cost:** Free forever at 200k nodes / 400k relationships, 1 GB
- **Cons:** Hard cap below a typical 50k-user target (~2M nodes, 7.5M edges). Would require migration mid-growth.
- **Verdict:** Viable for very-early pre-launch prototype only.

### 3. Neo4j AuraDB Professional
- **Cost:** $65+/month per GB, scaling up
- **Pros:** Fully managed, same Cypher dialect as local dev, drop-in from self-host
- **Cons:** More expensive than self-host; escape hatch rather than default

### 4. Self-hosted Neo4j Community on AWS
Several sub-variants compared below.

---

## Self-Hosted Sub-Variants

### 4a. ECS Fargate + EBS
- **Verdict: DEAD END.** AWS announced Fargate + EBS in 2024, but EBS volumes auto-delete when tasks stop. Reattachment across task restarts is not native; requires custom Lambda + EventBridge glue.
- Not a clean primitive for a persistent database. Footgun territory.

### 4b. ECS Fargate + EFS
- **Verdict: Workable but expensive and slow.** EFS General Purpose is $0.30/GB-month (3× EBS). Neo4j docs explicitly warn against NFS-backed data files. For a ~7.5M-edge graph with hot pagecache, the NFS latency only shows on cache misses — but benchmarks on public forums report 2-10× slower cold queries vs local disk.
- Not a first choice.

### 4c. ECS on EC2 + EBS
- **What the AWS-pattern answer recommends.**
- Orchestration benefits: task definition as code, auto-restart, log shipping, task role.
- **But:** Community Edition is single-writer. You can only run ONE Neo4j instance on that EBS volume. ECS's core value (orchestration of multiple containers, rolling updates, scaling) does not apply.

### 4d. Plain EC2 + Docker + EBS ✓ RECOMMENDED
- One EC2 instance. Neo4j runs via `docker run` inside a systemd unit. EBS mounted to `/data`.
- No ECS cluster, no task definition, no agent.
- systemd gives auto-restart on process crash. CloudWatch Agent ships logs. EC2 instance role injects Secrets Manager bolt password at container start.

---

## ECS-on-EC2 vs Plain-EC2 Breakdown

| Capability | ECS-on-EC2 | Plain EC2 | Winner for Neo4j |
|---|---|---|---|
| Container orchestration | ✓ | ✗ | ECS — but irrelevant (only one Neo4j instance) |
| Rolling updates | ✓ | ✗ | ECS — but impossible with a single-instance DB |
| Auto-scaling | ✓ | ✗ | ECS — Community can't scale horizontally |
| Auto-restart on crash | ✓ | ✓ (systemd) | tie |
| Log shipping to CloudWatch | ✓ | ✓ (agent) | tie |
| Secrets injection | Task role | Instance role | tie |
| EBS attach stability | mount flap risk on task rotation | attached at instance level | plain EC2 |
| Debug by SSH | indirect (exec into container) | direct | plain EC2 |
| Pieces to maintain | ECS cluster + agent + task def + service | Just an instance + userdata | plain EC2 |
| Consistency with trellis API (ECS Fargate) | ✓ | ✗ | ECS |

**Net:** ECS buys consistency-of-tooling and nothing else functional for this workload. Plain EC2 is fewer moving parts for a single-instance stateful service.

---

## Recommended Architecture

```
┌─────────────────────────────────────────────┐
│ VPC (private subnet, single AZ)             │
│ ┌─────────────────────────────────────────┐ │
│ │ EC2 t4g.medium (ARM64)                  │ │
│ │   ├── systemd: docker run neo4j:5-*     │ │
│ │   ├── CloudWatch Agent → /aws/ec2/neo4j │ │
│ │   └── EC2 instance role (Secrets+S3+CW) │ │
│ │                                         │ │
│ │   /data ─► EBS gp3 20GB ─► auto-snapshot│ │
│ └─────────────────────────────────────────┘ │
│         ▲                                   │
│         │ bolt://neo4j.internal:7687        │
│         │ (password in Secrets Manager)     │
│ ┌───────┴─────────────┐                     │
│ │ trellis API (ECS)   │                     │
│ └─────────────────────┘                     │
└─────────────────────────────────────────────┘
```

**Components:**
- **EC2:** t4g.medium (4 GB, ARM) pre-launch → t4g.large (8 GB) at ~50k users
- **Storage:** EBS gp3 20 GB (single-AZ; ~$1.60/month)
- **Container:** `neo4j:5-community` Docker image, run via systemd with `--restart=always`
- **Shutdown:** `stopTimeout 120s` in systemd unit; `tini` is PID 1 in the official image; `docker stop -t 120`
- **Logs:** CloudWatch Agent → log group `/aws/ec2/neo4j`
- **Secrets:** Bolt password in Secrets Manager; instance role grants read; systemd `EnvironmentFile` injects it at container start
- **Backup:** Daily EBS snapshot via AWS Backup or DLM (crash-consistent; Neo4j WAL handles recovery on next start). 7-day retention.
- **DNS:** Route 53 private zone record `neo4j.internal` → instance IP (via instance userdata or Elastic IP)
- **Security group:** port 7687 (bolt) from trellis API SG only; no public ingress
- **Monitoring:** CloudWatch alarm on `InstanceStatusCheck` + a synthetic bolt ping every 60s from trellis

---

## Cost Comparison (monthly, eu-central-1 approx)

| Option | Idle / Pre-launch | At ~50k users |
|---|---|---|
| Neptune Serverless | ~$130 | ~$200–400 |
| Plain EC2 + Docker (t4g.medium → t4g.large) | **~$30** | **~$55** (or ~$37 with 1yr RI) |
| ECS on EC2 + EBS | ~$30 | ~$55 (same; ECS has no incremental cost) |
| AuraDB Professional | ~$65/GB | scales with data |

**6-month pre-launch savings vs Neptune:** ~$600.

---

## Risks (ranked)

| Severity | Risk | Mitigation |
|---|---|---|
| HIGH | **SPOF — Community Edition no clustering.** Crash = 3–15 min downtime. | CloudWatch alarm → SNS; documented runbook; RTO target 15 min. Acceptable for social graph, not payments. |
| MED | **Single-AZ EBS.** AZ outage = down until AZ recovers or S3 restore. | Daily EBS snapshot; or run a warm-standby with EBS Multi-Attach (Neo4j 5 doesn't support this cleanly though). |
| MED | **SIGTERM handling on ungraceful stop.** Can truncate WAL → recovery replay on restart. | `stopTimeout: 120s`, `tini` as PID 1, pre-test shutdown time. |
| LOW | **Bolt password vs IAM SigV4.** | Secrets Manager + rotation Lambda + VPC-internal only. Not materially less secure when no public ingress. |
| LOW | **Backup consistency.** `neo4j-admin dump` needs Neo4j stopped in Community. | EBS snapshots are crash-consistent; skip neo4j-admin dump. |

---

## Migration Paths (Future)

- **→ Neptune later:** requires Cypher dialect audit. Avoid APOC procedures, list-type node properties, `FOREACH` in writes, `reduce()` in reads. If you write clean Cypher from day one, migration is data export + query audit, not a rewrite.
- **→ AuraDB Professional:** drop-in (same Cypher). Pure cost tradeoff if self-hosting becomes a burden.
- **→ ECS on EC2 (same Neo4j, different packaging):** mechanical refactor. No data migration.

---

## Open Questions Before Committing

1. **HA from day one, or accept 3–15 min downtime on crash?** If strict SLO required, we need Neo4j Enterprise (clustering) — which changes the cost picture entirely. Pre-launch, a solo-dev project with no paying users, the answer is likely "accept the downtime." Confirm.
2. **Multi-region later?** If the consuming deployment goes multi-region, the graph layer replication strategy needs design. Neptune has global databases; self-hosted Neo4j does not. Not a day-1 concern.
3. **Backup cadence + retention?** Daily + 7 days is a reasonable default. Business-critical scenarios (B2B contracts with SLAs) may require hourly + 30 days.

---

## Recommendation

**Go with Plain EC2 + Docker + EBS.** Accept single-AZ SPOF pre-launch. Revisit HA when:
- Paying B2B customers with SLA contracts exist, OR
- Daily active users exceed a threshold where downtime is revenue-impacting, OR
- Operational burden of the single-instance model becomes noticeable (in practice: rarely)

**Not recommended:**
- Neptune Serverless at current pricing — 4× markup for marginal value
- ECS on EC2 — same cost as plain EC2 with more moving parts for no functional gain in this single-instance case
- ECS Fargate + EBS — volume lifecycle footgun
- EFS-backed — performance hit + higher cost

**If HA becomes required before launch:** switch to AuraDB Professional (managed, $65+/mo) rather than wrestling Enterprise licensing for self-hosted clustering. Community → AuraDB is drop-in.
