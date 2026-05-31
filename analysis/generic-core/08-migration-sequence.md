# Migration Sequence

Recommended order of changes to reach a generic core. Each phase is
independently valuable and can be shipped without completing later phases.

## Phase 1: Draw the Line (no behavior change)

**Goal:** Establish the boundary between core and domain code.

1. Create `extensions/dogs/` directory as an npm workspace package.
2. Define the `TrellisExtension` interface in a new `packages/core/` package
   (or in `apps/api/src/lib/interfaces/`).
3. Move these files into `extensions/dogs/src/`:
   - `life-stage-calculator.ts`
   - `taxonomy-seed.ts`
   - `activitypub/dog-profile.ts`
   - `activitypub/dog-profile-service.ts`
   - `activitypub/dispatchers/dog-actor.ts`
4. Re-export from original locations (temporary shims) so nothing breaks.
5. Update `routes/index.ts` to import dog routes from the extension.

**Risk:** Low. No logic changes. Just moving files.
**Estimated files touched:** ~10

## Phase 2: Extract Metadata Validation

**Goal:** Make entity metadata validation pluggable.

1. Define a `metadataSchema` property on the extension interface.
2. Create `extensions/dogs/src/metadata-schema.ts` with the Zod schema for
   `breed`, `birthdate`, `breedSize`.
3. Modify `entity-handler.ts` to look up the schema from the registered
   extension based on `entityType`.
4. Remove dog metadata validation from core `validation.ts`.

**Risk:** Low-medium. Validation behavior must remain identical.
**Estimated files touched:** ~4

## Phase 3: Fix Follow targetType

**Goal:** Remove 'dog' literal from the core Follow table.

1. Create a Prisma migration: `UPDATE "follows" SET target_type = 'entity'
   WHERE target_type = 'dog'`.
2. Update all queries that filter `targetType = 'dog'` to use `'entity'`.
3. Update the `Follow` model documentation.

**Risk:** Medium. Data migration on a potentially large table. Needs downtime
window or blue-green deploy.
**Estimated files touched:** ~5

## Phase 4: Extract Feed & Recommendation Strategies

**Goal:** Make feed personalization and product recommendations pluggable.

1. Define `FeedStrategy` and `RecommendationStrategy` interfaces in core.
2. Move dog-specific feed logic into `extensions/dogs/src/feed-strategy.ts`.
3. Move dog-specific recommendation logic into
   `extensions/dogs/src/recommendation-strategy.ts`.
4. Core feed handler calls `extension.feedStrategy` if present.

**Risk:** Low-medium. Feed behavior must remain identical.
**Estimated files touched:** ~6

## Phase 5: Generalize ActivityPub URIs

**Goal:** Make federation URIs entity-type-aware.

1. Change dog profile URIs from `/dogs/{id}` to `/entities/dog/{id}` (or a
   configurable pattern).
2. Update Fedify dispatchers to resolve entity type from the URI.
3. Handle backward compatibility: existing federated URIs (`/dogs/{id}`) must
   still resolve (redirect or alias).

**Risk:** High. ActivityPub URIs are permanent. Existing federation peers have
stored the old URIs. This needs careful planning and may require running both
old and new URIs indefinitely.
**Estimated files touched:** ~5

## Phase 6: Extension-Scoped Configuration

**Goal:** Each extension declares its own config requirements.

1. Add a `configSchema` property to the extension interface.
2. At startup, validate that required env vars are present.
3. Pass extension-specific config to extension handlers.

**Risk:** Low. Additive change.
**Estimated files touched:** ~3

## Phase 7: Core Lifecycle Hooks

**Goal:** Allow extensions to react to core events without modifying core code.

1. Define hook points: `onPostCreated`, `onEntityCreated`, `onFollowCreated`.
2. Core handlers call registered hooks after completing their operation.
3. Dog extension registers hooks (e.g., auto-tag breed from image).

**Risk:** Low-medium. Must not break core handler error handling.
**Estimated files touched:** ~5

## Phase 8: Flutter Extension Modules

**Goal:** Mirror the backend extension pattern in Flutter.

1. Create `apps/flutter/lib/extensions/dogs/` module.
2. Move dog-specific widgets, pages, and use cases there.
3. Core Flutter code loads extension UI based on configuration.
4. Terminology service drives UI labels.

**Risk:** Low. Renaming and reorganizing.
**Estimated files touched:** ~25 (mostly renames)

---

## Total Estimated Effort

| Phase | Files | Risk | Dependency |
|-------|-------|------|-----------|
| 1. Draw the Line | ~10 | Low | None |
| 2. Metadata Validation | ~4 | Low-Med | Phase 1 |
| 3. Follow targetType | ~5 | Medium | None |
| 4. Feed & Recommendations | ~6 | Low-Med | Phase 1 |
| 5. ActivityPub URIs | ~5 | High | Phase 1 |
| 6. Extension Config | ~3 | Low | Phase 1 |
| 7. Lifecycle Hooks | ~5 | Low-Med | Phase 1 |
| 8. Flutter Modules | ~25 | Low | Phase 1 |

Phases 1-4 provide the most value for the least risk. Phase 5 (ActivityPub URIs)
is the most delicate and can be deferred. Phases 3, 4, 6, 7, 8 can run in
parallel after Phase 1 is complete.
