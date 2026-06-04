# Metrics: Measuring Success and Avoiding Pitfalls

## Baseline Metrics (Capture Before Phase 1)

Record these before introducing AI changes, so improvements can be measured:

| Metric | How to Measure | Current Source |
|--------|---------------|----------------|
| PR cycle time | Time from branch creation to merge | GitHub API |
| Deploy frequency | Deploys per week | GitHub Actions history |
| Deploy failure rate | Failed deploys / total deploys | GitHub Actions + deploy logs |
| Test coverage | vitest coverage report | `npm run test:coverage` |
| Mean time to detect (MTTD) | Time from error to developer awareness | Manual estimate |
| Mean time to resolve (MTTR) | Time from detection to fix deployed | Git history |
| Hours on maintenance vs. features | Self-reported weekly | Manual tracking |

## Phase 1 Metrics (Assistance)

**Goal**: Validate that AI tools improve individual productivity.

| Metric | Target | How to Measure |
|--------|--------|---------------|
| PR cycle time reduction | 20% faster | Compare to baseline |
| Test coverage | Maintain or increase 80% | Coverage reports |
| Time writing boilerplate | Reduced by 30% | Self-reported |
| Steering rule effectiveness | Fewer "undo" moments | Count times AI output needed significant correction |

## Phase 2 Metrics (Augmentation)

**Goal**: Validate that agents produce reliable, useful output.

### Ops Monitor Agent
| Metric | Target |
|--------|--------|
| Detection latency | < 5 minutes from error to alert |
| False positive rate | < 20% |
| Actionable diagnosis rate | > 80% of alerts include a useful suggestion |
| Incidents caught while developer was offline | Track count |

### Test Generation Agent
| Metric | Target |
|--------|--------|
| First-pass success rate | > 70% of generated tests pass without edits |
| Coverage delta | Positive on > 90% of PRs |
| Developer review time | < 5 minutes per generated test file |
| Test quality | Generated tests catch real bugs (track over time) |

### Security Scanner Agent
| Metric | Target |
|--------|--------|
| True positive rate | > 90% for OWASP top 10 in changed code |
| False positive rate | < 30% |
| Fix suggestion quality | > 70% of suggestions are directly usable |

### Deploy Assistant Agent
| Metric | Target |
|--------|--------|
| Deployment success rate | Equal to or better than manual |
| Deployment time | Within 10% of manual execution |
| Failure diagnosis quality | Actionable in > 90% of failure cases |
| Developer intervention required | < 10% of deployments |

### Cross-Agent
| Metric | Target |
|--------|--------|
| Agent execution cost | < $200/month total (Phase 2) |
| Developer hours saved | > 10 hours/week |
| Maintenance-to-feature ratio | Shift from 60/40 to 30/70 |

## Phase 3 Metrics (Autonomy)

**Goal**: Validate that multi-agent coordination works reliably.

| Metric | Target |
|--------|--------|
| Issue-to-PR time (auto-implementable) | < 2 hours |
| Auto-generated PRs merged without changes | > 50% |
| Incident auto-resolution rate | > 30% for known failure modes |
| Zero-touch dependency updates | > 80% of patch/minor updates |
| Agent coordination failures | < 5% of multi-agent workflows |

## Pitfall Detection

### Cost Spiral
- **Signal**: Monthly agent cost exceeds 2x previous month
- **Action**: Review token usage per agent, identify hallucination patterns, tighten context

### Quality Degradation
- **Signal**: Defect escape rate increases after introducing agents
- **Action**: Tighten security scanner rules, increase mandatory human review scope
- **Gartner warning**: Prompt-to-code without oversight can increase defects 2500%

### Over-Reliance
- **Signal**: Developer stops understanding code that agents generate
- **Action**: Enforce review depth — read every diff, not just approve
- **Rule**: If you can't explain what a generated change does, don't merge it

### Alert Fatigue
- **Signal**: Developer ignores > 30% of agent alerts
- **Action**: Tune Ops Monitor thresholds, reduce false positives, consolidate alerts

### Agent Drift
- **Signal**: Agent output diverges from project conventions over time
- **Action**: Update steering rules, refresh Memory with current patterns, review Evaluations

## Monthly Review

On the first of each month:
1. Review all metrics against targets
2. Identify the agent providing the least value — improve or remove it
3. Identify the biggest remaining manual bottleneck — plan an agent for it
4. Update cost projections
5. Update steering rules based on the month's corrections
