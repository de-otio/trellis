# Phase 2: Augmentation (Months 2–4)

Custom agents on AgentCore that execute tasks and produce artifacts for human review.

## ✅ Infrastructure (Complete)

### CDK Stack: `agents-stack.ts`

Deployed in Phase 4 alongside Api and Workers. Conditional on `config.agents.enabled`.

See [architecture/13-agents.md](../architecture/13-agents.md) for full architecture details.

**What was built:**
- 5 IAM roles (Runtime, Gateway, Tool Lambda read-only, Alert Tool, Diagnostics Proxy)
- 8 tool Lambdas exposing infrastructure as MCP tools via AgentCore Gateway
- Diagnostics proxy Lambda with anti-flapping (per-alarm cooldown, daily cap, SNS source filter)
- AgentCore Memory (STM + LTM), Gateway, Policy (Cedar), Runtime
- Monthly Bedrock cost budget alarm
- Agent ECR repository (in StorageStack)
- Deploy pipeline updates (`deploy.sh`, `deploy.yml`)

**Key design decision:** CloudWatch alarms handle detection ($0). AI is invoked only when an alarm fires — for diagnosis, not polling. This keeps costs near $0 on quiet days.

### Gateway Tools

| Tool | Source | Access |
|------|--------|--------|
| `search_logs` | CloudWatch Logs Insights | Read |
| `get_errors` | CloudWatch Logs (ERROR filter) | Read |
| `describe_services` | ECS DescribeServices | Read |
| `check_health` | API health endpoint (HTTP) | Read |
| `get_queue_status` | SQS queue depths + DLQs | Read |
| `get_cost_report` | Cost Explorer | Read |
| `get_feature_flags` | DynamoDB FeatureToggle scan | Read |
| `send_alert` | SNS (with `source="agent"` attribute) | Write |

### Policy (Cedar)

Explicit `permit` for all 8 tools. Default deny for everything else. Tool Lambda IAM is read-only (no `sns:Publish`, no `dynamodb:PutItem`, no `lambda:InvokeFunction`). `send_alert` uses a separate role with only `sns:Publish`.

## ✅ Agent 1: Diagnostics Agent (Complete)

### Purpose
Investigate CloudWatch alarms. Correlate with context. Produce actionable diagnosis.

### Behavior
1. CloudWatch alarm fires → SNS → diagnostics proxy Lambda
2. Proxy checks: ALARM state only, per-alarm cooldown (5 min), daily cap (50)
3. Proxy invokes AgentCore Runtime with alarm details
4. Agent calls tools to gather context: `search_logs`, `describe_services`, `get_queue_status`
5. Agent correlates with past incidents (AgentCore Memory)
6. Agent sends diagnosis via `send_alert`: severity, root cause hypothesis, evidence, suggested action
7. Agent stores incident in Memory for future correlation

### What the agent does NOT do
- Run on a schedule (detection is CloudWatch's job)
- Take remediation actions
- Deploy, restart services, or modify infrastructure

### Success Criteria
- Diagnosis includes evidence (log lines, metric values)
- False positive rate < 20%
- Daily cost < $5 (enforced by invocation cap)

## Agent 2: Test Generation (Month 2–3) — Not Yet Built

### Purpose
Maintain 80% coverage as features are added.

### Planned Behavior
1. Triggered on PR creation (via GitHub webhook)
2. Reads the diff to identify new/changed handlers
3. Generates tests following patterns from existing 314 test files
4. Runs generated tests in AgentCore Code Interpreter
5. Creates commit on PR branch (pass) or comments with failure (fail)

### Prerequisites
- AgentCore Code Interpreter availability
- GitHub webhook → AgentCore Runtime trigger pattern

## Agent 3: Security Scanner (Month 3) — Not Yet Built

### Purpose
Catch OWASP issues in PRs before merge.

### Planned Behavior
1. Triggered on PR creation
2. Analyzes changed files for injection, XSS, CSRF bypass, auth bypass, insecure crypto
3. Posts PR review with inline comments

## Agent 4: Deploy Assistant (Month 3–4) — Not Yet Built

### Purpose
Automate deploy pipeline with monitoring and rollback suggestions.

### Planned Behavior
1. Triggered manually
2. Executes `scripts/deploy.sh` pipeline
3. Reports progress, captures failure context
4. Does NOT auto-rollback (human decision)

## Month 4: Integration and Tuning

- Tune diagnostics agent alert quality based on first month of data
- Add tools as needed (e.g., `get_slow_queries` for RDS Performance Insights)
- Wire Test Generation and Security Scanner agents to the same Gateway
- Establish cost baseline for agent execution
