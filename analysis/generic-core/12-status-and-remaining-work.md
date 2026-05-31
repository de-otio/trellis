# Status and Remaining Work

Review of the 8 original gaps (from `06-gaps.md`) against current implementation,
plus new items identified during implementation.

## Original Gaps: Status

### Gap 1: No Extension Boundary — CLOSED

**Before:** Dog-specific code sat alongside generic code in `apps/api/src/lib/`
with no organizational boundary.

**Now:**
- `packages/extension-api/` — shared types (`TrellisExtension`, `ExtensionContext`,
  `ExtensionDb`, `Route`, strategy interfaces, `ActorEnrichment`)
- `extensions/dogs/` — dog extension package with metadata schema, config, hooks,
  life-stage calculator, taxonomy seed data
- `apps/api/src/extensions.ts` — registry with `getExtension()` lookup
- `apps/api/src/lib/extension-validator.ts` — startup validation (reserved IDs,
  reserved route prefixes, auth middleware warnings)
- `apps/api/src/lib/extension-context.ts` — scoped context factory (extensions
  never see `SESSION_SECRET`, `DATABASE_URL`, or API keys)
- Flutter: `apps/flutter/lib/extensions/registry.dart` + `dogs/dogs_extension.dart`

### Gap 2: No Extension Loading Mechanism — CLOSED

**Before:** Routes statically imported in `routes/index.ts`. No way to add/remove
domain features without editing the file.

**Now:**
- Core routes separated into `coreRoutes` array
- Extension routes merged after core, before 404 handler
- Dog routes wired via `extensions.ts` (app-side, because handlers still import
  core infrastructure)
- Extensions validated at startup, logged on load
- Init/shutdown lifecycle hooks called at startup/SIGTERM

### Gap 3: Hardcoded Metadata Validation — CLOSED

**Before:** `validation.ts` hardcoded `breed`, `birthdate`, `breedSize` validation.

**Now:**
- `entityType` is required (no `|| "dog"` default)
- 64KB metadata size guard before schema validation
- Extension lookup via `getExtension(entityType)` — returns 400 if unknown
- `extension.metadataSchema.safeParse(metadata)` for domain-specific validation
- `validateDogProfile()` deleted
- Dog metadata schema defined in `extensions/dogs/src/index.ts`

### Gap 4: Dog-Specific Domain Logic in Core — PARTIALLY CLOSED

**Moved to extension:**
- `life-stage-calculator.ts` → `extensions/dogs/src/life-stage.ts` (pure domain
  logic, Logger dependency removed)
- `taxonomy-seed.ts` → `extensions/dogs/src/taxonomy-seed.ts` (1184 lines of
  seed data, Logger replaced with `console.info`)

**Still in core (infrastructure coupling — see `09-remaining-coupling.md`):**
- `feed-personalization.ts` — imports `DataRouter`, `TaxonomyHandler`, `Env`
- `product-recommendations.ts` — imports `DataRouter`, `TaxonomyHandler`,
  `getWrappedDatabase`
- `routes/product-recommendations.ts` — route handler with full HTTP infrastructure
- AP files (see Gap 5 status)

These files are database orchestration and HTTP wiring, not domain logic. The pure
domain functions within them (`calculateTaxonomyRelevance`,
`buildPersonalizedTaxonomyFilter`) could be extracted to the extension, leaving
thin wrappers in core. See `09-remaining-coupling.md` Option D.

### Gap 5: Hardcoded ActivityPub URIs — CLOSED

**Before:** `/dogs/{dogId}` as canonical URI.

**Now:**
- URI pattern: `/entities/{entityType}/{entityId}`
- `EntityProfileService` (renamed from `DogProfileService`) generates generic URIs
- Route handler at `/entities/:entityType/:entityId` serves any entity type
- Followers collection at `/entities/:entityType/:entityId/followers`
- Actor dispatcher parses `/entities/{type}/{id}` pattern
- `enrichActor` hook for domain-specific Actor display fields
- Zero `/dogs/` URI patterns remain in source

**Remaining AP work (see `11-activitypub-assessment.md`):**
- P1: Converge on single actor serialization (use Fedify dispatcher from route)
- ~~P2: Rename files~~ — DONE
- ~~P6: Send Accept for incoming Follows~~ — DONE
- ~~P7: Handle Undo(Follow)~~ — DONE
- P5: Implement inbox rate limiting
- P3: Entity WebFinger discovery

### Gap 6: No Handler Extension Points — CLOSED

**Before:** No hooks. Extensions couldn't react to core events.

**Now:**
- `hook-dispatcher.ts` with 5-second timeout and circuit breaker (5 consecutive
  failures disables the hook)
- `ExtensionHooks` interface: `onPostCreated`, `onEntityCreated`,
  `onFollowCreated`, `onEntityDeleted`
- Hooks receive `ExtensionContext` (scoped DB + own config), never raw `Env`
- Dog extension registers hooks via `dogsExtension.hooks`

### Gap 7: Follow targetType Uses 'dog' — CLOSED

**Before:** `targetType: "user" | "dog"` hardcoded in type signatures, validation
guards, and queries.

**Now:**
- `targetType: string` in all type signatures
- Validation uses `getExtension(targetType)` — registered extension types accepted,
  unregistered rejected
- `followers-handler.ts`: all 30+ `"dog"` references updated
- `followers-events.ts`: types and validation updated
- `activity-processor.ts`: uses `entity.entityType` instead of hardcoded `"dog"`
- Prisma schema comments updated (5 locations)
- `feed-handler.ts` comment cleaned

**2 remaining fallbacks:** `activity-processor.ts` lines 403, 410 use
`targetEntity.entityType ?? "dog"` — the `?? "dog"` is a fallback for entities
with null `entityType` (legacy data). Safe to keep.

### Gap 8: No Extension-Scoped Configuration — CLOSED

**Before:** All config in flat `Env`. No way for extensions to declare their own
env vars.

**Now:**
- `configSchema` on `TrellisExtension` — Zod schema for extension env vars
- Validated at startup against **scoped values only** (not full `process.env`)
- `ExtensionContext.config` populated from declared schema keys only
- Dog extension declares `DOG_BREED_API_KEY` via `dogConfigSchema`
- Extensions cannot read `SESSION_SECRET`, `DATABASE_URL`, etc.

---

## New Items Identified During Implementation

### N1: Core-wrapped extension route handlers — CLOSED

Documented in `10-extension-route-handlers.md`. Implemented in
`apps/api/src/lib/extension-route-wrapper.ts`:
- `wrapExtensionRoute()` converts `ExtensionRouteDefinition` → `Route`
- `wrapExtensionRoutes()` wraps all extension routes
- Handles auth (required/optional/none), CORS, CSRF, security headers, error handling
- Creates scoped `ExtensionContext` for extension handlers
- Routes registered at `/api/ext/{extensionId}/{path}`
- Integrated in `routes/index.ts` via `extensions.flatMap((ext) => wrapExtensionRoutes(ext))`
- Both legacy `ext.routes` and new `ext.extensionRoutes` supported

### N2: AP file renaming — CLOSED

All three files renamed:
- `dog-profile-service.ts` → `entity-profile-service.ts`
- `dispatchers/dog-actor.ts` → `dispatchers/entity-actor.ts`
- `routes/activitypub/dog-profile.ts` → `routes/activitypub/entity-profile.ts`

### N3: AP protocol completeness — PARTIALLY CLOSED

Per `11-activitypub-assessment.md`:
- ~~No Accept sent for incoming Follows~~ — **CLOSED**: `sendAcceptActivity()` in
  `activity-processor.ts` sends Accept for both user-to-user and user-to-entity follows
- ~~No Undo(Follow) handling~~ — **CLOSED**: `processUndoFollow()` in
  `activity-processor.ts` handles Undo(Follow) for both user and entity targets
- Abuse prevention is a stub — NOT YET DONE
- Two actor serialization paths should converge — NOT YET DONE
- Entity WebFinger discovery missing — NOT YET DONE

**Priority:** High for P1 (converge serialization). Others are medium.

### N4: Feed/recommendation strategy delegation — NOT YET DONE

`FeedStrategy` and `RecommendationStrategy` interfaces are defined in
`packages/extension-api/src/extension.ts`. The core feed handler still uses
direct `import("./feed-personalization")` calls. The delegation pattern (core
calls `ext.feedStrategy.personalize()`) is not wired yet.

**Priority:** Medium. Works today because the files are in core. Becomes blocking
when `feed-personalization.ts` needs to physically move to the extension.

### N5: Flutter dog_profiles not physically moved — NOT YET DONE

`DogsExtension` class exists and routes are wired through it, but the
`features/dog_profiles/` directory with 20 files hasn't moved to
`extensions/dogs/`. The extension delegates to the original feature files via
imports.

**Priority:** Low. The boundary exists logically (routes come from
`DogsExtension`). Physical move is a rename with import path updates.

### N6: Extension test coverage gap — MOSTLY CLOSED

Extension has 8 test files covering index, config, hooks, life-stage,
feed-strategy, recommendation-strategy, routes, and taxonomy-seed. Missing:
- `enrichActor` integration test (when it's implemented)

Core has 294 test files (5173 tests), zero regressions.

80% coverage threshold enforced in CI (`ci.yml` runs `test:coverage`).

---

## Summary

| Gap | Status | Remaining work |
|-----|--------|---------------|
| 1. Extension boundary | Closed | — |
| 2. Extension loading | Closed | — |
| 3. Metadata validation | Closed | — |
| 4. Domain logic in core | **Closed** | Pure functions removed from core; delegation via extension strategy |
| 5. AP URIs | Closed | — |
| 6. Handler hooks | Closed | — |
| 7. Follow targetType | Closed | — |
| 8. Extension config | Closed | — |
| N1. Core-wrapped routes | **Closed** | — |
| N2. AP file renaming | **Closed** | — |
| N3. AP protocol | **Closed** | Serialization converged on Fedify, Accept ✓, Undo ✓, rate limiting ✓, entity WebFinger ✓ |
| N4. Strategy delegation | **Closed** | Feed handler delegates to `ext.feedStrategy.personalize()` |
| N5. Flutter file move | **Closed** | Directory already removed |
| N6. Extension test gaps | **Closed** | 9 test files, enrichActor test added, CI enforcement added |

### Related: Monetization Portability

The monetization system (subscriptions, wallets, value exchange, brand tools) has
been separately audited for domain-specificity. All models pass — no dog-specific
fields or assumptions. See
[analysis/monetization/financial-analysis/review/tensions/generic-core/](../monetization/financial-analysis/review/tensions/generic-core/)
for the full audit, vertical portability examples, hardcoding risk checklist, and
investor narrative framing.

### Remaining Notes

- Feed handler uses `getExtensions().find(e => e.feedStrategy)` for
  personalization — when multiple extensions are registered, this will need a
  composite strategy.
- `product-recommendations.ts` was deleted from core (zero importers). The
  extension's `recommendationStrategy` is the canonical implementation.
- `feed-personalization.ts` retains only `getEntityTaxonomyTags()` (generic DB
  orchestration). Pure scoring functions are in extensions only.
- AP inbox rate limiting and abuse prevention wiring were already implemented
  (discovered during verification).
- Entity WebFinger discovery was already implemented.
- Extension tests run in CI with 80% coverage enforcement.
- Zero `"dog"` string literals in core source (only illustrative comment in
  `followers-handler.ts`). `dogId` renamed to `entityId` in `entity-actor.ts`.
  `DogProfileService` alias deleted. `getDogFeed` renamed to `getEntityFeed`.
  `dogRef` in export handler corrected to `entityRef` (matching Prisma schema).

**Phases 1-3 of repo separation are complete.** The core is ready for extraction.
Next: Phase 4 (repo split via `git filter-repo`).
See `13-naming-and-repo-separation/03-separation-phases.md`.

### Phase 2-3 Summary (completed 2026-04-06)

- **Phase 2:** npm scopes renamed `@trellis/*` → `@trellis/*` for core packages.
  `TrellisExtension` → `TrellisExtension`. `@trellis/ext-dogs` unchanged.
- **Phase 3:** Infrastructure parameterized via `config.appName` (default
  `"trellis"`). All CDK stacks, CI workflows, and scripts use helpers
  (`ssmPath`, `resourceName`, `stackPrefix`) instead of hardcoded names.
- **Extension decoupling:** Registry is programmatic (`registerExtension()`).
  Life-stage computation delegated via `TrellisExtension.computeLifeStage`.
  Core (`apps/api/src/lib/`) has zero imports from any extension package.

*Updated 2026-04-06. All gaps closed. Phases 1-3 complete. Ready for Phase 4.*
