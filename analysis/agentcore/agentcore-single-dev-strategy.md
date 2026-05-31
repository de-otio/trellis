# Single-Developer Strategy with AgentCore

## The Problem

Trellis is a ~260,000-line codebase spanning:
- 40+ API route handlers
- 38 Prisma models
- 8 CDK stacks
- 314 test files
- Flutter mobile/web app
- 10 Lambda functions
- 5 SQS queues with DLQs

Maintaining this across the full SDLC (planning, implementation, testing, deployment, operations, maintenance) requires expertise in TypeScript, Dart, AWS, CDK, Prisma, security, and DevOps. For a single developer, the bottleneck is not capability but attention.

## How Agents Shift the Bottleneck

AI agents don't replace the developer. They shift the role from **executor** to **reviewer**:

| Without Agents | With Agents |
|---------------|-------------|
| Write tests manually | Review generated tests |
| Monitor logs and dashboards | Receive diagnosed incidents with suggested fixes |
| Run deployments and watch for failures | Approve deployment plans, agents handle execution |
| Manually check for dependency vulnerabilities | Review agent-generated update PRs |
| Write boilerplate route handlers | Review scaffolded code against requirements |
| Manually track feature flag lifecycle | Approve cleanup PRs for stale flags |

## Phased Adoption

### Phase 1: Ops Agents (Lowest risk, highest immediate value)

**Why first**: These are read-only, don't modify code, and address the biggest single-dev pain point: you can't watch dashboards 24/7.

1. **Log Monitor Agent** — Watches CloudWatch for errors, correlates with recent deploys
2. **Cost Monitor Agent** — Extends `budget-monitor.ts` with trend analysis and alerts
3. **Health Check Agent** — Runs periodic smoke tests, alerts on degradation

**AgentCore services needed**: Runtime, Gateway (CloudWatch/ECS APIs), Memory (baseline metrics)

### Phase 2: Quality Agents (Medium risk, high value)

**Why second**: These read code and produce reports/PRs but don't deploy or modify infrastructure.

4. **Test Generation Agent** — Creates test stubs matching existing patterns
5. **Security Scanner Agent** — Reviews code changes for OWASP issues
6. **Dependency Audit Agent** — Monitors for CVEs, tests updates, creates PRs

**Additional services**: Code Interpreter (run tests), Evaluations (assess quality)

### Phase 3: Dev Agents (Higher risk, transformative value)

**Why third**: These generate code that will be reviewed before merge.

7. **Scaffolding Agent** — Generates route handlers, Prisma migrations, Flutter clients
8. **Migration Agent** — Generates and validates schema changes
9. **Documentation Agent** — Keeps docs in sync with code changes

**Additional services**: Policy (guardrails on code generation scope)

### Phase 4: Deploy Agents (Highest risk, full automation)

**Why last**: These affect production. By this point, trust is established through Phases 1-3.

10. **Deploy Orchestrator** — Runs `scripts/deploy.sh` with monitoring and rollback
11. **Incident Response Agent** — Executes runbooks from `scripts/incident/`
12. **Infrastructure Drift Agent** — Detects and corrects configuration drift

**Additional services**: Policy (require human approval for prod), Observability (full tracing)

## Daily Workflow with Agents

### Morning
1. Review overnight alerts from Log Monitor Agent (incidents diagnosed, not just raw errors)
2. Review PRs from Dependency Audit Agent and Test Generation Agent
3. Check Cost Monitor Agent's weekly trend report

### Development
4. Describe feature in a GitHub issue
5. Requirements Agent produces implementation brief (affected files, schema changes, test plan)
6. Scaffolding Agent generates initial code based on brief
7. Developer refines, adds business logic
8. Security Scanner Agent reviews changes
9. Test Generation Agent creates test coverage

### Deployment
10. Developer approves deployment
11. Deploy Orchestrator runs the pipeline, reports status
12. E2E tests run automatically post-deploy
13. Health Check Agent validates production stability

### Maintenance (automated, runs continuously)
14. Feature Flag Agent flags stale toggles monthly
15. Infrastructure Drift Agent checks daily
16. Documentation Agent updates after each merge

## Cost Considerations

AgentCore uses consumption-based pricing with no minimums. For a single-developer project:

- **Ops agents** (Phase 1): Low cost — periodic API calls to CloudWatch/ECS
- **Quality agents** (Phase 2): Moderate — code analysis uses Code Interpreter compute
- **Dev agents** (Phase 3): Moderate — code generation uses LLM inference
- **Deploy agents** (Phase 4): Low cost — infrequent execution, mostly API calls

The main cost driver is the underlying foundation model (Claude, Nova, etc.) inference. Agents that primarily call AWS APIs (ops, deploy) are cheap. Agents that generate or analyze code are more expensive but still far cheaper than hiring additional developers.

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Agent generates insecure code | Security Scanner Agent reviews all generated code; Policy blocks deployment without review |
| Agent makes destructive change in prod | Policy enforces human approval for all prod modifications; dev environment is the default |
| Agent hallucinates incorrect diagnosis | Agents always cite evidence (log lines, metrics, code references); developer validates before acting |
| Cost spirals from agent usage | Budget Monitor Agent also monitors its own AgentCore costs; alerts on thresholds |
| Over-reliance on agents | Agents produce PRs and reports, never merge or deploy without approval (Phase 4 exception requires explicit opt-in) |
