# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

**Trellis** is a generic multi-tenant social-network platform core. It provides the foundation (auth + **multi-tenant identity federation (SAML/OIDC)**, feeds, posts, comments, media, moderation, ActivityPub federation) that vertical-specific applications build on via extensions. Multi-tenancy is a first-class capability — every product on trellis can serve B2C consumers and B2B organizations with their own identity providers, side-by-side. See [`doc/02-technical/identity-federation/`](doc/02-technical/identity-federation/) for the design.

- **Repository Type**: TypeScript/Node.js monorepo (npm workspaces)
- **Distribution**: Published to npm as `@de-otio/trellis`, `@de-otio/trellis-extension-api`, and `@de-otio/trellis-extension-testkit`
- **Database (target)**: PostgreSQL via Prisma + DynamoDB for KV/cache
- **Auth (target)**: AWS Cognito
- **Federation (target)**: ActivityPub via Fedify

## Deployment Status — IMPORTANT

**Trellis is not (yet) deployed standalone.** It is consumed by a downstream vertical application as an npm dependency, and that application owns the live AWS environment. Code lands here, gets published to npm via the tag-triggered `publish.yml` workflow, and reaches AWS only when a consuming application bumps its `@de-otio/trellis` dependency and deploys from its own repo.

End-to-end verification of code that touches infrastructure (e.g., the graph layer, RDS migrations) happens in **the consuming application's** environment, not here.

## Related repos

Trellis is developed alongside two sibling repos:

| Repo                    | Path                           | Role                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **trellis** (this repo) | —                              | Domain-agnostic API core (see Project Overview above)                                                                                                                                                                                     |
| **skybber**             | `~/repos/dot/skybber`          | The primary consuming vertical application today: Flutter frontend, the `@skybber/ext-dogs` extension, CDK infra, and the live AWS deployment (dev + prod). Owns the AWS environment this repo has none of (see Deployment Status above). |
| **trellis-internal**    | `~/repos/dot/trellis-internal` | Internal-only docs, plans, and platform-level analyses; canonical generic (non-neutral) test content and its standalone dummy-target lane. Not published to npm; scrubbed/neutral subsets get mirrored into this repo before release.     |

### Testing a trellis change from skybber

If you're validating a change here against a live consumer, use skybber's link
loop (`scripts/dev-link.sh` / `scripts/dev-unlink.sh` in the skybber repo):
link → rebuild trellis after every edit (`npm run build`, since `npm link`
symlinks the package but does not rebuild it for you) → run skybber's unit
and e2e tests against the linked package → `dev-unlink.sh` to restore the
published npm version when done. Full mechanics are documented in skybber's
`CLAUDE.md` under the same heading.

**This does not cover Prisma schema changes.** `prisma/schema.prisma` ships
**inside the published npm tarball**: `apps/api/package.json`'s `files` field
includes `prisma`, and its `prepack`/`postpack` scripts copy `../../prisma`
into `apps/api/prisma` only during `npm pack`/`npm publish` (removed
immediately after). Consumers resolve the schema at
`node_modules/@de-otio/trellis/prisma/schema.prisma`. Under `npm link` that
path resolves to this repo's `apps/api/` directory directly, which has no
`prisma/` subdirectory outside of a pack/publish run — so a linked schema
change will not resolve for a consumer's `prisma generate`/`migrate`. Verify
schema changes by publishing a pre-release version and bumping the
consumer's `package.json` + lockfile, not through the link loop.

## Workspace Structure

```
apps/
  └── api/              # Node.js HTTP API (consumed by verticals as @de-otio/trellis)

packages/
  ├── extension-api/      # TrellisExtension interface and types (@de-otio/trellis-extension-api)
  └── extension-testkit/  # Standalone boot + conformance suite for extension authors
                          # (@de-otio/trellis-extension-testkit)

prisma/                 # Prisma schema + migrations
scripts/                # Local dev helpers only (see scripts/README.md)
```

## Common Commands

### Development

```bash
npm install                    # Install all workspace dependencies
bash scripts/dev-setup.sh      # First-run setup: start services, migrate DB, seed data
npm run dev                    # Start API in watch mode
```

### Database

```bash
npm run prisma:generate        # Regenerate Prisma client
npm run prisma:migrate:dev     # Create + apply migration (dev) — requires DATABASE_URL + DIRECT_DATABASE_URL
npm run prisma:migrate:deploy  # Apply migrations (prod)
npm run seed:feature-toggles   # Seed feature toggles
```

## Architecture

This describes the architecture Trellis is **designed for** when deployed (currently realised by Trellis, which embeds Trellis):

- **API**: Node.js HTTP server (Hono), designed to run in ECS Fargate on port 3000
- **Entry point**: `apps/api/src/server.ts`
- **Routes**: `apps/api/src/lib/routes.ts`
- **Env**: `apps/api/src/env.ts` (all config from process.env + AWS clients)
- **Database**: Prisma ORM → PostgreSQL via plain pg driver
- **KV/Cache**: DynamoDB single-table (`{stage}-{appName}`)
- **Queues**: SQS (5 core queues + DLQs; federation queue only when `features.activityPub` is enabled)
- **Auth**: Cognito JWT validated with `aws-jwt-verify`
- **Federation**: ActivityPub via Fedify — **disabled by default**, enabled per environment via `config.features.activityPub`
- **Extensions**: Verticals register extensions via `registerExtension()` to add domain-specific routes, metadata schemas, and terminology

## Testing

```bash
npm test                                  # All tests
npm test -- path/to/test.test.ts         # Specific test
npm run test:coverage                    # Coverage report
```

**Run tests in parallel, up to the machine's resource budget — not "never in
the background."** Test processes are RAM-heavy (each can consume 4GB+), so
parallelism is bounded by memory, not CPU or a blanket foreground-only rule.
On a 32 GB / 12-core machine: reserve ~8 GB for the OS/editor/build tooling,
leaving ~24 GB for tests. Stay under that budget — **≤4 concurrent heavy
runs** (full suite, `--coverage`) **or ~8–10 concurrent scoped runs** (a
handful of files), or any mix whose summed peak stays within budget. Prefer
scoped runs; background them when it keeps you within budget (that's how you
run several lanes at once); back off (drop concurrency / serialize) under
memory pressure or if runs start getting OOM-killed. This converges with
skybber's `CLAUDE.md` "Testing" section — same rule, same numbers.

Test setup: Docker Compose must be running for integration tests.

## Environment Variables

All configuration comes from `process.env`. Secrets are in AWS SSM Parameter Store:

- `/{appName}/{stage}/db-secret-arn` — RDS credentials (Secrets Manager ARN)
- `/{appName}/{stage}/cognito-user-pool-id`
- `/{appName}/{stage}/cognito-app-client-id`
- `/{appName}/{stage}/openai-api-key`
- `/{appName}/{stage}/google-safe-browsing-key`
- `/{appName}/{stage}/session-secret`

See `apps/api/src/env.ts` for the full environment schema.

### Email Provider Configuration

Trellis sends transactional email (magic-link login tokens) through a swappable provider abstraction, supporting both AWS SES and Resend. Provider selection and configuration is determined from environment variables read identically by both the API server and the Cognito magic-link Lambda trigger, ensuring consistent behavior.

**Provider selection:** `EMAIL_SERVICE` env var (`"aws-ses"` | `"resend"`, default: `"aws-ses"`)

**AWS SES** (`EMAIL_SERVICE=aws-ses`):

- Credentials: Uses the default AWS credential provider chain (IAM role on ECS/Lambda; no static keys stored).
- Required: `FROM_EMAIL` — default sender address (email address verified in SES for the sending region).
- Optional: `AWS_SES_REGION` or `SES_REGION` (defaults to `AWS_REGION` or `us-east-1`).
- Optional: `SES_CONFIGURATION_SET` — SES configuration set name (for event publishing and IP pool management).
- IAM permission required: `ses:SendEmail` and `ses:SendRawEmail` on the verified sender identity ARN.
- **Note:** Domain identity, Easy DKIM, custom MAIL FROM, and bounce/complaint SNS topic are provisioned separately by the `SesEmailIdentity` CDK construct in `@de-otio/saas-foundation-cdk` (no SES configuration needed in the trellis package itself).

**Resend** (`EMAIL_SERVICE=resend`):

- Required: `RESEND_API_KEY` — API key for Resend (stored in SSM Parameter Store).
- Sends via HTTPS REST API; no AWS credentials needed.

All other configuration (DMARC policy, DNS records, event destinations) is handled by the consuming application's infrastructure as code.

## Development Best Practices

1. **Always read files before editing**
2. **Minimal changes** — don't refactor or "improve" surrounding code
3. **Use Prisma types** — leverage type safety for database operations
4. **Security first** — review for injection, OWASP issues
5. **Run tests in parallel within the RAM budget** — see the Testing section (≤4 heavy or ~8–10 scoped concurrent runs on a 32 GB machine); back off under memory pressure
6. **Database efficiency** — use indexes, limit query complexity, paginate
7. **Client-metadata storage rule** — IP, User-Agent, and device identifiers
   are stored **only** through a path that enforces anonymization or an
   explicit retention bound. The two sanctioned paths are the audit composer
   (`lib/audit-composer.ts`) and `SecurityEvent` (which carries a non-nullable
   `retentionUntil`, pruned by the hourly cron). Storing client metadata ad hoc
   alongside domain data — or on `User` — is a **review blocker**. See
   `doc/02-technical/surveillance-threat-model/07-data-minimization.md`.
8. **Threshold-secrecy rule** — operational security parameters (rate limits
   beyond defaults, detection thresholds, sampling rates, retention windows)
   are **runtime config** (env vars / feature toggles with defaults), never
   compiled-in constants sprinkled at call sites. The npm tarball is public, so
   a hard-coded threshold is a published threshold. See
   `doc/02-technical/surveillance-threat-model/09-public-project-exposure.md`.

## When Working on Features

1. Look for existing patterns in `apps/api/src/lib/`
2. Add tests in `apps/api/test/`
3. Remember: changes here ship via npm, not via direct deploy (see "Deployment Status" / "Release Checklist")

## Infinite Loop Prevention

When implementing pagination, polling, retries, or recurring operations:

1. Always include a maximum iteration count
2. Always include a circuit breaker
3. Never call async methods from `build()` without a guard
4. Test the degenerate case (API returns success but no data)

## Extension Development

Trellis is extended by verticals that register extensions at startup. An extension provides:

- **id**: Unique identifier (e.g., `"dog"`)
- **terminology**: Entity naming (`{ entity: "dog", entityPlural: "dogs" }`)
- **routes**: Additional route handlers
- **metadataSchema**: Zod schema for entity metadata validation
- **configSchema** (optional): Zod schema for extension-specific env vars
- **shutdown** (optional): Cleanup function called on graceful shutdown

See `packages/extension-api/` for the `TrellisExtension` interface.

**Extension review criterion (tracker-free guarantee):** an extension **must
not** introduce third-party trackers, analytics SDKs, or ad-network
integrations into server-side request handling, and may store client metadata
only through the sanctioned anonymized/retention-bound paths (rule 7 above).
This is stated for vertical developers in
[`packages/extension-api/README.md`](packages/extension-api/README.md);
extension review blocks on a violation.

---

## Code Patterns

### Route Handler Pattern

Handlers are class-based, located in `apps/api/src/lib/`. Each handler method follows this structure:

```typescript
import type { Env } from "../env";
import type { RequestContext } from "./request-context";
import type { Session } from "./session-manager";

export class ExampleHandler {
  async handleCreate(
    resourceId: string,
    request: Request,
    session: Session,
    env: Env,
    requestContext: RequestContext,
  ): Promise<Response> {
    try {
      // 1. Validate input with Zod schema
      const { validateRequest } = await import("./validate-request");
      const validation = await validateRequest(request, createSchema);
      if (!validation.success) return validation.error;
      const body = validation.data;

      // 2. Check business rules (rate limits, permissions, feature flags)

      // 3. Perform database operation via Prisma
      const result = await db.model.create({ data: { ... } });

      // 4. Return JSON response
      return new Response(JSON.stringify(result), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      logger.error("Operation failed:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }
}
```

Key conventions:

- Use dynamic imports (`await import(...)`) for tree-shaking
- Error responses use `{ error: "CODE", message: "user-friendly text" }` format
- Always validate at the handler boundary, not deeper
- Get Prisma client from env, not direct imports

### Route Registration Pattern

Routes are arrays of `Route[]` objects in `apps/api/src/lib/routes/`:

```typescript
import type { Route } from "./types";

export const exampleRoutes: Route[] = [
  {
    path: /^\/api\/examples\/([^/]+)$/, // Regex with capture groups
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      // 1. Instantiate dependencies
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const handler = new ExampleHandler();

      // 2. Check auth
      const session = await sessionManager.getSession(request, Secrets.getSessionSecret(env));
      if (!session) {
        return securityHeaders.createSecureResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      // 3. Extract path params
      const id = pathname.match(/^\/api\/examples\/([^/]+)$/)?.[1];

      // 4. Delegate to handler
      const response = await handler.handleCreate(id!, request, session, env, requestContext);

      // 5. Add security headers
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Create example",
  },
];
```

Key conventions:

- Instantiate dependencies inside the handler function, not at module level
- Always check auth before delegating to the handler
- Always wrap response with `securityHeaders.addSecurityHeaders()`
- Apply middleware as an array (CORS and CSRF are standard)

### Unit Test Pattern

Tests use vitest, located in `apps/api/test/unit/`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";

// Hoist mocks for factory functions
const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

// Mock external dependencies
vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

const mockPrisma = {
  model: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
};

describe("ExampleHandler", () => {
  let handler: ExampleHandler;
  let mockEnv: Env;
  let mockSession: any;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ExampleHandler();
    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
    } as Env;
    mockSession = {
      userId: "user123",
      email: "user@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 3600000,
    };
  });

  describe("handleCreate", () => {
    it("should create and return 201", async () => {
      mockPrisma.model.create.mockResolvedValue({ id: "new-id" });
      const request = new Request("https://api.example.com/api/examples", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      });

      const response = await handler.handleCreate("id", request, mockSession, mockEnv, {} as any);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.id).toBe("new-id");
    });

    it("should return 404 when not found", async () => {
      mockPrisma.model.findUnique.mockResolvedValue(null);
      // ... test 404 path
    });

    it("should return 500 on database error", async () => {
      mockPrisma.model.create.mockRejectedValue(new Error("DB error"));
      // ... test error handling
    });
  });
});
```

Key conventions:

- Use `vi.hoisted()` for mock factories that need to be available before module loading
- Use `vi.clearAllMocks()` in `beforeEach`, not `afterEach`
- Test the success case, not-found case, and database error case at minimum
- Assert both `response.status` and the parsed JSON body
- Create `Request` objects with full URLs for realistic testing

### Lambda Function Pattern (Cognito Triggers)

Lambda triggers live in `apps/api/src/lambda/`:

```typescript
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

// AWS clients at module level (reused across invocations)
const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE = process.env.DYNAMODB_TABLE!;

export const handler = async (event: any) => {
  const email = event.request.userAttributes.email;

  try {
    // Perform operation
    await dynamo.send(new PutItemCommand({ TableName: TABLE, Item: { ... } }));
  } catch (err) {
    console.error("Operation failed", err);
    throw err;  // Let Lambda retry
  }

  // Modify and return the Cognito event
  event.response.privateChallengeParameters = { ... };
  return event;
};
```

Key conventions:

- AWS SDK clients instantiated at module level for connection reuse
- Use `process.env` for configuration (set via CDK Lambda environment)
- Throw errors to let Lambda retry (don't swallow them)
- Return the modified event object for Cognito triggers
- Use DynamoDB for temporary state (with TTL for auto-cleanup)

### Prisma Schema Conventions

```prisma
model Example {
  id        String   @id @default(cuid())
  name      String
  ownerId   String   @map("owner_id")      // snake_case in DB
  metadata  Json?                            // Flexible JSON when needed
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  owner User @relation(fields: [ownerId], references: [id])

  @@index([ownerId])                         // Index foreign keys
  @@map("examples")                          // snake_case table name
}
```

Key conventions:

- `@map()` for snake_case column and table names
- `@default(cuid())` for primary keys
- `@updatedAt` for audit trails
- Enums for fixed value sets (`UserRole`, `Privacy`, etc.)
- `@@index` on foreign keys and frequently queried fields
- `Json?` for extensible metadata fields
- Denormalized counts for performance (e.g., `followersCount`)

---

## Release Checklist

Trellis ships via npm. Three tag-triggered publish flows exist (`.github/workflows/publish.yml`):

- `extension-api-v<x.y.z>` → publishes `@de-otio/trellis-extension-api`
- `extension-testkit-v<x.y.z>` → publishes `@de-otio/trellis-extension-testkit`
- `v<x.y.z>` → publishes `@de-otio/trellis` (the api package)

The `v` prefix is a prefix of the other two, so the workflow matches
longest-first. Adding a fourth series means adding its arm **above** `v*`.

Before tagging:

- [ ] Tests + lint pass on `main`
- [ ] `packages/extension-api/package.json` and `apps/api/package.json` versions match the tags you're about to push
- [ ] If extension-api is bumped, `apps/api`'s `@de-otio/trellis-extension-api` constraint accepts the new version (npm caret on `0.x` only allows patch)
- [ ] `package-lock.json` is updated to match

**Version numbers live in the release commit, not the feature PR.** Between a
feature landing and the release that ships it, `apps/api/package.json` still
carries the _last published_ version. Anything in-repo that names a _future_
core version — the testkit's `peerDependencies` range and its matching
`MINIMUM_CORE_VERSION` — is therefore ahead of the tree on purpose, and
`smoke-pack.sh` tolerates exactly that skew and says so in its output. If you
see that NOTE after a release, the release forgot a bump.

**Ordering constraint for the testkit.** `@de-otio/trellis-extension-testkit`
calls `shutdownTrellis`, `classifyApiVersion` and `EXTENSION_API_VERSION`, none
of which are in a published core before `0.25.0-alpha.8`. Publish core first,
then the testkit. Publishing the testkit against an older core produces an
install that resolves and fails at boot — which is why `assertCoreShape()`
exists, but a good error is not a substitute for the right order.

After tagging, watch the workflow run and confirm the version is on npm with `npm view <pkg> versions --json --registry=https://registry.npmjs.org`. `npm view` lags the registry by a minute or so; a `curl` of the registry URL is the faster confirmation.
