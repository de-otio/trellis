# Code patterns (in-repo)

Reference examples for work inside this repository. The rules that these
examples illustrate are stated in [`AGENTS.md`](../../../AGENTS.md); this file
holds the long-form shapes so the contract can stay short.

> Migrated verbatim from the repository's former `CLAUDE.md` (2026-09-06) when
> `AGENTS.md` became the single vendor-neutral contract.

## Route handler pattern

Handlers are class-based, located in `apps/api/src/lib/`. Each handler method
follows this structure:

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
- Get the Prisma client from `env`, not direct imports

## Route registration pattern

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
- Always wrap the response with `securityHeaders.addSecurityHeaders()`
- Apply middleware as an array (CORS and CSRF are standard)

## Unit test pattern

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

- Use `vi.hoisted()` for mock factories that must exist before module loading
- Use `vi.clearAllMocks()` in `beforeEach`, not `afterEach`
- Test the success case, the not-found case and the database-error case at minimum
- Assert both `response.status` and the parsed JSON body
- Create `Request` objects with full URLs for realistic testing

## Lambda function pattern (Cognito triggers)

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
- Use `process.env` for configuration
- Throw errors to let Lambda retry (do not swallow them)
- Return the modified event object for Cognito triggers
- Use DynamoDB for temporary state (with TTL for auto-cleanup)

## Prisma schema conventions

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
- Enums for fixed value sets (`UserRole`, `Privacy`, …)
- `@@index` on foreign keys and frequently queried fields
- `Json?` for extensible metadata fields
- Denormalized counts for performance (e.g. `followersCount`)

## Environment variables and email provider

All configuration comes from `process.env`; see `apps/api/src/env.ts` for the
full schema. Secrets are resolved from the consuming application's parameter
store — this repo deploys nothing itself.

Transactional email (magic-link login tokens) goes through a swappable
provider abstraction read identically by the API server and the Cognito
magic-link Lambda trigger.

| Setting | Value |
|---|---|
| `EMAIL_SERVICE` | `"aws-ses"` (default) or `"resend"` |
| SES: credentials | default AWS credential provider chain — no static keys |
| SES: required | `FROM_EMAIL` (verified sender in the sending region) |
| SES: optional | `AWS_SES_REGION` / `SES_REGION`, `SES_CONFIGURATION_SET` |
| SES: IAM | `ses:SendEmail`, `ses:SendRawEmail` on the sender identity ARN |
| Resend: required | `RESEND_API_KEY` |

Domain identity, Easy DKIM, custom MAIL FROM and the bounce/complaint SNS
topic are provisioned separately by the `SesEmailIdentity` CDK construct in
`@de-otio/saas-foundation-cdk`; DMARC policy, DNS records and event
destinations belong to the consuming application's IaC. No SES configuration
lives in this package.

## Infinite-loop prevention

When implementing pagination, polling, retries or recurring operations:

1. Always include a maximum iteration count
2. Always include a circuit breaker
3. Never call async methods from `build()` without a guard
4. Test the degenerate case (API returns success but no data)
