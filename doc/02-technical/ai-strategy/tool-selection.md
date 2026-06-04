# Tool Selection

Which AI tools to use for which tasks in Trellis development.

## Interactive Development (Human-in-the-loop)

| Task | Tool | Why |
|------|------|-----|
| Multi-file refactoring | Claude Code (CLI) | Best at reasoning across API, infra, Flutter simultaneously; CLAUDE.md provides project context |
| Architecture changes | Claude Code (CLI) | Deep reasoning about CDK stacks, Prisma schema, route implications |
| Debugging production issues | Claude Code (CLI) | Can read logs, code, and infra config in one session |
| Flow-state feature coding | Claude in VS Code | Inline suggestions, autocomplete, and chat while editing |
| Quick Prisma queries | Claude in VS Code | Type-safe query completion from schema context |
| Flutter UI work | Claude Code (CLI) | Dart code generation with full repository context |
| Git operations, PR creation | Claude Code (CLI) | Git-native workflow, commit message generation |
| One-off scripts | Claude Code (CLI) | Can read existing ops scripts as patterns |

## Automated Agents (AgentCore, Phase 2+)

| Task | Agent Type | Trigger |
|------|-----------|---------|
| Error monitoring | Ops Monitor | Scheduled (5 min) |
| Cost tracking | Cost Monitor | Scheduled (daily) |
| Test generation | Test Gen | GitHub webhook (PR created) |
| Security review | Security Scanner | GitHub webhook (PR created) |
| Deployment | Deploy Assistant | Manual trigger |
| Dependency updates | Dependency Updater | Scheduled (weekly) |
| Feature flag cleanup | Flag Lifecycle | Scheduled (monthly) |
| Incident response | Incident Response | CloudWatch alarm |
| Impact analysis | Requirements Analyst | GitHub webhook (issue created) |
| Code scaffolding | Scaffold | Issue tag trigger |

## Tool Combinations by Scenario

### "I need to add a new API endpoint"
1. Create a GitHub issue describing the endpoint
2. **Requirements Agent** (Phase 3) analyzes impact, or do this manually with **Claude Code**
3. **Claude Code** or **Scaffold Agent** (Phase 3) generates the handler, route, tests
4. **Claude in VS Code** for refinement while editing
5. **Test Gen Agent** (Phase 2) fills coverage gaps
6. **Security Scanner** (Phase 2) reviews the PR
7. **Deploy Assistant** (Phase 2) deploys after merge

### "I need to fix a production bug"
1. **Ops Monitor** (Phase 2) alerts with diagnosis, or run `scripts/ops/diagnose.sh`
2. **Claude Code** to read logs + code + reproduce the issue
3. **Claude Code** to implement the fix
4. **Claude in VS Code** for quick inline edits
5. **Test Gen Agent** adds regression test
6. **Deploy Assistant** deploys the fix

### "I need to update infrastructure"
1. **Claude Code** to modify CDK stacks (understands 4-phase deployment, SSM parameter passing)
2. Manual `npm run infra:diff` to preview changes
3. **Deploy Assistant** executes deployment
4. **Ops Monitor** validates post-deploy stability

### "I need to update the Flutter app"
1. **Claude Code** for Dart development (full repo context for API + Flutter simultaneously)
2. **Claude in VS Code** for Riverpod boilerplate and inline edits
3. Manual testing on device/emulator (no agent can do this yet)
4. **Deploy Assistant** handles S3 sync + CloudFront invalidation

## What AI Should NOT Do (Today)

- **Database schema design** — Prisma migrations are too consequential; human designs, AI can scaffold
- **Security architecture** — Auth flows, encryption schemes, Cognito configuration require human judgment
- **CDK stack architecture** — Adding/removing stacks, changing VPC topology, modifying security groups
- **Business logic decisions** — Feed algorithms, moderation rules, feature prioritization
- **Cost optimization execution** — AI can recommend; human decides and implements
