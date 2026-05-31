# Maturity Phases

## Overview

```
Phase 1: Assistance        Phase 2: Augmentation       Phase 3: Autonomy
(Weeks 1–4)                (Months 2–4)                (Months 5+)
─────────────────────      ─────────────────────       ─────────────────────
AI suggests                AI executes                 AI executes
Human executes             Human reviews before        Human reviews after
                           merge/deploy                (low-risk only)

Tools: Claude Code CLI,    Tools: AgentCore            Tools: Multi-agent
Claude in VS Code,         Runtime + Gateway,          orchestration via
AI-DLC steering rules      custom agents               A2A protocol

Risk: Minimal              Risk: Medium                Risk: Managed by
                           (sandboxed execution)       Policy + Evaluations
```

## Phase 1: Assistance (Weeks 1–4)

**Goal**: Maximize productivity with tools that already exist. Zero infrastructure investment.

**What changes**: The developer works faster with better context. No new AWS resources. No custom agents.

**Key deliverable**: AI-DLC steering rules in the repo, optimized CLAUDE.md, measurable baseline metrics.

See [phase-1-assistance.md](phase-1-assistance.md) for details.

## Phase 2: Augmentation (Months 2–4)

**Goal**: Deploy 3–4 custom agents on AgentCore that handle specific SDLC tasks autonomously, with human review.

**What changes**: New CDK stack for AgentCore resources. Agents create PRs, file reports, and alert on issues. Developer reviews and approves.

**Key deliverable**: Ops monitoring agent, test generation agent, security scanner agent, deploy assistant agent.

See [phase-2-augmentation.md](phase-2-augmentation.md) for details.

## Phase 3: Autonomy (Months 5+)

**Goal**: Multi-agent workflows that handle routine work end-to-end. Developer intervenes only for architecture, security, and novel features.

**What changes**: Agents coordinate via A2A protocol. Issue-to-PR pipelines for routine work. Autonomous incident response for known failure modes.

**Key deliverable**: Orchestrated agent fleet covering planning, implementation, testing, deployment, and operations.

See [phase-3-autonomy.md](phase-3-autonomy.md) for details.
