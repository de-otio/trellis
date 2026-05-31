# Managed Neo4j — Reconsidering for Solo-Dev Context

**Date:** 2026-04-12
**Context:** After reading [`graph-db-self-hosted-neo4j/README.md`](graph-db-self-hosted-neo4j/README.md) and seeing the 12-topic scope of self-hosting properly, the math on "cheap self-host" changes.

---

## Thesis

The $30/month vs $65/month price delta between self-hosted and AuraDB Professional is only the visible half of the cost. The invisible half — developer hours, cognitive load, and incident exposure — typically flips the decision for a solo developer who is **not trying to become a database operator**.

## The Iceberg: What "self-hosting" Actually Costs

The README's 12 topics aren't optional — every one represents work that managed Neo4j performs for you.

| Topic | Self-host cost (one-time) | Self-host cost (ongoing) | Managed equivalent |
|---|---|---|---|
| Instance sizing | 2–4 hours | Re-tune at scale milestones | Automatic |
| CDK stack | 4–8 hours | Changes on every AWS update | Terraform from Aura docs (1 hour) |
| Container lifecycle | 2–3 hours | Monitoring for tini/SIGTERM issues | N/A |
| Auth & secrets | 2 hours | Rotation runs, credential reviews | Built-in, rotate via console |
| Backup & restore | 3–4 hours | Test restores quarterly (else they don't work) | Automatic, point-in-time restore |
| Monitoring | 2–3 hours | Alarm tuning, new alarms as bugs emerge | Built-in dashboards |
| DR runbook | 4–6 hours | Must rehearse periodically | SLA covers it |
| Upgrade procedure | 2 hours per upgrade | Every Neo4j minor version (quarterly) | Rolling, zero-touch |
| Perf testing | 4–6 hours | Re-run at scale milestones | Load testing still needed, but against a stable target |
| Cost optimization | 2 hours | Reserved Instance decisions, snapshot pruning | Fixed-rate bill |
| Cypher guardrails | Same either way | Same | Same |
| Incident response | — | 1–4 hours per incident, worse at 3am | SLA + support portal |

**Front-loaded one-time cost: ~25–40 hours.** At $100/hour developer value, that's $2,500–$4,000 you pay in Year 1 *before* you've saved a penny on the hosting bill.

**Ongoing: ~2–5 hours/month minimum** in steady state, spiking during incidents. At $100/hour, that's $200–$500/month in opportunity cost — which **erases the entire self-host savings and then some**.

---

## Hidden Costs Beyond Hours

### Incident exposure

Self-hosting a SPOF single-node Community Edition means **you are the on-call rotation**. Pre-launch this is manageable. Post-launch — especially after B2B customers with SLAs — a 3am crash means you wake up and fix it. Managed services give you the ability to treat the DB as a problem AWS/Neo4j engineers solve while you sleep.

### Cognitive load (the real tax)

Every self-hosted system occupies a permanent slot in your working memory:
- "Did I renew the instance profile?"
- "Is the backup still running? When did I last test restore?"
- "Is this error log a known pattern or something new?"
- "Should I upgrade to Neo4j 5.x → 5.y now, or wait?"

A solo dev has a finite number of these slots. Self-hosting a database is one of the most attention-hungry uses of that slot — especially when the rest of your stack (ECS Fargate, Cognito, RDS, DynamoDB) is already managed. **You don't become more productive by taking on more ops.**

### Risk of doing it half-right

With 40 hours of one-time setup, most solo devs will cut corners — skip DR rehearsal, skip monitoring alarm tuning, delay the Neo4j minor-version upgrade for 6 months. Then the first real incident reveals the backup was never tested, the alarm didn't fire, or the upgrade had been delayed into a major-version jump. Managed services absorb this entire risk class.

---

## Managed Options Reconsidered

### AuraDB Free

- **Cost:** $0
- **Limits:** 200k nodes / 400k relationships / 1 GB storage
- **Typical deployment target:** ~2M nodes + 7.5M edges at 50k users — **hard-caps below needs at growth**
- **Use case:** Prototype / very early pre-launch validation. Migrate before ~10k users.

### AuraDB Professional

- **Cost:** $65/month per GB (minimum 1 GB), scales per-GB
- **Limits:** Up to 128 GB, 96 GB RAM configurations
- **SLA:** 99.4%
- **Deployment fit:** Strong. 1 GB covers pre-launch comfortably; scale up as graph grows.
- **Backup:** Continuous, point-in-time restore within 7 days
- **Upgrade:** Rolling, automatic minor versions
- **Monitoring:** Built-in dashboards + metrics endpoint

### AuraDB Business Critical

- **Cost:** Starting around $350/month (significantly higher than Professional)
- **SLA:** 99.95% with multi-region DR
- **Deployment fit:** Overkill pre-launch. Consider if/when B2B contracts require strict SLA.

### Neptune Serverless (the default we inherited)

- **Cost:** ~$130/month floor, $200–400/month realistic at 50k users
- **Idle behavior:** No scale-to-zero (correction of earlier memory)
- **SLA:** 99.9% (single-AZ), 99.99% (multi-AZ — extra cost)
- **Why originally chosen:** CDK-managed, IAM auth, CloudWatch integration
- **Downside vs AuraDB:** Cypher dialect subset (no APOC, restricted list properties); higher cost floor; more expensive at every tier

---

## Cost Comparison (Realistic Scenarios)

### Pre-launch (0–10k users, ~1 GB graph, solo developer)

| Option | Monthly $ | Dev hours / month | "All-in" cost at $100/hr |
|---|---|---|---|
| Self-hosted EC2 + Docker | $30 | 3–5 | **$330–$530** |
| AuraDB Professional (1 GB) | $65 | <0.5 | **~$115** |
| Neptune Serverless | $130 | <1 (after CDK) | **~$230** |
| AuraDB Free | $0 | <0.5 | **~$50** (until cap) |

### Growth (10k–50k users, ~5 GB graph, still solo)

| Option | Monthly $ | Dev hours / month | "All-in" cost at $100/hr |
|---|---|---|---|
| Self-hosted EC2 + Docker | $55 | 5–10 (more incidents, upgrades) | **$555–$1,055** |
| AuraDB Professional (5 GB) | $325 | <1 | **~$425** |
| Neptune Serverless | $300–400 | <1 | **~$400–500** |

### Scale (50k+ users, with B2B SLAs, possibly sub-team)

Self-hosted becomes untenable without dedicated ops. Managed is the obvious answer; exact choice depends on SLA commitments. AuraDB Business Critical or Neptune with multi-AZ begin competing with each other; cost difference shrinks at this scale.

---

## Decision Framework

**Self-host wins when:**
- Developer hours are free (you're a student, hobby project, or your time value is near zero)
- You enjoy ops work and want to keep those skills sharp
- The project is ephemeral enough that one-time setup won't amortize
- Ultra-tight budget with no alternative

**Managed wins when:** (almost every other case)
- You charge for your time (even implicitly)
- You'd rather spend those 40+ hours on the product
- You dislike being on-call for infrastructure
- You want to sleep through the first post-launch incident
- You want the option to go on vacation

**For a small/solo deployment specifically:** pre-revenue, aiming at B2B monetization later — managed wins by a wide margin. The $35/month premium of AuraDB over self-host is the cheapest insurance policy against distraction and burnout.

---

## AuraDB vs Neptune: Final Managed-Tier Choice

If we accept managed is the right answer, the remaining question is AuraDB Professional vs Neptune Serverless:

| Dimension | AuraDB Pro | Neptune Serverless |
|---|---|---|
| Cost pre-launch | $65 | $130 |
| Cost at 50k users | ~$325 | ~$300–400 |
| Cypher dialect | Full Neo4j | Subset (no APOC, no list props) |
| Local dev parity | Identical (Neo4j Community in Docker) | Must mock / work around dialect gaps |
| CDK-native provisioning | No (Terraform provider + Aura API) | Yes |
| IAM auth | No (bolt password + TLS) | Yes (SigV4) |
| Lock-in concern | Low (export + import to anywhere) | Medium (subset dialect) |
| Ecosystem tooling | Full Neo4j tools (Bloom, APOC, GraphQL lib) | Limited |

**AuraDB Professional wins on:**
- Local dev parity (critical for solo dev productivity — already using Neo4j in Docker)
- Cypher completeness (open future for features like APOC, Bloom)
- Portability (easier to leave if we ever want to)

**Neptune Serverless wins on:**
- CDK-native (one less console to click in)
- IAM-native auth (one less secret to rotate)

Neither wins is decisive, but the **local-dev-parity argument is strong for a solo dev who is already working with Neo4j Community in Docker for integration tests**. The dialect gap means every time we touch Cypher, we'd have to cross-check against the Neptune subset. That's a recurring productivity tax.

---

## Recommendation

**Switch from Neptune Serverless to AuraDB Professional.**

Rationale:
1. Managed beats self-host in the solo-dev calculus by ~$300–$500/month in time value
2. AuraDB beats Neptune by preserving local-dev parity + avoiding Cypher dialect surgery
3. $65/month is easily the cheapest line item in the deployment's AWS bill; the marginal $35 over self-host buys dramatic reduction in cognitive load
4. Migration path stays open in both directions (Aura ↔ self-hosted Neo4j is trivial; Aura → Neptune is possible if needed later)

## Implementation Implications (if chosen)

- Replace Neptune CDK stack (never built) with: an external-resource reference to the AuraDB connection URI + credentials stored in Secrets Manager
- Update `graph-factory.ts` to use AuraDB bolt URI from env (already parameterized — good redesign decision)
- `.env` files for dev reference Docker Neo4j; prod env refers to Aura
- Docker Neo4j stays for unit + integration tests (no change needed)
- Update the consuming deployment's graph-DB decision record (external) with the corrected decision + rationale

## What to Do Next

1. **Confirm direction** with the user (you, right now)
2. Sign up for Aura Professional free trial to validate:
   - Connection from a dev ECS task in eu-central-1
   - Latency profile (transatlantic or regional?)
   - Backup restore to a local Docker Neo4j (portability check)
3. Update the consuming deployment's graph-DB decision record (external)
4. Remove any Neptune stack placeholder code (there wasn't any — bonus)
5. Delete the `graph-db-self-hosted-neo4j/` folder (keep the parent decision doc as the record of analysis)

## Caveat / Alternative

If the $65/month is a genuine blocker right now, **AuraDB Free as the pre-launch database** is a legitimate bridge. Migrate to Professional when graph crosses 150k relationships (75% of the Free cap), which likely coincides with your first real users. Free → Professional is a documented, low-downtime migration.
