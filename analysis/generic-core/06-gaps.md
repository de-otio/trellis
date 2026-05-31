# Gaps: What's Missing

## Gap 1: No Extension Boundary

There is no directory, module, or interface that says "this is where domain
extensions live." Dog-specific code sits alongside generic code in
`apps/api/src/lib/`. Nothing prevents future developers from adding more
domain coupling to core files.

**Impact:** Coupling will grow silently over time.

## Gap 2: No Extension Loading Mechanism

Routes are statically imported. There is no way to add or remove a set of
domain features without editing `routes/index.ts`. For a reusable core, you
need a way to register extension routes at startup.

**Impact:** Deploying the core without dogs requires manually removing imports.

## Gap 3: Hardcoded Metadata Validation

`validation.ts` validates entity metadata assuming dog fields (`breed`,
`birthdate`, `breedSize`). A plant community would need different metadata
(species, sunlight, watering frequency). There is no way to plug in a different
metadata schema.

**Impact:** Adding a new entity type requires modifying core validation code.

## Gap 4: Dog-Specific Domain Logic in Core

- `life-stage-calculator.ts` is 100% dog biology
- `taxonomy-seed.ts` is 100% dog behavior categories
- `product-recommendations.ts` assumes breedSize and lifeStage exist
- `feed-personalization.ts` assumes dog taxonomy tags

**Impact:** These files would need to be rewritten or deleted for a non-dog
deployment.

## Gap 5: Hardcoded ActivityPub URIs

The ActivityPub dog profile routes use `/dogs/{dogId}` as the canonical URI.
These URIs are permanent (other servers store them). Changing them later would
break federation.

**Impact:** Federation URIs should be entity-type-aware from the start, e.g.,
`/entities/{type}/{id}` or `/{type-plural}/{id}`.

## Gap 6: No Handler Extension Points

Handlers are self-contained classes with no hooks. For example, when a post is
created, there's no way for an extension to add domain-specific behavior
(e.g., auto-tagging a dog breed from image analysis) without modifying the
core post handler.

**Impact:** Extensions can't enhance core behavior without forking core code.

## Gap 7: Follow targetType Uses 'dog' Not 'entity'

The `Follow` model's `targetType` field stores the literal string `'dog'`
rather than `'entity'`. This leaks domain terminology into a core table.

**Impact:** A data migration is needed, plus updating all queries that filter
by `targetType`.

## Gap 8: No Extension-Scoped Configuration

`StageConfig` (CDK) and `Env` (runtime) have no concept of extension-specific
configuration. A dog extension might need a breed API key; a plant extension
might need a weather API key. Today these would all go into the flat `Env`.

**Impact:** Configuration for multiple extensions would collide in a single
namespace.
