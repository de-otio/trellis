# Extension Route Handlers: Core-Wrapped Pattern

## The Problem

Extension route handlers currently live in `apps/api/src/lib/routes/` because they
import 5-10 core HTTP modules (`SecurityHeaders`, `corsMiddleware`, `SessionManager`,
`DatabaseConnectionManager`, `detectRegionSync`, etc.). Moving them to the extension
package would require either extracting all that infrastructure to a shared package
(Option A — heavyweight, creates a bottleneck) or passing it all as parameters
(Option B as originally stated — god object).

## The Insight

Look at what the route handlers actually do:

```typescript
// Current: apps/api/src/lib/routes/activitypub/dog-profile.ts
handler: async (request, env, { params }) => {
  // 1. Boilerplate: security headers, logger
  const securityHeaders = new SecurityHeaders(env);
  const logger = Logger.getInstance(env);

  // 2. Boilerplate: get database connection for region
  const region = detectRegionSync(request, env);
  const dbManager = sharedDatabaseConnectionManager;

  // 3. Boilerplate: query with timeout/retry
  const entity = await withQueryTimeoutAndRetry(dbManager, region, env, async (db) => {
    return await db.entity.findUnique({ where: { id: params.entityId } });
  });

  // 4. Domain logic: validate entity, serialize actor
  if (!entity) return notFound();
  if (entity.entityType !== routeEntityType) return notFound();
  const actorDoc = await DogProfileService.serializeActor(entity, env);

  // 5. Boilerplate: wrap response
  const response = securityHeaders.createSecureResponse(JSON.stringify(actorDoc), {
    status: 200,
    headers: { "content-type": "application/activity+json" },
  });
  return addCorsHeaders(response, request, env);
}
```

Steps 1, 2, 3, and 5 are identical across every route in the app. Step 4 is the
only part that's domain-specific. The extension should only provide step 4.

## The Pattern: Core-Wrapped Handlers

Extensions provide a handler function with a minimal, stable interface. Core wraps
it with all the HTTP infrastructure.

### Extension side

```typescript
// In TrellisExtension interface
interface ExtensionRouteDefinition {
  /** Path pattern — matched after /api/ext/{extensionId}/ prefix */
  path: string;
  method: string | string[];
  /** Whether this route requires authentication (default: true) */
  auth?: "required" | "optional" | "none";
  description?: string;

  /** The handler — receives parsed request, session, and scoped context */
  handle: ExtensionHandler;
}

type ExtensionHandler = (
  request: Request,
  params: Record<string, string>,
  session: Session | null,
  ctx: ExtensionContext,  // scoped DB, config, app URL — no secrets
) => Promise<ExtensionResponse>;

/** What the handler returns — core converts this to a full HTTP Response */
interface ExtensionResponse {
  status: number;
  body: unknown;       // JSON-serializable, core calls JSON.stringify
  headers?: Record<string, string>;
}
```

### Core side

Core registers extension routes with a wrapper that handles all boilerplate:

```typescript
function wrapExtensionRoute(
  ext: TrellisExtension,
  route: ExtensionRouteDefinition,
): Route {
  return {
    path: `/api/ext/${ext.id}/${route.path}`,
    method: route.method,
    middleware: [corsMiddleware(), csrfMiddleware()],
    handler: async (request, env, { params, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);

      // Auth check (core-enforced, not extension-dependent)
      let session: Session | null = null;
      if (route.auth !== "none") {
        const sessionManager = new SessionManager();
        session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
        if (!session && route.auth !== "optional") {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
      }

      // Build scoped context
      const ctx = createExtensionContext(ext, env, prisma);

      // Call extension handler
      try {
        const result = await route.handle(request, params, session, ctx);
        const response = securityHeaders.createSecureResponse(
          JSON.stringify(result.body),
          {
            status: result.status,
            headers: { "content-type": "application/json", ...result.headers },
          },
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error(`Extension "${ext.id}" route error:`, error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    description: route.description,
  };
}
```

### What the extension handler looks like

```typescript
// extensions/dogs/src/routes.ts
import type { ExtensionRouteDefinition } from "@trellis/extension-api";

export const dogRoutes: ExtensionRouteDefinition[] = [
  {
    path: "breeds",
    method: "GET",
    auth: "required",
    description: "List dog breeds",
    handle: async (request, params, session, ctx) => {
      // ctx.db is scoped — only extension-safe tables
      // ctx.config has DOG_BREED_API_KEY if configured
      // session is guaranteed non-null (auth: "required")
      const breeds = await fetchBreeds(ctx);
      return { status: 200, body: { breeds } };
    },
  },
  {
    path: "life-stage/:entityId",
    method: "GET",
    auth: "required",
    description: "Get life stage for a dog entity",
    handle: async (request, params, session, ctx) => {
      const entity = await ctx.db.entity.findUnique({
        where: { id: params.entityId },
      });
      if (!entity) return { status: 404, body: { error: "Not found" } };

      const lifeStage = calculateLifeStage(
        entity.metadata?.birthdate,
        entity.metadata?.breedSize,
      );
      return { status: 200, body: { lifeStage } };
    },
  },
];
```

## What this solves

| Problem | How it's solved |
|---------|-----------------|
| Extensions import `SecurityHeaders` | Core applies security headers — extension never touches them |
| Extensions import `corsMiddleware` | Core applies CORS — extension never touches it |
| Extensions import `SessionManager` | Core checks auth — extension receives `session` or gets a 401 |
| Extensions import `DatabaseConnectionManager` | Core creates `ExtensionContext` with scoped DB — extension uses `ctx.db` |
| Extensions import `Logger` | Core catches errors and logs them — extension just throws |
| Extensions can skip auth | `auth` field is enforced by core, not the extension |
| Extensions can shadow core routes | Route prefix `/api/ext/{id}/` is namespaced and reserved |

## ActivityPub routes stay in core

AP routes (`/entities/{type}/{id}`, `/.well-known/webfinger`, `/users/:username`,
inbox/outbox/followers collections) do **not** use the extension route pattern.
They stay in core.

**Why:** AP routes are protocol-level infrastructure, not domain logic. They
implement WebFinger, HTTP signature verification, JSON-LD serialization, content
negotiation (`application/activity+json` vs `application/ld+json`), and
OrderedCollection formatting. These are the same regardless of entity type.
Pushing this into extensions would force domain code to understand federation
protocol details — the opposite of clean separation.

The only thing that varies per domain is the **display content** of the Actor
document — breed in the summary, a domain-specific icon, structured metadata
attachments. The `enrichActor` hook handles this cleanly: core serializes the
Actor with all protocol-critical fields (`id`, `publicKey`, `inbox`, `outbox`,
`@context`), then calls the extension for display-only additions.

This is reinforced by the AP assessment (see `11-activitypub-assessment.md`).
The highest-priority finding (P1) says the route handler should delegate actor
serialization to the Fedify dispatcher rather than building JSON manually. Once
that's done, the AP route becomes an even thinner protocol wrapper:

```
GET /entities/{type}/{id}
  → core looks up entity by ID
  → core calls Fedify dispatcher
  → Fedify dispatcher calls enrichActor for display fields
  → Fedify handles JSON-LD context, content negotiation, signatures
  → core returns response
```

The extension's involvement is minimal — one function that returns
`{ summary?, icon?, attachment? }`.

**Future consideration:** If a future extension needs custom JSON-LD properties
(the way dogs had `trellis:breed`), the `ActorEnrichment` type should grow a
generic properties field:

```typescript
interface ActorEnrichment {
  summary?: string;
  icon?: { type: "Image"; url: string; mediaType?: string };
  attachment?: Array<{ type: "PropertyValue"; name: string; value: string }>;
  /** Custom namespace properties (e.g., { "trellis:breed": "Golden Retriever" }) */
  properties?: Record<string, string>;
}
```

Core merges `properties` into the Actor document individually (never via spread),
preserving the security invariant that extensions cannot override `id`, `publicKey`,
`inbox`, `outbox`, or `@context`.

## Migration path

1. Add `ExtensionRouteDefinition` and `ExtensionHandler` to `@trellis/extension-api`
2. Add `wrapExtensionRoute` to core
3. Add `extensionRoutes: ExtensionRouteDefinition[]` to `TrellisExtension` (alongside
   the existing `routes: Route[]` for backward compat during migration)
4. Move dog-specific route handlers one at a time:
   - `routes/product-recommendations.ts` → extension handler that uses `ctx.db`
   - Any new dog-specific endpoints → extension handlers from the start
5. Once all extension routes use the new pattern, remove `routes: Route[]` from
   the interface

The existing `routes: Route[]` property (currently used for the AP and product
recommendation routes wired in `extensions.ts`) continues to work during migration.
No big bang required.

## Comparison to current hooks pattern

The hook dispatcher already implements this pattern for lifecycle events:

```
Core handler completes operation
  → dispatchHook("onPostCreated", env, prisma, post)
    → creates ExtensionContext
    → calls extension hook with (post, ctx)
    → catches errors, enforces timeout
```

The route wrapper is the same idea applied to HTTP:

```
HTTP request arrives
  → core checks auth, applies middleware
  → creates ExtensionContext
  → calls extension handler with (request, params, session, ctx)
  → catches errors, wraps response with security headers
```

Both patterns keep infrastructure in core and domain logic in extensions.
