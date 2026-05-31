# AgentCore Architecture for Trellis

## Multi-Agent Topology

```
                    ┌─────────────────────┐
                    │   Orchestrator      │
                    │   (A2A Protocol)    │
                    └──────┬──────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
     ┌──────▼──────┐ ┌────▼────┐ ┌───────▼──────┐
     │  Dev Agents  │ │  Ops    │ │  Quality     │
     │  (Impl,      │ │  Agents │ │  Agents      │
     │   Scaffold,  │ │  (Deploy│ │  (Test, Sec, │
     │   Migrate)   │ │   Mon,  │ │   Review)    │
     │              │ │   Inc)  │ │              │
     └──────┬───────┘ └────┬────┘ └──────┬───────┘
            │              │              │
            └──────────────┼──────────────┘
                           │
                    ┌──────▼──────────────┐
                    │  AgentCore Gateway  │
                    │  (MCP Tools)        │
                    └──────┬──────────────┘
                           │
     ┌─────────┬───────────┼────────────┬──────────┐
     │         │           │            │          │
  ┌──▼──┐  ┌──▼──┐  ┌─────▼────┐  ┌───▼───┐  ┌──▼──┐
  │ Git │  │ AWS │  │ Database │  │ Build │  │ Mon │
  │ Hub │  │ APIs│  │ (RDS/    │  │ Tools │  │ itor│
  │     │  │     │  │  DDB)    │  │       │  │ ing │
  └─────┘  └─────┘  └──────────┘  └───────┘  └─────┘
```

## Agent Communication Pattern

Agents coordinate via the **A2A protocol** (JSON-RPC 2.0 over HTTP):

1. **Orchestrator** receives developer intent (GitHub issue, Slack message, scheduled trigger)
2. Orchestrator discovers available specialist agents and their capabilities
3. Specialist agents execute independently, reporting status back
4. Each agent has its own session isolation (AgentCore Runtime)
5. Shared context flows through AgentCore Memory (not direct state sharing)

This loose coupling means agents can be developed, tested, and deployed independently.

## Tool Exposure via Gateway

Trellis's existing infrastructure becomes agent-accessible through AgentCore Gateway:

### Existing Lambda Functions → MCP Tools
```
Lambda: media-processing-worker  → Tool: "process_media"
Lambda: delete-account-worker    → Tool: "delete_account"
Lambda: cleanup-cron             → Tool: "run_cleanup"
Lambda: pre-token-generation     → Tool: "inspect_token_claims"
```

### API Endpoints → MCP Tools
```
GET  /health                     → Tool: "check_api_health"
GET  /api/feature-toggles       → Tool: "list_feature_flags"
POST /api/feature-toggles       → Tool: "update_feature_flag"
```

### AWS Services → MCP Tools (via Gateway connectors)
```
CloudWatch Logs                  → Tool: "search_logs"
ECS                             → Tool: "describe_services"
RDS Performance Insights        → Tool: "get_slow_queries"
S3                              → Tool: "manage_media"
SQS                             → Tool: "inspect_queues"
SSM Parameter Store             → Tool: "get_config"
Cost Explorer                   → Tool: "get_cost_report"
```

### External Services → MCP Tools
```
GitHub API                      → Tool: "manage_issues", "create_pr"
npm registry                    → Tool: "check_vulnerabilities"
```

## Identity & Authorization

```
Developer (Cognito) ──► AgentCore Identity ──► Agent Sessions
                                                    │
                                              AgentCore Policy
                                                    │
                                              ┌─────▼─────┐
                                              │ Rules:     │
                                              │ - No prod  │
                                              │   deploy   │
                                              │   without  │
                                              │   approval │
                                              │ - No DB    │
                                              │   drops    │
                                              │ - Read-    │
                                              │   only in  │
                                              │   prod DB  │
                                              └───────────┘
```

AgentCore Identity integrates with the existing Cognito User Pool. The developer authenticates once; agents inherit scoped permissions. AgentCore Policy enforces guardrails:

- **Dev environment**: Agents can deploy, run migrations, modify data
- **Prod environment**: Agents require explicit approval for deployments; database access is read-only
- **Security**: Agents cannot access SSM secrets directly; they request through Policy-gated Gateway tools

## Observability Stack

```
Agent Execution ──► AgentCore Observability ──► OpenTelemetry
                                                     │
                                    ┌────────────────┼────────────┐
                                    │                │            │
                              CloudWatch        X-Ray        Grafana
                              (existing)      (existing)    (optional)
```

AgentCore Observability emits OpenTelemetry traces, which feed into the existing CloudWatch/X-Ray setup from the Monitoring Stack. This gives unified visibility: API request traces alongside agent decision traces.

## Memory Architecture

```
┌────────────────────────────────┐
│        AgentCore Memory        │
├───────────────┬────────────────┤
│  Short-term   │  Long-term     │
│  (session)    │  (persistent)  │
├───────────────┼────────────────┤
│ Current task  │ Schema history │
│ context       │ Deploy history │
│ Conversation  │ Incident log   │
│ with dev      │ Cost trends    │
│ In-progress   │ Test patterns  │
│ changes       │ Known issues   │
└───────────────┴────────────────┘
```

Long-term memory is shared across agents, enabling the Incident Response Agent to reference deployment history from the Deploy Agent, or the Test Agent to know which areas changed recently.

## CDK Integration

AgentCore resources can be provisioned alongside existing Trellis infrastructure:

```typescript
// New stack: infra/lib/stacks/agents-stack.ts
// Phase: deployed after API stack (needs endpoints)

- AgentCore Runtime (agent execution environment)
- AgentCore Gateway (tool endpoints)
- AgentCore Memory store
- AgentCore Policy rules
- IAM roles for agent-to-AWS access
```

This would become a 9th CDK stack in the existing 4-phase deployment pipeline, deployed in the final phase alongside Workers.
