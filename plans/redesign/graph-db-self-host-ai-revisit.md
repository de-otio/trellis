# Self-Hosted Neo4j on AWS — Revisited in Light of AI-Assisted Operations

**Date:** 2026-06-01
**Status:** Superseded by the Neptune Serverless decision (2026-06-01). See
[`graph-db-neptune-serverless/`](graph-db-neptune-serverless/README.md), which
evaluates the third option this analysis treats as out of reach — managed HA
*and* AWS-native — and is the chosen direction. Retained as the record of the
self-hosted-vs-managed reasoning that the Neptune analysis builds on.
**Supersedes:** Nothing. Supplements [`graph-db-managed-analysis.md`](graph-db-managed-analysis.md).

---

## Context

[`graph-db-managed-analysis.md`](graph-db-managed-analysis.md) concluded that AuraDB Professional beats self-hosting because the solo-developer opportunity cost ($300–500/month in time) erases the $35/month hosting delta and then some. That analysis was written in April 2026.

The core of the managed-wins argument was **cognitive load**: 40 hours of one-time setup plus 3–5 hours/month of ongoing ops, valued at $100/hour. AuraDB wins because you don't pay those hours.

The question here: **does AI-assisted operations change that calculus?**

---

## Thesis

The cognitive-load argument against self-hosting rests on three claims:

1. Setup is expensive (40 hours).
2. Ongoing maintenance is expensive (3–5 hours/month).
3. The work occupies a permanent attention slot you'd rather spend on product.

AI materially reduces (1) and (2). Whether it eliminates (3) depends on a structural advantage that the original analysis didn't consider: **AWS homogeneity**.

---

## What AI Changes

### 1. Setup time

The original 40-hour estimate covers 12 topics (from [`graph-db-self-hosted-neo4j/README.md`](graph-db-self-hosted-neo4j/README.md)):

| Topic | Original estimate | With AI |
|---|---|---|
| Instance sizing | 2–4 hrs | 30 min (AI models the graph, picks instance) |
| CDK stack | 4–8 hrs | 1–2 hrs (AI writes it; you review + deploy) |
| Container lifecycle | 2–3 hrs | 30 min (AI writes systemd unit + docker invocation) |
| Auth & secrets | 2 hrs | 30 min (AI writes IAM policy + rotation Lambda) |
| Backup & restore | 3–4 hrs | 1 hr (AI writes DLM policy + restore runbook; you test it once) |
| Monitoring & alerting | 2–3 hrs | 30 min (AI generates CloudWatch alarm config) |
| DR runbook | 4–6 hrs | 30 min (AI writes the runbook; you review) |
| Upgrade procedure | 2 hrs | 15 min (AI looks up breaking changes per release) |
| Perf testing | 4–6 hrs | 1 hr (AI writes k6/jest-neo4j load script) |
| Cost model | 2 hrs | AI already knows AWS pricing; on-demand |
| Migration paths | 1 hr | Known; skip |
| Cypher guardrails | 1 hr | AI writes the lint rules + review checklist |

**Revised one-time estimate: 6–10 hours.** Primarily review, deploy, and test — not composition.

### 2. Ongoing maintenance

| Task | Original | With AI |
|---|---|---|
| Incident diagnosis | 1–4 hrs/incident | Minutes (AI queries CloudWatch, diagnoses, suggests fix) |
| Upgrade procedure | 2 hrs/quarter | 30 min/quarter (AI researches release notes, drafts runbook) |
| Backup restore testing | 2 hrs/quarter | 30 min (AI runs the restore script; you verify the data) |
| Monitoring alarm tuning | 1 hr/month | Near zero (AI reviews alarm history on request) |
| Credential rotation | 30 min/quarter | Near zero (rotation Lambda runs automatically) |

**Revised ongoing estimate: ~0.5 hours/month** in steady state. Incidents spike this, but diagnosis time shrinks — you're not spelunking logs by hand.

### 3. Cognitive load — the AWS homogeneity argument

This is the strongest point and wasn't in the original analysis.

**The problem with AuraDB from an AI-operations perspective:** it lives outside your AWS account. Logs go to the Aura console. Metrics are on a separate dashboard. Connection URIs and credentials are in Aura's UI. When something is slow or broken, an AI assistant can't query the DB server's CloudWatch logs, describe the network path, or correlate with ECS task logs — because there's no DB server in your account to observe.

**With self-hosted Neo4j on EC2:**
- Logs → `/aws/ec2/neo4j` in CloudWatch. AI can query them with the same tools it uses for ECS task logs.
- Metrics → CloudWatch namespace. AI can build dashboards, check alarm history, correlate with API latency spikes.
- Security posture → VPC, SGs, IAM. AI sees the whole picture, not just "Aura says it's up."
- Cost → Cost Explorer. One bill, one anomaly detector.
- Incidents → AI can correlate a Neo4j slowdown with an ECS memory spike, a sudden relationship write burst, or a bad Cypher query — across the same tooling.

AuraDB is a **black box** to AWS-native AI tooling. The Aura console is a separate context switch that AI assistants can't directly operate. Self-hosted Neo4j on EC2 is fully visible and operable from within the same toolchain.

---

## The Reusable CDK Construct Angle

The original analysis treated self-hosting as bespoke per-deployment work. It doesn't have to be.

If the EC2 + EBS + Neo4j Community stack is packaged as a reusable CDK construct — call it `Neo4jCommunityInstance` — published to npm (e.g. `@de-otio/neo4j-community-aws`):

1. **One-time setup cost amortizes across all deployments.** After the first build, subsequent consumers get it for free.
2. **AI maintains the construct, not the bespoke stack.** The construct is a known artifact with tests and documentation. AI can update it when Neo4j releases a new major version, when AWS deprecates an instance type, or when a security CVE requires a config change.
3. **Trellis and all its verticals share it.** Today it's one deployment. If more verticals come, each gets Neo4j by adding one CDK construct, not repeating the 40-hour exercise.
4. **The construct is independently testable.** CDK construct tests (`@aws-cdk/assertions`) can validate the alarm count, SG rules, and backup policy — no live AWS needed.

### Minimal construct surface

```typescript
// Hypothetical usage
const neo4j = new Neo4jCommunityInstance(stack, 'Graph', {
  stage: 'prod',                     // 'dev' | 'prod'
  vpc,
  ecsSecurityGroup,                  // grants bolt ingress automatically
  instanceType: 't4g.medium',        // default; overridable at scale milestones
  ebsVolumeGiB: 20,
  backupRetentionDays: 7,
  snapshotSchedule: 'cron(0 2 * * ? *)',  // 2am UTC daily
});

// Outputs: neo4j.boltUri (SSM param or Secret ARN), neo4j.securityGroup
```

Props the construct encapsulates: EC2 instance, EBS volume, instance role, Secrets Manager bolt password, CloudWatch alarms, backup plan, Route53 private record, systemd userdata, SG rules.

---

## Revised Cost Model

Assumptions: developer time at $100/hour, one-time setup amortized over 24 months.

### Pre-launch (0–10k users, ~1 GB graph)

| Option | Monthly hosting | Monthly dev time (hrs × $100) | Monthly all-in |
|---|---|---|---|
| **Self-hosted EC2 (with AI)** | $30 | 0.5 hrs = $50 | **~$80** |
| **Self-hosted EC2 (with AI + reusable construct)** | $30 | 0.25 hrs = $25 | **~$55** |
| AuraDB Professional | $65 | 0.5 hrs = $50 (Aura ops is not zero) | **~$115** |
| AuraDB Free | $0 | 0.5 hrs = $50 | **~$50** (until cap) |

### Growth (10k–50k users, ~5 GB graph)

| Option | Monthly hosting | Monthly dev time | Monthly all-in |
|---|---|---|---|
| **Self-hosted EC2 (t4g.large, with AI)** | $55 | 1 hr = $100 (more incidents at growth) | **~$155** |
| AuraDB Professional (5 GB) | $325 | 0.5 hrs = $50 | **~$375** |

The crossover point inverts at scale: self-hosted is clearly cheaper once the graph reaches a few GB, because AuraDB's per-GB pricing grows linearly while EC2 cost barely moves.

---

## What AI Does Not Change

Honest accounting of what remains structurally true regardless of AI assistance:

### 1. Community Edition is still a SPOF

A crash means downtime. AI helps you diagnose and recover faster, but it cannot prevent the crash or restore HA while the instance is down. The RTO improves (minutes vs 15–30 min without AI), but the incident still happens.

**Managed mitigation if needed:** AuraDB Professional has 99.4% SLA. AuraDB Business Critical ($350+/mo) has 99.95% multi-region DR. If B2B SLA contracts require strict uptime guarantees, managed still wins on availability — AI narrows the gap but doesn't close it.

### 2. Backup quality: crash-consistent vs PITR

EBS snapshots are crash-consistent (Neo4j WAL handles the rest). AuraDB Professional has continuous backup with point-in-time restore within 7 days. For most cases this doesn't matter. For cases where it does (corrupted data discovered hours after the fact), PITR is genuinely better.

`neo4j-admin dump` produces a consistent backup, but requires the DB to be stopped — which is a downtime event for Community Edition. AuraDB's PITR is zero-downtime.

### 3. You're still the on-call rotation

Faster AI-assisted diagnosis doesn't mean the 3am alert doesn't happen. You're still woken up, you still open a laptop. AI makes the recovery faster, but you're the one doing it. Managed services (AuraDB, Neptune) have their own on-call teams who fix infrastructure failures without involving you.

**Counter-argument:** For a pre-launch project with no paying customers, this tradeoff is acceptable. The SLA argument becomes compelling only once B2B customers or SLA contracts exist.

### 4. External Aura ops is not zero

AuraDB is also not zero cognitive load. You still need to: monitor the Aura console, watch for pricing tier changes, manage API access and credentials, track the Aura service status page, respond to Aura-side incidents that aren't your fault but affect your users. AI can't automate these away — they're in a different system.

---

## Verdict

The managed-wins argument from April 2026 rested on a 40-hour setup cost and 3–5 hours/month ongoing. Both estimates were for a solo developer working without AI assistance.

With AI, setup shrinks to 6–10 hours. With a reusable CDK construct, amortized setup is near zero. Monthly maintenance drops to ~0.5 hours — comparable to what AuraDB itself requires.

**The cognitive-load argument is substantially weakened.** The remaining genuine advantages of managed are:
- PITR backup (vs crash-consistent EBS)
- HA SLA (vs SPOF Community Edition)
- Zero 3am responsibility

None of these are relevant pre-launch for a project with no paying customers and no SLA contracts. They become relevant post-launch at B2B scale.

**The AWS homogeneity argument is a genuine new consideration.** Keeping Neo4j in AWS makes it observable, diagnosable, and operable by the same AI toolchain that operates everything else. AuraDB is structurally outside that observability loop.

---

## Recommendation

**Build the reusable CDK construct.** Use it for dev and prod.

Rationale:
1. The construct investment is one-time across all deployments and verticals
2. AI makes the construction and maintenance burden low enough that self-host beats managed on all-in cost at every scale tier
3. AWS homogeneity is a genuine operational advantage that grows more valuable over time as AI tooling matures
4. AuraDB Professional remains the escape hatch if HA requirements change — migration is still drop-in (same Cypher)
5. The remaining managed advantages (PITR, HA SLA) can be added to the construct if needed: `neo4j-admin dump` on a scheduled Lambda + S3 covers backup portability; a future Neo4j Enterprise construct covers HA

### Migration path from current (AuraDB Free / Pro) to self-hosted

1. Build and test the CDK construct against the dev environment first
2. `neo4j-admin dump` from Aura → `neo4j-admin load` into EC2 Neo4j
3. Validate data with a Cypher count query + spot-check on relationships
4. Cut over in a maintenance window (update `NEO4J_URI` in Secrets Manager; ECS tasks pick up on restart)
5. Decommission Aura instance after 2 weeks of stable operation

### CDK construct scope (minimum viable)

- [ ] EC2 instance (ARM t4g, stage-parameterized sizing)
- [ ] EBS volume with DLM snapshot policy
- [ ] SystemD userdata running `neo4j:5-community` via Docker
- [ ] Secrets Manager bolt password with automatic rotation Lambda
- [ ] Instance role: Secrets Manager read, CloudWatch Agent, S3 backup bucket write
- [ ] CloudWatch Agent config: Neo4j query and debug logs
- [ ] CloudWatch alarms: instance health, bolt-ping synthetic (from Lambda), memory pressure
- [ ] Route53 private record: `neo4j-{stage}.internal`
- [ ] Security group: port 7687 from ECS API SG only
- [ ] SSM Parameter: `/trellis/{stage}/neo4j-bolt-uri` (for ECS task consumption)
- [ ] CDK construct tests validating alarm count, SG rules, backup policy

### Open questions before committing

1. **Publish scope:** `@de-otio/neo4j-community-aws` as its own public package, or internal to the `saas-foundation` monorepo? Given the saas-foundation consolidation (see memory), `saas-foundation` is the natural home.
2. **Backup portability:** EBS snapshots are the primary DR path. Should we add a weekly `neo4j-admin dump` to S3 (human-readable, portable, restorable anywhere) via a Lambda on a schedule? Cost is minimal; portability is much higher than EBS.
3. **HA trigger:** At what milestone does HA become a real requirement — first paying B2B customer, first SLA contract, or some user count threshold? Define the trigger now rather than when an incident forces the decision.
