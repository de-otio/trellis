# AgentCore Agents Across the Software Development Lifecycle

This document maps concrete AI agent opportunities to each SDLC phase for Trellis. Each agent would run on AgentCore Runtime with tools exposed via AgentCore Gateway.

## Phase 1: Planning & Design

### Requirements Analyst Agent
- Ingests GitHub issues, feature requests, and existing plans (`/plans/` directory)
- Cross-references the Prisma schema (38 models) and route registry (40+ routes) to identify impact
- Produces scoped implementation briefs with affected files and estimated test surface
- **AgentCore services**: Memory (project context), Browser (fetch linked issues/docs)

### Architecture Advisor Agent
- Reviews proposed schema changes against existing CDK stacks and config (`infra/lib/config/`)
- Flags infrastructure implications (new queues, permissions, environment variables)
- Validates against the `StageConfig` interface to ensure dev/prod parity
- **AgentCore services**: Code Interpreter (parse TypeScript AST), Memory (architecture decisions)

## Phase 2: Implementation

### Code Scaffolding Agent
- Generates new route handlers following established patterns in `apps/api/src/lib/`
- Creates corresponding Prisma migrations, TypeScript types, and test stubs
- Follows existing conventions: handler → service → route registration
- **AgentCore services**: Code Interpreter (generate and validate code), Gateway (access repo via MCP)

### Database Migration Agent
- Generates Prisma schema changes from natural language requirements
- Validates migrations against existing data (checks for destructive changes)
- Generates seed data for new models
- **AgentCore services**: Code Interpreter (run Prisma commands), Policy (block destructive migrations without approval)

### Flutter Client Sync Agent
- Detects API route changes and updates Dart API client code in `apps/flutter/lib/core/api/`
- Generates corresponding Riverpod providers and UI scaffolding
- Keeps frontend and backend types in sync
- **AgentCore services**: Code Interpreter (Dart analysis), Memory (API contract history)

## Phase 3: Testing

### Test Generation Agent
- Generates unit tests for new handlers, matching the patterns in the existing 314 test files
- Creates integration test fixtures with proper mock setup (auth, environment, AWS services)
- Targets the 80% coverage threshold defined in `vitest.config.ts`
- **AgentCore services**: Code Interpreter (run tests in sandbox), Evaluations (measure test quality)

### Security Review Agent
- Scans route handlers for OWASP vulnerabilities (injection, XSS, CSRF bypass)
- Validates cryptographic usage in `packages/crypto/` and `lib/crypto/`
- Checks Cognito JWT validation, CORS configuration, and security headers
- Reviews Prisma queries for SQL injection and N+1 patterns
- **AgentCore services**: Code Interpreter (static analysis), Policy (enforce security rules)

### E2E Test Runner Agent
- Executes post-deployment smoke tests (`apps/api/test/e2e/`)
- Validates critical paths: auth flow, media upload, feed generation
- Reports failures with context (logs, request/response pairs)
- **AgentCore services**: Browser (test web UI), Runtime (async execution for long test suites)

## Phase 4: Deployment

### Deploy Orchestrator Agent
- Executes the 4-phase CDK deployment pipeline defined in `scripts/deploy.sh`
- Monitors each phase, handles rollback on failure
- Runs database migrations as ECS tasks and validates completion
- Performs smoke tests and CloudFront invalidation
- **AgentCore services**: Runtime (long-running async), Observability (deployment tracing), Policy (require approval for prod)

### Infrastructure Drift Agent
- Compares deployed state against CDK definitions
- Detects configuration drift in SSM parameters, security groups, IAM policies
- Alerts on unexpected changes and suggests corrective CDK code
- **AgentCore services**: Gateway (AWS API access), Memory (baseline state), Observability (drift metrics)

## Phase 5: Operations

### Incident Response Agent
- Monitors CloudWatch alarms and error logs (`scripts/ops/errors.sh` patterns)
- Correlates errors with recent deployments and code changes
- Executes incident runbooks from `scripts/incident/`
- Escalates to the developer with diagnosis and suggested fixes
- **AgentCore services**: Gateway (CloudWatch, ECS APIs), Memory (incident history), Observability (trace correlation)

### Cost Optimization Agent
- Extends the existing `budget-monitor.ts` with predictive analysis
- Monitors ECS task scaling, Lambda invocations, DynamoDB capacity, S3 storage
- Suggests right-sizing for Fargate tasks and RDS instances
- **AgentCore services**: Gateway (AWS Cost Explorer API), Memory (spending trends), Evaluations (recommendation quality)

### Database Health Agent
- Monitors query performance, connection pool utilization, and index usage
- Detects slow queries and suggests Prisma query optimizations or new indexes
- Validates backup status and recovery point objectives
- **AgentCore services**: Gateway (RDS Performance Insights), Code Interpreter (query analysis)

## Phase 6: Maintenance

### Dependency Update Agent
- Monitors npm and Flutter package updates for security vulnerabilities
- Tests updates in isolation (AgentCore sandboxed runtime)
- Creates PRs with changelog summaries and test results
- **AgentCore services**: Code Interpreter (run builds and tests), Browser (check CVE databases)

### Feature Flag Lifecycle Agent
- Tracks feature toggles in the `FeatureToggle` table
- Identifies stale flags (enabled everywhere for >30 days)
- Generates cleanup PRs removing flag checks from code
- **AgentCore services**: Gateway (DynamoDB access), Code Interpreter (code analysis)

### Documentation Agent
- Generates API documentation from route handlers and Prisma schema
- Updates `CLAUDE.md` and implementation checklists when architecture changes
- Produces changelog entries from commit history
- **AgentCore services**: Code Interpreter (TypeScript parsing), Memory (documentation state)
