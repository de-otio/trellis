# Self-Hosted Neo4j — Deep Analysis

> ## ⚠️ OBSOLETE — Retained as historical record
>
> **This analysis was superseded on 2026-04-12.** The final decision is:
> - **Prod:** AuraDB Professional (managed)
> - **Dev + CI:** AuraDB Free on a separate Neo4j account ($0)
> - **Local:** Docker `neo4j:5-community` (unchanged)
>
> See [`../graph-db-nonprod-environments.md`](../graph-db-nonprod-environments.md) for the final design, and [`../graph-db-managed-analysis.md`](../graph-db-managed-analysis.md) for the decision rationale.
>
> **Why kept:** the topics enumerated here document what self-hosting *would have required* — useful as a reality check on the managed vs self-host tradeoff, and as a reference if a consuming deployment ever has to reconsider (e.g. Aura's pricing changes dramatically, or a compliance requirement demands private-cloud Neo4j).
>
> **Do not use this folder as an implementation guide.** No CDK code should be written from it.

---

Context: [`../graph-db-hosting-decision.md`](../graph-db-hosting-decision.md) — option **4d** (Plain EC2 + Docker + EBS) was the preferred sub-variant at the time this folder was created. The managed analysis that followed ([`../graph-db-managed-analysis.md`](../graph-db-managed-analysis.md)) showed that solo-developer opportunity cost flipped the decision back to managed.

## Topic Index

Files to produce (in dependency order):

| # | Topic | File | Purpose |
|---|---|---|---|
| 1 | **Instance sizing & memory tuning** | `01-sizing.md` | Map a target graph (~7.5M edges at 50k users) to Neo4j memory formulas; pick pre-launch + scale-up instance types |
| 2 | **CDK stack design** | `02-cdk-stack.md` | Full CDK construct: EC2 + EBS + instance role + SG + Route53 + userdata + snapshot schedule |
| 3 | **Container lifecycle** | `03-container-lifecycle.md` | systemd unit, docker run invocation, graceful shutdown (tini, stopTimeout), restart policy, version pinning |
| 4 | **Secrets & auth** | `04-auth-and-secrets.md` | Bolt password rotation via Secrets Manager, VPC-internal access only, no public ingress, instance role policy |
| 5 | **Backup & restore** | `05-backup-restore.md` | EBS snapshot schedule vs `neo4j-admin dump`; retention; documented restore runbook; tested RTO |
| 6 | **Monitoring & alerting** | `06-monitoring.md` | CloudWatch Agent config; bolt-ping synthetic; alarms on instance health + process liveness + memory pressure; log patterns |
| 7 | **Disaster recovery runbook** | `07-dr-runbook.md` | Step-by-step: AZ failure, instance failure, EBS corruption, data restore from S3, Neo4j WAL replay |
| 8 | **Upgrade procedure** | `08-upgrade.md` | Neo4j minor/major version bumps; container image swap; downtime window; rollback plan |
| 9 | **Performance testing plan** | `09-perf-testing.md` | Synthetic workload mimicking peak: N relationship writes/min, K circle-resolution reads/sec; pass/fail thresholds |
| 10 | **Cost model & optimization** | `10-cost-model.md` | Detailed TCO: on-demand vs Reserved vs Savings Plans; EBS snapshot costs; S3 backup costs; scale milestones |
| 11 | **Migration path out** | `11-migration-paths.md` | To Neptune (Cypher audit), to AuraDB (drop-in), to Enterprise clustering (if HA becomes required); triggers for each |
| 12 | **Cypher guardrails** | `12-cypher-guardrails.md` | Rules to keep queries portable: no APOC, no list properties, no FOREACH writes. Lint/review checklist. |

## Decision Gates

Before writing CDK code, we need:

- [ ] Instance size chosen (pre-launch + 50k target) — from **#1**
- [ ] Backup cadence + retention confirmed — from **#5**
- [ ] HA posture confirmed (accept SPOF vs Enterprise licensing vs AuraDB) — from **#7** + business call
- [ ] Monitoring SLOs agreed (RTO, alarm thresholds) — from **#6** + **#7**

## Open Questions (carried from parent doc)

1. HA from day one, or accept 3–15 min downtime on crash?
2. Multi-region later?
3. Backup cadence + retention?

## Status

- README.md — this index
- All other files — not yet written

## How to consume this folder

- Start with `01-sizing.md` for the concrete hardware choice
- Read `05-backup-restore.md` and `07-dr-runbook.md` together to pressure-test the HA posture
- `02-cdk-stack.md` is the implementation artifact — delay writing until #1–#7 are agreed
- `12-cypher-guardrails.md` can be written independently; it applies regardless of hosting choice and is useful input for the trellis code review
