# Adopting AI-DLC Steering Rules for Trellis

## What Are Steering Rules?

Steering rules are project-level configuration files that guide AI coding agents through a structured development lifecycle. AWS open-sourced the [AI-DLC framework](https://github.com/awslabs/aidlc-workflows) with drop-in rules for every major agent.

Trellis already has `CLAUDE.md` — this is a steering rule. The AI-DLC framework extends this concept to cover the full lifecycle with adaptive phase selection.

## AI-DLC Phases Applied to Trellis

### Inception Phase

**When**: Starting a new feature, investigating a bug, or planning a refactor.

**Steering rules should encode**:
- Check `infra/lib/config/index.ts` for the `StageConfig` interface before proposing infra changes
- Check `prisma/schema.prisma` for existing models before proposing schema changes
- Check `apps/api/src/lib/routes/` for existing routes before adding new ones
- Check feature flags in `FeatureToggle` model before assuming feature availability
- Review `apps/api/src/env.ts` for available environment variables

### Construction Phase

**When**: Writing code, tests, migrations, or CDK changes.

**Steering rules should encode**:

**API handlers:**
- Follow the pattern in existing handlers under `apps/api/src/lib/`
- Export handler functions, not classes
- Use Prisma client from env, not direct imports
- Validate all user input at the handler boundary
- Return typed responses matching existing patterns

**Tests:**
- Use vitest (not jest)
- Import test setup from `test/setup.ts`
- Use auth helpers from `test/utils/`
- Mock AWS services using existing patterns in `test/utils/`
- Max 2 worker threads (configured in `vitest.config.ts`)
- Target 80% coverage

**Prisma:**
- Always generate client after schema changes: `npm run prisma:generate`
- Use transactions for multi-model operations
- Paginate all list queries
- Add indexes for frequently queried fields
- Use `@updatedAt` for audit trails

**CDK:**
- Follow 4-phase deployment order (Monitoring/Network → Data/Storage/CDN → Auth → API/Workers)
- Pass values between stacks via SSM Parameter Store, not direct references
- Use `getConfig()` from `infra/lib/config/` for environment-specific values
- Tag all resources with `stage` and `project`

**Lambda:**
- Follow patterns from existing triggers in `apps/api/src/lambda/`
- Bundle with esbuild (configured in CDK)
- Include error handling with structured logging
- Keep handlers focused — one responsibility per Lambda

**Flutter:**
- Use Riverpod for state management
- Use Amplify for Cognito auth
- API client lives in `apps/flutter/lib/core/api/`
- Follow feature-based folder structure in `apps/flutter/lib/features/`

### Operations Phase

**When**: Deploying, monitoring, or responding to incidents.

**Steering rules should encode**:
- Deploy with `scripts/deploy.sh` or the GitHub Actions workflow
- Never skip tests for non-emergency deploys
- Always run smoke tests after deployment
- Check `scripts/ops/` for existing operational tooling before writing new scripts
- Use structured logging (JSON) for all operational output

## Files to Create

### For Claude Code CLI + Claude in VS Code

Both tools read `CLAUDE.md` for project context. This is the single source of truth for all steering rules.

**Extend `CLAUDE.md`** with AI-DLC lifecycle sections. The inception/construction/operations guidance above should be incorporated into the relevant sections. Since both the CLI and VS Code extension read the same file, conventions only need to be maintained in one place.

### For any future agent (generic)

Create `.aidlc-rule-details/` with the full AI-DLC rule set from the open-source repo, customized with Trellis-specific patterns. This gives any compatible agent access to the same lifecycle guidance. This is optional and only needed if additional AI tools are adopted later.

## Maintenance

Steering rules are living documents. Update them when:
- A new pattern is established (e.g., a new type of handler or test)
- A convention changes (e.g., switching from vitest to another framework)
- A mistake recurs (add the correction as a rule)
- A new tool or service is added to the stack
