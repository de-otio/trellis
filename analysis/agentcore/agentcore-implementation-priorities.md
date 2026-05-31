# Implementation Priorities

## Ranking Criteria

Agents are ranked by: **effort to build** vs. **value to a single developer** vs. **risk**.

## Tier 1: Build First (High value, low risk)

### 1. Log Monitor Agent
- **Value**: Catch production issues while you sleep
- **Effort**: Small — wraps CloudWatch Logs Insights queries
- **Tools**: Gateway → CloudWatch API
- **Trigger**: Scheduled (every 5 min) + CloudWatch alarm subscription
- **Output**: Slack/email alert with diagnosis: error message, stack trace, affected endpoint, recent deploy correlation

### 2. Cost Monitor Agent
- **Value**: Prevent bill surprises (ECS, RDS, Lambda, S3, DynamoDB)
- **Effort**: Small — extends existing `budget-monitor.ts`
- **Tools**: Gateway → Cost Explorer, CloudWatch Metrics
- **Trigger**: Daily scheduled
- **Output**: Daily summary, weekly trend, threshold alerts

### 3. Dependency Audit Agent
- **Value**: Stay ahead of CVEs without manual checking
- **Effort**: Small — `npm audit` + Flutter `pub outdated` in Code Interpreter
- **Tools**: Code Interpreter, Browser (CVE databases), Gateway (GitHub API for PRs)
- **Trigger**: Weekly scheduled
- **Output**: GitHub PR with update, test results, and changelog summary

## Tier 2: Build Next (High value, medium effort)

### 4. Test Generation Agent
- **Value**: Maintain 80% coverage as features are added; 314 existing tests provide strong patterns
- **Effort**: Medium — needs to understand handler patterns and test conventions
- **Tools**: Code Interpreter (run vitest), Memory (test patterns)
- **Trigger**: On PR creation (detect untested new code)
- **Output**: PR comment with generated test file, or separate PR

### 5. Security Scanner Agent
- **Value**: Critical for a platform handling user data, media, auth
- **Effort**: Medium — static analysis + pattern matching against known vulnerabilities
- **Tools**: Code Interpreter (AST analysis), Policy (security rules)
- **Trigger**: On PR creation
- **Output**: PR review comments on security issues

### 6. Deploy Orchestrator Agent
- **Value**: Hands-free deployment with monitoring and rollback
- **Effort**: Medium — wraps `scripts/deploy.sh` with health monitoring
- **Tools**: Gateway (ECS, CloudFormation, ECR APIs), Runtime (async, long-running)
- **Trigger**: Manual (developer command) or on merge to main
- **Output**: Deployment report with status, timing, smoke test results

## Tier 3: Build When Ready (Transformative, higher effort)

### 7. Code Scaffolding Agent
- **Value**: Eliminate boilerplate for new routes, models, and Lambda functions
- **Effort**: High — needs deep understanding of project conventions
- **Tools**: Code Interpreter, Memory (project patterns), Gateway (GitHub API)
- **Trigger**: On issue labeled "scaffold" or manual command
- **Output**: Draft PR with handler, tests, migration, and Flutter client updates

### 8. Incident Response Agent
- **Value**: Automated first-response using existing runbooks in `scripts/incident/`
- **Effort**: High — needs to safely execute operational commands
- **Tools**: Gateway (all AWS APIs), Memory (incident history), Policy (constrain blast radius)
- **Trigger**: CloudWatch alarm → SNS → agent
- **Output**: Executed runbook steps, diagnosis, escalation to developer if unresolved

### 9. Requirements Analyst Agent
- **Value**: Turn GitHub issues into scoped implementation plans
- **Effort**: High — needs project-wide understanding
- **Tools**: Memory (architecture knowledge), Browser (fetch issues), Code Interpreter (impact analysis)
- **Trigger**: On issue creation
- **Output**: Implementation brief attached to the issue

## Tier 4: Future Vision (Full SDLC automation)

### 10. Flutter Client Sync Agent
- **Value**: Keep frontend and backend in sync automatically
- **Effort**: High — Dart code generation, Riverpod patterns
- **Trigger**: On API route change

### 11. Feature Flag Lifecycle Agent
- **Value**: Prevent flag accumulation and dead code
- **Effort**: Low — but value is incremental
- **Trigger**: Monthly scheduled

### 12. Infrastructure Drift Agent
- **Value**: Catch unauthorized or accidental changes
- **Effort**: Medium — compare CDK output vs. deployed state
- **Trigger**: Daily scheduled

## Getting Started

The minimum viable agent setup requires:

1. **AgentCore Runtime** — deploy a single agent
2. **AgentCore Gateway** — expose CloudWatch Logs API as an MCP tool
3. **AgentCore Memory** — store baseline metrics
4. **A CDK stack** (`agents-stack.ts`) to provision the above

Start with the Log Monitor Agent. It's the simplest to build, provides immediate value, and establishes the infrastructure pattern for all subsequent agents.

```
Estimated timeline for a single developer:
  Tier 1 (3 agents): 2-3 weeks
  Tier 2 (3 agents): 3-4 weeks
  Tier 3 (3 agents): 4-6 weeks
  Tier 4 (3 agents): Ongoing refinement
```
