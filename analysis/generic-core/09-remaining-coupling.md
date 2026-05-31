# Remaining Core-Extension Coupling

## What moved

| File | Destination | Core dependency removed |
|------|-------------|------------------------|
| `life-stage-calculator.ts` | `extensions/dogs/src/life-stage.ts` | `Logger` → deleted (edge-case warnings, no value) |
| `taxonomy-seed.ts` | `extensions/dogs/src/taxonomy-seed.ts` | `Logger` → `console.info` (seed progress logging) |

These moved cleanly because they are **pure domain logic** with trivial
infrastructure dependencies.

## What stays in `apps/api/src/lib/` and why

### Route handlers

| File | Core imports |
|------|-------------|
| `routes/activitypub/dog-profile.ts` | `SecurityHeaders`, `corsMiddleware`, `detectRegionSync`, `sharedDatabaseConnectionManager`, `withQueryTimeoutAndRetry`, `Logger`, `addCorsHeaders`, `Route` |
| `routes/product-recommendations.ts` | `SecurityHeaders`, `corsMiddleware`, `SessionManager`, `Logger`, `createRequestContext`, `getRequestContext`, `Route` |

These are HTTP wiring — they compose middleware, check sessions, add security
headers, handle CORS, and delegate to business logic. This is not domain logic.
It's the same pattern every route in the app uses. Moving it to a separate package
would mean either duplicating the HTTP infrastructure or extracting it into a
shared package, neither of which adds value.

### Database orchestration

| File | Core imports |
|------|-------------|
| `feed-personalization.ts` | `DataRouter`, `TaxonomyHandler`, `getWrappedDatabase`, `Env` |
| `product-recommendations.ts` | `DataRouter`, `TaxonomyHandler`, `getWrappedDatabase`, `Env` |

These files query the database using region-aware connection routing (`DataRouter`),
query timeout/retry wrappers, and the taxonomy system. The actual domain logic
within them is small:

- `FeedPersonalization.calculateTaxonomyRelevance()` — pure function, 20 lines,
  no imports. Could move to the extension.
- `FeedPersonalization.buildPersonalizedTaxonomyFilter()` — pure function, 15 lines,
  no imports. Could move to the extension.
- `FeedPersonalization.getEntityTaxonomyTags()` — database orchestration. Queries
  entities, queries taxonomy tags, returns a list. Uses `DataRouter`,
  `TaxonomyHandler`, and `getWrappedDatabase`. This is the piece that can't move.

The same pattern repeats in `product-recommendations.ts`: small domain logic
wrapped in database orchestration.

### ActivityPub services

| File | Core imports |
|------|-------------|
| `activitypub/dog-profile-service.ts` | `ActorService`, `KeyPairService`, `Env` |
| `activitypub/dispatchers/dog-actor.ts` | `DatabaseConnectionManager`, `Logger`, `KeyPairService`, `DogProfileService`, `detectRegionSync`, `withQueryTimeoutAndRetry`, Fedify types |

The AP service generates actor URIs, serializes Actor documents, and manages
RSA key pairs. The dispatcher resolves URIs to actors via database lookups. Both
are tightly integrated with the Fedify runtime and the database connection system.

## Options to complete the extraction

### Option A: Extract core HTTP infrastructure to a shared package

Create `packages/core-http/` exporting `SecurityHeaders`, `corsMiddleware`,
`SessionManager`, `Route`, `Middleware`, etc. Both `apps/api` and extensions
depend on it.

**Pros:** Clean package boundaries.
**Cons:** Large scope. These modules also import from `Env`, `request-context`,
and each other. Untangling them is a project in itself.

### Option B: Dependency injection via ExtensionContext

Expand `ExtensionContext` to include HTTP infrastructure:

```typescript
interface ExtensionContext {
  // ... existing fields
  http: {
    securityHeaders: SecurityHeaders;
    corsMiddleware: Middleware;
    sessionManager: SessionManager;
  };
  db: ExtensionDb;  // already exists
}
```

Route handlers in the extension receive `ExtensionContext` and use the provided
instances instead of importing them.

**Pros:** No new packages. Extensions stay decoupled.
**Cons:** `ExtensionContext` becomes a god object. Route handler signatures change.

### Option C: Keep route handlers in core, move only domain logic

This is what we did. The extension owns:
- Entity metadata schema (what fields a dog has)
- Life stage calculation (pure domain logic)
- Taxonomy seed data (what categories exist)
- Hooks (react to core events)
- Terminology (display names)

The app owns:
- Route wiring (HTTP method, path, middleware, auth, CORS)
- Database orchestration (connection pooling, region routing, timeouts)
- ActivityPub protocol integration (Fedify runtime, HTTP signatures)

The extension's routes are registered via `extensions.ts` which imports both the
extension metadata and the app-side route handlers. This is explicit and type-safe.

**Pros:** Minimal changes. No new packages. Domain logic is cleanly separated.
**Cons:** Route handler files stay in `apps/api/src/lib/`. They're identifiable
by name but not physically separated.

### Option D: Split files — pure logic to extension, orchestration stays

For `feed-personalization.ts`, extract the pure functions:

```
extensions/dogs/src/feed-scoring.ts    → calculateTaxonomyRelevance(), buildFilter()
apps/api/src/lib/feed-personalization.ts → getEntityTaxonomyTags() (keeps DataRouter)
```

The core file imports the scoring functions from the extension.

**Pros:** Pure domain logic moves. Database code stays where it belongs.
**Cons:** Fragments one cohesive class across two packages. The core file
becomes a thin wrapper that just queries the DB and calls the extension.

## Recommendation

**Option C is the right call today.** The domain logic that matters (metadata
schemas, life stages, taxonomy, hooks, terminology) has moved. What remains is
HTTP and database wiring — code that is the same shape as every other handler in
the app and would be awkward to extract.

Option D is worth doing for `feed-personalization.ts` specifically, because
`calculateTaxonomyRelevance` is a pure scoring function that a second extension
(e.g., plants) would want to replace. But this is a refinement, not a blocker.

The test for "is this extension-ready?" is: **can you deploy the core with a
different extension?** With the current state:
- Change `extensions.ts` to load `plantsExtension` instead of `dogsExtension`
- The plant extension provides its own metadata schema, terminology, life-stage
  equivalent, taxonomy seed, and hooks
- Dog-specific route handlers (`/entities/dog/:id`) still exist but return 404
  for non-dog entities (the handler checks `entityType` against the URI)
- Feed personalization and product recommendations use taxonomy tags generically —
  they work for any entity type that has taxonomy tags

The answer is **yes**, with the caveat that dog-specific route handlers are dead
code in a non-dog deployment. A future cleanup could gate them behind the
extension registry, but they don't break anything.
