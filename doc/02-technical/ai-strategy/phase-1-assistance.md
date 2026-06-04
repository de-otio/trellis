# Phase 1: Assistance (Weeks 1–4)

Zero infrastructure investment. Maximize what existing tools can do today.

## ~~Week 1: AI-DLC Steering Rules~~ COMPLETE

> **Completed 2026-03-18.** CLAUDE.md extended with:
> - AI-DLC lifecycle phases (Inception, Construction, Operations) adapted for Trellis
> - Route handler pattern template (class-based, Zod validation, try/catch, JSON responses)
> - Route registration pattern template (Route[] array, auth check, security headers, middleware)
> - Unit test pattern template (vitest, vi.hoisted mocks, beforeEach, success/error/500 cases)
> - Lambda function pattern template (Cognito triggers, module-level AWS clients, event return)
> - Prisma schema conventions (@map, cuid, indexes, denormalized counts, Json fields)
> - CDK stack conventions (SSM parameter passing, per-resource IAM, 4-phase deployment)
> - Flutter conventions (Riverpod, Amplify, Go Router, feature-based structure)
> - Deployment checklist (before and after deploy verification steps)

## Week 2: Optimize Daily Workflow

### Claude Code CLI for complex work
- Multi-file refactoring, architecture changes, debugging
- Use for tasks requiring reasoning across API, infra, and Flutter simultaneously
- Leverage existing `CLAUDE.md` context for project-aware suggestions
- Best for: multi-step tasks, deployment, git operations, exploring unfamiliar code

### Claude in VS Code for flow-state coding
- Autocomplete while writing handlers, tests, CDK constructs
- Inline suggestions for Prisma queries, TypeScript types, Dart code
- Chat panel for quick questions about unfamiliar code
- Best for: editing within a file, quick fixes, boilerplate generation

### Establish the review habit
- Every AI-generated change gets a manual review before commit
- Check: security, correctness, does it follow existing patterns
- This habit is essential training for Phase 2 where review volume increases

## Week 3: AI-Assisted Testing

### Generate test coverage for gaps
- Use Claude Code to analyze `vitest.config.ts` coverage reports
- Generate tests for uncovered handlers, following patterns from existing 314 test files
- Focus on: route handlers, Prisma query functions, middleware

### AI-assisted E2E test authoring
- Use Claude Code to scaffold new E2E tests in `apps/api/test/e2e/`
- Feed it existing E2E tests as examples plus the route definitions
- Review and refine — E2E tests are high-value but brittle if poorly written

## Week 4: AI-Assisted Operations

### Script the diagnostic workflow
- Create a "diagnose" script that Claude Code can run: `scripts/ops/diagnose.sh`
- Combines: `errors.sh`, `logs.sh`, `status.sh`, `db.sh status` output
- Feed combined output to Claude Code for analysis when issues arise

### Document incident patterns
- Use Claude Code to analyze git history for past bug fixes
- Create `scripts/incident/` runbooks based on actual failure patterns
- Each runbook: symptoms, diagnosis steps, resolution, prevention

## Deliverables Checklist

- [x] AI-DLC steering rules adapted and committed
- [x] Enhanced CLAUDE.md with templates and conventions
- [ ] Baseline metrics recorded (current PR cycle time, test coverage, deploy frequency)
- [ ] Test coverage gaps identified and top 10 addressed
- [ ] `scripts/ops/diagnose.sh` created
- [ ] At least 3 incident runbooks documented
- [ ] Daily workflow established: Claude Code CLI + Claude in VS Code with consistent review
