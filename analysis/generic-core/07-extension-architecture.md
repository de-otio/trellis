# Proposed Extension Architecture

## Design Principles

1. **Core knows about extensions; extensions know about core.** Core defines
   interfaces that extensions implement. Extensions import core types. Neither
   core nor extensions import from each other's siblings.

2. **Convention over configuration.** Extensions live in a known directory with
   a known entry point. No XML or YAML manifests.

3. **Extensions are npm packages.** They can be workspace packages (monorepo)
   or published packages. The core discovers them at startup.

## Directory Structure

```
packages/
  core/                    # Generic social network library
    src/
      models/              # Core Prisma types (re-exported)
      handlers/            # Base handler classes
      interfaces/          # Extension interfaces
      middleware/           # Shared middleware
      services/            # Core services (auth, media, feeds, etc.)

extensions/
  dogs/                    # Dog extension (npm workspace package)
    src/
      routes.ts            # Route[] to register
      metadata-schema.ts   # Zod schema for Entity.metadata
      life-stage.ts        # Dog life-stage calculator
      taxonomy-seed.ts     # Dog taxonomy data
      handlers/            # Dog-specific handlers
      activitypub/         # Dog ActivityPub dispatchers
    package.json           # depends on @trellis/core

  plants/                  # Hypothetical second extension
    src/
      routes.ts
      metadata-schema.ts
      ...
```

## Extension Interface

```typescript
// packages/core/src/interfaces/extension.ts

export interface TrellisExtension {
  /** Unique extension identifier */
  id: string;

  /** Display terminology for this entity type */
  terminology: {
    entity: string;       // "dog"
    entityPlural: string; // "dogs"
  };

  /** Routes to register */
  routes: Route[];

  /** Zod schema for Entity.metadata validation */
  metadataSchema: ZodSchema;

  /** Taxonomy seed data (dimensions, categories, taxons) */
  taxonomySeed?: TaxonomySeedData;

  /** Optional hooks into core lifecycle events */
  hooks?: {
    onPostCreated?: (post: Post, env: Env) => Promise<void>;
    onEntityCreated?: (entity: Entity, env: Env) => Promise<void>;
    onFollowCreated?: (follow: Follow, env: Env) => Promise<void>;
  };

  /** Optional feed personalization strategy */
  feedStrategy?: FeedStrategy;

  /** Optional product recommendation strategy */
  recommendationStrategy?: RecommendationStrategy;
}
```

## Extension Discovery at Startup

```typescript
// apps/api/src/extensions.ts

import type { TrellisExtension } from "@trellis/core";

// Static imports for now; dynamic discovery later
import { dogsExtension } from "@trellis/ext-dogs";

export const extensions: TrellisExtension[] = [
  dogsExtension,
];
```

## Route Registration

```typescript
// apps/api/src/lib/routes/index.ts

import { coreRoutes } from "./core";
import { extensions } from "../extensions";

export const routes: Route[] = [
  ...coreRoutes,
  ...extensions.flatMap(ext => ext.routes),
];
```

## Metadata Validation

```typescript
// In core entity handler
const extension = extensions.find(e => e.id === entity.entityType);
if (extension) {
  const result = extension.metadataSchema.safeParse(metadata);
  if (!result.success) return validationError(result.error);
}
```

## Why Not a Full Plugin System?

A dynamic plugin loader (scanning directories, resolving dependencies at
runtime) adds complexity that isn't justified yet. Static imports with a known
interface give you:

- Type safety at compile time
- Tree-shaking (unused extensions aren't bundled)
- Simple debugging (no magic resolution)
- Easy migration from the current architecture

Dynamic discovery can be added later if there are many extensions or third-party
contributors.
