# Routes Organization

This directory contains route definitions organized by domain/feature.

## Structure

```
routes/
├── index.ts          # Main entry point - combines all routes
├── types.ts          # Shared Route interface and types
├── health.ts         # Health check and configuration routes
├── auth.ts           # Authentication routes
├── admin.ts          # Admin and super-admin routes (TODO)
├── badges.ts         # Badge routes (TODO)
├── entities.ts       # Entity profile routes (replaces dogs)
├── feeds.ts          # Feed routes (TODO)
├── posts.ts          # Post routes (TODO)
├── comments.ts       # Comment routes (TODO)
├── sentiments.ts     # Sentiment/reaction routes (TODO)
├── privacy.ts        # Privacy preference routes (TODO)
├── export.ts         # User export routes (TODO)
├── deletion.ts       # Account deletion routes (TODO)
├── friends.ts        # Friends and connection routes (TODO)
├── invitations.ts    # Invitation routes (TODO)
├── map.ts            # Map routes (TODO)
└── internal-docs.ts   # Internal documentation routes (TODO)
```

## Best Practices

1. **Domain-Driven Organization**: Group routes by business domain/feature
2. **Single Responsibility**: Each file should handle one domain area
3. **Consistent Patterns**: Use similar structure across route files
4. **Shared Types**: Keep common types in `types.ts`
5. **Route Order**: More specific routes should be listed before general ones
6. **Documentation**: Include descriptions for all routes

## Migration Strategy

Routes are being migrated incrementally from `routes.ts`:

1. ✅ Health and configuration routes → `health.ts`
2. ✅ Authentication routes → `auth.ts`
3. ⏳ Admin routes → `admin.ts`
4. ⏳ Badge routes → `badges.ts`
5. ⏳ ... (continue for each domain)

The main `routes.ts` file will be gradually reduced as routes are migrated.

## Adding New Routes

1. Create a new file in this directory (e.g., `new-feature.ts`)
2. Export a `Route[]` array with your routes
3. Import and add to the `routes` array in `index.ts`
4. Ensure routes are ordered correctly (specific before general)

Example:

```typescript
// routes/new-feature.ts
import type { Route } from "./types";
import { corsMiddleware } from "../middleware";

export const newFeatureRoutes: Route[] = [
  {
    path: "/api/new-feature",
    method: "GET",
    handler: async (request, env, context) => {
      // Handler implementation
    },
    middleware: [corsMiddleware()],
    description: "New feature endpoint",
  },
];
```

Then in `index.ts`:

```typescript
import { newFeatureRoutes } from "./new-feature";

export const routes: Route[] = [
  ...healthRoutes,
  ...authRoutes,
  ...newFeatureRoutes,
  // ... other routes
];
```
