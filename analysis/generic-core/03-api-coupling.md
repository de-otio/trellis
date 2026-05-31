# API Layer Coupling

## Route Registration

All routes are statically imported in `apps/api/src/lib/routes/index.ts`.
There is no dynamic discovery or conditional loading. Dog-specific routes
(`entities.ts`, `taxonomy.ts`, `dog-profile.ts`) are always bundled.

```
// Current: everything imported unconditionally
import { entitiesRoutes } from "./entities";
import { dogProfileRoutes } from "./activitypub/dog-profile";
```

## Handlers with Dog-Specific Logic

### High coupling (domain logic embedded)

| File | What's dog-specific |
|------|-------------------|
| `life-stage-calculator.ts` | Entire file: dog age thresholds, breed-size multipliers |
| `validation.ts` | Validates `breed`, `birthdate`, `breedSize` in entity metadata |
| `taxonomy-seed.ts` | All seed data: dog behavior, training categories |
| `activitypub/dog-profile.ts` | Hardcoded `/dogs/{id}` URI paths |
| `activitypub/dog-profile-service.ts` | Filters entities by `entityType='dog'` |
| `activitypub/dispatchers/dog-actor.ts` | Fedify dispatcher for dog actors |

### Moderate coupling (references dog assumptions)

| File | What's dog-specific |
|------|-------------------|
| `product-recommendations.ts` | Assumes `breedSize`, `lifeStage` taxonomy |
| `feed-personalization.ts` | Personalizes by "entity (dog) taxonomy tags" |
| `entity-handler.ts` | Generic name, but callers pass dog metadata |

### No coupling (fully generic)

All auth, post, comment, follow, sentiment, media, moderation, privacy,
deletion, export, invitation, badge, and admin handlers.

## The Core Problem

There is no boundary between "core social features" and "dog features" at the
code level. Both live in `apps/api/src/lib/` as peers. The dog-specific files
are identifiable by name, but nothing in the architecture enforces separation.

A developer adding a new feature has no guidance on whether their code belongs
in core or in an extension. This means coupling will grow over time unless an
explicit boundary is introduced.
