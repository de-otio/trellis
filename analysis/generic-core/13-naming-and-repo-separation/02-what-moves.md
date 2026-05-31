# What Moves Where

## Trellis Repo (Core)

```
trellis/
  packages/
    extension-api/         # @trellis/extension-api — TrellisExtension, Route, strategies
    crypto/                # @trellis/crypto — AES-256-GCM, key derivation, hashing
  prisma/
    schema.prisma          # core models (no dog-specific fields — metadata is JSON)
    migrations/            # all existing migrations (already generic)
  apps/
    api/
      src/
        server.ts          # entry point (ships with empty registry; verticals wire extensions)
        env.ts             # environment schema
        extensions.ts      # programmatic registry: registerExtension(), getExtension()
        lib/               # all core handlers, middleware, services
          extension-*.ts   # extension infrastructure (context, validator, route wrapper, hooks)
          routes/          # core routes
          activitypub/     # federation (Fedify)
        lambda/            # Cognito triggers, workers, agent tools
  infra/                   # CDK stacks (parameterized via config.appName)
  scripts/                 # deploy, ops scripts (parameterized via APP_NAME env var)
```

## Trellis Repo (Vertical)

```
trellis/
  extensions/
    dogs/                  # @trellis/ext-dogs — breed profiles, life stages, taxonomy
  apps/
    flutter/               # dog-focused Flutter app (DogsExtension extends TrellisExtension)
  server.ts                # entry point: imports trellis core, calls registerExtension(dogsExtension)
  package.json             # depends on @trellis/api, @trellis/extension-api, @trellis/ext-dogs
```

## Boundary Verification (as of 2026-04-06)

- Core (`apps/api/src/lib/`) has **zero imports** from `@trellis/ext-dogs`
- Only `server.ts` (the app entry point) imports the dogs extension
- `extensions/dogs/` imports only from `@trellis/extension-api` (never from `apps/api/src/lib/`)
- Infrastructure names derive from `config.appName` (default `"trellis"`)
- Extension registry is programmatic (`registerExtension()`) — no static extension imports in core
