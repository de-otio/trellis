# Guiding Principles

## Operating Model: Delegate, Review, Own

The developer's role shifts from executor to orchestrator:

- **Delegate** — AI handles implementation, testing, deployment execution, monitoring
- **Review** — Developer validates AI output before it reaches production
- **Own** — Developer retains accountability for architecture, security, and business decisions

This is not about replacing the developer. It's about eliminating the bottleneck of a single person needing to context-switch across 260,000 lines of TypeScript, Dart, CDK, and Prisma.

## Core Principles

### 1. AI Across the Entire Lifecycle, Not Just Coding

McKinsey data shows the highest-performing teams use AI in every SDLC phase. Coding assistance alone yields modest gains. The multiplier comes from AI in planning, testing, deployment, operations, and maintenance.

### 2. Mature Practices First, AI Second

Gartner and McKinsey agree: AI amplifies existing quality. Trellis already has:
- 314 test files with 80% coverage thresholds
- 4-phase CDK deployment with smoke tests
- Operational scripts for logs, errors, status, feature flags
- Structured config per environment (dev/prod)
- CI/CD workflows on GitHub Actions

This maturity makes AI augmentation viable. Projects without these foundations should build them before adding AI.

### 3. Progressive Autonomy

Never skip from assistance to autonomy. The path is:
1. AI suggests → human executes
2. AI executes → human reviews before merge/deploy
3. AI executes → human reviews after the fact (for low-risk operations)

Each step requires earned trust through measured outcomes.

### 4. Human Approval at Security Boundaries

AI should never autonomously:
- Deploy to production without explicit approval
- Modify authentication/authorization logic
- Change cryptographic implementations
- Access or modify secrets in SSM Parameter Store
- Execute destructive database operations

These boundaries are enforced via AgentCore Policy rules, not just convention.

### 5. Measurable Outcomes Over Adoption Metrics

Don't measure "how much AI are we using." Measure:
- Time from issue to merged PR
- Defect escape rate (bugs reaching production)
- Mean time to detect and resolve incidents
- Deployment frequency and failure rate
- Hours spent on maintenance vs. feature work

### 6. Cost Discipline

Consumption-based AI pricing can spiral. Every agent must justify its cost against the time it saves. Token efficiency matters — minimize hallucinations and failed runs through good context (steering rules, memory, project structure).
