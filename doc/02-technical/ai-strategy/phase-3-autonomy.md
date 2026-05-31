# Phase 3: Autonomy (Months 5+)

Multi-agent coordination for routine work. Developer focuses on architecture, security, and novel features.

## Prerequisites

Before entering Phase 3, the following must be true:
- Phase 2 agents have run for at least 2 months
- Ops Monitor false positive rate is under 15%
- Test Generation first-pass success rate is over 75%
- Security Scanner false positive rate is under 25%
- Deploy Assistant has completed at least 10 successful deployments
- Cost of agent execution is tracked and within budget

## Multi-Agent Orchestration

### A2A Protocol Setup

Deploy an Orchestrator agent on AgentCore Runtime that coordinates specialist agents via the A2A protocol:

```
Developer Intent (GitHub issue, Slack, schedule)
       │
       ▼
  Orchestrator Agent
       │
       ├──► Requirements Agent (analyze impact)
       ├──► Scaffold Agent (generate code)
       ├──► Test Agent (generate + run tests)
       ├──► Security Agent (review changes)
       ├──► Deploy Agent (execute pipeline)
       └──► Ops Agent (monitor post-deploy)
```

Each agent runs in its own isolated session. Coordination happens through:
- A2A messages (capability discovery, task delegation, status updates)
- Shared AgentCore Memory (project context, deployment history, incident log)
- AgentCore Policy (enforce boundaries at every step)

## New Agents for Phase 3

### Agent 5: Requirements Analyst

**Trigger**: New GitHub issue labeled `feature` or `bug`

**Behavior**:
1. Reads the issue description
2. Searches codebase for related handlers, models, and tests
3. Identifies affected files and estimates test surface
4. Checks infra config for any needed changes (new env vars, permissions, queues)
5. Posts an implementation brief as an issue comment:
   - Affected files with line references
   - Required schema changes (if any)
   - Required CDK changes (if any)
   - Suggested test plan
   - Risk assessment (low/medium/high)
6. If low-risk: tags issue as `auto-implementable` for Scaffold Agent

### Agent 6: Code Scaffold

**Trigger**: Issue tagged `auto-implementable` (by Requirements Agent or developer)

**Behavior**:
1. Reads the implementation brief from the issue
2. Creates a branch from `dev`
3. Generates code following project patterns:
   - Route handler in `apps/api/src/lib/`
   - Route registration in `apps/api/src/lib/routes/`
   - Prisma schema changes (if needed)
   - Migration file
   - Test stubs
4. Creates a draft PR linked to the issue
5. Triggers Test Agent and Security Agent on the PR

### Agent 7: Dependency Updater

**Trigger**: Weekly schedule (Sundays)

**Behavior**:
1. Runs `npm audit` and checks for outdated packages
2. For each security update:
   - Creates a branch
   - Updates the dependency
   - Runs the full test suite
   - If tests pass: creates a PR with changelog summary
   - If tests fail: creates an issue with failure details
3. Runs `flutter pub outdated` for the Flutter app
4. Same branch/test/PR flow for Dart dependencies

### Agent 8: Feature Flag Lifecycle

**Trigger**: Monthly schedule (1st of each month)

**Behavior**:
1. Queries the `FeatureToggle` table via DynamoDB
2. Identifies flags that have been enabled in all environments for > 30 days
3. Searches codebase for flag references
4. For each stale flag:
   - Creates a PR removing the flag check from code
   - Removes the DynamoDB entry
   - Runs tests to validate removal
5. Posts a monthly flag health report as a GitHub issue

### Agent 9: Incident Response

**Trigger**: CloudWatch alarm → SNS → agent (critical severity only)

**Behavior**:
1. Reads the alarm details (metric, threshold, current value)
2. Executes diagnostic steps:
   - Check ECS service status and recent deployments
   - Search logs for errors in the last 15 minutes
   - Check RDS metrics (connections, CPU, replication lag)
   - Check SQS DLQ depth
3. Matches symptoms against known runbooks in `scripts/incident/`
4. For known failure modes with safe remediation:
   - Executes the runbook (e.g., restart ECS tasks, clear DLQ)
   - Reports action taken
5. For unknown or high-risk situations:
   - Sends full diagnosis to developer (Slack/email)
   - Suggests but does not execute remediation
6. Logs incident to Memory for trend analysis

## Autonomous Workflow: Issue to Production

For low-risk, well-scoped changes, the full pipeline runs without human intervention:

```
1. Developer creates issue with "feature" or "bug" label
2. Requirements Agent analyzes → tags as "auto-implementable" (if low-risk)
3. Scaffold Agent creates branch + code + draft PR
4. Test Agent generates tests, runs them
5. Security Agent reviews for vulnerabilities
6. If all pass: PR is marked "ready for review"
7. Developer reviews and approves (this step is always human)
8. On merge: Deploy Agent deploys to dev
9. Ops Agent monitors for 30 minutes post-deploy
10. If stable: Deploy Agent creates prod deploy request for approval
```

The developer's intervention points are:
- **Step 2 override**: Can change risk assessment or reject auto-implementation
- **Step 7 mandatory**: Human review and merge approval
- **Step 10 mandatory**: Human approval for prod deploy

## Policy Rules for Phase 3

Additional Cedar/natural language rules:

```
- Scaffold Agent may only create draft PRs (never ready-for-review)
- Scaffold Agent may not modify: auth handlers, crypto code, CDK stacks, deploy scripts
- Incident Response Agent may restart ECS tasks (max 2 per hour)
- Incident Response Agent may NOT modify database, scale infrastructure, or change config
- Dependency Updater may only update patch/minor versions; major requires human approval
- Feature Flag Agent may only remove flags enabled everywhere for > 30 days
- No agent may approve or merge a PR
```

## Cost Management

Phase 3 runs more agents more frequently. Expected cost drivers:

| Agent | Frequency | Primary Cost |
|-------|-----------|-------------|
| Orchestrator | Per-event | LLM inference (coordination reasoning) |
| Requirements | Per-issue | LLM inference (code analysis) |
| Scaffold | Per-issue | LLM inference + Code Interpreter |
| Test Generation | Per-PR | LLM inference + Code Interpreter |
| Security Scanner | Per-PR | LLM inference + Code Interpreter |
| Deploy Assistant | Per-deploy | Minimal (API calls) |
| Ops Monitor | Every 5 min | Minimal (API calls) |
| Dependency Updater | Weekly | Code Interpreter (test runs) |
| Feature Flag | Monthly | Minimal |
| Incident Response | On-alarm | LLM inference (diagnosis) |

Set a monthly AgentCore budget alert at 2x the Phase 2 baseline. The Cost Monitor agent should track its own platform costs.
